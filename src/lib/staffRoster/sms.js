/**
 * Roster text messages: the one place the wording is built.
 *
 * The database decides who gets a text and which classes it lists
 * (`staff_roster_sms_messages.details`, from the gym's clock); the server
 * (api/admin-publish-announcement.js, action 'send_roster_sms') turns that
 * into the text with `buildRosterSms` and sends it. Screens and tests use the
 * same function, so what a manager reads here is what a coach gets.
 *
 * Kept short and plain: GSM-7 characters only (so each segment holds 160/153
 * characters, not 70), at most three segments, and when the list does not
 * fit it ends "+N more, see the app" with the link.
 */
import { smsSegments } from '../smsCampaigns.js';
import { gymDateOf, gymMinuteOf, minuteLabel, parseDateKey } from './time.js';

export const ROSTER_SMS_DEFAULT_BASE_URL = 'https://www.xertfitness.com.au';
export const ROSTER_SMS_MAX_SEGMENTS = 3;
export const ROSTER_SMS_MAX_LENGTH = 1600; // Twilio's hard limit

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ROLE_WORDS = { lead: 'lead', assistant: 'assistant', shadow: 'shadow' };

// Typographic characters that would force the costly UCS-2 encoding.
/** @type {Array<[RegExp, string]>} */
const REPLACEMENTS = [
  [/[‘’‚‛′]/g, "'"],
  [/[“”„‟″]/g, '"'],
  [/[‐-―−]/g, '-'],
  [/…/g, '...'],
  [/[  -​  　]/g, ' '],
];
const GSM_CHAR = /[A-Za-z0-9 @£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑܧ¿äöñüà]/;

/** Plain, single-line GSM-7 text: smart quotes straightened, anything else dropped. */
export function smsSafeText(value, maxLength = 60) {
  let text = String(value ?? '');
  for (const [pattern, replacement] of REPLACEMENTS) text = text.replace(pattern, replacement);
  // Keep GSM characters; otherwise try the letter without its accent (ë → e).
  text = [...text.normalize('NFC')].map(char => {
    if (GSM_CHAR.test(char)) return char;
    const plain = char.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return plain.length === 1 && GSM_CHAR.test(plain) ? plain : '';
  }).join('');
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? text.slice(0, maxLength).trimEnd() : text;
}

/** `https://…/coaching?tab=roster`, from APP_BASE_URL when it is a valid https origin. */
export function rosterSmsLink(baseUrl = '') {
  let origin = ROSTER_SMS_DEFAULT_BASE_URL;
  try {
    const url = new URL(String(baseUrl || '').trim());
    if (url.protocol === 'https:' && url.hostname) origin = url.origin;
  } catch { /* the default */ }
  return `${origin}/coaching?tab=roster`;
}

/** `Tue 13 Oct` for a gym date key (the same style as the roster screens). */
export function smsDayLabel(dateKey) {
  const { year, month, day } = parseDateKey(dateKey);
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  return `${weekday} ${day} ${MONTHS[month - 1].slice(0, 3)}`;
}

/** `Tue 13 Oct 5:15am`, on the gym's clock whatever zone the server runs in. */
export function smsWhen(instant) {
  const date = gymDateOf(instant);
  if (!date) return '';
  return `${smsDayLabel(date)} ${minuteLabel(gymMinuteOf(instant)).replace(' ', '')}`;
}

function monthName(monthDate) {
  const month = Number(String(monthDate || '').slice(5, 7));
  return MONTHS[month - 1] || 'next month';
}

function roleNote(role) {
  return role && role !== 'lead' && ROLE_WORDS[role] ? ` (${ROLE_WORDS[role]})` : '';
}

/** One class as listed in a text. */
export function rosterSmsLine(line, kind = 'published') {
  const title = smsSafeText(line?.title, 30) || 'Class';
  const what = `${smsWhen(line?.start)} ${title}`;
  if (kind === 'published' || !line?.change) return `${what}${roleNote(line?.role)}`;
  if (line.change === 'added') return `added ${what}${roleNote(line.role)}`;
  if (line.change === 'removed') return `removed ${what}`;
  if (line.change === 'moved') return `moved ${smsWhen(line.was)} ${title} to ${smsWhen(line.start)}`;
  if (line.change === 'role') return `now ${ROLE_WORDS[line.role] || 'coaching'} on ${what}`;
  return what;
}

