import twilio from 'twilio';
import {
  findContactByPhone,
  addContactNote,
  findOpportunity,
  moveOpportunityToHotLead,
  createHandoffTask,
} from '../../lib/ghl.js';
import { getConfig } from '../../lib/verticals.js';

const ENDPOINT = 'hot-lead-handoff';

export default async function handler(req, res) {
  const timestamp = new Date().toISOString();

  if (req.method !== 'POST') {
    console.log(`[${timestamp}] [${ENDPOINT}] Metodo non consentito: ${req.method}`);
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { phone, vertical: rawVertical } = req.body;

    const vertical = rawVertical ?? 'noleggio';
    const config = getConfig(vertical);
    const ghlConfig = { apiKey: config.ghl_api_key, locationId: config.ghl_location_id };

    console.log(`[${timestamp}] [${ENDPOINT}] Handoff per ${phone} (vertical=${vertical})`);

    const contact = await findContactByPhone(phone, ghlConfig);
    if (!contact) {
      console.warn(`[${timestamp}] [${ENDPOINT}] Contatto non trovato per ${phone}`);
      return res.status(200).json({ ok: true, handoff_complete: false, reason: 'contact_not_found' });
    }

    const firstName = contact.firstName ?? 'Lead';

    // Leggi lead_score e ai_call_summary dai custom fields del contatto
    const fieldVal = (key) =>
      contact.customFields?.find((f) => f.fieldKey?.includes(key))?.value ?? '';
    const leadScore = fieldVal('lead_score') || 'N/D';
    const aiSummary = fieldVal('ai_call_summary');

    // Ultimi 5 SMS come contesto supplementare
    let smsContext = '';
    try {
      const twilioClient = twilio(
        process.env.TWILIO_ACCOUNT_SID,
        process.env.TWILIO_AUTH_TOKEN
      );
      const ourNumber = process.env.TWILIO_PHONE_NUMBER;
      const [out, inb] = await Promise.all([
        twilioClient.messages.list({ from: ourNumber, to: phone, limit: 5 }),
        twilioClient.messages.list({ from: phone, to: ourNumber, limit: 5 }),
      ]);
      const lines = [...out, ...inb]
        .sort((a, b) => new Date(a.dateSent) - new Date(b.dateSent))
        .slice(-5)
        .map((m) => `${m.direction === 'inbound' ? 'Lead' : 'Sara'}: ${m.body}`)
        .join('\n');
      if (lines) smsContext = `\n\nUltimi SMS:\n${lines}`;
    } catch (e) {
      console.warn(`[${timestamp}] [${ENDPOINT}] Errore recupero SMS Twilio:`, e.message);
    }

    // Nota di briefing completo
    const noteBody = [
      `🔥 LEAD CALDO — Handoff automatico Sara`,
      `Lead: ${firstName} (${phone})`,
      `Score: ${leadScore}/100`,
      aiSummary ? `\nBriefing chiamata:\n${aiSummary}` : '',
      smsContext,
      `\nAzione consigliata: richiama entro 30 minuti.`,
    ]
      .filter(Boolean)
      .join('\n');

    await addContactNote(contact.id, noteBody, ghlConfig);
    console.log(`[${timestamp}] [${ENDPOINT}] Nota GHL aggiunta`);

    // Muovi opportunity a Hot Lead
    const opp = await findOpportunity(contact.id, ghlConfig);
    if (opp) {
      await moveOpportunityToHotLead(opp.id, ghlConfig);
      console.log(`[${timestamp}] [${ENDPOINT}] Opportunity ${opp.id} → Hot Lead stage`);
    } else {
      console.warn(`[${timestamp}] [${ENDPOINT}] Nessuna opportunity per contact ${contact.id}`);
    }

    // Task GHL (notifica interna all'utente del location)
    try {
      await createHandoffTask(
        contact.id,
        `🔥 LEAD CALDO — ${firstName}`,
        `Score ${leadScore}/100. ${aiSummary ? 'Vedi nota per briefing.' : 'Contatto solo via SMS.'} Richiama entro 30 min.`,
        ghlConfig
      );
      console.log(`[${timestamp}] [${ENDPOINT}] Task GHL creato`);
    } catch (e) {
      console.warn(`[${timestamp}] [${ENDPOINT}] Errore creazione task GHL:`, e.message);
    }

    // SMS alert al commerciale
    if (process.env.COMMERCIALE_PHONE) {
      try {
        const twilioClient = twilio(
          process.env.TWILIO_ACCOUNT_SID,
          process.env.TWILIO_AUTH_TOKEN
        );
        await twilioClient.messages.create({
          body: `🔥 LEAD CALDO: ${firstName}, score ${leadScore}/100. Controlla GHL Mobile per il briefing completo.`,
          from: process.env.TWILIO_PHONE_NUMBER,
          to: process.env.COMMERCIALE_PHONE,
        });
        console.log(`[${timestamp}] [${ENDPOINT}] SMS alert inviato al commerciale`);
      } catch (e) {
        console.warn(`[${timestamp}] [${ENDPOINT}] Errore SMS alert commerciale:`, e.message);
      }
    } else {
      console.warn(`[${timestamp}] [${ENDPOINT}] COMMERCIALE_PHONE non configurata — SMS alert skippato`);
    }

    return res.status(200).json({ ok: true, handoff_complete: true });
  } catch (err) {
    const errTs = new Date().toISOString();
    console.error(`[${errTs}] [${ENDPOINT}] Errore:`, err.message);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
