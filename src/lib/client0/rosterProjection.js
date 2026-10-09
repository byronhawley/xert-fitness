import { createHash } from 'node:crypto';

export const CLIENT0_ROSTER_PROJECTION_SCHEMA_VERSION = 'client0.roster.projection.v1';
export const CLIENT0_ROSTER_PROJECTION_FINGERPRINT_VERSION = 'client0-roster-projection-v1';
export const CLIENT0_ROSTER_PROJECTION_MAX_ASSIGNMENTS = 1000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;
const MONTH_DAY_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])-01$/;
const SLOT_KEYS = new Set([
  'lead',
  'assistant',
  'assistant-2',
  'assistant-3',
  'assistant-4',
  'assistant-5',
  'assistant-6',
]);
const ASSIGNMENT_ROLES = new Set(['lead', 'assistant']);
const PROJECTION_FIELDS = Object.freeze([
  'assignments',
  'month',
  'revisionId',
  'revisionNumber',
  'schemaVersion',
  'sourceRevisionVersion',
  'sourceUpdatedAt',
]);
const ASSIGNMENT_FIELDS = Object.freeze([
  'publicCoachName',
  'sessionId',
  'slotKey',
  'sourceStaffId',
]);

export class Client0RosterProjectionError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'Client0RosterProjectionError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function invalid(code, field, message = 'Client-0 roster projection field is out of contract.') {
  return new Client0RosterProjectionError(code, message, { field });
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeUuid(value, field) {
  if (typeof value !== 'string' || value.trim() !== value || !UUID_PATTERN.test(value)) {
    throw invalid('REVISION_FIELD_INVALID', field, 'Client-0 roster id is not a safe UUID.');
  }
  return value.toLowerCase();
}

function normalizePositiveInteger(value, field) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw invalid('REVISION_FIELD_INVALID', field, 'Client-0 roster number must be a positive safe integer.');
  }
  return value;
}

