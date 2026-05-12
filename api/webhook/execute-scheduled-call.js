import axios from 'axios';
import { Redis } from '@upstash/redis';
import { normalizePhone } from '../../lib/channel-actions.js';
import { getContact, addContactTags, updateContactFields } from '../../lib/ghl.js';
import { TTL_SCHEDULED_CALL_EXECUTED } from '../../lib/redis-config.js';

const redis = Redis.fromEnv();
const ENDPOINT = 'execute-scheduled-call';

function getField(body, key) {
  return body?.[key]
    ?? body?.customData?.[key]
    ?? body?.extras?.[key]
    ?? body?.data?.[key]
    ?? null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    console.log(`[${ENDPOINT}] RAW BODY:`, JSON.stringify(req.body));
    console.log(`[${ENDPOINT}] HEADERS:`, JSON.stringify(req.headers));

    const rawPhone  = getField(req.body, 'phone');
    const contactId = getField(req.body, 'contact_id');

    if (!rawPhone || !contactId) {
      return res.status(400).json({ error: 'Missing required fields: phone, contact_id' });
    }

    const phone = normalizePhone(rawPhone);
    if (!phone) {
      return res.status(400).json({ error: `Invalid phone: "${rawPhone}"` });
    }

    console.log(`[${ENDPOINT}] Received phone=${phone} contact_id=${contactId}`);

    // ── Step 5: idempotenza ────────────────────────────────────────────────
    const alreadyExecuted = await redis.get(`scheduled_call_executed:${phone}`);
    if (alreadyExecuted) {
      console.log(`[${ENDPOINT}] Skip reason=already_executed`);
      return res.status(200).json({ ok: true, action: 'skipped', reason: 'already_executed', vapi_call_id: null });
    }

    // ── Step 6: verifica che la chiamata non sia stata cancellata dal lead ─
    const scheduledCall = await redis.get(`scheduled_call:${phone}`);
    if (!scheduledCall) {
      console.log(`[${ENDPOINT}] Skip reason=scheduled_call_cancelled`);
      return res.status(200).json({ ok: true, action: 'skipped', reason: 'scheduled_call_cancelled', vapi_call_id: null });
    }

    // ── Step 7: recupera first_name da GHL (best-effort) ──────────────────
    let firstName = '';
    try {
      const contact = await getContact(contactId);
      if (contact) {
        firstName = contact.firstName ?? '';
      } else {
        console.warn(`[${ENDPOINT}] WARN: contact_id=${contactId} non trovato su GHL — procedo con first_name vuoto`);
      }
    } catch (e) {
      console.warn(`[${ENDPOINT}] WARN: GHL contact fetch failed: ${e.message} — procedo`);
    }

    // ── Step 8: avvia chiamata Vapi ────────────────────────────────────────
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

    // ── Step 9 & 10: marca come eseguito + rimuovi chiave schedulata ───────
    console.log(`[${ENDPOINT}] Setting key scheduled_call_executed TTL=${TTL_SCHEDULED_CALL_EXECUTED}s`);
    await redis.set(`scheduled_call_executed:${phone}`, '1', { ex: TTL_SCHEDULED_CALL_EXECUTED });
    await redis.del(`scheduled_call:${phone}`);

    // ── Step 11: aggiorna GHL (best-effort) ───────────────────────────────
    try {
      await Promise.all([
        addContactTags(contactId, ['scheduled_call_executed']),
        updateContactFields(contactId, [{ key: 'channel_status', value: 'call_in_progress' }]),
      ]);
    } catch (e) {
      console.warn(`[${ENDPOINT}] WARN: GHL update failed: ${e.message}`);
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
