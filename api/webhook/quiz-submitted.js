import twilio from 'twilio';
import { Redis } from '@upstash/redis';
import { getConfig } from '../../lib/verticals.js';

const redis = Redis.fromEnv();
const ENDPOINT = 'quiz-submitted';

export default async function handler(req, res) {
  const timestamp = new Date().toISOString();

  if (req.method !== 'POST') {
    console.log(`[${timestamp}] [${ENDPOINT}] Metodo non consentito: ${req.method}`);
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const payload = req.body;
    console.log(`[${timestamp}] [${ENDPOINT}] Payload ricevuto:`, JSON.stringify(payload, null, 2));

    const {
      first_name,
      phone,
      tipo_cliente,
      km_anno,
      durata_mesi,
      segmento_auto,
      urgenza,
      vertical: rawVertical,
    } = payload;

    const vertical = rawVertical ?? 'noleggio';
    const config = getConfig(vertical);

    console.log(`[${timestamp}] [${ENDPOINT}] vertical=${vertical}`);

    // --- SMS iniziale di apertura conversazione ---
    const smsBody = config.sms_opening(first_name);

    try {
      const twilioClient = twilio(
        process.env.TWILIO_ACCOUNT_SID,
        process.env.TWILIO_AUTH_TOKEN
      );
      const smsResult = await twilioClient.messages.create({
        body: smsBody,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: phone,
      });
      console.log(`[${new Date().toISOString()}] [${ENDPOINT}] SMS inviato — sid: ${smsResult.sid}`);
    } catch (smsErr) {
      console.error(`[${new Date().toISOString()}] [${ENDPOINT}] Errore invio SMS (non bloccante):`, smsErr.message);
    }

    // Salva i dati del lead su Redis con TTL 600s (10 min)
    const redisKey = `vapi_pending:${phone}`;
    await redis.set(
      redisKey,
      JSON.stringify({ timestamp, customerData: { first_name, phone, tipo_cliente, km_anno, durata_mesi, segmento_auto, urgenza } }),
      { ex: 600 }
    );
    console.log(`[${new Date().toISOString()}] [${ENDPOINT}] Redis: chiave "${redisKey}" salvata con TTL 600s`);

    // Salva il vertical associato al numero — usato da incoming-sms e altri handler
    await redis.set(`vertical:${phone}`, vertical, { ex: 600 });
    console.log(`[${new Date().toISOString()}] [${ENDPOINT}] Redis: chiave "vertical:${phone}" salvata con TTL 600s`);

    return res.status(200).json({ ok: true, sms_sent: true, vapi_scheduled: true });
  } catch (err) {
    const errTs = new Date().toISOString();
    console.error(`[${errTs}] [${ENDPOINT}] Errore:`, err.message);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
