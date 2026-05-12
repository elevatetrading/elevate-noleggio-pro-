import twilio from 'twilio';
import axios from 'axios';
import { Redis } from '@upstash/redis';
import {
  findContactByPhone,
  updateContactFields,
  addContactTags,
  findOpportunity,
  moveOpportunityToHotLead,
} from '../../lib/ghl.js';

const redis = Redis.fromEnv();
const ENDPOINT = 'vapi-call-ended';

const NO_INTERACTION_REASONS = new Set([
  'customer-did-not-answer',
  'customer-busy',
  'rejected',
  'no-answer',
  'call-rejected',
  'voicemail',
]);

const VOICEMAIL_KEYWORDS = [
  'segnale acustico',
  'lasci un messaggio',
  'lasciare un messaggio',
  'casella vocale',
  'voicemail',
  'segreteria',
  'non disponibile in questo momento',
];

function shouldSendRecovery(endedReason, transcript) {
  if (NO_INTERACTION_REASONS.has(endedReason)) return true;
  if (endedReason === 'silence-timed-out') return true;
  const lower = (transcript ?? '').toLowerCase();
  return VOICEMAIL_KEYWORDS.some((kw) => lower.includes(kw));
}

const HOT_OUTCOMES = new Set(['interested', 'human_requested', 'booked']);

function internalUrl(path) {
  if (process.env.BASE_URL) return `${process.env.BASE_URL}${path}`;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}${path}`;
  return `http://localhost:3000${path}`;
}

