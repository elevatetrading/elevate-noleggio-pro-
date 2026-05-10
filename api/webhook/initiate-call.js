import axios from 'axios';
import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();
const ENDPOINT = 'initiate-call';

export default async function handler(req, res) {
  const timestamp = new Date().toISOString();

  if (req.method !== 'POST') {
    console.log(`[${timestamp}] [${ENDPOINT}] Metodo non consentito: ${req.method}`);
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { phone, contact_id, first_name, tipo_cliente, km_anno, durata_mesi, segmento_auto, urgenza } = req.body;
    console.log(`[${timestamp}] [${ENDPOINT}] Richiesta per ${phone} (contact_id: ${contact_id})`);

    const redisKey = `vapi_pending:${phone}`;
    const pending = await redis.get(redisKey);

    if (!pending) {
      console.log(`[${new Date().toISOString()}] [${ENDPOINT}] Skip Vapi call: lead already responded (${phone})`);
      return res.status(200).json({ ok: true, skipped: true });
    }

    // Cancella la chiave prima di chiamare per evitare doppie chiamate
    await redis.del(redisKey);
    console.log(`[${new Date().toISOString()}] [${ENDPOINT}] Redis: chiave "${redisKey}" rimossa`);

    const callBody = {
      phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID,
      assistantId: process.env.VAPI_ASSISTANT_ID,
      customer: {
        number: phone,
      },
      assistantOverrides: {
        variableValues: {
          first_name,
          tipo_cliente,
          km_anno,
          durata_mesi,
          segmento_auto,
          urgenza,
        },
      },
    };

    console.log(`[${new Date().toISOString()}] [${ENDPOINT}] Avvio chiamata Vapi:`, JSON.stringify(callBody, null, 2));

    const { data } = await axios.post('https://api.vapi.ai/call/phone', callBody, {
      headers: {
        Authorization: `Bearer ${process.env.VAPI_PRIVATE_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    const callId = data?.id;
    console.log(`[${new Date().toISOString()}] [${ENDPOINT}] Chiamata avviata — call_id: ${callId}`);

    return res.status(200).json({ ok: true, call_id: callId });
  } catch (err) {
    const errTs = new Date().toISOString();
    if (err.response?.data) {
      console.error(`[${errTs}] [${ENDPOINT}] Errore Vapi:`, JSON.stringify(err.response.data, null, 2));
    } else {
      console.error(`[${errTs}] [${ENDPOINT}] Errore:`, err.message);
    }
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
