import axios from 'axios';
import { Redis } from '@upstash/redis';
import { normalizePhone } from '../../lib/channel-actions.js';
import { getContact, addContactTags, updateContactFields } from '../../lib/ghl.js';
import { TTL_SCHEDULED_CALL_EXECUTED } from '../../lib/redis-config.js';
import { qstashReceiver } from '../../lib/qstash.js';

const redis = Redis.fromEnv();
const ENDPOINT = 'execute-scheduled-call';

// SKIP_QSTASH_SIGNATURE_CHECK=true solo per test locali, mai in produzione.
const SKIP_SIG_CHECK = process.env.SKIP_QSTASH_SIGNATURE_CHECK === 'true';

function getField(body, key) {
  return body?.[key]
    ?? body?.customData?.[key]
    ?? body?.extras?.[key]
    ?? body?.data?.[key]
    ?? null;
}

// Ottiene il body come stringa raw per la verifica della firma QStash.
// Vercel auto-parsifica JSON → req.body è già un oggetto. La re-serializzazione
// funziona perché publishJSON ha usato JSON.stringify sullo stesso oggetto piatto.
function getRawBody(req) {
  if (req.rawBody) {
    return typeof req.rawBody === 'string' ? req.rawBody : req.rawBody.toString('utf8');
  }
  if (typeof req.body === 'string') return req.body;
  if (req.body != null) return JSON.stringify(req.body);
  return '';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  // ── Verifica firma QStash ─────────────────────────────────────────────────
  if (!SKIP_SIG_CHECK) {
    const signature = req.headers['upstash-signature'];
    if (!signature) {
      console.log(`[${ENDPOINT}] INVALID signature: header upstash-signature assente`);
      return res.status(401).json({ error: 'Invalid QStash signature' });
    }
    try {
      await qstashReceiver.verify({ signature, body: getRawBody(req) });
      console.log(`[${ENDPOINT}] QStash signature OK`);
    } catch (e) {
      console.log(`[${ENDPOINT}] INVALID signature: ${e.message}`);
      return res.status(401).json({ error: 'Invalid QStash signature' });
    }
  } else {
    console.warn(`[${ENDPOINT}] WARN: QStash signature check skipped (SKIP_QSTASH_SIGNATURE_CHECK=true)`);
  }

  try {
    console.log(`[${ENDPOINT}] RAW BODY:`, JSON.stringify(req.body));
    console.log(`[${ENDPOINT}] HEADERS:`, JSON.stringify(req.headers));

    const rawPhone  = getField(req.body, 'phone');
    const contactId = getField(req.body, 'contact_id') ?? null;

    if (!rawPhone) {
      return res.status(400).json({ error: 'Missing required field: phone' });
    }
    if (!contactId) {
      console.warn(`[${ENDPOINT}] WARN: contact_id mancante — procedo con ricerca per phone`);
    }

    const phone = normalizePhone(rawPhone);
    if (!phone) {
      return res.status(400).json({ error: `Invalid phone: "${rawPhone}"` });
    }

    console.log(`[${ENDPOINT}] Received phone=${phone} contact_id=${contactId}`);

    // ── Idempotenza ──────────────────────────────────────────────────────────
    const alreadyExecuted = await redis.get(`scheduled_call_executed:${phone}`);
    if (alreadyExecuted) {
      console.log(`[${ENDPOINT}] Skip reason=already_executed`);
      return res.status(200).json({ ok: true, action: 'skipped', reason: 'already_executed', vapi_call_id: null });
    }

    // ── Verifica che il lead non abbia cancellato la chiamata ────────────────
    const scheduledCall = await redis.get(`scheduled_call:${phone}`);
    if (!scheduledCall) {
      console.log(`[${ENDPOINT}] Skip reason=scheduled_call_cancelled`);
      return res.status(200).json({ ok: true, action: 'skipped', reason: 'scheduled_call_cancelled', vapi_call_id: null });
    }

    // ── Recupera first_name da GHL (best-effort) ─────────────────────────────
    let firstName = '';
    let resolvedContactId = contactId;
    try {
      const contact = contactId
        ? await getContact(contactId)
        : await (await import('../../lib/ghl.js')).findContactByPhone(phone);
      if (contact) {
        firstName = contact.firstName ?? '';
        resolvedContactId = resolvedContactId ?? contact.id;
      } else {
        console.warn(`[${ENDPOINT}] WARN: contatto GHL non trovato — procedo con first_name vuoto`);
      }
    } catch (e) {
      console.warn(`[${ENDPOINT}] WARN: GHL contact fetch failed: ${e.message} — procedo`);
    }

    // ── Avvia chiamata Vapi ──────────────────────────────────────────────────
    let vapiCallId = null;
    try {
      const { data } = await axios.post(
        'https://api.vapi.ai/call/phone',
        {
          phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID,
          assistantId: process.env.VAPI_ASSISTANT_ID,
          customer: { number: phone },
          assistantOverrides: {
            variableValues: { first_name: firstName },
          },
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.VAPI_PRIVATE_KEY}`,
            'Content-Type': 'application/json',
          },
        }
      );
      vapiCallId = data?.id ?? null;
      console.log(`[${ENDPOINT}] Vapi call initiated call_id=${vapiCallId}`);
    } catch (e) {
      const errBody = e.response?.data ? JSON.stringify(e.response.data) : e.message;
      console.error(`[${ENDPOINT}] ERROR Vapi: ${errBody}`);
      return res.status(500).json({ error: 'Internal Server Error' });
    }

    // ── Cleanup Redis ─────────────────────────────────────────────────────────
    console.log(`[${ENDPOINT}] Setting key scheduled_call_executed TTL=${TTL_SCHEDULED_CALL_EXECUTED}s`);
    await Promise.all([
      redis.set(`scheduled_call_executed:${phone}`, '1', { ex: TTL_SCHEDULED_CALL_EXECUTED }),
      redis.del(`scheduled_call:${phone}`),
      redis.del(`qstash_message_id:${phone}`),
    ]);

    // ── Aggiorna GHL (best-effort) ────────────────────────────────────────────
    if (resolvedContactId) {
      try {
        await Promise.all([
          addContactTags(resolvedContactId, ['scheduled_call_executed']),
          updateContactFields(resolvedContactId, [{ key: 'channel_status', value: 'call_in_progress' }]),
        ]);
      } catch (e) {
        console.warn(`[${ENDPOINT}] WARN: GHL update failed: ${e.message}`);
      }
    }

    return res.status(200).json({
      ok: true,
      action: 'scheduled_call_initiated',
      reason: null,
      vapi_call_id: vapiCallId,
    });

  } catch (err) {
    console.error(`[${ENDPOINT}] ERROR: ${err.message}`, err.stack);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
