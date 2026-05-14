import twilio from 'twilio';
import OpenAI from 'openai';
import axios from 'axios';
import { URLSearchParams } from 'url';
import { Redis } from '@upstash/redis';
import {
  findContactByPhone,
  updateContactFields,
  addContactTags,
  setContactDnd,
} from '../../lib/ghl.js';
import { schedulePost, cancelMessage } from '../../lib/qstash.js';
import { getConfig } from '../../lib/verticals.js';

const redis = Redis.fromEnv();
const ENDPOINT = 'incoming-sms';

function internalUrl(path) {
  if (process.env.BASE_URL) return `${process.env.BASE_URL}${path}`;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}${path}`;
  return `http://localhost:3000${path}`;
}

// URL fisso di produzione per callback QStash — NON usare VERCEL_URL (punta al preview deploy).
function qstashCallbackUrl(path) {
  if (process.env.PUBLIC_BASE_URL) return `${process.env.PUBLIC_BASE_URL}${path}`;
  console.warn(`[incoming-sms] WARN: PUBLIC_BASE_URL non definita — uso URL hardcoded produzione`);
  return `https://elevate-noleggio-pro.vercel.app${path}`;
}

// Parole/frasi che indicano disdetta esplicita di una chiamata schedulata.
const CANCELLATION_KEYWORDS = [
  'non mi va più', 'non mi va piu', 'annulla', 'annullare', 'disdici', 'disdire',
  'non mi chiamare', 'non richiamarmi', 'cancella la chiamata', 'non voglio essere chiamato',
  'rimanda la chiamata', 'spostiamo la chiamata',
];

function hasCancellationKeyword(text) {
  const lower = (text ?? '').toLowerCase();
  return CANCELLATION_KEYWORDS.some((kw) => lower.includes(kw));
}

