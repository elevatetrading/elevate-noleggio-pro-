import axios from 'axios';
import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();
const BASE = 'https://services.leadconnectorhq.com';

function headers() {
  return {
    Authorization: `Bearer ${process.env.GHL_API_KEY}`,
    'Content-Type': 'application/json',
    Version: '2021-07-28',
  };
}

// Risolve l'ID di un custom field dal suo fieldKey, con cache Redis 24h.
// GHL usa fieldKey in formato "contact.field_name" — il resolver prova
// sia la chiave esatta sia con prefisso "contact." aggiunto/rimosso.
// TODO: i fieldKey esatti dipendono dai nomi scelti nel sub-account GHL.
//       Controlla GET /locations/{id}/customFields per i valori reali.
export async function resolveFieldId(fieldKey) {
  const cacheKey = `ghl:field:${fieldKey}`;
  const cached = await redis.get(cacheKey);
  if (cached) return cached;

  const { data } = await axios.get(
    `${BASE}/locations/${process.env.GHL_LOCATION_ID}/customFields`,
    { headers: headers() }
  );

  for (const f of data?.customFields ?? []) {
    await redis.set(`ghl:field:${f.fieldKey}`, f.id, { ex: 86400 });
    const short = f.fieldKey.replace(/^contact\./, '');
    if (short !== f.fieldKey) await redis.set(`ghl:field:${short}`, f.id, { ex: 86400 });
  }

  const match = (data?.customFields ?? []).find(
    (f) => f.fieldKey === fieldKey || f.fieldKey === `contact.${fieldKey}`
  );
  return match?.id ?? null;
}

// Cerca un contatto GHL per numero di telefono (primo risultato).
export async function findContactByPhone(phone) {
  const { data } = await axios.get(`${BASE}/contacts/`, {
    headers: headers(),
    params: { locationId: process.env.GHL_LOCATION_ID, query: phone },
  });
  return data?.contacts?.[0] ?? null;
}

// Aggiorna custom fields su un contatto.
// fields: [{ key: 'lead_score', value: '85' }]
export async function updateContactFields(contactId, fields) {
  const resolved = await Promise.all(
    fields.map(async ({ key, value }) => {
      const id = await resolveFieldId(key);
      if (!id) {
        console.warn(`[ghl] Campo non trovato per key="${key}" — skip (aggiungi il fieldKey corretto)`);
        return null;
      }
      return { id, field_value: String(value) };
    })
  );

  const customFields = resolved.filter(Boolean);
  if (!customFields.length) return null;

  const { data } = await axios.put(
    `${BASE}/contacts/${contactId}`,
    { customFields },
    { headers: headers() }
  );
  return data;
}

// Aggiunge una nota testuale a un contatto.
export async function addContactNote(contactId, body) {
  const { data } = await axios.post(
    `${BASE}/contacts/${contactId}/notes`,
    { body },
    { headers: headers() }
  );
  return data;
}

// Trova la prima opportunity aperta per un contatto.
export async function findOpportunity(contactId) {
  const { data } = await axios.get(`${BASE}/opportunities/search`, {
    headers: headers(),
    params: { location_id: process.env.GHL_LOCATION_ID, contact_id: contactId },
  });
  return data?.opportunities?.[0] ?? null;
}

// Sposta una opportunity allo stage "Hot Lead".
// Richiede la env var GHL_HOT_LEAD_STAGE_ID — ottienila da
// GET /locations/{id}/pipelines e copia l'ID dello stage corretto.
export async function moveOpportunityToHotLead(opportunityId) {
  const stageId = process.env.GHL_HOT_LEAD_STAGE_ID;
  if (!stageId) {
    console.warn('[ghl] GHL_HOT_LEAD_STAGE_ID non configurata — skip stage move');
    return null;
  }
  const { data } = await axios.put(
    `${BASE}/opportunities/${opportunityId}`,
    { stageId },
    { headers: headers() }
  );
  return data;
}

/**
 * Esegue upsert del contatto su GHL e, se il phone nella response non corrisponde
 * a quello atteso (caso: GHL non sovrascrive phone su contatto esistente matched by email),
 * esegue una PATCH esplicita per forzare l'aggiornamento.
 *
 * @param {object} payload  - Body per POST /contacts/upsert (include già phone)
 * @param {string} expectedPhone - Phone normalizzato E.164 che deve essere salvato
 * @returns {{ contactId: string, contact: object }}
 */
