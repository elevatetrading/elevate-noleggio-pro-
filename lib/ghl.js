import axios from 'axios';
import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();
const BASE = 'https://services.leadconnectorhq.com';

function headers(apiKey) {
  return {
    Authorization: `Bearer ${apiKey ?? process.env.GHL_API_KEY}`,
    'Content-Type': 'application/json',
    Version: '2021-07-28',
  };
}

// Risolve l'ID di un custom field dal suo fieldKey, con cache Redis 24h.
// La cache è per-location per supportare sub-account GHL diversi.
export async function resolveFieldId(fieldKey, ghlConfig = {}) {
  const apiKey = ghlConfig.apiKey ?? process.env.GHL_API_KEY;
  const locationId = ghlConfig.locationId ?? process.env.GHL_LOCATION_ID;
  const cacheKey = `ghl:field:${locationId}:${fieldKey}`;
  const cached = await redis.get(cacheKey);
  if (cached) return cached;

  const { data } = await axios.get(
    `${BASE}/locations/${locationId}/customFields`,
    { headers: headers(apiKey) }
  );

  for (const f of data?.customFields ?? []) {
    await redis.set(`ghl:field:${locationId}:${f.fieldKey}`, f.id, { ex: 86400 });
    const short = f.fieldKey.replace(/^contact\./, '');
    if (short !== f.fieldKey) await redis.set(`ghl:field:${locationId}:${short}`, f.id, { ex: 86400 });
  }

  const match = (data?.customFields ?? []).find(
    (f) => f.fieldKey === fieldKey || f.fieldKey === `contact.${fieldKey}`
  );
  return match?.id ?? null;
}

// Cerca un contatto GHL per numero di telefono (primo risultato).
export async function findContactByPhone(phone, ghlConfig = {}) {
  const apiKey = ghlConfig.apiKey ?? process.env.GHL_API_KEY;
  const locationId = ghlConfig.locationId ?? process.env.GHL_LOCATION_ID;
  const { data } = await axios.get(`${BASE}/contacts/`, {
    headers: headers(apiKey),
    params: { locationId, query: phone },
  });
  return data?.contacts?.[0] ?? null;
}