// Parser robusto per la risposta JSON di OpenAI (gestisce markdown code block)
function parseOpenAiJson(content) {
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

// Restituisce data/ora corrente formattata per il prompt (Europe/Rome).
function getRomeDateTime() {
  const now = new Date();
  const dateStr = new Intl.DateTimeFormat('it-IT', {
    timeZone: 'Europe/Rome',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(now);
  const timeStr = new Intl.DateTimeFormat('it-IT', {
    timeZone: 'Europe/Rome',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);
  return `${dateStr}, ore ${timeStr}`;
}

function buildSystemPrompt(chatPrompt) {
  const currentDateTime = getRomeDateTime();
  return `Data/ora corrente: ${currentDateTime} (fuso orario Europe/Rome)\n\n${chatPrompt}`;
}

export default async function handler(req, res) {
  const timestamp = new Date().toISOString();

  if (req.method !== 'POST') {
    console.log(`[${timestamp}] [${ENDPOINT}] Metodo non consentito: ${req.method}`);
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    console.log(`[${ENDPOINT}] RAW BODY:`, JSON.stringify(req.body));

    // Twilio invia application/x-www-form-urlencoded
    const raw = typeof req.body === 'string'
      ? Object.fromEntries(new URLSearchParams(req.body))
      : req.body;

    const from = raw.From;
    const incomingText = raw.Body;

    console.log(`[${timestamp}] [${ENDPOINT}] SMS da ${from}: "${incomingText}"`);

    // Leggi il vertical del lead da Redis (salvato da quiz-submitted o altri handler)
    const vertical = (await redis.get(`vertical:${from}`)) ?? 'noleggio';
    const config = getConfig(vertical);
    const ghlConfig = { apiKey: config.ghl_api_key, locationId: config.ghl_location_id };
    console.log(`[${ENDPOINT}] vertical=${vertical}`);

    // Il lead sta interagendo via SMS — cancella eventuale chiamata Vapi pendente
    const deleted = await redis.del(`vapi_pending:${from}`);
    if (deleted) {
      console.log(`[${ENDPOINT}] Cancelled scheduled Vapi call for ${from}`);
    }

    // Segnala che il lead è attivo — blocca fallback e recovery per 24h
    await redis.set(`engaged:${from}`, '1', { ex: 86400 });
    console.log(`[${ENDPOINT}] Set engaged:${from} TTL 86400s`);

    const twilioClient = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
    const ourNumber = process.env.TWILIO_PHONE_NUMBER;

    // Ultimi 20 messaggi tra il nostro numero e il lead (in entrambe le direzioni)
    const [outbound, inbound] = await Promise.all([
      twilioClient.messages.list({ from: ourNumber, to: from, limit: 20 }),
      twilioClient.messages.list({ from: from, to: ourNumber, limit: 20 }),
    ]);

    const history = [...outbound, ...inbound]
      .sort((a, b) => new Date(a.dateSent) - new Date(b.dateSent))
      .slice(-20)
      .map((msg) => ({
        role: msg.direction === 'inbound' ? 'user' : 'assistant',
        content: msg.body,
      }));

    const messages = [
      { role: 'system', content: buildSystemPrompt(config.chat_setter_prompt) },
      ...history,
      { role: 'user', content: incomingText },
    ];

    console.log(`[${ENDPOINT}] Contesto: ${history.length} messaggi precedenti`);

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.6,
      max_tokens: 350,
      messages,
    });

    const rawContent = completion.choices[0].message.content;
    console.log(`[${ENDPOINT}] OpenAI raw: ${rawContent}`);

    const parsed = parseOpenAiJson(rawContent);
    const reply = parsed?.response ?? rawContent;
    const intent = parsed?.intent ?? 'qualify';
    const scheduledDatetime = parsed?.scheduled_datetime ?? null;

    console.log(`[${ENDPOINT}] LLM response intent=${intent} scheduled_datetime=${scheduledDatetime} engagement_score=${parsed?.engagement_score ?? 'N/A'}`);

    // Invia sempre la risposta SMS
    await twilioClient.messages.create({ body: reply, from: ourNumber, to: from });
    console.log(`[${ENDPOINT}] SMS inviato a ${from}: "${reply}"`);

    // Cancella chiamata schedulata se il lead la disdice (qualsiasi intent)
    if (intent === 'rejection' || hasCancellationKeyword(incomingText)) {
      const cancelledCount = await redis.del(`scheduled_call:${from}`);
      if (cancelledCount) {
        console.log(`[incoming-sms] Scheduled call CANCELLED for ${from} due to lead message`);
      }
      const qstashMsgId = await redis.get(`qstash_message_id:${from}`);
      if (qstashMsgId) {
        try {
          await cancelMessage(qstashMsgId);
          console.log(`[incoming-sms] QStash message cancelled: messageId=${qstashMsgId}`);
        } catch (e) {
          console.warn(`[incoming-sms] WARN: QStash cancel failed for messageId=${qstashMsgId}: ${e.message}`);
        }
        await redis.del(`qstash_message_id:${from}`);
      }
    }

    // ── Logica per intent ──────────────────────────────────────────────────

    if (intent === 'schedule') {
      if (scheduledDatetime) {
        const scheduledAt = new Date(scheduledDatetime);
        if (!isNaN(scheduledAt.getTime())) {
          const secondsUntil = Math.floor((scheduledAt.getTime() - Date.now()) / 1000);
          const ttl = Math.max(3600, secondsUntil + 3600);
          await redis.set(`scheduled_call:${from}`, scheduledDatetime, { ex: ttl });
          console.log(`[${ENDPOINT}] Scheduled call set for ${from} at ${scheduledDatetime} (TTL ${ttl}s)`);

          let contactId = null;
          try {
            const contact = await findContactByPhone(from, ghlConfig);
            if (contact) {
              contactId = contact.id;
              await Promise.all([
                updateContactFields(contact.id, [{ key: 'next_contact_at', value: scheduledDatetime }], ghlConfig),
                addContactTags(contact.id, ['scheduled_call_set', 'engaged_sms'], ghlConfig),
              ]);
            }
          } catch (e) {
            console.warn(`[${ENDPOINT}] WARN: GHL schedule update failed: ${e.message}`);
          }

          // Schedula via QStash per chiamare il lead al datetime esatto
          if (contactId) {
            try {
              const unixTimestamp = Math.floor(scheduledAt.getTime() / 1000);
              const targetUrl = qstashCallbackUrl('/api/webhook/execute-scheduled-call');
              const messageId = await schedulePost(targetUrl, { phone: from, contact_id: contactId, vertical }, unixTimestamp);
              const msgTtl = Math.max(3600, secondsUntil + 3600);
              await redis.set(`qstash_message_id:${from}`, messageId, { ex: msgTtl });
              console.log(`[incoming-sms] QStash scheduled message_id=${messageId} for_datetime=${scheduledDatetime} unix=${unixTimestamp}`);
            } catch (e) {
              console.warn(`[${ENDPOINT}] WARN: QStash scheduling failed: ${e.message}`);
            }
          } else {
            console.warn(`[${ENDPOINT}] WARN: contact_id non disponibile — QStash scheduling saltato`);
          }

          console.log(`[${ENDPOINT}] Action taken: schedule_confirmed`);
        } else {
          console.warn(`[${ENDPOINT}] WARN: scheduled_datetime non valido ("${scheduledDatetime}") — trattato come null`);
          console.log(`[${ENDPOINT}] Action taken: schedule_clarification_requested`);
        }
      } else {
        // LLM ha restituito intent=schedule ma senza orario — ha già chiesto chiarimento
        try {
          const contact = await findContactByPhone(from, ghlConfig);
          if (contact) await addContactTags(contact.id, ['scheduling_in_progress'], ghlConfig);
        } catch (e) {
          console.warn(`[${ENDPOINT}] WARN: GHL tag failed: ${e.message}`);
        }
        console.log(`[${ENDPOINT}] Action taken: schedule_clarification_requested`);
      }

    } else if (intent === 'rejection') {
      try {
        const contact = await findContactByPhone(from, ghlConfig);
        if (contact) {
          await addContactTags(contact.id, ['rejected_by_lead'], ghlConfig);
          await setContactDnd(contact.id, ghlConfig);
        }
      } catch (e) {
        console.warn(`[${ENDPOINT}] WARN: GHL rejection update failed: ${e.message}`);
      }
      console.log(`[${ENDPOINT}] Lead explicitly rejected, marking as DND`);
      console.log(`[${ENDPOINT}] Action taken: rejection_handled`);

    } else {
      // qualify o info_only — aggiorna score e triggera eventuale handoff
      if (parsed && parsed.intent_score != null) {
        console.log(
          `[${ENDPOINT}] Score: ` +
          `intent=${parsed.intent_score} qualifica=${parsed.qualifica_score} ` +
          `engagement=${parsed.engagement_score} handoff=${parsed.ready_for_handoff}`
        );
        try {
          await axios.post(
            internalUrl('/api/webhook/score-update'),
            {
              phone: from,
              vertical,
              intent_score: parsed.intent_score,
              qualifica_score: parsed.qualifica_score,
              engagement_score: parsed.engagement_score,
              ready_for_handoff: parsed.ready_for_handoff,
            },
            { timeout: 10000 }
          );
        } catch (e) {
          console.warn(`[${ENDPOINT}] Errore score-update (non bloccante): ${e.message}`);
        }
      } else {
        console.warn(`[${ENDPOINT}] JSON scoring non valido — skip score-update`);
      }
      console.log(`[${ENDPOINT}] Action taken: qualify_${intent}`);
    }

    // TwiML vuoto richiesto da Twilio per confermare ricezione
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send('<Response></Response>');
  } catch (err) {
    const errTs = new Date().toISOString();
    console.error(`[${errTs}] [${ENDPOINT}] Errore:`, err.message);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
