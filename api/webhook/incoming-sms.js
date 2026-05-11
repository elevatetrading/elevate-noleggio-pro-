import twilio from 'twilio';
import OpenAI from 'openai';
import { URLSearchParams } from 'url';
import { Redis } from '@upstash/redis';
import axios from 'axios';

const redis = Redis.fromEnv();
const ENDPOINT = 'incoming-sms';

function internalUrl(path) {
  if (process.env.BASE_URL) return `${process.env.BASE_URL}${path}`;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}${path}`;
  return `http://localhost:3000${path}`;
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

const CHAT_SETTER_PROMPT = `# RUOLO
Sei Sara, assistente di AutoExperience (noleggio a lungo termine, Siracusa). Rispondi via SMS a un lead che ha compilato un quiz sul sito.

# OBIETTIVO
Qualificare il lead in 4-5 messaggi raccogliendo: tipo cliente (privato o partita IVA), km/anno percorsi, tipo auto (city car/berlina/SUV/premium), urgenza. Se interessato e qualificato, proporre richiamo da un commerciale umano.

# TONO E STILE SMS
- Frasi brevi, max 2 per messaggio
- Italiano semplice, mai formale-aulico
- Mai usare paragrafi lunghi
- Risposte da 1-3 righe massimo
- Cordialità senza esagerazioni

# REGOLE INVIOLABILI
- MAI dare prezzi specifici. Se chiedono: "Non posso darti cifre precise via SMS, dipende da configurazione, durata e km. Te le farà sapere il commerciale in un preventivo personalizzato."
- MAI inventare modelli auto, promozioni, o disponibilità
- MAI promettere orari specifici di richiamo
- Se chiede umano subito: "Certo, ti faccio richiamare. Posso solo chiederti nome e tipo di noleggio per girare la richiesta giusta?"
- Se ostile: scusa breve, chiudi senza insistere
- Se non interessato: ringrazia, chiudi

# CHIUSURA
Quando hai info sufficienti: "Perfetto, ti faccio richiamare a breve da un commerciale per un preventivo personalizzato. Buona giornata!"

# OUTPUT JSON
Rispondi SEMPRE e SOLO con un oggetto JSON valido, senza markdown. Struttura:
{
  "response": "<il messaggio SMS da inviare al lead, max 3 righe>",
  "intent_score": <0-100, quanto sembra deciso ad andare avanti>,
  "qualifica_score": <0-100, quanto sta fornendo informazioni utili>,
  "engagement_score": <0-100, quanto è ingaggiato nella conversazione>,
  "ready_for_handoff": <true se serve passare subito al commerciale, false altrimenti>
}`;

export default async function handler(req, res) {
  const timestamp = new Date().toISOString();

  if (req.method !== 'POST') {
    console.log(`[${timestamp}] [${ENDPOINT}] Metodo non consentito: ${req.method}`);
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    // Twilio invia application/x-www-form-urlencoded
    const raw = typeof req.body === 'string'
      ? Object.fromEntries(new URLSearchParams(req.body))
      : req.body;

    const from = raw.From;
    const incomingText = raw.Body;

    console.log(`[${timestamp}] [${ENDPOINT}] SMS da ${from}: "${incomingText}"`);

    // Il lead sta interagendo via SMS: cancella l'eventuale chiamata Vapi schedulata
    const deleted = await redis.del(`vapi_pending:${from}`);
    if (deleted) {
      console.log(`[${new Date().toISOString()}] [${ENDPOINT}] Cancelled scheduled Vapi call for ${from}`);
    }

    // Segnala che il lead è attivo — blocca il fallback endpoint per 1h
    await redis.set(`engaged:${from}`, '1', { ex: 3600 });
    console.log(`[${new Date().toISOString()}] [${ENDPOINT}] Set engaged:${from} TTL 3600s`);

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
      { role: 'system', content: CHAT_SETTER_PROMPT },
      ...history,
      { role: 'user', content: incomingText },
    ];

    console.log(`[${new Date().toISOString()}] [${ENDPOINT}] Contesto: ${history.length} messaggi precedenti`);

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.6,
      max_tokens: 300,
      messages,
    });

    const rawContent = completion.choices[0].message.content;
    console.log(`[${new Date().toISOString()}] [${ENDPOINT}] Risposta OpenAI raw: ${rawContent}`);

    // Parsing JSON — con fallback su testo puro se il formato non è valido
    const parsed = parseOpenAiJson(rawContent);
    const reply = parsed?.response ?? rawContent;

    console.log(`[${new Date().toISOString()}] [${ENDPOINT}] Risposta SMS: "${reply}"`);

    await twilioClient.messages.create({ body: reply, from: ourNumber, to: from });
    console.log(`[${new Date().toISOString()}] [${ENDPOINT}] SMS inviato a ${from}`);

    // Aggiorna score se il parsing è andato a buon fine
    if (parsed && parsed.intent_score != null) {
      console.log(
        `[${new Date().toISOString()}] [${ENDPOINT}] Score: ` +
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
        console.warn(`[${new Date().toISOString()}] [${ENDPOINT}] Errore score-update (non bloccante):`, e.message);
      }
    } else {
      console.warn(`[${new Date().toISOString()}] [${ENDPOINT}] JSON scoring non valido — skip score-update`);
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