// Naviga un path dot-separated nel body Vapi, prova più varianti in ordine.
function extractVapiField(body, ...paths) {
  for (const path of paths) {
    let val = body;
    for (const key of path.split('.')) {
      val = val?.[key];
      if (val === undefined || val === null) { val = null; break; }
    }
    if (val !== null && val !== undefined) return val;
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();

  const timestamp = new Date().toISOString();

  if (req.method !== 'POST') {
    console.log(`[${timestamp}] [${ENDPOINT}] Metodo non consentito: ${req.method}`);
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    // Log raw sempre — critico per debug payload Vapi
    console.log(`[${ENDPOINT}] RAW BODY:`, JSON.stringify(req.body));

    const body = req.body ?? {};
    const message = body.message;

    // Vapi invia vari tipi di evento — processiamo solo la fine chiamata
    const eventType = message?.type ?? body.type;
    if (eventType !== 'end-of-call-report') {
      console.log(`[${timestamp}] [${ENDPOINT}] Evento ignorato: type=${eventType}`);
      return res.status(200).json({ ok: true, ignored: true });
    }

    // Estrazione robusta: il nesting Vapi varia tra versioni API
    const phone = extractVapiField(body,
      'message.call.customer.number',
      'call.customer.number',
      'message.customer.number',
      'customer.number'
    );

    const endedReason = extractVapiField(body,
      'message.endedReason',
      'message.call.endedReason',
      'endedReason',
      'call.endedReason'
    ) ?? 'unknown';

    const transcript = extractVapiField(body,
      'message.transcript', 'transcript'
    ) ?? '';

    const summary = extractVapiField(body,
      'message.analysis.summary', 'message.summary', 'analysis.summary', 'summary'
    ) ?? '';

    const structuredData = extractVapiField(body,
      'message.analysis.structuredData', 'analysis.structuredData', 'structuredData'
    ) ?? {};

    console.log(`[${timestamp}] [${ENDPOINT}] Fine chiamata — phone: ${phone}, reason: ${endedReason}`);

    if (!phone) {
      console.warn(`[${timestamp}] [${ENDPOINT}] customer.number mancante nel payload Vapi`);
      return res.status(200).json({ ok: true, action: 'warning_unknown_reason' });
    }

    const hasVoicemailKeyword = VOICEMAIL_KEYWORDS.some((kw) => (transcript ?? '').toLowerCase().includes(kw));
    const recovery = shouldSendRecovery(endedReason, transcript);
    const outcome = recovery ? 'no_answer_effective' : 'completed_normally';
    console.log(`[${ENDPOINT}] Classification: endedReason=${endedReason} hasVoicemailKeyword=${hasVoicemailKeyword} outcome=${outcome}`);

    // ── RAMO RECOVERY — lead non ha avuto interazione vocale reale ────────
    if (recovery) {
      console.log(`[${ENDPOINT}] Recovery SMS WILL be sent`);

      // Idempotenza: blocca doppi invii (Vapi può mandare l'evento 2-3 volte)
      const alreadySent = await redis.get(`recovery_sms_sent:${phone}`);
      if (alreadySent) {
        console.log(`[${timestamp}] [${ENDPOINT}] Recovery SMS già inviato, skip per evitare duplicati`);
        return res.status(200).json({ ok: true, action: 'skipped_duplicate' });
      }

      // Recupera first_name da GHL
      let firstName = null;
      let contactId = null;
      try {
        const contact = await findContactByPhone(phone);
        firstName = contact?.firstName ?? null;
        contactId = contact?.id ?? null;
        console.log(`[${timestamp}] [${ENDPOINT}] Contact: ${contactId} firstName=${firstName}`);
      } catch (e) {
        console.warn(`[${timestamp}] [${ENDPOINT}] WARN: GHL contact fetch failed: ${e.message}`);
      }

      // SMS di recovery
      const greeting = firstName ? `Ciao ${firstName}` : 'Ciao';
      const smsBody =
        `${greeting}, ti ho appena chiamata ma non sono riuscita a sentirti. ` +
        `Possiamo rifissare la chiamata in un altro momento, oppure se preferisci ` +
        `puoi chiedermi qui in chat. Sara di AutoExperience`;

      try {
        const twilioClient = twilio(
          process.env.TWILIO_ACCOUNT_SID,
          process.env.TWILIO_AUTH_TOKEN
        );
        const sms = await twilioClient.messages.create({
          body: smsBody,
          from: process.env.TWILIO_PHONE_NUMBER,
          to: phone,
        });
        console.log(`[${timestamp}] [${ENDPOINT}] Recovery SMS sent to ${phone}, twilio_sid=${sms.sid}`);
      } catch (e) {
        console.error(`[${timestamp}] [${ENDPOINT}] ERROR SMS: ${e.message}`);
      }

      // Redis: engaged 24h + anti-duplicato 1h
      await redis.set(`engaged:${phone}`, '1', { ex: 86400 });
      await redis.set(`recovery_sms_sent:${phone}`, '1', { ex: 3600 });

      // GHL: tag + custom fields (best effort, non bloccano il flusso)
      if (contactId) {
        try {
          await addContactTags(contactId, ['call_no_answer', 'engaged_sms']);
        } catch (e) {
          console.warn(`[${timestamp}] [${ENDPOINT}] WARN: GHL tag add failed: ${e.message}`);
        }
        try {
          await updateContactFields(contactId, [
            { key: 'channel_status', value: 'engaged_sms_recovery' },
            { key: 'ai_call_outcome', value: 'no_answer_recovery_sent' },
          ]);
        } catch (e) {
          console.warn(`[${timestamp}] [${ENDPOINT}] WARN: GHL fields update failed: ${e.message}`);
        }
      }

      return res.status(200).json({ ok: true, action: 'recovery_sms_sent' });
    }

    // ── RAMO CONVERSAZIONE REALE — aggiornamento GHL + hot-lead handoff ──
    {
      console.log(`[${ENDPOINT}] Skipping recovery (real conversation occurred)`);
      console.log(`[${timestamp}] [${ENDPOINT}] Call completed normally, endedReason=${endedReason} outcome=${outcome}`);
      console.log(`[${timestamp}] [${ENDPOINT}] Summary: ${summary}`);
      console.log(`[${timestamp}] [${ENDPOINT}] Transcript (${transcript.length} chars)`);

      const contact = await findContactByPhone(phone);
      if (!contact) {
        console.warn(`[${timestamp}] [${ENDPOINT}] Contatto GHL non trovato per ${phone}`);
        return res.status(200).json({ ok: true, action: 'call_completed_normally' });
      }

      console.log(`[${timestamp}] [${ENDPOINT}] Contatto GHL: ${contact.id} (${contact.firstName ?? phone})`);

      await updateContactFields(contact.id, [
        { key: 'ai_call_summary', value: summary },
        { key: 'ai_call_outcome', value: outcome },
      ]);
      console.log(`[${timestamp}] [${ENDPOINT}] Custom fields GHL aggiornati`);

      const leadScore = Number(structuredData?.lead_score ?? 0);
      const sdOutcome = structuredData?.outcome ?? '';
      const isHot = HOT_OUTCOMES.has(sdOutcome) || leadScore >= 70;

      if (isHot) {
        const alreadyDone = await redis.get(`handoff_done:${phone}`);
        if (!alreadyDone) {
          console.log(`[${timestamp}] [${ENDPOINT}] Lead caldo — avvio handoff per ${phone}`);
          const opp = await findOpportunity(contact.id);
          if (opp) {
            await moveOpportunityToHotLead(opp.id);
            console.log(`[${timestamp}] [${ENDPOINT}] Opportunity ${opp.id} → Hot Lead stage`);
          }
          try {
            await axios.post(
              internalUrl('/api/webhook/hot-lead-handoff'),
              { phone },
              { timeout: 8000 }
            );
          } catch (e) {
            console.error(`[${timestamp}] [${ENDPOINT}] Errore chiamata handoff:`, e.message);
          }
        } else {
          console.log(`[${timestamp}] [${ENDPOINT}] Handoff già eseguito per ${phone} — skip`);
        }
      }

      return res.status(200).json({ ok: true, action: 'call_completed_normally' });
    }

  } catch (err) {
    const errTs = new Date().toISOString();
    console.error(`[${errTs}] [${ENDPOINT}] Errore:`, err.message);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
