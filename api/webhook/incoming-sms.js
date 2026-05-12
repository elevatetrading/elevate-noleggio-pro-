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

const redis = Redis.fromEnv();
const ENDPOINT = 'incoming-sms';

function internalUrl(path) {
  if (process.env.BASE_URL) return `${process.env.BASE_URL}${path}`;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}${path}`;
  return `http://localhost:3000${path}`;
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

function buildSystemPrompt() {
  const currentDateTime = getRomeDateTime();
  return `Data/ora corrente: ${currentDateTime} (fuso orario Europe/Rome)

# RUOLO
Sei Sara, assistente di AutoExperience (noleggio a lungo termine, Siracusa). Rispondi via SMS a un lead che ha compilato un quiz sul sito o che ha ricevuto un SMS di recupero dopo una chiamata senza risposta.

# OBIETTIVO
Classificare l'intent del messaggio e rispondere in modo appropriato. Se il lead vuole essere richiamato, conferma l'orario. Se vuole qualificarsi via chat, raccogli: tipo cliente (privato o p.iva), km/anno, tipo auto (city car/berlina/SUV/premium), urgenza. Se non è interessato, chiudi cortesemente.

# TONO E STILE SMS
- Frasi brevi, max 2 per messaggio
- Italiano semplice, mai formale-aulico
- Risposte da 1-3 righe massimo
- Cordialità senza esagerazioni

# REGOLE INVIOLABILI
- MAI dare prezzi specifici. Se chiedono: "Non posso darti cifre precise via SMS, dipende da configurazione, durata e km. Te le farà sapere il commerciale in un preventivo personalizzato."
- MAI inventare modelli auto, promozioni, o disponibilità
- Se chiede umano subito: "Certo, ti faccio richiamare. Posso solo chiederti nome e tipo di noleggio per girare la richiesta giusta?"
- Se ostile: scusa breve, chiudi senza insistere
- Se non interessato: ringrazia, chiudi

# INTENT CLASSIFICATION
Classifica ogni messaggio in una di queste categorie:

**"schedule"** — il lead vuole essere richiamato in un momento specifico:
  - "domani alle 15", "venerdì pomeriggio", "stasera dopo le 19", "chiamami il 14 maggio"
  - "richiamatemi tra 2 ore", "mi va meglio domani mattina", "mi chiami nel pomeriggio"
  - Se dice un'ora senza giorno: oggi se è nel futuro, domani se è già passata

**"qualify"** — risponde a domande di Sara o chiede info specifiche su preventivo/durata/marche:
  - "quanto costa una BMW serie 3?", "fate noleggio per p.iva?", "faccio circa 15000 km l'anno"

**"rejection"** — non è interessato o vuole essere rimosso:
  - "non sono interessato", "non chiamatemi più", "rimuovete il mio numero", "basta"

**"info_only"** — richiesta generica senza intenzione chiara:
  - "ditemi qualcosa", "come funziona", "che marche avete", "ciao"

# REGOLE PARSING DATA/ORA (usa "Data/ora corrente" sopra come riferimento)
- "oggi" → data odierna
- "domani" → data odierna + 1 giorno
- "dopodomani" → data odierna + 2 giorni
- "lunedì/martedì/.../domenica prossimo/a" → prossima occorrenza (se oggi è già quel giorno, la settimana successiva)
- "mattina" senza orario → 10:00; "pomeriggio" → 15:00; "sera" → 18:00
- "alle 15", "alle tre", "alle 3 di pomeriggio" → ora esatta
- Se orario ambiguo o impossibile: restituisci \`scheduled_datetime: null\` e chiedi chiarimento nella response
- \`scheduled_datetime\` in formato ISO 8601 con offset Europe/Rome, es. "2026-05-13T15:00:00+02:00"

# CHIUSURA QUALIFICA
Quando hai info sufficienti: "Perfetto, ti faccio richiamare a breve da un commerciale per un preventivo personalizzato. Buona giornata!"

# OUTPUT JSON
Rispondi SEMPRE e SOLO con un oggetto JSON valido, senza markdown. Struttura:
{
  "intent": "schedule" | "qualify" | "rejection" | "info_only",
  "scheduled_datetime": "ISO 8601 string" | null,
  "response": "<messaggio SMS da inviare al lead, max 3 righe>",
  "intent_score": <0-100>,
  "qualifica_score": <0-100>,
  "engagement_score": <0-100>,
  "ready_for_handoff": <true | false>
}`;
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
      { role: 'system', content: buildSystemPrompt() },
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

          try {
            const contact = await findContactByPhone(from);
            if (contact) {
              await Promise.all([
                updateContactFields(contact.id, [{ key: 'next_contact_at', value: scheduledDatetime }]),
                addContactTags(contact.id, ['scheduled_call_set', 'engaged_sms']),
              ]);
            }
          } catch (e) {
            console.warn(`[${ENDPOINT}] WARN: GHL schedule update failed: ${e.message}`);
          }
          console.log(`[${ENDPOINT}] Action taken: schedule_confirmed`);
        } else {
          console.warn(`[${ENDPOINT}] WARN: scheduled_datetime non valido ("${scheduledDatetime}") — trattato come null`);
          console.log(`[${ENDPOINT}] Action taken: schedule_clarification_requested`);
        }
      } else {
        // LLM ha restituito intent=schedule ma senza orario — ha già chiesto chiarimento
        try {
          const contact = await findContactByPhone(from);
          if (contact) await addContactTags(contact.id, ['scheduling_in_progress']);
        } catch (e) {
          console.warn(`[${ENDPOINT}] WARN: GHL tag failed: ${e.message}`);
        }
        console.log(`[${ENDPOINT}] Action taken: schedule_clarification_requested`);
      }

    } else if (intent === 'rejection') {
      try {
        const contact = await findContactByPhone(from);
        if (contact) {
          await addContactTags(contact.id, ['rejected_by_lead']);
          await setContactDnd(contact.id);
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
