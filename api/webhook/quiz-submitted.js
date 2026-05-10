import axios from 'axios';
import twilio from 'twilio';

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

    // --- SMS iniziale di apertura conversazione ---
    const greeting = first_name
      ? `Ciao ${first_name}!`
      : 'Ciao!';
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

    // 30s placeholder — slot riservato alla chat AI; la Vapi call è il fallback
    console.log(`[${new Date().toISOString()}] [${ENDPOINT}] Attesa 30s (slot riservato alla chat AI)...`);
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
