import twilio from 'twilio';
import axios from 'axios';
import { Redis } from '@upstash/redis';
import { normalizePhone, isCallingHourAllowed } from '../../lib/channel-actions.js';
import { getContact, addContactTags } from '../../lib/ghl.js';

const redis = Redis.fromEnv();
const ENDPOINT = 'fallback';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const log = (msg) => console.log(`[${new Date().toISOString()}] [${ENDPOINT}] ${msg}`);

  try {
    const { phone: rawPhone, primary, contact_id } = req.body ?? {};

    // ── Step 1: Validazione ───────────────────────────────────────────────
    if (!rawPhone || !primary || !contact_id) {
      return res.status(400).json({ error: 'Missing required fields: phone, primary, contact_id' });
    }

    // ── Step 2: Normalizza phone ──────────────────────────────────────────
    const phone = normalizePhone(rawPhone);
    if (!phone) {
      return res.status(400).json({ error: `Invalid phone: "${rawPhone}"` });
    }

    log(`Received phone=${phone} primary=${primary} contact_id=${contact_id}`);

    // ── Step 3: Verifica fallback_done (idempotenza) ──────────────────────
    const donePrev = await redis.get(`fallback_done:${phone}`);
    if (donePrev) {
      log(`Skipping reason=fallback_done_for_today`);
      return res.status(200).json({ ok: true, action: 'skipped', reason: 'fallback_done_for_today' });
    }

    // ── Step 4: Verifica engaged (lead ha già risposto via SMS) ───────────
    const engagedKey = await redis.get(`engaged:${phone}`);
    if (engagedKey) {
      log(`Skipping reason=lead_already_engaged`);
      return res.status(200).json({ ok: true, action: 'skipped', reason: 'lead_already_engaged' });
    }

    // ── Step 5: Verifica GHL — tag 'responded'/'engaged' + GET contatto ──
    let contact = null;
    try {
      contact = await getContact(contact_id);
      if (!contact) {
        log(`WARN: contact_id=${contact_id} non trovato su GHL — skip`);
        return res.status(200).json({ ok: true, action: 'skipped', reason: 'lead_already_engaged' });
      }
      const tags = Array.isArray(contact.tags) ? contact.tags : [];
      const alreadyEngaged = tags.some(
        (t) => ['responded', 'engaged'].includes(String(t).toLowerCase())
      );
      if (alreadyEngaged) {
        log(`Skipping reason=lead_already_engaged (GHL tag)`);
        return res.status(200).json({ ok: true, action: 'skipped', reason: 'lead_already_engaged' });
      }
    } catch (e) {
      log(`WARN: GHL contact fetch failed: ${e.message} — continuing`);
    }

    // ── Step 6: Verifica chiamata schedulata ancora futura ────────────────
    try {
      const fp = await redis.get(`fallback_pending:${phone}`);
      if (fp) {
        const fpData = typeof fp === 'string' ? JSON.parse(fp) : fp;
        if (fpData?.scheduledFor && new Date(fpData.scheduledFor) > new Date()) {
          log(`Skipping reason=scheduled_call_pending (scheduledFor=${fpData.scheduledFor})`);
          return res.status(200).json({ ok: true, action: 'skipped', reason: 'scheduled_call_pending' });
        }
      }
    } catch (e) {
      log(`WARN: Redis fallback_pending read error: ${e.message} — continuing`);
    }

    // ── Step 7: Esegui fallback ───────────────────────────────────────────
    const firstName = contact?.firstName ?? null;
    const greeting = firstName ? `Ciao ${firstName}` : 'Ciao';
    const inHours = isCallingHourAllowed(new Date());

    const twilioClient = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );

    let action;
    let ghlTag;

    if (primary === 'sms') {
      // CASO A — lead aveva scelto SMS, fallback → chiamata Vapi (o SMS reminder fuori orario)
      if (inHours) {
        log(`Executing branch=CASO_A_inHours action=fallback_call_executed`);
        try {
          const vapiRes = await axios.post(
            'https://api.vapi.ai/call/phone',
            {
              phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID,
              assistantId: process.env.VAPI_ASSISTANT_ID,
              customer: { number: phone },
              assistantOverrides: { variableValues: { first_name: firstName ?? '' } },
            },
            {
              headers: {
                Authorization: `Bearer ${process.env.VAPI_PRIVATE_KEY}`,
                'Content-Type': 'application/json',
              },
            }
          );
          log(`Vapi call initiated call_id=${vapiRes.data?.id}`);
        } catch (e) {
          log(`ERROR Vapi call: ${e.message}`);
        }
        action = 'fallback_call_executed';
        ghlTag = 'fallback:call_executed';
      } else {
        const body =
          `${greeting}, ho provato a scriverti senza ricevere risposta. ` +
          `Riproverò domani alle 9:00 o, se preferisci, scrivimi tu quando ti va. Sara di AutoExperience`;
        log(`Executing branch=CASO_A_outOfHours action=fallback_sms_sent`);
        try {
          const sms = await twilioClient.messages.create({
            body,
            from: process.env.TWILIO_PHONE_NUMBER,
            to: phone,
          });
          log(`SMS sent twilio_sid=${sms.sid}`);
        } catch (e) {
          log(`ERROR SMS: ${e.message}`);
        }
        action = 'fallback_sms_sent';
        ghlTag = 'fallback:sms_reminder_sent';
      }
    } else {
      // CASO B — lead aveva scelto chiamata, fallback → SMS (scuse in orario, reminder fuori orario)
      let body;
      if (inHours) {
        log(`Executing branch=CASO_B_inHours action=fallback_sms_sent`);
        body =
          `${greeting}, ho provato a chiamarti senza riuscire a parlare con te. ` +
          `Quando ti va che ci sentiamo? Rispondi qui e ti contatto. Sara di AutoExperience`;
        ghlTag = 'fallback:sms_apology_sent';
      } else {
        log(`Executing branch=CASO_B_outOfHours action=fallback_sms_sent`);
        body =
          `${greeting}, ti ricontatto domani alle 9:00. ` +
          `Se preferisci scrivermi qui, ti rispondo subito. Sara di AutoExperience`;
        ghlTag = 'fallback:sms_reminder_sent';
      }
      try {
        const sms = await twilioClient.messages.create({
          body,
          from: process.env.TWILIO_PHONE_NUMBER,
          to: phone,
        });
        log(`SMS sent twilio_sid=${sms.sid}`);
      } catch (e) {
        log(`ERROR SMS: ${e.message}`);
      }
      action = 'fallback_sms_sent';
    }

    // ── Step 8: Setta fallback_done per prevenire ri-esecuzione ──────────
    await redis.set(`fallback_done:${phone}`, '1', { ex: 86400 });
    log(`Redis fallback_done:${phone} set TTL 86400s`);

    // Aggiungi tag GHL (best effort, non blocca il flusso)
    try {
      await addContactTags(contact_id, [ghlTag]);
      log(`GHL tag added: ${ghlTag}`);
    } catch (e) {
      log(`WARN: GHL tag add failed: ${e.message}`);
    }

    return res.status(200).json({ ok: true, action, reason: null });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [${ENDPOINT}] ERROR ${err.message}`, err.stack);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
