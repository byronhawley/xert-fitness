/**
 * Client-0 operator health is an observational surface only.
 *
 * It summarizes whether the configured environment *could* arm the existing,
 * separately gated calendar paths. It never contacts XertOS, never probes a
 * provider transport, never reads a database, and never returns secrets.
 */

export const CLIENT0_PROVIDER = 'xert_fitness';
export const CLIENT0_OPERATOR_SURFACE = 'read_only';
export const CLIENT0_EXACT_WRITE_ENDPOINT = '/api/xertos-webhook';

function isExactTrue(value) {
  return value === 'true';
}

function safeTrimmed(value) {
  return String(value ?? '').trim();
}

function isHttpsUrl(value) {
  try {
    return new URL(safeTrimmed(value)).protocol === 'https:';
  } catch {
    return false;
  }
}

function strictPositiveVersion(value) {
  const text = safeTrimmed(value);
  if (!/^\d+$/.test(text)) return null;
  const version = Number(text);
  return Number.isSafeInteger(version) && version > 0 ? version : null;
}

function configured(value) {
  return safeTrimmed(value).length > 0;
}

/**
 * Build a deterministic, secret-free snapshot for the authenticated operator
 * health endpoint. `environment` is injected so tests and callers remain pure.
 */
export function client0OperatorHealthSnapshot(environment = {}) {
  const apiUrlConfigured = isHttpsUrl(environment.XERTOS_API_URL);
  const clientIdConfigured = configured(environment.XERTOS_CLIENT_ID);
  const clientSecretConfigured = configured(environment.XERTOS_CLIENT_SECRET);
  const dispatchSecretConfigured = safeTrimmed(environment.XERTOS_SYNC_DISPATCH_SECRET).length >= 32;
  const outboundPushReady = apiUrlConfigured
    && clientIdConfigured
    && clientSecretConfigured
    && dispatchSecretConfigured;

  const syncEnabled = isExactTrue(environment.CLIENT0_SYNC_ENABLED);
  const calendarWritesEnabled = isExactTrue(environment.CLIENT0_CALENDAR_WRITES_ENABLED);

  const writeSecretConfigured = configured(environment.XERTOS_WRITE_SECRET);
  const writeSecretVersion = strictPositiveVersion(environment.XERTOS_WRITE_SECRET_VERSION);
  const previousWriteSecretConfigured = configured(environment.XERTOS_PREVIOUS_WRITE_SECRET);
  const previousWriteSecretVersion = strictPositiveVersion(environment.XERTOS_PREVIOUS_WRITE_SECRET_VERSION);
  const previousWriteSecretPairConfigured = previousWriteSecretConfigured
    ? previousWriteSecretVersion !== null && previousWriteSecretVersion !== writeSecretVersion
    : true;
  const webhookTransportReady = writeSecretConfigured
    && writeSecretVersion !== null
    && previousWriteSecretPairConfigured;

  const siteSecretConfigured = safeTrimmed(environment.XERTOS_SITE_SECRET).length >= 16;
  const inboundEditConfigured = webhookTransportReady && siteSecretConfigured;
  const calendarWriteGatesEnabled = syncEnabled && calendarWritesEnabled;
  const calendarMutationPathReady = calendarWriteGatesEnabled && inboundEditConfigured;

  return {
    surface: CLIENT0_OPERATOR_SURFACE,
    provider: CLIENT0_PROVIDER,
    exactWriteEndpoint: CLIENT0_EXACT_WRITE_ENDPOINT,
    providerCalls: false,
    providerMutation: false,
    flags: {
      syncEnabled,
      calendarWritesEnabled,
      bothEnabled: calendarWriteGatesEnabled,
    },
    outbound: {
      push: {
        ready: outboundPushReady,
        apiUrlConfigured,
        clientIdConfigured,
        clientSecretConfigured,
        dispatchSecretConfigured,
      },
    },
    inbound: {
      calendarEdit: {
        configured: inboundEditConfigured,
        webhookTransportReady,
        writeSecretConfigured,
        writeSecretVersion,
        previousWriteSecretConfigured,
        previousWriteSecretVersion,
        previousWriteSecretPairConfigured,
        siteSecretConfigured,
      },
    },
    calendar: {
      mutationPathReady: calendarMutationPathReady,
    },
  };
}
