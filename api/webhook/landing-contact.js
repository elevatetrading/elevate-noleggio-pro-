import axios from 'axios';
import { Redis } from '@upstash/redis';
import {
  normalizePhone,
  mapChannel,
  resolveChannelState,
  executeChannelAction,
} from '../../lib/channel-actions.js';

const redis = Redis.fromEnv();
const ENDPOINT = 'landing-contact';
const GHL_BASE = 'https://services.leadconnectorhq.com';

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email ?? ''));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

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
    const { first_name, phone: rawPhone, email, preferred_channel } = req.body ?? {};

    // ── Validazione campi required ────────────────────────────────────────
    if (!first_name || !String(first_name).trim()) {
      return res.status(400).json({ error: 'Campo obbligatorio mancante: first_name' });
    }
    if (!rawPhone) {
      return res.status(400).json({ error: 'Campo obbligatorio mancante: phone' });
    }
    if (!email) {
      return res.status(400).json({ error: 'Campo obbligatorio mancante: email' });
    }
    if (!preferred_channel) {
      return res.status(400).json({ error: 'Campo obbligatorio mancante: preferred_channel' });
    }

    const firstName = String(first_name).trim();

    const phone = normalizePhone(rawPhone);
    if (!phone) {
      return res.status(400).json({ error: `Numero di telefono non valido: "${rawPhone}"` });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: `Email non valida: "${email}"` });
    }

    log(`Richiesta da ${firstName} — phone: ${phone} — canale: ${preferred_channel}`);

    // ── Routing canale ────────────────────────────────────────────────────
    const { primary, whatsappDegraded, unknownChannel } = mapChannel(preferred_channel);
    if (unknownChannel) log(`WARN: preferred_channel non riconosciuto "${preferred_channel}" → default sms`);
    const { channelStatus, actionTaken, scheduledFor } = resolveChannelState(primary);
    const channelTag = primary === 'call' ? 'channel:phone' : 'channel:sms';
    log(`Canale: ${primary} — action: ${actionTaken} — tag: ${channelTag}`);

    // ── Upsert contatto GHL ───────────────────────────────────────────────
    const customFields = [
      { key: 'contatto_preferito', field_value: preferred_channel },
      { key: 'channel_status',     field_value: channelStatus },
      scheduledFor && { key: 'next_contact_at', field_value: scheduledFor.toISOString() },
    ].filter(Boolean);

    const upsertPayload = {
      locationId: process.env.GHL_LOCATION_ID,
      firstName,
      phone,
      email,
      tags: ['src:landing', channelTag],
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

    if (whatsappDegraded) {
      log(`WARN: WhatsApp request degraded to SMS, contact_id=${contactId}`);
    }

    // ── Azione immediata in base al canale ────────────────────────────────
    const smsOpeningBody =
      `Ciao ${firstName}! Sono Sara di AutoExperience, ricevo la tua richiesta di contatto. ` +
      `Per consigliarti meglio, posso farti qualche domanda veloce sul tuo noleggio?`;
    await executeChannelAction({
      primary,
      actionTaken,
      phone,
      firstName,
      scheduledFor,
      smsOpeningBody,
      smsCourtesyIntro: 'grazie per la tua richiesta di contatto!',
      vapiVariables: { first_name: firstName },
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