// Aggiorna custom fields su un contatto.
// fields: [{ key: 'lead_score', value: '85' }]
export async function updateContactFields(contactId, fields, ghlConfig = {}) {
  const resolved = await Promise.all(
    fields.map(async ({ key, value }) => {
      const id = await resolveFieldId(key, ghlConfig);
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
    { headers: headers(ghlConfig.apiKey ?? process.env.GHL_API_KEY) }
  );
  return data;
}

// Aggiunge una nota testuale a un contatto.
export async function addContactNote(contactId, body, ghlConfig = {}) {
  const { data } = await axios.post(
    `${BASE}/contacts/${contactId}/notes`,
    { body },
    { headers: headers(ghlConfig.apiKey ?? process.env.GHL_API_KEY) }
  );
  return data;
}

// Trova la prima opportunity aperta per un contatto.
export async function findOpportunity(contactId, ghlConfig = {}) {
  const apiKey = ghlConfig.apiKey ?? process.env.GHL_API_KEY;
  const locationId = ghlConfig.locationId ?? process.env.GHL_LOCATION_ID;
  const { data } = await axios.get(`${BASE}/opportunities/search`, {
    headers: headers(apiKey),
    params: { location_id: locationId, contact_id: contactId },
  });
  return data?.opportunities?.[0] ?? null;
}

// Sposta una opportunity allo stage "Hot Lead".
export async function moveOpportunityToHotLead(opportunityId, ghlConfig = {}) {
  const stageId = process.env.GHL_HOT_LEAD_STAGE_ID;
  if (!stageId) {
    console.warn('[ghl] GHL_HOT_LEAD_STAGE_ID non configurata — skip stage move');
    return null;
  }
  const { data } = await axios.put(
    `${BASE}/opportunities/${opportunityId}`,
    { stageId },
    { headers: headers(ghlConfig.apiKey ?? process.env.GHL_API_KEY) }
  );
  return data;
}

/**
 * Esegue upsert del contatto su GHL e, se il phone nella response non corrisponde
 * a quello atteso, esegue una PATCH esplicita per forzare l'aggiornamento.
 */
export async function upsertContact(payload, expectedPhone, ghlConfig = {}) {
  const LOG = '[ghl-upsert]';
  const apiKey = ghlConfig.apiKey ?? process.env.GHL_API_KEY;
  const email = payload.email ?? '(no email)';
  const { tags: tagsToAdd, ...upsertPayload } = payload;
  console.log(`${LOG} Upserting contact email=${email} phone=${expectedPhone}${tagsToAdd?.length ? ` (tags separati: ${tagsToAdd.join(', ')})` : ''}`);

  const { data: ghlData } = await axios.post(
    `${BASE}/contacts/upsert`,
    upsertPayload,
    { headers: headers(apiKey) }
  );

  const contact = ghlData?.contact ?? {};
  const contactId = contact.id ?? ghlData?.id;
  const responsePhone = contact.phone ?? '';

  console.log(`${LOG} Response contact_id=${contactId} response_phone="${responsePhone}"`);

  const digitsOnly = (p) => String(p ?? '').replace(/\D/g, '');
  if (contactId && digitsOnly(responsePhone) !== digitsOnly(expectedPhone)) {
    console.log(`${LOG} PATCH needed, forcing phone=${expectedPhone} on contact_id=${contactId}`);
    try {
      await axios.put(
        `${BASE}/contacts/${contactId}`,
        { phone: expectedPhone },
        { headers: headers(apiKey) }
      );
      console.log(`${LOG} PATCH ok`);
    } catch (e) {
      console.warn(`${LOG} PATCH failed: ${e.message}`);
    }
  }

  if (contactId && tagsToAdd?.length) {
    try {
      await axios.delete(
        `${BASE}/contacts/${contactId}/tags`,
        { headers: headers(apiKey), data: { tags: tagsToAdd } }
      );
      console.log(`${LOG} Tag rimossi (per forzare re-trigger): ${tagsToAdd.join(', ')}`);
    } catch (err) {
      console.warn(`${LOG} Tag remove failed (probabilmente non erano presenti): ${err.message}`);
    }

    console.log(`${LOG} Aggiunta tag a contact_id=${contactId}: ${tagsToAdd.join(', ')}`);
    try {
      await axios.post(
        `${BASE}/contacts/${contactId}/tags`,
        { tags: tagsToAdd },
        { headers: headers(apiKey) }
      );
      console.log(`${LOG} Tag aggiunti ok`);
    } catch (e) {
      console.warn(`${LOG} Tag call failed (contatto creato, trigger non scatterà): ${e.message}`);
    }
  }

  return { contactId, contact };
}

// Recupera i dettagli di un contatto GHL per ID.
export async function getContact(contactId, ghlConfig = {}) {
  const { data } = await axios.get(
    `${BASE}/contacts/${contactId}`,
    { headers: headers(ghlConfig.apiKey ?? process.env.GHL_API_KEY) }
  );
  return data?.contact ?? null;
}

// Imposta Do Not Disturb su un contatto GHL.
export async function setContactDnd(contactId, ghlConfig = {}) {
  const { data } = await axios.put(
    `${BASE}/contacts/${contactId}`,
    { dnd: true },
    { headers: headers(ghlConfig.apiKey ?? process.env.GHL_API_KEY) }
  );
  return data;
}

// Aggiunge tag a un contatto GHL senza sovrascrivere i tag esistenti.
export async function addContactTags(contactId, tags, ghlConfig = {}) {
  const tagList = Array.isArray(tags) ? tags : [tags];
  const { data } = await axios.post(
    `${BASE}/contacts/${contactId}/tags`,
    { tags: tagList },
    { headers: headers(ghlConfig.apiKey ?? process.env.GHL_API_KEY) }
  );
  return data;
}

// Crea un task GHL assegnato all'utente principale del location.
// L'userId viene cachato per location per evitare chiamate ripetute.
export async function createHandoffTask(contactId, title, body, ghlConfig = {}) {
  const apiKey = ghlConfig.apiKey ?? process.env.GHL_API_KEY;
  const locationId = ghlConfig.locationId ?? process.env.GHL_LOCATION_ID;
  const userCacheKey = `ghl:main_user_id:${locationId}`;

  let userId = await redis.get(userCacheKey);
  if (!userId) {
    try {
      const { data } = await axios.get(
        `${BASE}/locations/${locationId}/users`,
        { headers: headers(apiKey) }
      );
      userId = data?.users?.[0]?.id ?? null;
      if (userId) await redis.set(userCacheKey, userId, { ex: 86400 });
    } catch (e) {
      console.warn('[ghl] Impossibile recuperare userId:', e.message);
    }
  }

  const dueDate = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const { data } = await axios.post(
    `${BASE}/contacts/${contactId}/tasks`,
    { title, body, dueDate, status: 'incompleted', ...(userId ? { assignedTo: userId } : {}) },
    { headers: headers(apiKey) }
  );
  return data;
}