function normalizeMonth(value, field) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())
      || value.getUTCFullYear() < 1
      || value.getUTCMonth() !== 0
      || value.getUTCDate() !== 1
      || value.getUTCHours() !== 0
      || value.getUTCMinutes() !== 0
      || value.getUTCSeconds() !== 0
      || value.getUTCMilliseconds() !== 0) {
      throw invalid('REVISION_FIELD_INVALID', field, 'Client-0 roster month must be the first day of a month.');
    }
    return `${String(value.getUTCFullYear()).padStart(4, '0')}-${String(value.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  if (typeof value !== 'string' || value.trim() !== value) {
    throw invalid('REVISION_FIELD_INVALID', field, 'Client-0 roster month is invalid.');
  }
  const monthOnly = MONTH_PATTERN.exec(value);
  if (monthOnly) return value;
  const monthDay = MONTH_DAY_PATTERN.exec(value);
  if (monthDay) return `${monthDay[1]}-${monthDay[2]}`;
  throw invalid('REVISION_FIELD_INVALID', field, 'Client-0 roster month is invalid.');
}

function normalizeTimestamp(value, field) {
  if (typeof value === 'string' && value.trim() !== value) {
    throw invalid('REVISION_FIELD_INVALID', field, 'Client-0 roster timestamp is invalid.');
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw invalid('REVISION_FIELD_INVALID', field, 'Client-0 roster timestamp is invalid.');
  }
  return date.toISOString();
}

function normalizeState(value, field) {
  if (value !== 'published') {
    throw new Client0RosterProjectionError(
      'REVISION_NOT_PUBLISHED',
      'Client-0 roster projection accepts only a published revision.',
      { field, state: value },
    );
  }
  return value;
}

function normalizeOptionalSupersededAt(value, field) {
  if (value === undefined || value === null) return null;
  throw new Client0RosterProjectionError(
    'REVISION_NOT_PUBLISHED',
    'A published Client-0 roster revision cannot be superseded.',
    { field },
  );
}

function normalizeSlotKey(value, field) {
  if (typeof value !== 'string' || !SLOT_KEYS.has(value)) {
    throw invalid('ASSIGNMENT_OUT_OF_CONTRACT', field, 'Client-0 roster slot is out of contract.');
  }
  return value;
}

function normalizeAssignmentRole(value, field) {
  if (typeof value !== 'string' || !ASSIGNMENT_ROLES.has(value)) {
    throw invalid('ASSIGNMENT_OUT_OF_CONTRACT', field, 'Client-0 roster assignment role is out of contract.');
  }
  return value;
}

function normalizePublicCoachName(value, field) {
  if (typeof value !== 'string'
    || value.trim() !== value
    || value.length === 0
    || value.length > 80
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw invalid('STAFF_MAPPING_INVALID', field, 'Client-0 public coach name is invalid.');
  }
  return value;
}

/**
 * Read one canonical value from camelCase or database-shaped snake_case input.
 * If aliases are present more than once, every spelling must agree.
 */
function readAliasedField(source, aliases, normalize) {
  const present = aliases
    .filter(alias => Object.prototype.hasOwnProperty.call(source, alias) && source[alias] !== undefined)
    .map(alias => ({ alias, value: normalize(source[alias], alias) }));
  if (present.length === 0) {
    throw invalid('REVISION_FIELD_REQUIRED', aliases[0], 'Client-0 roster projection field is required.');
  }
  for (const item of present.slice(1)) {
    if (item.value !== present[0].value) {
      throw new Client0RosterProjectionError(
        'REVISION_FIELD_CONFLICT',
        'Client-0 roster projection input has conflicting field aliases.',
        { fields: present.map(item => item.alias) },
      );
    }
  }
  return present[0].value;
}

function readOptionalAliasedField(source, aliases, normalize) {
  const presentAliases = aliases
    .filter(alias => Object.prototype.hasOwnProperty.call(source, alias) && source[alias] !== undefined);
  if (presentAliases.length === 0) return null;
  const hasNull = presentAliases.some(alias => source[alias] === null);
  const hasNonNull = presentAliases.some(alias => source[alias] !== null);
  if (hasNull && hasNonNull) {
    throw new Client0RosterProjectionError(
      'REVISION_FIELD_CONFLICT',
      'Client-0 roster projection input has conflicting field aliases.',
      { fields: presentAliases },
    );
  }
  const present = presentAliases
    .map(alias => ({ alias, value: normalize(source[alias], alias) }));
  for (const item of present.slice(1)) {
    if (item.value !== present[0].value) {
      throw new Client0RosterProjectionError(
        'REVISION_FIELD_CONFLICT',
        'Client-0 roster projection input has conflicting field aliases.',
        { fields: present.map(item => item.alias) },
      );
    }
  }
  return present[0].value;
}

function normalizeStaffPublicNames(value, required) {
  if (value === undefined || value === null) {
    if (!required) return new Map();
    throw new Client0RosterProjectionError(
      'STAFF_MAPPING_REQUIRED',
      'Client-0 roster projection requires a staff public-name mapping.',
    );
  }

  const entries = value instanceof Map
    ? [...value.entries()].map(([staffId, publicCoachName]) => ({ staffId, publicCoachName }))
    : value;
  if (!Array.isArray(entries)) {
    throw new Client0RosterProjectionError(
      'STAFF_MAPPING_INVALID',
      'Client-0 staff mapping must be an array or Map.',
    );
  }

  const staffByName = new Map();
  entries.forEach((entry, index) => {
    if (!plainObject(entry)) {
      throw new Client0RosterProjectionError(
        'STAFF_MAPPING_INVALID',
        'Client-0 staff mapping entry is invalid.',
        { index },
      );
    }
    const staffId = readAliasedField(
      entry,
      ['staffId', 'sourceStaffId', 'staff_id'],
      (value, field) => normalizeUuid(value, `staffPublicNames.${index}.${field}`),
    );
    const publicCoachName = readAliasedField(
      entry,
      ['publicCoachName', 'public_coach_name'],
      (value, field) => normalizePublicCoachName(
        value,
        `staffPublicNames.${index}.publicCoachName`,
      ),
    );
    if (staffByName.has(staffId)) {
      throw new Client0RosterProjectionError(
        'STAFF_MAPPING_AMBIGUOUS',
        'Client-0 staff mapping contains more than one name for a staff id.',
        { staffId },
      );
    }
    staffByName.set(staffId, publicCoachName);
  });
  return staffByName;
}

function compareCanonicalText(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function projectionAssignment(rawAssignment, index, staffByName) {
  if (!plainObject(rawAssignment)) {
    throw new Client0RosterProjectionError(
      'ASSIGNMENT_OUT_OF_CONTRACT',
      'Client-0 roster assignment is invalid.',
      { index },
    );
  }

  const sessionId = readAliasedField(
    rawAssignment,
    ['sessionId', 'session_id'],
    (value, field) => normalizeUuid(value, `assignments.${index}.${field}`),
  );
  const slotKey = readAliasedField(
    rawAssignment,
    ['slotKey', 'slot_key'],
    (value, field) => normalizeSlotKey(value, `assignments.${index}.${field}`),
  );
  const sourceStaffId = readAliasedField(
    rawAssignment,
    ['sourceStaffId', 'source_staff_id', 'staffId', 'staff_id'],
    (value, field) => normalizeUuid(value, `assignments.${index}.${field}`),
  );
  normalizeAssignmentRole(
    rawAssignment.role,
    `assignments.${index}.role`,
  );

  if (!staffByName.has(sourceStaffId)) {
    throw new Client0RosterProjectionError(
      'STAFF_MAPPING_MISSING',
      'Client-0 roster assignment has no staff public-name mapping.',
      { index, staffId: sourceStaffId },
    );
  }

  return {
    sessionId,
    slotKey,
    sourceStaffId,
    publicCoachName: staffByName.get(sourceStaffId),
  };
}

function projectionRevision(revision) {
  if (!plainObject(revision)) {
    throw new Client0RosterProjectionError(
      'REVISION_REQUIRED',
      'Client-0 roster projection requires a revision.',
    );
  }

  normalizeState(
    readAliasedField(revision, ['state', 'sourceState'], value => value),
    'state',
  );
  normalizeOptionalSupersededAt(
    readOptionalAliasedField(
      revision,
      ['supersededAt', 'superseded_at'],
      normalizeOptionalSupersededAt,
    ),
    'supersededAt',
  );

  return {
    revisionId: readAliasedField(
      revision,
      ['revisionId', 'id', 'revision_id'],
      (value, field) => normalizeUuid(value, field),
    ),
    month: readAliasedField(
      revision,
      ['month'],
      (value, field) => normalizeMonth(value, field),
    ),
    revisionNumber: readAliasedField(
      revision,
      ['revisionNumber', 'number'],
      (value, field) => normalizePositiveInteger(value, field),
    ),
    sourceRevisionVersion: readAliasedField(
      revision,
      ['sourceRevisionVersion', 'version'],
      (value, field) => normalizePositiveInteger(value, field),
    ),
    sourceUpdatedAt: readAliasedField(
      revision,
      ['sourceUpdatedAt', 'source_updated_at', 'publishedAt', 'published_at'],
      (value, field) => normalizeTimestamp(value, field),
    ),
  };
}

/**
 * Project one already-published XERT roster revision into the merged Client-0
 * H2 shape. This is intentionally read-only: it performs no I/O and has no
 * feature flag, dispatch, endpoint, or mutation behavior.
 */
export function projectClient0RosterRevision({
  revision,
  assignments,
  staffPublicNames,
} = {}) {
  if (!Array.isArray(assignments)) {
    throw new Client0RosterProjectionError(
      'ASSIGNMENTS_REQUIRED',
      'Client-0 roster projection requires an assignment array.',
    );
  }
  if (assignments.length > CLIENT0_ROSTER_PROJECTION_MAX_ASSIGNMENTS) {
    throw new Client0RosterProjectionError(
      'TOO_MANY_ASSIGNMENTS',
      'Client-0 roster projection exceeds its assignment bound.',
      { limit: CLIENT0_ROSTER_PROJECTION_MAX_ASSIGNMENTS, received: assignments.length },
    );
  }

  const staffByName = normalizeStaffPublicNames(staffPublicNames, assignments.length > 0);
  const projectedRevision = projectionRevision(revision);

  const projectedAssignments = assignments.map((assignment, index) => projectionAssignment(
    assignment,
    index,
    staffByName,
  ));
  const seenSlots = new Set();
  const seenStaff = new Set();
  for (const assignment of projectedAssignments) {
    const slotKey = `${assignment.sessionId}\u001f${assignment.slotKey}`;
    const staffKey = `${assignment.sessionId}\u001f${assignment.sourceStaffId}`;
    if (seenSlots.has(slotKey)) {
      throw new Client0RosterProjectionError(
        'DUPLICATE_ASSIGNMENT',
        'Client-0 roster has duplicate session and slot assignments.',
        { sessionId: assignment.sessionId, slotKey: assignment.slotKey },
      );
    }
    if (seenStaff.has(staffKey)) {
      throw new Client0RosterProjectionError(
        'DUPLICATE_ASSIGNMENT',
        'Client-0 roster has duplicate session and staff assignments.',
        { sessionId: assignment.sessionId, sourceStaffId: assignment.sourceStaffId },
      );
    }
    seenSlots.add(slotKey);
    seenStaff.add(staffKey);
  }

  projectedAssignments.sort((left, right) => compareCanonicalText(left.sessionId, right.sessionId)
    || compareCanonicalText(left.slotKey, right.slotKey)
    || compareCanonicalText(left.sourceStaffId, right.sourceStaffId));

  return {
    schemaVersion: CLIENT0_ROSTER_PROJECTION_SCHEMA_VERSION,
    month: projectedRevision.month,
    revisionId: projectedRevision.revisionId,
    revisionNumber: projectedRevision.revisionNumber,
    sourceRevisionVersion: projectedRevision.sourceRevisionVersion,
    sourceUpdatedAt: projectedRevision.sourceUpdatedAt,
    assignments: projectedAssignments,
  };
}

function canonicalize(value, path = '$') {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new Client0RosterProjectionError(
        'CANONICAL_JSON_INVALID',
        'Client-0 canonical JSON contains an unsupported number.',
        { path },
      );
    }
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map((item, index) => canonicalize(item, `${path}.${index}`)).join(',')}]`;
  if (plainObject(value)) {
    const fields = Object.keys(value).sort(compareCanonicalText);
    return `{${fields.map(key => `${JSON.stringify(key)}:${canonicalize(value[key], `${path}.${key}`)}`).join(',')}}`;
  }
  throw new Client0RosterProjectionError(
    'CANONICAL_JSON_INVALID',
    'Client-0 canonical JSON contains an unsupported value.',
    { path },
  );
}

