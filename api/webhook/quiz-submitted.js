import twilio from 'twilio';
import { Redis } from '@upstash/redis';

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
    } = payload;

    // --- SMS iniziale di apertura conversazione ---
    const greeting = first_name ? `Ciao ${first_name}!` : 'Ciao!';
    const smsBody =
      `${greeting} Sono Sara di AutoExperience. Hai appena compilato il quiz sul noleggio. ` +
      `Posso farti un paio di domande veloci per capire come posso aiutarti?`;

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
    // Se il lead risponde via SMS prima dello scadere, incoming-sms.js cancella questa chiave
    // e GHL non riceverà conferma per avviare la Vapi call
    const redisKey = `vapi_pending:${phone}`;
    await redis.set(
      redisKey,
      JSON.stringify({ timestamp, customerData: { first_name, phone, tipo_cliente, km_anno, durata_mesi, segmento_auto, urgenza } }),
      { ex: 600 }
    );
    console.log(`[${new Date().toISOString()}] [${ENDPOINT}] Redis: chiave "${redisKey}" salvata con TTL 600s`);

    return res.status(200).json({ ok: true, sms_sent: true, vapi_scheduled: true });
  } catch (err) {
    const errTs = new Date().toISOString();
    console.error(`[${errTs}] [${ENDPOINT}] Errore:`, err.message);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
