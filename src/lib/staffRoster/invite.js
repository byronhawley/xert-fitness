/**
 * Coach invite links: `https://<host>/coach-invite#token=<64 hex>`.
 *
 * The token travels in the URL fragment, which browsers never send to a
 * server, so it stays out of request logs and referrers. The page moves it
 * into this browser's storage and strips it from the address bar straight
 * away, so it survives signing in or creating an account (including the
 * email-confirmation round trip in the same browser) without ever being put
 * in a `?next=` query string.
 */

export const INVITE_PATH = '/coach-invite';
export const INVITE_STORAGE_KEY = 'xert.coachInvite';
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const KEEP_MS = 24 * 60 * 60 * 1000;

export function normalizeInviteToken(value) {
  const token = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return TOKEN_PATTERN.test(token) ? token : null;
}

/** The token from a location hash such as `#token=abc…`, or null. */
export function inviteTokenFromHash(hash) {
  if (typeof hash !== 'string' || !hash) return null;
  try {
    return normalizeInviteToken(new URLSearchParams(hash.replace(/^#/, '')).get('token'));
  } catch {
    return null;
  }
}

export function inviteLink(origin, token) {
  return `${String(origin).replace(/\/+$/, '')}${INVITE_PATH}#token=${token}`;
}

export function rememberInviteToken(token, storage = globalThis.localStorage, now = Date.now()) {
  const normalized = normalizeInviteToken(token);
  if (!normalized) return;
  try { storage?.setItem(INVITE_STORAGE_KEY, JSON.stringify({ token: normalized, savedAt: now })); } catch { /* storage can be blocked */ }
}

export function recallInviteToken(storage = globalThis.localStorage, now = Date.now()) {
  try {
    const saved = JSON.parse(storage?.getItem(INVITE_STORAGE_KEY) || 'null');
    if (!saved || typeof saved.savedAt !== 'number' || now - saved.savedAt > KEEP_MS || saved.savedAt > now + 60000) return null;
    return normalizeInviteToken(saved.token);
  } catch {
    return null;
  }
}

export function forgetInviteToken(storage = globalThis.localStorage) {
  try { storage?.removeItem(INVITE_STORAGE_KEY); } catch { /* storage can be blocked */ }
}

/** Plain words for every outcome the invite functions can return. */
export const INVITE_OUTCOMES = Object.freeze({
  INVITE_INVALID: ['This invite link doesn’t work', 'Check you copied the whole link, or ask the manager for a new one.'],
  INVITE_EXPIRED: ['This invite has expired', 'Invites last 14 days. Ask the manager to send you a new link.'],
  INVITE_USED: ['This invite has already been used', 'Each link works once. If that wasn’t you, tell the manager.'],
  INVITE_REVOKED: ['This invite was cancelled', 'The manager may have sent you a newer link. Use the latest one, or ask them for a new one.'],
  TOO_MANY_ATTEMPTS: ['Too many tries', 'Wait 15 minutes, then open the link again.'],
  ACCOUNT_ALREADY_LINKED: ['This sign-in is already on the coach roster', 'Sign out and use a different account, or ask the manager.'],
  STAFF_ALREADY_LINKED: ['This coach already has a sign-in', 'Ask the manager if you need access.'],
  STAFF_INACTIVE: ['This invite is paused', 'Your coach record is inactive. Talk to the manager.'],
  PROFILE_NOT_READY: ['Your account is still being set up', 'Wait a moment and try again.'],
});

/** Manager-facing words for an invite's state. */
export const INVITE_STATUS_LABELS = Object.freeze({
  pending: 'Invite sent', expired: 'Invite expired', accepted: 'Joined', revoked: 'Invite cancelled',
});
