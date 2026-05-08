const ENDPOINT = 'score-update';

export default async function handler(req, res) {
  const timestamp = new Date().toISOString();

  if (req.method !== 'POST') {
    console.log(`[${timestamp}] [${ENDPOINT}] Metodo non consentito: ${req.method}`);
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const payload = req.body;
    console.log(`[${timestamp}] [${ENDPOINT}] Score aggiornamento:`, JSON.stringify(payload, null, 2));

    // TODO: gestire lo score in tempo reale durante la chiamata (attivo dal giorno 11)

    return res.status(200).json({ ok: true });
  } catch (err) {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] [${ENDPOINT}] Errore:`, err.message);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