function fits(text, maxSegments) {
  return text.length <= ROSTER_SMS_MAX_LENGTH && smsSegments(text).segments <= maxSegments;
}

/**
 * The text for one queued message.
 * @param message `{ kind: 'published'|'changed', details: { first_name, month, starts_on, lines } }`
 */
export function buildRosterSms(message, { baseUrl = '', maxSegments = ROSTER_SMS_MAX_SEGMENTS } = {}) {
  const kind = message?.kind === 'changed' ? 'changed' : 'published';
  const details = message?.details || {};
  const name = smsSafeText(details.first_name, 20);
  const hi = name ? `XERT: Hi ${name}, ` : 'XERT: Hi, ';
  const month = monthName(details.month);
  let from = '';
  if (kind === 'published' && details.starts_on) {
    try { from = ` (from ${smsDayLabel(details.starts_on).slice(4)})`; } catch { from = ''; }
  }
  const head = kind === 'published' ? `${hi}your ${month} classes${from}: ` : `${hi}your ${month} roster changed: `;
  const link = rosterSmsLink(baseUrl);
  const items = (Array.isArray(details.lines) ? details.lines : []).map(line => rosterSmsLine(line, kind)).filter(Boolean);
  if (items.length === 0) return `${head.replace(/: $/, '')}. See all: ${link}`;

  const whole = `${head}${items.join('; ')}. See all: ${link}`;
  if (fits(whole, maxSegments)) return whole;
  // Keep as many classes as fit, then say how many more there are.
  for (let shown = items.length - 1; shown >= 1; shown -= 1) {
    const text = `${head}${items.slice(0, shown).join('; ')}; +${items.length - shown} more, see the app: ${link}`;
    if (fits(text, maxSegments)) return text;
  }
  return `${head}${items.length} ${items.length === 1 ? 'class' : 'classes'}, see the app: ${link}`;
}

/** Plain words for why a text was not sent, for the manager screens. */
export const ROSTER_SMS_REASONS = Object.freeze({
  NO_MOBILE: 'no mobile number',
  MOBILE_INVALID: 'mobile number not valid',
  NO_ACCOUNT: 'no sign-in linked',
  OPTED_OUT: 'turned texts off',
  INACTIVE: 'inactive',
  SMS_SWITCHED_OFF: 'texts switched off',
  REPLACED_BY_NEWER: 'replaced by a newer text',
});

export function rosterSmsReason(reason) {
  if (!reason) return 'not sent';
  if (ROSTER_SMS_REASONS[reason]) return ROSTER_SMS_REASONS[reason];
  if (/^RETRIES_EXHAUSTED/.test(reason)) return 'failed after 3 tries';
  if (/RECIPIENT_UNSUBSCRIBED/.test(reason)) return 'replied STOP to texts';
  return 'not delivered';
}

/**
 * "4 sent, 1 no mobile number (Cam)" for a revision's texts
 * (`staff_roster_sms_status(...).messages`).
 */
export function rosterSmsSummary(messages = []) {
  const rows = Array.isArray(messages) ? messages : [];
  const parts = [];
  const sent = rows.filter(row => row.status === 'sent').length;
  const waiting = rows.filter(row => row.status === 'pending' || row.status === 'sending').length;
  if (sent) parts.push(`${sent} sent`);
  if (waiting) parts.push(`${waiting} sending`);
  const groups = new Map();
  for (const row of rows) {
    if (row.status !== 'failed' && row.status !== 'skipped') continue;
    const label = rosterSmsReason(row.reason);
    const key = row.status === 'failed' ? `failed, ${label}` : label;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row.name || 'a coach');
  }
  for (const [label, names] of groups) parts.push(`${names.length} ${label} (${names.join(', ')})`);
  return parts.length ? parts.join(', ') : 'No texts for this version';
}
