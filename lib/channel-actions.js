import axios from 'axios';
import twilio from 'twilio';
import { isCallingHourAllowed, nextAllowedCallTime } from './business-hours.js';

export { isCallingHourAllowed, nextAllowedCallTime };

export function normalizePhone(raw) {
  if (!raw) return null;
  let n = String(raw).replace(/[\s\-().]/g, '');
  if (n.startsWith('00')) n = '+' + n.slice(2);
  if (!n.startsWith('+')) n = '+39' + n;
  return /^\+\d{10,15}$/.test(n) ? n : null;
}

/**
 * Maps preferred_channel string to { primary, whatsappDegraded, unknownChannel }.
 * primary: 'call' | 'sms'
 */
export function mapChannel(preferredChannel) {
  if (!preferredChannel || preferredChannel === 'SMS') {
    return { primary: 'sms', whatsappDegraded: false };
  }
  if (preferredChannel === 'Chiamata telefonica') {
    return { primary: 'call', whatsappDegraded: false };
  }
  if (/whatsapp/i.test(preferredChannel)) {
    return { primary: 'sms', whatsappDegraded: true };
  }
  return { primary: 'sms', whatsappDegraded: false, unknownChannel: true };
}

/**
 * Derives channelStatus, actionTaken, scheduledFor from primary + current time.
 */
export function resolveChannelState(primary, now = new Date()) {
  if (primary === 'call') {
    if (isCallingHourAllowed(now)) {
      return { channelStatus: 'call_initiated', actionTaken: 'call_initiated', scheduledFor: null };
    }
    const scheduledFor = nextAllowedCallTime(now);
    return { channelStatus: 'scheduled_call', actionTaken: 'call_scheduled', scheduledFor };
  }
  return { channelStatus: 'sms_sent', actionTaken: 'sms_sent', scheduledFor: null };
}

/**
 * Executes the immediate channel action: Vapi call or SMS.
 *
 * @param {object} opts
 * @param {'call'|'sms'} opts.primary
 * @param {'call_initiated'|'call_scheduled'|'sms_sent'} opts.actionTaken
 * @param {string} opts.phone
 * @param {string|null} opts.firstName
 * @param {Date|null} opts.scheduledFor
 * @param {string} opts.smsOpeningBody - Full SMS text used when primary === 'sms'
 * @param {string} opts.smsCourtesyIntro - Sentence inserted into out-of-hours courtesy SMS
 * @param {object} [opts.vapiVariables] - Injected into Vapi assistantOverrides.variableValues
 * @param {string} [opts.vapiAssistantId] - Override Vapi assistant ID (multi-tenant)
 * @param {string} opts.endpoint - For error logging
 * @param {(msg:string)=>void} opts.log
 */
export async function executeChannelAction({
  primary,
  actionTaken,
  phone,
  firstName,
  scheduledFor,
  smsOpeningBody,
  smsCourtesyIntro,
  vapiVariables = {},
  vapiAssistantId,
  endpoint,
  log,
}) {
  const twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );

  if (primary === 'call') {
    if (actionTaken === 'call_initiated') {
      try {
        const vapiRes = await axios.post(
          'https://api.vapi.ai/call/phone',
          {
            phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID,
            assistantId: vapiAssistantId ?? process.env.VAPI_ASSISTANT_ID,
            customer: { number: phone },
            assistantOverrides: { variableValues: vapiVariables },
          },
          {
            headers: {
              Authorization: `Bearer ${process.env.VAPI_PRIVATE_KEY}`,
              'Content-Type': 'application/json',
            },
          }
        );
        log(`Call initiated immediately, callId=${vapiRes.data?.id}`);
      } catch (vapiErr) {
        console.error(
          `[${new Date().toISOString()}] [${endpoint}] Errore Vapi:`,
          vapiErr.response?.data ?? vapiErr.message
        );
      }
    } else {
      const greeting = firstName ? `Ciao ${firstName}` : 'Ciao';
      const dayHumanReadable = new Intl.DateTimeFormat('it-IT', {
        timeZone: 'Europe/Rome',
        weekday: 'long',
        day: 'numeric',
        month: 'long',
      }).format(scheduledFor);
      const courtesySms =
        `${greeting}, ${smsCourtesyIntro} Per rispetto delle normative italiane sulle chiamate ` +
        `ti contatteremo ${dayHumanReadable} alle 9:00. Se vuoi parlare prima, rispondi a questo ` +
        `messaggio e ti rispondo subito. Sara di AutoExperience`;
      try {
        const sms = await twilioClient.messages.create({
          body: courtesySms,
          from: process.env.TWILIO_PHONE_NUMBER,
          to: phone,
        });
        log(`Call scheduled for ${scheduledFor.toISOString()}, SMS courtesy sent — sid: ${sms.sid}`);
      } catch (smsErr) {
        console.error(
          `[${new Date().toISOString()}] [${endpoint}] Errore SMS courtesy:`,
          smsErr.message
        );
      }
    }
  } else {
    try {
      const sms = await twilioClient.messages.create({
        body: smsOpeningBody,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: phone,
      });
      log(`Opening SMS sent — sid: ${sms.sid}`);
    } catch (smsErr) {
      console.error(
        `[${new Date().toISOString()}] [${endpoint}] Errore SMS:`,
        smsErr.message
      );
    }
  }
}
