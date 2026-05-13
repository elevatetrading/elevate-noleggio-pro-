import { Redis } from '@upstash/redis';
import {
  normalizePhone,
  mapChannel,
  resolveChannelState,
  executeChannelAction,
} from '../../lib/channel-actions.js';
import { upsertContact } from '../../lib/ghl.js';

const redis = Redis.fromEnv();
const ENDPOINT = 'landing-contact';

const ALLOWED_ORIGINS = [
  'https://autoexperience.vercel.app',
  'https://elevate-noleggio-pro.vercel.app',
];

function setCorsHeaders(req, res) {
  const origin = req.headers['origin'];
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else if (!origin) {
    // Server-to-server call — nessun header CORS necessario
  } else {
    // Origin non in lista — riflettiamo comunque per non bloccare test locali,
    // ma logghiamo il warning
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email ?? ''));
}

export default async function handler(req, res) {
  setCorsHeaders(req, res);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  const timestamp = new Date().toISOString();
  const log = (msg) => console.log(`[${new Date().toISOString()}] [${ENDPOINT}] ${msg}`);

  if (req.method !== 'POST') {
    log(`Metodo non consentito: ${req.method}`);
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const {
      first_name, last_name, phone: rawPhone, email, preferred_channel,
      tipo_cliente, km_anno, segmento_auto, urgenza, durata_mesi,
    } = req.body ?? {};

    // ── Unico campo obbligatorio: phone ───────────────────────────────────
    if (!rawPhone) {
      return res.status(400).json({ error: 'Campo obbligatorio mancante: phone' });
    }

    const phone = normalizePhone(rawPhone);
    if (!phone) {
      return res.status(400).json({ error: `Numero di telefono non valido: "${rawPhone}"` });
    }

    // Campi opzionali con default
    const firstName = first_name ? String(first_name).trim() : '';
    const explicitLastName = last_name ? String(last_name).trim() : '';
    const lastName = explicitLastName || (() => {
      const digits = phone.replace(/\D/g, '');
      const generated = digits.slice(-7);
      log(`last_name generato: ${generated}`);
      return generated;
    })();
    const channel   = preferred_channel ?? 'phone';

    if (email && !isValidEmail(email)) {
      return res.status(400).json({ error: `Email non valida: "${email}"` });
    }

    const origin = req.headers['origin'] ?? 'direct';
    if (origin !== 'direct' && !ALLOWED_ORIGINS.includes(origin)) {
      log(`WARN: origin non in whitelist "${origin}"`);
    }

    log(`Richiesta — phone: ${phone} first_name: ${firstName || '(assente)'} canale: ${channel} origin: ${origin}`);

    // ── Routing canale ────────────────────────────────────────────────────
    const { primary, whatsappDegraded, unknownChannel } = mapChannel(channel);
    if (unknownChannel) log(`WARN: preferred_channel non riconosciuto "${channel}" → default sms`);
    const { channelStatus, actionTaken, scheduledFor } = resolveChannelState(primary);
    const channelTag = primary === 'call' ? 'channel:phone' : 'channel:sms';
    log(`Canale: ${primary} — action: ${actionTaken} — tag: ${channelTag}`);

    // ── Upsert contatto GHL ───────────────────────────────────────────────
    const customFields = [
      { key: 'contatto_preferito', field_value: channel },
      { key: 'channel_status',     field_value: channelStatus },
      scheduledFor  && { key: 'next_contact_at', field_value: scheduledFor.toISOString() },
      tipo_cliente  && { key: 'tipo_cliente',    field_value: tipo_cliente },
      km_anno       && { key: 'km_anno',         field_value: String(km_anno) },
      segmento_auto && { key: 'segmento_auto',   field_value: segmento_auto },
      urgenza       && { key: 'urgenza',         field_value: urgenza },
      durata_mesi   && { key: 'durata_mesi',     field_value: String(durata_mesi) },
    ].filter(Boolean);

    const upsertPayload = {
      locationId: process.env.GHL_LOCATION_ID,
      ...(firstName && { firstName }),
      lastName,
      phone,
      ...(email && { email }),
      tags: ['src:landing', channelTag],
      customFields,
    };

    const { contactId } = await upsertContact(upsertPayload, phone);

    if (whatsappDegraded) {
      log(`WARN: WhatsApp request degraded to SMS, contact_id=${contactId}`);
    }

    // ── Azione immediata in base al canale ────────────────────────────────
    const displayName = firstName || 'Cliente';
    const smsOpeningBody =
      `Ciao ${displayName}! Sono Sara di AutoExperience, ricevo la tua richiesta di contatto. ` +
      `Per consigliarti meglio, posso farti qualche domanda veloce sul tuo noleggio?`;
    await executeChannelAction({
      primary,
      actionTaken,
      phone,
      firstName: displayName,
      scheduledFor,
      smsOpeningBody,
      smsCourtesyIntro: 'grazie per la tua richiesta di contatto!',
      vapiVariables: { first_name: displayName },
      endpoint: ENDPOINT,
      log,
    });

    // ── Redis: chiave fallback per GHL Workflow dopo 30 min ───────────────
    const redisKey = `fallback_pending:${phone}`;
    await redis.set(
      redisKey,
      JSON.stringify({
        primary,
        ...(scheduledFor && { scheduledFor: scheduledFor.toISOString() }),
        contact_id: contactId,
        timestamp,
      }),
      { ex: 86400 }
    );
    log(`Redis: "${redisKey}" salvata con TTL 86400s`);

    return res.status(200).json({
      ok: true,
      contact_id: contactId,
      primary_channel: primary,
      action_taken: actionTaken,
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [${ENDPOINT}] Errore:`, err.message, err.stack);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