function assertExactProjectionShape(value) {
  if (!plainObject(value) || Object.keys(value).length !== PROJECTION_FIELDS.length
    || !PROJECTION_FIELDS.every(field => Object.prototype.hasOwnProperty.call(value, field))) {
    throw new Client0RosterProjectionError(
      'PROJECTION_SHAPE_INVALID',
      'Client-0 canonical JSON accepts only the merged H2 projection shape.',
    );
  }
  if (value.schemaVersion !== CLIENT0_ROSTER_PROJECTION_SCHEMA_VERSION
    || !Array.isArray(value.assignments)
    || value.assignments.some(assignment => !plainObject(assignment)
      || Object.keys(assignment).length !== ASSIGNMENT_FIELDS.length
      || !ASSIGNMENT_FIELDS.every(field => Object.prototype.hasOwnProperty.call(assignment, field)))) {
    throw new Client0RosterProjectionError(
      'PROJECTION_SHAPE_INVALID',
      'Client-0 canonical JSON accepts only merged H2 assignment rows.',
    );
  }
}

/**
 * Canonical JSON is UTF-8 text produced with object keys sorted by UTF-16 code
 * unit, array order preserved, no insignificant whitespace, no `-0`, and no
 * non-finite numbers. Array order is meaningful and is fixed by
 * `projectClient0RosterRevision`.
 */
export function canonicalClient0RosterProjectionJson(projection) {
  assertExactProjectionShape(projection);
  return canonicalize(projection);
}

/**
 * Fingerprint is lowercase hex SHA-256 over UTF-8 bytes of:
 *   `${CLIENT0_ROSTER_PROJECTION_FINGERPRINT_VERSION}\n${canonicalJson}`
 */
export function client0RosterProjectionFingerprint(projection) {
  return createHash('sha256')
    .update(`${CLIENT0_ROSTER_PROJECTION_FINGERPRINT_VERSION}\n${canonicalClient0RosterProjectionJson(projection)}`, 'utf8')
    .digest('hex');
}
