// IDEMPOTENCY_TTL_SECONDS — override unico per tutti i TTL di idempotenza.
// Usarlo in dev (es. 300) per far scadere le chiavi velocemente e ripetere i test
// senza cancellare chiavi Redis a mano. In produzione lasciare non impostato.
const override = process.env.IDEMPOTENCY_TTL_SECONDS
  ? parseInt(process.env.IDEMPOTENCY_TTL_SECONDS, 10)
  : null;

export const TTL_RECOVERY_SMS  = override ?? 3600;   // recovery_sms_sent:{phone}
export const TTL_FALLBACK_DONE = override ?? 86400;  // fallback_done:{phone}
export const TTL_HANDOFF_DONE  = override ?? 86400;  // handoff_done:{phone}