export async function upsertContact(payload, expectedPhone) {
  const LOG = '[ghl-upsert]';
  const email = payload.email ?? '(no email)';
  const { tags: tagsToAdd, ...upsertPayload } = payload;
  console.log(`${LOG} Upserting contact email=${email} phone=${expectedPhone}${tagsToAdd?.length ? ` (tags separati: ${tagsToAdd.join(', ')})` : ''}`);

  const { data: ghlData } = await axios.post(
    `${BASE}/contacts/upsert`,
    upsertPayload,
    { headers: headers() }
  );

  const contact = ghlData?.contact ?? {};
  const contactId = contact.id ?? ghlData?.id;
  const responsePhone = contact.phone ?? '';

  console.log(`${LOG} Response contact_id=${contactId} response_phone="${responsePhone}"`);

  // GHL a volte non sovrascrive phone in upsert quando matcha per email e il contatto
  // esiste già con phone vuoto (o conflict interno). PATCH esplicita come rimedio.
  const digitsOnly = (p) => String(p ?? '').replace(/\D/g, '');
  if (contactId && digitsOnly(responsePhone) !== digitsOnly(expectedPhone)) {
    console.log(`${LOG} PATCH needed, forcing phone=${expectedPhone} on contact_id=${contactId}`);
    try {
      await axios.put(
        `${BASE}/contacts/${contactId}`,
        { phone: expectedPhone },
        { headers: headers() }
      );
      console.log(`${LOG} PATCH ok`);
    } catch (e) {
      console.warn(`${LOG} PATCH failed: ${e.message}`);
    }
  }

  // Seconda chiamata separata per i tag: GHL scatta "Tag Added" solo su POST
  // /tags successivo all'upsert, non sui tag inclusi nel payload iniziale.
  if (contactId && tagsToAdd?.length) {
    console.log(`${LOG} Aggiunta tag a contact_id=${contactId}: ${tagsToAdd.join(', ')}`);
    try {
      await axios.post(
        `${BASE}/contacts/${contactId}/tags`,
        { tags: tagsToAdd },
        { headers: headers() }
      );
      console.log(`${LOG} Tag aggiunti ok`);
    } catch (e) {
      console.warn(`${LOG} Tag call failed (contatto creato, trigger non scatterà): ${e.message}`);
    }
  }

  return { contactId, contact };
}

// Recupera i dettagli di un contatto GHL per ID.
export async function getContact(contactId) {
  const { data } = await axios.get(`${BASE}/contacts/${contactId}`, { headers: headers() });
  return data?.contact ?? null;
}

// Imposta Do Not Disturb su un contatto GHL.
export async function setContactDnd(contactId) {
  const { data } = await axios.put(
    `${BASE}/contacts/${contactId}`,
    { dnd: true },
    { headers: headers() }
  );
  return data;
}

// Aggiunge tag a un contatto GHL senza sovrascrivere i tag esistenti.
export async function addContactTags(contactId, tags) {
  const tagList = Array.isArray(tags) ? tags : [tags];
  const { data } = await axios.post(
    `${BASE}/contacts/${contactId}/tags`,
    { tags: tagList },
    { headers: headers() }
  );
  return data;
}

// Crea un task GHL (visibile come notifica) assegnato all'utente principale del location.
// L'userId viene cachato in Redis per evitare chiamate ripetute.
export async function createHandoffTask(contactId, title, body) {
  let userId = await redis.get('ghl:main_user_id');
  if (!userId) {
    try {
      const { data } = await axios.get(
        `${BASE}/locations/${process.env.GHL_LOCATION_ID}/users`,
        { headers: headers() }
      );
      userId = data?.users?.[0]?.id ?? null;
      if (userId) await redis.set('ghl:main_user_id', userId, { ex: 86400 });
    } catch (e) {
      console.warn('[ghl] Impossibile recuperare userId:', e.message);
    }
  }

  const dueDate = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const { data } = await axios.post(
    `${BASE}/contacts/${contactId}/tasks`,
    { title, body, dueDate, status: 'incompleted', ...(userId ? { assignedTo: userId } : {}) },
    { headers: headers() }
  );
  return data;
}
