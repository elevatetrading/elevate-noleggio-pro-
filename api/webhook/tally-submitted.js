import crypto from 'crypto';
import { Redis } from '@upstash/redis';
import { normalizePhone, mapChannel, resolveChannelState, executeChannelAction } from '../../lib/channel-actions.js';
import { upsertContact } from '../../lib/ghl.js';
import { getConfig } from '../../lib/verticals.js';

const redis = Redis.fromEnv();
const ENDPOINT = 'tally-submitted';

// ─── HMAC verification ────────────────────────────────────────────────────────
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
        return uuid;
      }
      return opt.text;
    });
    return texts.length === 1 ? texts[0] : texts.join(', ');
  }

  if (CHECKBOX_TYPES.has(type)) {
    if (Array.isArray(value)) return value.length > 0;
    return Boolean(value);
  }

  if (TEXT_TYPES.has(type)) {
    return value ?? null;
  }

  console.warn(`[${ENDPOINT}] WARN: tipo non gestito "${type}" per field="${label}", ritorno value grezzo`);
  return value ?? null;
}

// ─── buildFieldGetter ─────────────────────────────────────────────────────────
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

// ─── extractConsents ──────────────────────────────────────────────────────────
function extractConsents(fields) {
  const result = { consenso_privacy: null, consenso_chiamate: null, consenso_marketing: null };
  for (const f of fields ?? []) {
    if (f.type !== 'CHECKBOXES' || f.label !== null) continue;
    const optionText = f.options?.[0]?.text ?? '';
    const t = optionText.toLowerCase();
    const boolValue = Array.isArray(f.value) && f.value.length > 0;
    let consensoKey = null;
    if (t.includes('trattamento') || t.includes('gdpr') || t.includes('privacy policy')) {
      consensoKey = 'consenso_privacy';
    } else if (t.includes('chiamate automatizzate') || t.includes('sistema ai') || t.includes('sms dal sistema')) {
      consensoKey = 'consenso_chiamate';
    } else if (t.includes('comunicazioni commerciali') || t.includes('promozionali') || t.includes('marketing')) {
      consensoKey = 'consenso_marketing';
    }
    if (consensoKey) {
      result[consensoKey] = boolValue;
      console.log(
        `[tally-submitted] Consenso detected key="${consensoKey}" ` +
        `from option_text="${optionText.substring(0, 80)}..." value=${boolValue}`
      );
    } else {
      console.warn(
        `[tally-submitted] WARN: CHECKBOXES con label null non riconosciuto come consenso, ` +
        `option_text="${optionText}"`
      );
    }
  }
  return result;
}

