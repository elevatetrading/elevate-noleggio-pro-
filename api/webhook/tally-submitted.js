import crypto from 'crypto';
import twilio from 'twilio';
import axios from 'axios';
import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();
const ENDPOINT = 'tally-submitted';
const GHL_BASE = 'https://services.leadconnectorhq.com';

// ─── HMAC verification ────────────────────────────────────────────────────────
// Tally firma il raw body con HMAC-SHA256 e invia la firma in X-Tally-Signature.
// Vercel parsa il body JSON prima che arrivi qui, quindi usiamo JSON.stringify
// come approssimazione. Se i byte non combaciano esattamente, disabilita la
// verifica per ora e riabilita con TALLY_WEBHOOK_SECRET dopo aver confermato
// il formato esatto usato da Tally (hex o base64).
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

// ─── Field extractor ─────────────────────────────────────────────────────────
// Restituisce una funzione get(label) → stringa | null
// Gestisce i tipi Tally più comuni (testo, scelta singola, checkbox, dropdown).
function buildFieldGetter(fields) {
  const byLabel = {};
  for (const f of fields ?? []) {
    byLabel[f.label] = f;
  }

  return function get(label) {
    const f = byLabel[label];
    if (!f) return null;

    // Scelta singola / multipla con options
    if (Array.isArray(f.options) && f.options.length > 0) {
      const selected = f.options.filter((o) => o.isSelected);
      if (selected.length === 1) return selected[0].text;
      if (selected.length > 1) return selected.map((o) => o.text).join(', ');
    }

    // Checkbox booleana (consensi)
    if (f.type === 'CHECKBOXES') {
      if (typeof f.value === 'boolean') return f.value ? 'true' : 'false';
      if (Array.isArray(f.value)) return f.value.length > 0 ? 'true' : 'false';
    }

    // Tutto il resto → valore grezzo come stringa
    if (f.value == null) return null;
    return String(f.value);
  };
}

// ─── Phone normalization ──────────────────────────────────────────────────────
// Target: E.164 italiano (+39XXXXXXXXXX)
function normalizePhone(raw) {
  if (!raw) return null;
  let n = String(raw).replace(/[\s\-().]/g, '');
  if (n.startsWith('00')) n = '+' + n.slice(2);
  if (!n.startsWith('+')) n = '+39' + n;
  return /^\+\d{10,15}$/.test(n) ? n : null;
}

// ─── Quiz score ───────────────────────────────────────────────────────────────
// Max lordo ~105, cappato a 100. Valori definiti con il cliente.
function calcQuizScore({ tipo_cliente, ha_noleggio_in_corso, urgenza, segmento_auto, km_anno, budget_mensile, scadenza_noleggio }) {
  let score = 0;

  // tipo_cliente (8–12 pt)
  if (tipo_cliente) {
    if (tipo_cliente === 'Privato') score += 8;
    else if (/P\.?IVA|partita ivа|partita iva/i.test(tipo_cliente)) score += 12;
    else if (/aziend/i.test(tipo_cliente)) score += 12;
  }

  // ha_noleggio_in_corso (5–20 pt)
  if (ha_noleggio_in_corso) {
    const v = ha_noleggio_in_corso.toLowerCase();
    if (v.includes('scadenza')) score += 20;
    else if (v.includes('lontano')) score += 5;
    else if (v.includes('mai avuto')) score += 8;
    else if (v.includes("so cos'è") || v.includes("non so cos")) score += 10;
  }

  // urgenza (3–25 pt)
  if (urgenza) {
    const v = urgenza.toLowerCase();
    if (v.includes('subito')) score += 25;
    else if (v.includes('1 e 3') || v.includes('1-3')) score += 18;
    else if (v.includes('3 e 6') || v.includes('3-6')) score += 10;
    else if (v.includes('valutando') || v.includes('valuto')) score += 3;
  }

  // segmento_auto (5–15 pt)
  if (segmento_auto) {
    const v = segmento_auto.toLowerCase();
    if (v.includes('utilitaria')) score += 5;
    else if (v.includes('berlina')) score += 8;
    else if (v.includes('suv')) score += 10;
    else if (v.includes('premium')) score += 15;
  }

  // km_anno: +5 se ha risposto (info qualifica)
  if (km_anno) score += 5;

  // budget_mensile (3–20 pt)
  if (budget_mensile) {
    if (/fino a 300/i.test(budget_mensile)) score += 5;
    else if (/tra 300|300.+500/i.test(budget_mensile)) score += 10;
    else if (/tra 500|500.+800/i.test(budget_mensile)) score += 15;
    else if (/oltre 800/i.test(budget_mensile)) score += 20;
    else if (/non ho|senza budget/i.test(budget_mensile)) score += 3;
  }

  // BONUS scadenza_noleggio (0 o +10)
  if (scadenza_noleggio && /entro 1 mese/i.test(scadenza_noleggio)) score += 10;

  return Math.min(100, score);
}

