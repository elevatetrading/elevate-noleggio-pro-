import crypto from 'crypto';
import twilio from 'twilio';
import axios from 'axios';
import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();
const ENDPOINT = 'tally-submitted';
const GHL_BASE = 'https://services.leadconnectorhq.com';

// ─── HMAC verification ────────────────────────────────────────────────────────
// Tally firma il raw body. Vercel parsa il JSON prima di qui, quindi usiamo
// JSON.stringify come approssimazione. Disabilita TALLY_WEBHOOK_SECRET per ora
// e riabilita solo dopo aver confermato il formato esatto (hex/base64).
function verifySignature(req) {
  const secret = process.env.TALLY_WEBHOOK_SECRET;
  if (!secret) {
    console.warn(`[${ENDPOINT}] TALLY_WEBHOOK_SECRET non configurata — verifica firma skippata`);
    return true;
  }
  const signature = req.headers['x-tally-signature'];
  if (!signature) {
    console.warn(`[${ENDPOINT}] Header X-Tally-Signature assente`);
    return false;
  }
  const computed = crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(req.body))
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(computed, 'hex'));
  } catch {
    return false;
  }
}

// ─── extractFieldValue ────────────────────────────────────────────────────────
// Tally invia field.value come array di UUID per MULTIPLE_CHOICE/DROPDOWN/CHECKBOXES.
// Gli UUID vanno risolti al testo tramite field.options = [{id, text}].
// Per campi testuali, restituisce field.value direttamente.
const CHOICE_TYPES = new Set(['MULTIPLE_CHOICE', 'DROPDOWN', 'RANKING']);
const CHECKBOX_TYPES = new Set(['CHECKBOXES']);
const TEXT_TYPES = new Set([
  'INPUT_TEXT', 'TEXTAREA', 'INPUT_EMAIL',
  'INPUT_PHONE_NUMBER', 'INPUT_NUMBER', 'INPUT_DATE', 'INPUT_LINK',
]);

function extractFieldValue(field) {
  const { type, value, options = [], label } = field;

  if (CHOICE_TYPES.has(type)) {
    const uuids = Array.isArray(value) ? value : (value ? [value] : []);
    if (uuids.length === 0) return null;

    const texts = uuids.map((uuid) => {
      const opt = options.find((o) => o.id === uuid);
      if (!opt) {
        console.warn(`[${ENDPOINT}] WARN: option not found for uuid=${uuid} in field="${label}"`);
        return uuid; // fallback: tieni UUID grezzo
      }
      return opt.text;
    });

    return texts.length === 1 ? texts[0] : texts.join(', ');
  }

  if (CHECKBOX_TYPES.has(type)) {
    // Checkbox di consenso: value è array di UUID delle opzioni spuntate
    // Array non vuoto → spuntato → true, array vuoto/null → false
    if (Array.isArray(value)) return value.length > 0;
    return Boolean(value);
  }

  if (TEXT_TYPES.has(type)) {
    return value ?? null;
  }

  // Tipo non gestito esplicitamente: ritorna as-is con warning
  console.warn(`[${ENDPOINT}] WARN: tipo non gestito "${type}" per field="${label}", ritorno value grezzo`);
  return value ?? null;
}

// ─── buildFieldGetter ─────────────────────────────────────────────────────────
// Restituisce get(label) → valore estratto e loggato.
function buildFieldGetter(fields) {
  const byLabel = {};
  for (const f of fields ?? []) {
    byLabel[f.label] = f;
  }

  return function get(label) {
    const f = byLabel[label];
    if (!f) return null;

    const extracted = extractFieldValue(f);
    console.log(
      `[${ENDPOINT}] Field "${label}" type=${f.type} ` +
      `raw_value=${JSON.stringify(f.value)} extracted=${JSON.stringify(extracted)}`
    );
    return extracted;
  };
}

// ─── Phone normalization ──────────────────────────────────────────────────────
function normalizePhone(raw) {
  if (!raw) return null;
  let n = String(raw).replace(/[\s\-().]/g, '');
  if (n.startsWith('00')) n = '+' + n.slice(2);
  if (!n.startsWith('+')) n = '+39' + n;
  return /^\+\d{10,15}$/.test(n) ? n : null;
}

