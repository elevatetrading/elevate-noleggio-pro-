const ENDPOINT = 'vapi-call-ended';

export default async function handler(req, res) {
  const timestamp = new Date().toISOString();

  if (req.method !== 'POST') {
    console.log(`[${timestamp}] [${ENDPOINT}] Metodo non consentito: ${req.method}`);
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const payload = req.body;
    const { transcript, summary, outcome } = payload || {};

    console.log(`[${timestamp}] [${ENDPOINT}] Chiamata terminata — outcome: ${outcome}`);
    console.log(`[${timestamp}] [${ENDPOINT}] Summary:`, summary);
    console.log(`[${timestamp}] [${ENDPOINT}] Transcript:`, transcript);

    // TODO: aggiornare i custom fields del contatto su GHL via API

    return res.status(200).json({ ok: true });
  } catch (err) {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] [${ENDPOINT}] Errore:`, err.message);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
