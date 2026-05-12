import { Client, Receiver } from '@upstash/qstash';

export const qstashClient = new Client({
  token: process.env.QSTASH_TOKEN,
  ...(process.env.QSTASH_URL ? { baseUrl: process.env.QSTASH_URL } : {}),
});

export const qstashReceiver = new Receiver({
  currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY ?? '',
  nextSigningKey:    process.env.QSTASH_NEXT_SIGNING_KEY ?? '',
});

/**
 * Pubblica un messaggio QStash che chiamerà url con body JSON al timestamp specificato.
 * @param {string} url - URL pubblico del receiver
 * @param {object} body - Payload JSON da inviare
 * @param {number} notBeforeTimestamp - Unix timestamp in secondi (UTC)
 * @returns {Promise<string>} messageId QStash
 */
export async function schedulePost(url, body, notBeforeTimestamp) {
  const res = await qstashClient.publishJSON({
    url,
    body,
    notBefore: notBeforeTimestamp,
  });
  return res.messageId;
}

/**
 * Cancella un messaggio QStash schedulato.
 * @param {string} messageId
 */
export async function cancelMessage(messageId) {
  await qstashClient.messages.delete(messageId);
}
