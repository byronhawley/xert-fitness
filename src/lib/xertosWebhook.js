import { createHmac, timingSafeEqual } from 'node:crypto';

export const XERTOS_PROVIDER = 'xert_fitness';
export const SIGNATURE_TOLERANCE_SECONDS = 300;

function configuredSecrets(environment) {
  const secrets = [];
  const current = String(environment.XERTOS_WRITE_SECRET || '').trim();
  const currentVersion = Number.parseInt(environment.XERTOS_WRITE_SECRET_VERSION || '1', 10);
  if (current) secrets.push({ version: Number.isInteger(currentVersion) && currentVersion > 0 ? currentVersion : 1, secret: current });

  const previous = String(environment.XERTOS_PREVIOUS_WRITE_SECRET || '').trim();
  const previousVersion = Number.parseInt(environment.XERTOS_PREVIOUS_WRITE_SECRET_VERSION || '', 10);
  if (previous && Number.isInteger(previousVersion) && previousVersion > 0) {
    secrets.push({ version: previousVersion, secret: previous });
  }
  return secrets;
}

function signaturePayload(secret, timestamp, body) {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

function equalHex(left, right) {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function xertosSecretsAreConfigured(environment = process.env) {
  return configuredSecrets(environment).length > 0;
}

export function verifyXertosSignature({
  signatureHeader = '',
  timestampHeader = '',
  rawBody = '',
  environment = process.env,
  now = Math.floor(Date.now() / 1000),
  toleranceSeconds = SIGNATURE_TOLERANCE_SECONDS,
} = {}) {
  const timestamp = Number.parseInt(timestampHeader, 10);
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > toleranceSeconds) return false;

  return String(signatureHeader || '')
    .split(/\s+/)
    .filter(Boolean)
    .some(part => {
      const match = /^v1,k(\d+)=([0-9a-f]{64})$/.exec(part);
      if (!match) return false;
      const secret = configuredSecrets(environment).find(candidate => candidate.version === Number(match[1]));
      if (!secret) return false;
      return equalHex(match[2], signaturePayload(secret.secret, timestamp, rawBody));
    });
}

export function xertosWebhookConfigError(environment = process.env) {
  if (!xertosSecretsAreConfigured(environment)) return 'XERTOS_WRITE_SECRET is not configured';
  if (String(environment.XERTOS_WRITE_SECRET_VERSION || '1').trim() === '') return 'XERTOS_WRITE_SECRET_VERSION is not configured';
  return null;
}
