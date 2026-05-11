// Gestione orari chiamate — timezone Europe/Rome.
// Orari consentiti: Lunedì–Sabato, 09:00–21:00.
// Non richiede dipendenze esterne.

function getRomeComponents(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Rome',
    weekday: 'short',  // 'Mon', 'Tue', ..., 'Sun'
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(date);

  const get = (type) => parts.find((p) => p.type === type)?.value ?? '0';
  let hour = parseInt(get('hour'));
  if (hour === 24) hour = 0; // Intl può restituire 24 per mezzanotte esatta

  return {
    weekday: get('weekday'),
    year: parseInt(get('year')),
    month: parseInt(get('month')) - 1, // 0-indexed
    day: parseInt(get('day')),
    hour,
    minute: parseInt(get('minute')),
  };
}

// Restituisce un Date corrispondente alle 09:00 Europe/Rome
// della data di calendario passata (anno/mese0/giorno in time Rome).
function romeAt9(year, month0, day) {
  // Partiamo da mezzogiorno UTC dello stesso giorno di calendario per evitare
  // problemi di boundary (Rome è sempre UTC+1 o UTC+2, mai oltre).
  const utcNoon = new Date(Date.UTC(year, month0, day, 12, 0, 0));
  const romeHourAtNoon = parseInt(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Rome',
      hour: 'numeric',
      hour12: false,
    }).format(utcNoon)
  );
  // UTC noon + (9 - romeHour) ore = 09:00 Rome
  return new Date(utcNoon.getTime() + (9 - romeHourAtNoon) * 3_600_000);
}

/**
 * Ritorna true se la data cade negli orari consentiti per le chiamate:
 * Lunedì–Sabato, 09:00–21:00 Europe/Rome.
 */
export function isCallingHourAllowed(date = new Date()) {
  const { weekday, hour } = getRomeComponents(date);
  if (weekday === 'Sun') return false;
  return hour >= 9 && hour < 21;
}

/**
 * Ritorna un Date con il prossimo slot consentito (09:00 Rome).
 * Se la data passata è già dentro gli orari, la ritorna invariata.
 *
 * Casistiche:
 *  - Dentro orario         → stessa data
 *  - Lun–Sab prima delle 9 → stesso giorno alle 9
 *  - Qualsiasi giorno dopo le 21 o domenica → giorno successivo alle 9, salta domenica
 */
export function nextAllowedCallTime(fromDate = new Date()) {
  if (isCallingHourAllowed(fromDate)) return fromDate;

  const { weekday, year, month, day, hour } = getRomeComponents(fromDate);

  // Prima delle 9 su un giorno permesso → stesso giorno alle 9
  if (weekday !== 'Sun' && hour < 9) {
    return romeAt9(year, month, day);
  }

  // Dopo le 21 o domenica → avanziamo al giorno successivo, saltiamo domenica
  // Usiamo mezzogiorno UTC per evitare problemi di boundary tra UTC e Rome
  let candidate = new Date(Date.UTC(year, month, day + 1, 12, 0, 0));
  let comp = getRomeComponents(candidate);
  if (comp.weekday === 'Sun') {
    candidate = new Date(Date.UTC(comp.year, comp.month, comp.day + 1, 12, 0, 0));
    comp = getRomeComponents(candidate);
  }

  return romeAt9(comp.year, comp.month, comp.day);
}
