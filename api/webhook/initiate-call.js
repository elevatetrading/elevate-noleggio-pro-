import axios from 'axios';
import { Redis } from '@upstash/redis';
import { getConfig } from '../../lib/verticals.js';

const redis = Redis.fromEnv();
const ENDPOINT = 'initiate-call';

function getField(body, key) {
  return body?.[key]
    ?? body?.customData?.[key]
    ?? body?.extras?.[key]
    ?? body?.data?.[key]
    ?? null;
}

export default async function handler(req, res) {
  const timestamp = new Date().toISOString();

  if (req.method !== 'POST') {
    console.log(`[${timestamp}] [${ENDPOINT}] Metodo non consentito: ${req.method}`);
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    console.log(`[${ENDPOINT}] RAW BODY:`, JSON.stringify(req.body));
    console.log(`[${ENDPOINT}] HEADERS:`, JSON.stringify(req.headers));

    const phone        = getField(req.body, 'phone');
    const contact_id   = getField(req.body, 'contact_id');
    const first_name   = getField(req.body, 'first_name');
    const tipo_cliente = getField(req.body, 'tipo_cliente');
    const km_anno      = getField(req.body, 'km_anno');
    const durata_mesi  = getField(req.body, 'durata_mesi');
    const segmento_auto = getField(req.body, 'segmento_auto');
    const urgenza      = getField(req.body, 'urgenza');
    const rawVertical  = getField(req.body, 'vertical');

    const vertical = rawVertical ?? 'noleggio';
    const config = getConfig(vertical);

    console.log(`[${ENDPOINT}] Extracted phone=${phone} contact_id=${contact_id} first_name=${first_name} vertical=${vertical}`);
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
      assistantId: config.vapi_assistant_id,
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
