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

// Single-word tokens covering all Italian greeting/opener/filler phrases.
const GREETING_TOKENS = new Set([
  'pronto', 'sì', 'si', 'sono', 'io', 'chi', 'parla', 'è', 'sei',
  'salve', 'ciao', 'buongiorno', 'buona', 'giornata', 'buonasera',
  'sera', 'pomeriggio', 'buon', 'dimmi', 'dica', 'mi',
  'mh', 'eh', 'ah', 'uhm',
]);

// Returns concatenated text of significant user messages + count.
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

// Returns true if every word in text is a known Italian greeting/opener/filler.
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

Estrai le seguenti informazioni SE presenti nella trascrizione. Se un campo non è menzionato o non è chiaro, restituisci null per quel campo.

Campi da estrarre:
- tipo_cliente: "privato" | "p.iva" | null
- km_anno: numero intero (es. 15000) | null — i km percorsi annualmente
- segmento_auto: "city_car" | "berlina" | "suv" | "premium" | null
- urgenza: "immediata" | "entro_3_mesi" | "esplorativa" | null
- durata_mesi: numero intero (es. 36, 48, 60) | null — durata preferita del contratto

Rispondi SOLO con un oggetto JSON valido, senza markdown, senza spiegazioni:
{"tipo_cliente": ..., "km_anno": ..., "segmento_auto": ..., "urgenza": ..., "durata_mesi": ...}`;

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

    const artifactMessages = body.message?.artifact?.messages ?? [];

    console.log(`[${timestamp}] [${ENDPOINT}] Fine chiamata — phone: ${phone}, reason: ${endedReason}`);

    if (!phone) {
      console.warn(`[${timestamp}] [${ENDPOINT}] customer.number mancante nel payload Vapi`);
      return res.status(200).json({ ok: true, action: 'warning_unknown_reason' });
    }

    const { text: userText, count: userMsgCount } = analyzeUserMessages(artifactMessages);
    const vk = hasVoicemailKeyword(transcript);
    const onlyGreetings = isOnlyGreetings(userText);
    console.log(`[${ENDPOINT}] User transcript: "${userText}" (length=${userText.length}, onlyGreetings=${onlyGreetings})`);

    // Real conversation only if ALL 4 conditions hold:
    //   1. userText.length >= 15 OR msgCount >= 2
    //   2. user transcript is not only greetings/openers
    //   3. no voicemail keywords in transcript
    //   4. endedReason not in explicit no-answer set
    const recovery =
      NO_ANSWER_REASONS.has(endedReason) ||
      vk ||
      (userText.length < 15 && userMsgCount < 2) ||
      onlyGreetings;

    const outcome = recovery ? 'no_answer_effective' : 'completed_normally';
    console.log(`[${ENDPOINT}] Classification: outcome=${outcome}`);

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

      // Redis: engaged fisso 24h + anti-duplicato configurabile
      await redis.set(`engaged:${phone}`, '1', { ex: 86400 });
      console.log(`[${ENDPOINT}] Setting key recovery_sms_sent TTL=${TTL_RECOVERY_SMS}s`);
      await redis.set(`recovery_sms_sent:${phone}`, '1', { ex: TTL_RECOVERY_SMS });

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

      // ── Estrazione strutturata qualifica via LLM ─────────────────────────
      const STRUCT_KEYS = ['tipo_cliente', 'km_anno', 'segmento_auto', 'urgenza', 'durata_mesi'];
      let extracted = {};

      const transcriptString = buildTranscriptString(artifactMessages);
      if (transcriptString.length > 0) {
        try {
          const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
          const completion = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            temperature: 0,
            max_tokens: 150,
            messages: [
              { role: 'system', content: EXTRACTION_PROMPT },
              { role: 'user', content: transcriptString },
            ],
          });
          const raw = completion.choices[0].message.content;
          const parsed = parseJsonSafe(raw);
          if (parsed) {
            extracted = parsed;
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

      // Campi già popolati nel contatto GHL (da quiz o interazioni precedenti)
      const existingKeys = new Set(
        (contact.customFields ?? [])
          .filter((f) => f.value !== null && f.value !== '' && f.value !== undefined)
          .map((f) => f.key ?? f.id)
      );

      // Costruisce la lista dei campi da scrivere
      const fieldsToWrite = [
        { key: 'ai_call_summary', value: summary },
        { key: 'ai_call_outcome', value: outcome },
      ];

      let written = 2;
      let preserved = 0;
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

      await updateContactFields(contact.id, fieldsToWrite);
      console.log(`[${ENDPOINT}] GHL custom fields updated: ${written} campi scritti, ${preserved} preservati`);

      // ── Hot-lead handoff ──────────────────────────────────────────────────
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