// ─── Quiz score ───────────────────────────────────────────────────────────────
// Opera SEMPRE su stringhe di testo risolte, mai su UUID.
// Max lordo ~105, cappato a 100.
function calcQuizScore({ tipo_cliente, ha_noleggio_in_corso, urgenza, segmento_auto, km_anno, budget_mensile, scadenza_noleggio }) {
  let score = 0;

  // tipo_cliente (8–12 pt)
  if (tipo_cliente && typeof tipo_cliente === 'string') {
    if (tipo_cliente === 'Privato') score += 8;
    else if (/P\.?IVA|partita\s*iva/i.test(tipo_cliente)) score += 12;
    else if (/aziend/i.test(tipo_cliente)) score += 12;
  }

  // ha_noleggio_in_corso (5–20 pt)
  if (ha_noleggio_in_corso && typeof ha_noleggio_in_corso === 'string') {
    const v = ha_noleggio_in_corso.toLowerCase();
    if (v.includes('scadenza')) score += 20;
    else if (v.includes('lontano')) score += 5;
    else if (v.includes('mai avuto')) score += 8;
    else if (v.includes("so cos'è") || v.includes('non so cos')) score += 10;
  }

  // urgenza (3–25 pt)
  if (urgenza && typeof urgenza === 'string') {
    const v = urgenza.toLowerCase();
    if (v.includes('subito')) score += 25;
    else if (v.includes('1 e 3') || v.includes('1-3')) score += 18;
    else if (v.includes('3 e 6') || v.includes('3-6')) score += 10;
    else if (v.includes('valutando') || v.includes('valuto')) score += 3;
  }

  // segmento_auto (5–15 pt)
  if (segmento_auto && typeof segmento_auto === 'string') {
    const v = segmento_auto.toLowerCase();
    if (v.includes('utilitaria')) score += 5;
    else if (v.includes('berlina')) score += 8;
    else if (v.includes('suv')) score += 10;
    else if (v.includes('premium')) score += 15;
  }

  // km_anno: +5 se ha risposto (info qualifica)
  if (km_anno) score += 5;

  // budget_mensile (3–20 pt)
  if (budget_mensile && typeof budget_mensile === 'string') {
    if (/fino a 300/i.test(budget_mensile)) score += 5;
    else if (/tra 300|300.+500/i.test(budget_mensile)) score += 10;
    else if (/tra 500|500.+800/i.test(budget_mensile)) score += 15;
    else if (/oltre 800/i.test(budget_mensile)) score += 20;
    else if (/non ho|senza budget/i.test(budget_mensile)) score += 3;
  }

  // BONUS scadenza_noleggio (+10)
  if (scadenza_noleggio && typeof scadenza_noleggio === 'string' && /entro 1 mese/i.test(scadenza_noleggio)) {
    score += 10;
  }

  return Math.min(100, score);
}

