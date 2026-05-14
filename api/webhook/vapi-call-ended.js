import twilio from 'twilio';
import axios from 'axios';
import OpenAI from 'openai';
import { Redis } from '@upstash/redis';
import {
  findContactByPhone,
  updateContactFields,
  addContactTags,
  findOpportunity,
  moveOpportunityToHotLead,
} from '../../lib/ghl.js';
import { TTL_RECOVERY_SMS } from '../../lib/redis-config.js';
import { getConfig } from '../../lib/verticals.js';

const redis = Redis.fromEnv();
const ENDPOINT = 'vapi-call-ended';

const NO_ANSWER_REASONS = new Set([
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
  'registra il tuo messaggio',
  'after the tone',
];

const USER_ROLES = new Set(['user', 'customer']);

const GREETING_TOKENS = new Set([
  'pronto', 'sì', 'si', 'sono', 'io', 'chi', 'parla', 'è', 'sei',
  'salve', 'ciao', 'buongiorno', 'buona', 'giornata', 'buonasera',
  'sera', 'pomeriggio', 'buon', 'dimmi', 'dica', 'mi',
  'mh', 'eh', 'ah', 'uhm',
]);

function analyzeUserMessages(messages) {
  if (!Array.isArray(messages)) return { text: '', count: 0 };
  const parts = [];
  for (const msg of messages) {
    if (!USER_ROLES.has(msg?.role)) continue;
    const text = (msg?.message ?? msg?.content ?? '').trim();
    if (text.length >= 2 && /[\p{L}\p{N}]/u.test(text)) parts.push(text);
  }
  return { text: parts.join(' '), count: parts.length };
}

function hasVoicemailKeyword(text) {
  const lower = (text ?? '').toLowerCase();
  return VOICEMAIL_KEYWORDS.some((kw) => lower.includes(kw));
}

function isOnlyGreetings(text) {
  if (!text) return true;
  const tokens = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((t) => t.length > 0);
  return tokens.length === 0 || tokens.every((t) => GREETING_TOKENS.has(t));
}

const HOT_OUTCOMES = new Set(['interested', 'human_requested', 'booked']);

const EXTRACTION_PROMPT = `Sei un estrattore di dati strutturati. Analizza la trascrizione di una chiamata tra Sara (assistente AI di AutoExperience, noleggio a lungo termine) e un potenziale cliente.

# CAMPO OBBLIGATORIO: ai_call_summary
Scrivi SEMPRE 2-3 frasi che riassumono la chiamata. MAI stringa vuota o null.
Anche se la conversazione è stata brevissima: descrivi cosa è successo (es. "Il lead ha risposto brevemente senza fornire dettagli sul noleggio. Non ha espresso interesse esplicito né urgenza.").

# CAMPI DI QUALIFICA (restituisci null se non menzionato)

tipo_cliente — SOLO questi valori esatti:
  "privato" | "p.iva" | null

km_anno — numero intero oppure null (es. 15000)

segmento_auto — SOLO questi valori esatti:
  "city_car" | "berlina" | "suv" | "premium" | null
  Mai valori diversi (es. mai "SUV", mai "city car", mai "berlina/suv").

urgenza — SOLO questi valori esatti: "1 mese" | "3 mesi" | "6 mesi" | "valutando"
  Mapping obbligatorio:
  → "subito" / "immediata" / "immediatamente" / "ora" / "presto" / "appena possibile" / "entro un mese" / "tra qualche settimana" → "1 mese"
  → "due-tre mesi" / "dopo l'estate" / "entro tre mesi" → "3 mesi"
  → "quattro-sei mesi" / "verso fine anno" / "entro sei mesi" → "6 mesi"
  → "non so" / "sto valutando" / "vediamo" / "in futuro" / nessuna tempistica esplicita → "valutando"
  MAI usare altri valori come "immediata", "entro_3_mesi", "esplorativa".

durata_mesi — numero intero oppure null (es. 36, 48, 60)

# REGOLA INVIOLABILE: null onesto > dato inventato
Se nel transcript NON c'è una dichiarazione esplicita del lead per un campo, DEVI restituire null per quel campo.

# SCORE (valori interi 0-100, OBBLIGATORI, mai null)
intent_score: quanto il lead sembra deciso ad andare avanti con il noleggio
qualifica_score: quante informazioni utili ha fornito (tipo cliente, km, auto, durata)
engagement_score: quanto è stato collaborativo e interessato durante la chiamata

# OUTPUT
Rispondi SOLO con un oggetto JSON valido, senza markdown, senza spiegazioni:
{"ai_call_summary": "...", "tipo_cliente": ..., "km_anno": ..., "segmento_auto": ..., "urgenza": ..., "durata_mesi": ..., "intent_score": ..., "qualifica_score": ..., "engagement_score": ...}`;

function buildTranscriptString(messages) {
  if (!Array.isArray(messages)) return '';
  return messages
    .filter((m) => m?.role && (m?.message ?? m?.content ?? '').trim().length > 0)
    .map((m) => {
      const role = USER_ROLES.has(m.role) ? 'Cliente' : 'Sara';
      const text = (m.message ?? m.content ?? '').trim();
      return `${role}: ${text}`;
    })
    .join('\n');
}

function parseJsonSafe(content) {
  try { return JSON.parse(content); } catch {}
  try {
    const clean = content.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    return JSON.parse(clean);
  } catch {}
  try {
    const match = content.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
  } catch {}
  return null;
}

function internalUrl(path) {
  if (process.env.BASE_URL) return `${process.env.BASE_URL}${path}`;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}${path}`;
  return `http://localhost:3000${path}`;
}

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
    console.log(`[${ENDPOINT}] RAW BODY:`, JSON.stringify(req.body));

    const body = req.body ?? {};
    const message = body.message;

    const eventType = message?.type ?? body.type;
    if (eventType !== 'end-of-call-report') {
      console.log(`[${timestamp}] [${ENDPOINT}] Evento ignorato: type=${eventType}`);
      return res.status(200).json({ ok: true, ignored: true });
    }

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

    const artifactMessages = body.message?.artifact?.messages ?? [];

    console.log(`[${timestamp}] [${ENDPOINT}] Fine chiamata — phone: ${phone}, reason: ${endedReason}`);

    if (!phone) {
      console.warn(`[${timestamp}] [${ENDPOINT}] customer.number mancante nel payload Vapi`);
      return res.status(200).json({ ok: true, action: 'warning_unknown_reason' });
    }

    // Leggi vertical da Redis (best-effort — potrebbe essere scaduto)
    const vertical = (await redis.get(`vertical:${phone}`)) ?? 'noleggio';
    const config = getConfig(vertical);
    const ghlConfig = { apiKey: config.ghl_api_key, locationId: config.ghl_location_id };
    console.log(`[${ENDPOINT}] vertical=${vertical}`);

    const { text: userText, count: userMsgCount } = analyzeUserMessages(artifactMessages);
    const vk = hasVoicemailKeyword(transcript);
    const onlyGreetings = isOnlyGreetings(userText);
    console.log(`[${ENDPOINT}] User transcript: "${userText}" (length=${userText.length}, onlyGreetings=${onlyGreetings})`);

    const recovery =
      NO_ANSWER_REASONS.has(endedReason) ||
      vk ||
      (userText.length < 15 && userMsgCount < 2) ||
      onlyGreetings;

    const outcome = recovery ? 'no_answer_effective' : 'completed_normally';
    console.log(`[${ENDPOINT}] Classification: outcome=${outcome}`);

    // ── RAMO RECOVERY ────────────────────────────────────────────────────
    if (recovery) {
      console.log(`[${ENDPOINT}] Recovery SMS WILL be sent`);

      const alreadySent = await redis.get(`recovery_sms_sent:${phone}`);
      if (alreadySent) {
        console.log(`[${timestamp}] [${ENDPOINT}] Recovery SMS già inviato, skip per evitare duplicati`);
        return res.status(200).json({ ok: true, action: 'skipped_duplicate' });
      }

      let firstName = null;
      let contactId = null;
      try {
        const contact = await findContactByPhone(phone, ghlConfig);
        firstName = contact?.firstName ?? null;
        contactId = contact?.id ?? null;
        console.log(`[${timestamp}] [${ENDPOINT}] Contact: ${contactId} firstName=${firstName}`);
      } catch (e) {
        console.warn(`[${timestamp}] [${ENDPOINT}] WARN: GHL contact fetch failed: ${e.message}`);
      }

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

      await redis.set(`engaged:${phone}`, '1', { ex: 86400 });
      console.log(`[${ENDPOINT}] Setting key recovery_sms_sent TTL=${TTL_RECOVERY_SMS}s`);
      await redis.set(`recovery_sms_sent:${phone}`, '1', { ex: TTL_RECOVERY_SMS });

      if (contactId) {
        try {
          await addContactTags(contactId, ['call_no_answer', 'engaged_sms'], ghlConfig);
        } catch (e) {
          console.warn(`[${timestamp}] [${ENDPOINT}] WARN: GHL tag add failed: ${e.message}`);
        }
        try {
          await updateContactFields(contactId, [
            { key: 'channel_status', value: 'engaged_sms_recovery' },
            { key: 'ai_call_outcome', value: 'no_answer_recovery_sent' },
          ], ghlConfig);
        } catch (e) {
          console.warn(`[${timestamp}] [${ENDPOINT}] WARN: GHL fields update failed: ${e.message}`);
        }
      }

      return res.status(200).json({ ok: true, action: 'recovery_sms_sent' });
    }

    // ── RAMO CONVERSAZIONE REALE ─────────────────────────────────────────
    {
      console.log(`[${ENDPOINT}] Skipping recovery (real conversation occurred)`);
      console.log(`[${timestamp}] [${ENDPOINT}] Call completed normally, endedReason=${endedReason} outcome=${outcome}`);
      console.log(`[${timestamp}] [${ENDPOINT}] Summary: ${summary}`);
      console.log(`[${timestamp}] [${ENDPOINT}] Transcript (${transcript.length} chars)`);

      const contact = await findContactByPhone(phone, ghlConfig);
      if (!contact) {
        console.warn(`[${timestamp}] [${ENDPOINT}] Contatto GHL non trovato per ${phone}`);
        return res.status(200).json({ ok: true, action: 'call_completed_normally' });
      }

      console.log(`[${timestamp}] [${ENDPOINT}] Contatto GHL: ${contact.id} (${contact.firstName ?? phone})`);

      // ── Rilevamento no_conversation ───────────────────────────────────────
      const durationSeconds = (() => {
        const direct = extractVapiField(body, 'message.durationSeconds', 'durationSeconds');
        if (direct != null) return Number(direct);
        const start = extractVapiField(body, 'message.startedAt', 'message.call.startedAt');
        const end   = extractVapiField(body, 'message.endedAt',   'message.call.endedAt');
        if (start && end) return Math.round((new Date(end) - new Date(start)) / 1000);
        return null;
      })();
      const parole_lead = userText.split(/\s+/).filter(Boolean).length;
      const noConversation =
        (durationSeconds !== null && durationSeconds < 15) ||
        userMsgCount < 2 ||
        parole_lead < 10;
      if (noConversation) {
        console.log(`[${ENDPOINT}] no_conversation detected (durata=${durationSeconds}, turni_lead=${userMsgCount}, parole_lead=${parole_lead}), skip extraction`);
      }

      // ── Estrazione strutturata qualifica via LLM ──────────────────────────
      const STRUCT_KEYS = ['tipo_cliente', 'km_anno', 'segmento_auto', 'urgenza', 'durata_mesi'];
      let extracted = {};

      if (!noConversation) {
        const transcriptString = buildTranscriptString(artifactMessages);
        if (transcriptString.length > 0) {
          try {
            const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
            const completion = await openai.chat.completions.create({
              model: 'gpt-4o-mini',
              temperature: 0,
              max_tokens: 300,
              messages: [
                { role: 'system', content: EXTRACTION_PROMPT },
                { role: 'user', content: transcriptString },
              ],
            });
            const raw = completion.choices[0].message.content;
            const parsed = parseJsonSafe(raw);
            if (parsed) {
              extracted = parsed;
              console.log(`[${ENDPOINT}] LLM raw JSON: ${JSON.stringify(parsed)}`);
              console.log(
                `[${ENDPOINT}] LLM extraction OK: tipo_cliente=${extracted.tipo_cliente} ` +
                `km_anno=${extracted.km_anno} segmento=${extracted.segmento_auto} ` +
                `urgenza=${extracted.urgenza} durata=${extracted.durata_mesi}`
              );
            } else {
              console.warn(`[${ENDPOINT}] WARN: LLM extraction parse failed — raw: ${raw}`);
            }
          } catch (e) {
            console.warn(`[${ENDPOINT}] WARN: LLM extraction failed: ${e.message}`);
          }
        }
      }

      const intentScore    = Number(extracted.intent_score    ?? 0);
      const qualificaScore = Number(extracted.qualifica_score ?? 0);
      const engagementScore = Number(extracted.engagement_score ?? 0);
      const computedLeadScore = noConversation
        ? 0
        : Math.round(0.4 * intentScore + 0.4 * qualificaScore + 0.2 * engagementScore);
      console.log(`[${ENDPOINT}] LLM scores: intent=${intentScore} qualifica=${qualificaScore} engagement=${engagementScore} → lead_score=${computedLeadScore}`);

      const existingKeys = new Set(
        (contact.customFields ?? [])
          .filter((f) => f.value !== null && f.value !== '' && f.value !== undefined)
          .map((f) => f.key ?? f.id)
      );

      const finalOutcome = noConversation ? 'no_conversation' : outcome;
      const callSummary = noConversation
        ? 'Chiamata non andata a buon fine — lead non ha risposto, è stato silente o ha chiuso subito. Da richiamare manualmente.'
        : ((extracted.ai_call_summary ?? '').trim() || summary);
      const fieldsToWrite = [
        { key: 'ai_call_summary', value: callSummary },
        { key: 'ai_call_outcome', value: finalOutcome },
        { key: 'lead_score',      value: String(computedLeadScore) },
      ];

      let written = fieldsToWrite.length;
      let preserved = 0;
      if (!noConversation) {
        for (const key of STRUCT_KEYS) {
          const val = extracted[key];
          if (val === null || val === undefined) continue;
          if (existingKeys.has(key)) {
            preserved++;
            console.log(`[${ENDPOINT}] Preserve existing GHL field: ${key}`);
          } else {
            fieldsToWrite.push({ key, value: String(val) });
            written++;
          }
        }
      }

      await updateContactFields(contact.id, fieldsToWrite, ghlConfig);
      console.log(`[${ENDPOINT}] GHL custom fields updated: ${written} campi scritti, ${preserved} preservati`);

      // ── Hot-lead handoff ──────────────────────────────────────────────────
      const sdOutcome = structuredData?.outcome ?? '';
      const isHot = HOT_OUTCOMES.has(sdOutcome) || computedLeadScore >= config.handoff_threshold;

      if (isHot) {
        const alreadyDone = await redis.get(`handoff_done:${phone}`);
        if (!alreadyDone) {
          console.log(`[${timestamp}] [${ENDPOINT}] Lead caldo — avvio handoff per ${phone}`);
          const opp = await findOpportunity(contact.id, ghlConfig);
          if (opp) {
            await moveOpportunityToHotLead(opp.id, ghlConfig);
            console.log(`[${timestamp}] [${ENDPOINT}] Opportunity ${opp.id} → Hot Lead stage`);
          }
          try {
            await axios.post(
              internalUrl('/api/webhook/hot-lead-handoff'),
              { phone, vertical },
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