// ─── Handler ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const timestamp = new Date().toISOString();
  const log = (msg, data) =>
    data !== undefined
      ? console.log(`[${new Date().toISOString()}] [${ENDPOINT}] ${msg}`, data)
      : console.log(`[${new Date().toISOString()}] [${ENDPOINT}] ${msg}`);

  if (req.method !== 'POST') {
    log(`Metodo non consentito: ${req.method}`);
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    // Verifica firma
    if (!verifySignature(req)) {
      log('Firma HMAC non valida — richiesta rifiutata');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { eventType, data } = req.body ?? {};
    log(`Evento ricevuto: ${eventType}`);

    // Submission parziali: logga e ignora (gestione retargeting futura)
    if (eventType === 'FORM_RESPONSE_PARTIAL') {
      log('Submission parziale — skip (retargeting non ancora implementato)');
      return res.status(200).json({ ok: true, ignored: true });
    }

    if (eventType !== 'FORM_RESPONSE') {
      log(`Evento non gestito: ${eventType}`);
      return res.status(200).json({ ok: true, ignored: true });
    }

    log(`Payload Tally ricevuto (formId: ${data?.formId})`);

    // ── Estrai campi ──────────────────────────────────────────────────────
    const get = buildFieldGetter(data?.fields);

    const tipo_cliente      = get("Sei un privato, hai partita IVA o sei un'azienda?");
    const settore_attivita  = get('In che settore lavori?');
    const ha_noleggio_in_corso = get('Hai già un noleggio a lungo termine in corso?');
    const scadenza_noleggio = get('Quando scade il tuo noleggio?');
    const first_name        = get('Come ti chiami?');
    const rawPhone          = get('Numero di telefono');
    const email             = get('Email');
    const consenso_privacy  = get('Acconsento al trattamento dei miei dati personali ai sensi del GDPR (privacy policy)');
    const consenso_chiamate = get('Acconsento a essere contattato tramite chiamate automatizzate e SMS dal sistema AI di [nome concessionario]');
    const consenso_marketing = get('Acconsento all\'invio di comunicazioni commerciali e promozionali');
    const urgenza           = get('Quando ti servirebbe l\'auto?');
    const segmento_auto     = get('Che tipo di auto stai cercando?');
    const km_anno           = get('Quanti chilometri all\'anno percorri di solito?');
    const budget_mensile    = get('Hai un budget mensile orientativo?');
    const contatto_preferito = get('Come preferisci essere contattato per il preventivo?');

    // ── Valida phone ──────────────────────────────────────────────────────
    const phone = normalizePhone(rawPhone);
    if (!phone) {
      log(`Phone mancante o non valido: "${rawPhone}"`);
      return res.status(400).json({ error: 'Numero di telefono mancante o non valido' });
    }

    log(`Lead: ${first_name ?? '(nome assente)'} — phone: ${phone}`);

    // ── Calcola quiz_score ────────────────────────────────────────────────
    const quiz_score = calcQuizScore({
      tipo_cliente, ha_noleggio_in_corso, urgenza,
      segmento_auto, km_anno, budget_mensile, scadenza_noleggio,
    });
    log(`quiz_score calcolato: ${quiz_score}/100`);

    // ── Upsert contatto GHL ───────────────────────────────────────────────
    // Usa POST /contacts/upsert che crea o aggiorna per phone/email.
    // customFields accetta il formato { key, field_value } con il fieldKey
    // breve (senza prefisso "contact.") come restituito da GET /customFields.
    const customFields = [
      tipo_cliente       && { key: 'tipo_cliente',       field_value: tipo_cliente },
      settore_attivita   && { key: 'settore_attivita',   field_value: settore_attivita },
      scadenza_noleggio  && { key: 'scadenza_noleggio',  field_value: scadenza_noleggio },
      contatto_preferito && { key: 'contatto_preferito', field_value: contatto_preferito },
      urgenza            && { key: 'urgenza',            field_value: urgenza },
      segmento_auto      && { key: 'segmento_auto',      field_value: segmento_auto },
      km_anno            && { key: 'km_anno',            field_value: km_anno },
      budget_mensile     && { key: 'budget_mensile',     field_value: budget_mensile },
      consenso_privacy   && { key: 'consenso_privacy',   field_value: consenso_privacy },
      consenso_chiamate  && { key: 'consenso_chiamate',  field_value: consenso_chiamate },
      consenso_marketing && { key: 'consenso_marketing', field_value: consenso_marketing },
                           { key: 'quiz_score',          field_value: quiz_score },
    ].filter(Boolean);

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

    // ── Upstash: schedula Vapi call fallback ──────────────────────────────
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