// ─── Handler ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const timestamp = new Date().toISOString();
  const log = (msg) => console.log(`[${new Date().toISOString()}] [${ENDPOINT}] ${msg}`);

  if (req.method !== 'POST') {
    log(`Metodo non consentito: ${req.method}`);
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    // Log completo per debug (rimuovere in produzione stabile)
    console.log(`[${ENDPOINT}] FULL PAYLOAD:`, JSON.stringify(req.body, null, 2));

    if (!verifySignature(req)) {
      log('Firma HMAC non valida — richiesta rifiutata');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { eventType, data } = req.body ?? {};
    log(`Evento ricevuto: ${eventType}`);

    if (eventType === 'FORM_RESPONSE_PARTIAL') {
      log('Submission parziale — skip (retargeting non ancora implementato)');
      return res.status(200).json({ ok: true, ignored: true });
    }

    if (eventType !== 'FORM_RESPONSE') {
      log(`Evento non gestito: ${eventType}`);
      return res.status(200).json({ ok: true, ignored: true });
    }

    log(`formId: ${data?.formId} — responseId: ${data?.responseId}`);

    // ── Estrai campi (UUID → testo) ───────────────────────────────────────
    const get = buildFieldGetter(data?.fields);

    const tipo_cliente        = get("Sei un privato, hai partita IVA o sei un'azienda?");
    const settore_attivita    = get('In che settore lavori?');
    const ha_noleggio_in_corso = get('Hai già un noleggio a lungo termine in corso?');
    const scadenza_noleggio   = get('Quando scade il tuo noleggio?');
    const first_name          = get('Come ti chiami?');
    const rawPhone            = get('Numero di telefono');
    const email               = get('Email');
    const urgenza             = get("Quando ti servirebbe l'auto?");
    const segmento_auto       = get('Che tipo di auto stai cercando?');
    const km_anno             = get('Quanti chilometri all\'anno percorri di solito?');
    const budget_mensile      = get('Hai un budget mensile orientativo?');
    const contatto_preferito  = get('Come preferisci essere contattato per il preventivo?');

    // Consensi: estratti come boolean (true/false), non stringa
    const consenso_privacy    = get('Acconsento al trattamento dei miei dati personali ai sensi del GDPR (privacy policy)');
    const consenso_chiamate   = get("Acconsento a essere contattato tramite chiamate automatizzate e SMS dal sistema AI di [nome concessionario]");
    const consenso_marketing  = get("Acconsento all'invio di comunicazioni commerciali e promozionali");

    // ── Valida phone ──────────────────────────────────────────────────────
    const phone = normalizePhone(rawPhone);
    if (!phone) {
      log(`Phone mancante o non valido: "${rawPhone}"`);
      return res.status(400).json({ error: 'Numero di telefono mancante o non valido' });
    }

    log(`Lead: ${first_name ?? '(nome assente)'} — phone: ${phone}`);

    // ── Calcola quiz_score su valori testuali risolti ─────────────────────
    const quiz_score = calcQuizScore({
      tipo_cliente, ha_noleggio_in_corso, urgenza,
      segmento_auto, km_anno, budget_mensile, scadenza_noleggio,
    });
    log(`quiz_score: ${quiz_score}/100`);

    // ── Componi customFields (skip se null, skip durata_mesi) ─────────────
    // durata_mesi non è presente nel form Tally — non includere per evitare
    // di sovrascrivere il placeholder "Es. 12" già visto in produzione.
    const customFields = [
      tipo_cliente        != null && { key: 'tipo_cliente',        field_value: tipo_cliente },
      settore_attivita    != null && { key: 'settore_attivita',    field_value: settore_attivita },
      scadenza_noleggio   != null && { key: 'scadenza_noleggio',   field_value: scadenza_noleggio },
      contatto_preferito  != null && { key: 'contatto_preferito',  field_value: contatto_preferito },
      urgenza             != null && { key: 'urgenza',             field_value: urgenza },
      segmento_auto       != null && { key: 'segmento_auto',       field_value: segmento_auto },
      km_anno             != null && { key: 'km_anno',             field_value: km_anno },
      budget_mensile      != null && { key: 'budget_mensile',      field_value: budget_mensile },
      // Consensi come boolean (tipo Checkbox in GHL)
      consenso_privacy    != null && { key: 'consenso_privacy',    field_value: consenso_privacy },
      consenso_chiamate   != null && { key: 'consenso_chiamate',   field_value: consenso_chiamate },
      consenso_marketing  != null && { key: 'consenso_marketing',  field_value: consenso_marketing },
      // quiz_score sempre presente
                                     { key: 'quiz_score',          field_value: quiz_score },
    ].filter(Boolean);

    log(`customFields payload GHL: ${JSON.stringify(customFields)}`);

    // ── Upsert contatto GHL ───────────────────────────────────────────────
    const upsertPayload = {
      locationId: process.env.GHL_LOCATION_ID,
      ...(first_name && { firstName: first_name }),
      phone,
      ...(email && { email }),
      tags: ['src:tally'],
      customFields,
    };

    log('Upsert GHL in corso…');
    const { data: ghlData } = await axios.post(
      `${GHL_BASE}/contacts/upsert`,
      upsertPayload,
      {
        headers: {
          Authorization: `Bearer ${process.env.GHL_API_KEY}`,
          'Content-Type': 'application/json',
          Version: '2021-07-28',
        },
      }
    );

    const contactId = ghlData?.contact?.id ?? ghlData?.id;
    log(`Contatto GHL upserted — contactId: ${contactId}`);

    // ── SMS apertura ──────────────────────────────────────────────────────
    const greeting = first_name ? `Ciao ${first_name}!` : 'Ciao!';
    const smsBody =
      `${greeting} Sono Sara di AutoExperience. Hai appena compilato il quiz sul noleggio. ` +
      `Posso farti un paio di domande veloci per capire come posso aiutarti?`;

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
      log(`SMS inviato — sid: ${sms.sid}`);
    } catch (smsErr) {
      console.error(`[${new Date().toISOString()}] [${ENDPOINT}] Errore SMS (non bloccante):`, smsErr.message);
    }

    // ── Upstash: schedula Vapi call fallback (TTL 600s) ───────────────────
    const redisKey = `vapi_pending:${phone}`;
    await redis.set(
      redisKey,
      JSON.stringify({
        timestamp,
        customerData: { first_name, phone, tipo_cliente, km_anno, segmento_auto, urgenza },
      }),
      { ex: 600 }
    );
    log(`Redis: "${redisKey}" salvata con TTL 600s`);

    return res.status(200).json({ ok: true, contact_created: true, quiz_score, contactId });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [${ENDPOINT}] Errore:`, err.message, err.stack);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
