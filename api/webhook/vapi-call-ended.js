import axios from 'axios';
import { Redis } from '@upstash/redis';
import { findContactByPhone, updateContactFields, findOpportunity, moveOpportunityToHotLead } from '../../lib/ghl.js';

const redis = Redis.fromEnv();
const ENDPOINT = 'vapi-call-ended';

// Mappa i motivi di chiusura Vapi verso outcome leggibili
const REASON_TO_OUTCOME = {
  'customer-ended-call': 'completed',
  'assistant-ended-call': 'completed',
  'voicemail': 'voicemail',
  'max-duration-exceeded': 'completed',
  'no-answer': 'no_answer',
  'busy': 'no_answer',
  'failed': 'failed',
};

const HOT_OUTCOMES = new Set(['interested', 'human_requested', 'booked']);

function internalUrl(path) {
  if (process.env.BASE_URL) return `${process.env.BASE_URL}${path}`;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}${path}`;
  return `http://localhost:3000${path}`;
}

export default async function handler(req, res) {
  const timestamp = new Date().toISOString();

  if (req.method !== 'POST') {
    console.log(`[${timestamp}] [${ENDPOINT}] Metodo non consentito: ${req.method}`);
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { message } = req.body ?? {};

    // Vapi invia vari tipi di evento — processiamo solo la fine chiamata
    if (message?.type !== 'end-of-call-report') {
      console.log(`[${timestamp}] [${ENDPOINT}] Evento ignorato: type=${message?.type}`);
      return res.status(200).json({ ok: true, ignored: true });
    }

    const phone = message.call?.customer?.number;
    const transcript = message.transcript ?? '';
    const summary = message.analysis?.summary ?? message.summary ?? '';
    const endedReason = message.endedReason ?? 'unknown';
    const structuredData = message.analysis?.structuredData ?? {};

    console.log(`[${timestamp}] [${ENDPOINT}] Fine chiamata — phone: ${phone}, reason: ${endedReason}`);
    console.log(`[${timestamp}] [${ENDPOINT}] Summary: ${summary}`);
    console.log(`[${timestamp}] [${ENDPOINT}] Transcript (${transcript.length} chars)`);

    // structuredData.outcome ha priorità su endedReason
    // TODO: configura il tuo Vapi assistant per produrre structuredData con campo "outcome"
    const outcome = structuredData?.outcome ?? REASON_TO_OUTCOME[endedReason] ?? 'completed';
    console.log(`[${timestamp}] [${ENDPOINT}] Outcome: ${outcome}`);

    if (!phone) {
      console.warn(`[${timestamp}] [${ENDPOINT}] customer.number mancante nel payload Vapi`);
      return res.status(200).json({ ok: true, contact_updated: false, outcome });
    }

    const contact = await findContactByPhone(phone);
    if (!contact) {
      console.warn(`[${timestamp}] [${ENDPOINT}] Contatto GHL non trovato per ${phone}`);
      return res.status(200).json({ ok: true, contact_updated: false, outcome });
    }

    console.log(`[${timestamp}] [${ENDPOINT}] Contatto GHL: ${contact.id} (${contact.firstName ?? phone})`);

    // Aggiorna i custom fields su GHL
    // TODO: verifica che i fieldKey "ai_call_summary" e "ai_call_outcome" corrispondano
    //       ai nomi esatti nel tuo sub-account (controlla con GET /locations/{id}/customFields)
    await updateContactFields(contact.id, [
      { key: 'ai_call_summary', value: summary },
      { key: 'ai_call_outcome', value: outcome },
    ]);
    console.log(`[${timestamp}] [${ENDPOINT}] Custom fields GHL aggiornati`);

    // Muovi opportunity se lead caldo (da structuredData o outcome semantico)
    const leadScore = Number(structuredData?.lead_score ?? 0);
    const isHot = HOT_OUTCOMES.has(outcome) || leadScore >= 70;

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

    return res.status(200).json({ ok: true, contact_updated: true, outcome });
  } catch (err) {
    const errTs = new Date().toISOString();
    console.error(`[${errTs}] [${ENDPOINT}] Errore:`, err.message);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
