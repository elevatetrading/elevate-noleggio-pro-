import axios from 'axios';
import { Redis } from '@upstash/redis';
import { findContactByPhone, updateContactFields } from '../../lib/ghl.js';

const redis = Redis.fromEnv();
const ENDPOINT = 'score-update';

function internalUrl(path) {
  if (process.env.BASE_URL) return `${process.env.BASE_URL}${path}`;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}${path}`;
  return `http://localhost:3000${path}`;
}

export default async function handler(req, res) {
  const timestamp = new Date().toISOString();

  if (req.method !== 'POST') {
    console.log(`[${timestamp}] [${ENDPOINT}] Metodo non consentito: ${req.method}`);
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { phone, intent_score, qualifica_score, engagement_score, ready_for_handoff } = req.body;

    // Media pesata: intent 40%, qualifica 40%, engagement 20%
    const lead_score = Math.round(
      0.4 * (Number(intent_score) || 0) +
      0.4 * (Number(qualifica_score) || 0) +
      0.2 * (Number(engagement_score) || 0)
    );

    console.log(
      `[${timestamp}] [${ENDPOINT}] Score per ${phone}: ` +
      `intent=${intent_score} qualifica=${qualifica_score} engagement=${engagement_score} → lead_score=${lead_score}`
    );

    // Aggiorna lead_score su GHL
    // TODO: verifica che il fieldKey "lead_score" corrisponda al nome nel sub-account
    const contact = await findContactByPhone(phone);
    if (contact) {
      await updateContactFields(contact.id, [{ key: 'lead_score', value: String(lead_score) }]);
      console.log(`[${timestamp}] [${ENDPOINT}] lead_score aggiornato su GHL (${contact.id})`);
    } else {
      console.warn(`[${timestamp}] [${ENDPOINT}] Contatto GHL non trovato per ${phone}`);
    }

    // Trigger handoff se caldo
    const shouldHandoff = ready_for_handoff === true || lead_score >= 70;
    let handoff_triggered = false;

    if (shouldHandoff) {
      const alreadyDone = await redis.get(`handoff_done:${phone}`);
      if (!alreadyDone) {
        // Segna subito per evitare doppie notifiche anche se la chiamata sotto fallisce
        await redis.set(`handoff_done:${phone}`, '1', { ex: 86400 });
        console.log(`[${timestamp}] [${ENDPOINT}] Trigger handoff per ${phone} (lead_score=${lead_score})`);
        try {
          await axios.post(
            internalUrl('/api/webhook/hot-lead-handoff'),
            { phone },
            { timeout: 8000 }
          );
          handoff_triggered = true;
        } catch (e) {
          console.error(`[${timestamp}] [${ENDPOINT}] Errore chiamata handoff:`, e.message);
        }
      } else {
        console.log(`[${timestamp}] [${ENDPOINT}] Handoff già eseguito per ${phone} — skip`);
      }
    }

    return res.status(200).json({ ok: true, lead_score, handoff_triggered });
  } catch (err) {
    const errTs = new Date().toISOString();
    console.error(`[${errTs}] [${ENDPOINT}] Errore:`, err.message);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