// ─── Quiz score ───────────────────────────────────────────────────────────────
function calcQuizScore({ tipo_cliente, ha_noleggio_in_corso, urgenza, segmento_auto, km_anno, budget_mensile, scadenza_noleggio }) {
  let score = 0;

  if (tipo_cliente && typeof tipo_cliente === 'string') {
    if (tipo_cliente === 'Privato') score += 8;
    else if (/P\.?IVA|partita\s*iva/i.test(tipo_cliente)) score += 12;
    else if (/aziend/i.test(tipo_cliente)) score += 12;
  }

  if (ha_noleggio_in_corso && typeof ha_noleggio_in_corso === 'string') {
    const v = ha_noleggio_in_corso.toLowerCase();
    if (v.includes('scadenza')) score += 20;
    else if (v.includes('lontano')) score += 5;
    else if (v.includes('mai avuto')) score += 8;
    else if (v.includes("so cos'è") || v.includes('non so cos')) score += 10;
  }

  if (urgenza && typeof urgenza === 'string') {
    const v = urgenza.toLowerCase();
    if (v.includes('subito')) score += 25;
    else if (v.includes('1 e 3') || v.includes('1-3')) score += 18;
    else if (v.includes('3 e 6') || v.includes('3-6')) score += 10;
    else if (v.includes('valutando') || v.includes('valuto')) score += 3;
  }

  if (segmento_auto && typeof segmento_auto === 'string') {
    const v = segmento_auto.toLowerCase();
    if (v.includes('utilitaria')) score += 5;
    else if (v.includes('berlina')) score += 8;
    else if (v.includes('suv')) score += 10;
    else if (v.includes('premium')) score += 15;
  }

  if (km_anno) score += 5;

  if (budget_mensile && typeof budget_mensile === 'string') {
    if (/fino a 300/i.test(budget_mensile)) score += 5;
    else if (/tra 300|300.+500/i.test(budget_mensile)) score += 10;
    else if (/tra 500|500.+800/i.test(budget_mensile)) score += 15;
    else if (/oltre 800/i.test(budget_mensile)) score += 20;
    else if (/non ho|senza budget/i.test(budget_mensile)) score += 3;
  }

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

    // Leggi vertical dal payload (può essere passato come campo nascosto nel form Tally)
    const vertical = req.body?.vertical ?? data?.vertical ?? 'noleggio';
    const config = getConfig(vertical);
    const ghlConfig = { apiKey: config.ghl_api_key, locationId: config.ghl_location_id };

    log(`formId: ${data?.formId} — responseId: ${data?.responseId} — vertical: ${vertical}`);

    // ── Estrai campi (UUID → testo) ───────────────────────────────────────
    const get = buildFieldGetter(data?.fields);

    const tipo_cliente         = get("Sei un privato, hai partita IVA o sei un'azienda?");
    const settore_attivita     = get('In che settore lavori?');
    const ha_noleggio_in_corso = get('Hai già un noleggio a lungo termine in corso?');
    const scadenza_noleggio    = get('Quando scade il tuo noleggio?');
    const first_name           = get('Come ti chiami?');
    const rawPhone             = get('Numero di telefono');
    const email                = get('Email');
    const urgenza              = get("Quando ti servirebbe l'auto?");
    const segmento_auto        = get('Che tipo di auto stai cercando?');
    const km_anno              = get('Quanti chilometri all\'anno percorri di solito?');
    const budget_mensile       = get('Hai un budget mensile orientativo?');
    const contatto_preferito   = get('Come preferisci essere contattato per il preventivo?');

    const { consenso_privacy, consenso_chiamate, consenso_marketing } = extractConsents(data?.fields);

    // ── Valida phone ──────────────────────────────────────────────────────
    const phone = normalizePhone(rawPhone);
    if (!phone) {
      log(`Phone mancante o non valido: "${rawPhone}"`);
      return res.status(400).json({ error: 'Numero di telefono mancante o non valido' });
    }

    log(`Lead: ${first_name ?? '(nome assente)'} — phone: ${phone}`);

    // ── Quiz score ────────────────────────────────────────────────────────
    const quiz_score = calcQuizScore({
      tipo_cliente, ha_noleggio_in_corso, urgenza,
      segmento_auto, km_anno, budget_mensile, scadenza_noleggio,
    });
    log(`quiz_score: ${quiz_score}/100`);

    // ── Routing canale ────────────────────────────────────────────────────
    const { primary, whatsappDegraded, unknownChannel } = mapChannel(contatto_preferito);
    if (unknownChannel) log(`WARN: contatto_preferito non riconosciuto "${contatto_preferito}" → default sms`);
    const { channelStatus, actionTaken, scheduledFor } = resolveChannelState(primary);
    const channelTag = primary === 'call' ? 'channel:phone' : 'channel:sms';
    log(`Canale: ${primary} — action: ${actionTaken} — tag: ${channelTag}`);

    // ── Componi customFields ──────────────────────────────────────────────
    const customFields = [
      tipo_cliente        != null && { key: 'tipo_cliente',        field_value: tipo_cliente },
      settore_attivita    != null && { key: 'settore_attivita',    field_value: settore_attivita },
      scadenza_noleggio   != null && { key: 'scadenza_noleggio',   field_value: scadenza_noleggio },
      contatto_preferito  != null && { key: 'contatto_preferito',  field_value: contatto_preferito },
      urgenza             != null && { key: 'urgenza',             field_value: urgenza },
      segmento_auto       != null && { key: 'segmento_auto',       field_value: segmento_auto },
      km_anno             != null && { key: 'km_anno',             field_value: km_anno },
      budget_mensile      != null && { key: 'budget_mensile',      field_value: budget_mensile },
      consenso_privacy    != null && { key: 'consenso_privacy',    field_value: consenso_privacy    ? 'Sì' : 'No' },
      consenso_chiamate   != null && { key: 'consenso_chiamate',   field_value: consenso_chiamate   ? 'Sì' : 'No' },
      consenso_marketing  != null && { key: 'consenso_marketing',  field_value: consenso_marketing  ? 'Sì' : 'No' },
                                     { key: 'quiz_score',          field_value: quiz_score },
                                     { key: 'channel_status',      field_value: channelStatus },
      scheduledFor != null &&        { key: 'next_contact_at',     field_value: scheduledFor.toISOString() },
    ].filter(Boolean);

    log(`customFields payload GHL: ${JSON.stringify(customFields)}`);

    // ── Upsert contatto GHL ───────────────────────────────────────────────
    const upsertPayload = {
      locationId: config.ghl_location_id,
      ...(first_name && { firstName: first_name }),
      phone,
      ...(email && { email }),
      tags: ['src:tally', channelTag],
      customFields,
    };

    const { contactId } = await upsertContact(upsertPayload, phone, ghlConfig);

    if (whatsappDegraded) {
      log(`WARN: WhatsApp request degraded to SMS, contact_id=${contactId}`);
    }

    // ── Azione immediata in base al canale ────────────────────────────────
    const smsOpeningBody =
      `${first_name ? `Ciao ${first_name}!` : 'Ciao!'} Sono Sara di AutoExperience. ` +
      `Hai appena compilato il quiz sul noleggio. Posso farti un paio di domande veloci per capire come posso aiutarti?`;
    await executeChannelAction({
      primary,
      actionTaken,
      phone,
      firstName: first_name,
      scheduledFor,
      smsOpeningBody,
      smsCourtesyIntro: 'grazie per aver compilato il quiz!',
      vapiVariables: { first_name, tipo_cliente, km_anno, segmento_auto, urgenza },
      vapiAssistantId: config.vapi_assistant_id,
      endpoint: ENDPOINT,
      log,
    });

    // ── Redis: chiave fallback usata dal workflow GHL dopo 30 min ─────────
    const redisKey = `fallback_pending:${phone}`;
    await redis.set(
      redisKey,
      JSON.stringify({
        primary,
        ...(scheduledFor && { scheduledFor: scheduledFor.toISOString() }),
        contact_id: contactId,
        vertical,
        timestamp,
      }),
      { ex: 86400 }
    );
    log(`Redis: "${redisKey}" salvata con TTL 86400s`);

    return res.status(200).json({
      ok: true,
      contact_created: true,
      contactId,
      primary_channel: primary,
      action_taken: actionTaken,
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [${ENDPOINT}] Errore:`, err.message, err.stack);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
