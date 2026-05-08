import axios from 'axios';

const ENDPOINT = 'quiz-submitted';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

    // 30s placeholder — quando aggiungeremo la chat AI avrà priorità, la voice è il fallback
    console.log(`[${timestamp}] [${ENDPOINT}] Attesa 30s (slot riservato alla chat AI)...`);
    await sleep(30_000);

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

    const vapiTs = new Date().toISOString();
    console.log(`[${vapiTs}] [${ENDPOINT}] Avvio chiamata Vapi:`, JSON.stringify(callBody, null, 2));

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
