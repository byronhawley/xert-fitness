import { createHash } from 'node:crypto';

import { CLIENT0_ROSTER_PROJECTION_SCHEMA_VERSION } from './rosterProjection.js';

export const CLIENT0_H2_WIRE_SCHEMA_VERSION = 1;
export const CLIENT0_H2_MAX_ASSIGNMENTS = 1000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;
const TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;
const SLOT_KEYS = new Set([
  'lead',
  'assistant',
  'assistant-2',
  'assistant-3',
  'assistant-4',
  'assistant-5',
  'assistant-6',
]);
const PRODUCER_FIELDS = Object.freeze([
  'assignments',
  'month',
  'revisionId',
  'revisionNumber',
  'schemaVersion',
  'sourceRevisionVersion',
  'sourceUpdatedAt',
]);
const PRODUCER_ASSIGNMENT_FIELDS = Object.freeze([
  'publicCoachName',
  'sessionId',
  'slotKey',
  'sourceStaffId',
]);
const H2_FIELDS = Object.freeze([
  'assignments',
  'month',
  'revisionId',
  'revisionNumber',
  'schemaVersion',
  'sourceRevisionVersion',
  'sourceUpdatedAt',
]);
const H2_ASSIGNMENT_FIELDS = Object.freeze([
  'publicCoachName',
  'sessionId',
  'slotKey',
  'sourceStaffId',
]);

export class Client0H2BoundaryError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'Client0H2BoundaryError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function boundaryError(code, message, details) {
  return new Client0H2BoundaryError(code, message, details);
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactFields(value, fields) {
  return plainObject(value)
    && Object.keys(value).length === fields.length
    && fields.every(field => Object.prototype.hasOwnProperty.call(value, field));
}

function assertExactFields(value, fields, code, message) {
  if (!hasExactFields(value, fields)) {
    throw boundaryError(code, message, { expected: [...fields], received: plainObject(value) ? Object.keys(value) : null });
  }
}

function assertWellFormedUnicode(value, field) {
  for (const character of value) {
    if (character.length !== 1) continue;
    const codePoint = character.codePointAt(0);
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
      throw boundaryError('H2_STRING_INVALID', 'Client-0 H2 string contains a lone surrogate.', { field });
    }
  }
}

function normalizeUuid(value, field) {
  if (typeof value !== 'string' || value.trim() !== value || !UUID_PATTERN.test(value)) {
    throw boundaryError('H2_FIELD_INVALID', 'Client-0 H2 identifier is invalid.', { field });
  }
  assertWellFormedUnicode(value, field);
  return value.toLowerCase();
}

function normalizePositiveInteger(value, field) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw boundaryError('H2_FIELD_INVALID', 'Client-0 H2 number must be a positive safe integer.', { field });
  }
  return value;
}

function normalizeMonth(value, field) {
  if (typeof value !== 'string' || !MONTH_PATTERN.test(value)) {
    throw boundaryError('H2_FIELD_INVALID', 'Client-0 H2 month is invalid.', { field });
  }
  return value;
}

function normalizeTimestamp(value, field) {
  const match = typeof value === 'string' ? TIMESTAMP_PATTERN.exec(value) : null;
  if (!match) {
    throw boundaryError('H2_FIELD_INVALID', 'Client-0 H2 timestamp is invalid.', { field });
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = '', zone] = match;
  if (secondText === '60' || zone === '-00:00') {
    throw boundaryError('H2_FIELD_INVALID', 'Client-0 H2 timestamp is invalid.', { field });
  }
  const milliseconds = Number((fraction + '000').slice(0, 3));
  if (fraction.length > 3 && /[^0]/.test(fraction.slice(3))) {
    throw boundaryError('H2_FIELD_INVALID', 'Client-0 H2 timestamp cannot be normalized without rounding.', { field });
  }
  const parts = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  const wall = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5], milliseconds));
  if (
    wall.getUTCFullYear() !== parts[0]
    || wall.getUTCMonth() + 1 !== parts[1]
    || wall.getUTCDate() !== parts[2]
    || wall.getUTCHours() !== parts[3]
    || wall.getUTCMinutes() !== parts[4]
    || wall.getUTCSeconds() !== parts[5]
    || wall.getUTCMilliseconds() !== milliseconds
  ) {
    throw boundaryError('H2_FIELD_INVALID', 'Client-0 H2 timestamp is invalid.', { field });
  }
  let instant = wall;
  if (zone !== 'Z') {
    const offsetHours = Number(zone.slice(1, 3));
    const offsetMinutes = Number(zone.slice(4, 6));
    if (offsetHours > 23 || offsetMinutes > 59) {
      throw boundaryError('H2_FIELD_INVALID', 'Client-0 H2 timestamp offset is invalid.', { field });
    }
    const direction = zone[0] === '+' ? -1 : 1;
    instant = new Date(wall.getTime() + direction * (offsetHours * 60 + offsetMinutes) * 60000);
  }
  return `${instant.toISOString().slice(0, 23)}Z`;
}

function normalizeProducerAssignment(assignment, index) {
  assertExactFields(
    assignment,
    PRODUCER_ASSIGNMENT_FIELDS,
    'H2_ASSIGNMENT_INVALID',
    'Client-0 producer assignment is not an exact R2 projection row.',
  );
  if (!SLOT_KEYS.has(assignment.slotKey)) {
    throw boundaryError('H2_FIELD_INVALID', 'Client-0 H2 slot is invalid.', {
      field: `assignments.${index}.slotKey`,
    });
  }
  if (
    typeof assignment.publicCoachName !== 'string'
    || assignment.publicCoachName.trim() !== assignment.publicCoachName
    || assignment.publicCoachName.length === 0
    || assignment.publicCoachName.length > 80
    || /[\u0000-\u001f\u007f]/.test(assignment.publicCoachName)
  ) {
    throw boundaryError('H2_FIELD_INVALID', 'Client-0 H2 public coach name is invalid.', {
      field: `assignments.${index}.publicCoachName`,
    });
  }
  assertWellFormedUnicode(assignment.publicCoachName, `assignments.${index}.publicCoachName`);
  return {
    publicCoachName: assignment.publicCoachName,
    sessionId: normalizeUuid(assignment.sessionId, `assignments.${index}.sessionId`),
    slotKey: assignment.slotKey,
    sourceStaffId: normalizeUuid(assignment.sourceStaffId, `assignments.${index}.sourceStaffId`),
  };
}

function normalizeProducerProjection(projection) {
  assertExactFields(
    projection,
    PRODUCER_FIELDS,
    'H2_PROJECTION_INVALID',
    'Client-0 producer input is not an exact R2 projection.',
  );
  if (projection.schemaVersion !== CLIENT0_ROSTER_PROJECTION_SCHEMA_VERSION) {
    throw boundaryError('H2_PROJECTION_INVALID', 'Client-0 producer projection schema is invalid.', {
      field: 'schemaVersion',
    });
  }
  if (!Array.isArray(projection.assignments) || projection.assignments.length > CLIENT0_H2_MAX_ASSIGNMENTS) {
    throw boundaryError('H2_ASSIGNMENTS_INVALID', 'Client-0 producer assignments are invalid.', {
      field: 'assignments',
      limit: CLIENT0_H2_MAX_ASSIGNMENTS,
    });
  }
  return {
    assignments: projection.assignments.map(normalizeProducerAssignment),
    month: normalizeMonth(projection.month, 'month'),
    revisionId: normalizeUuid(projection.revisionId, 'revisionId'),
    revisionNumber: normalizePositiveInteger(projection.revisionNumber, 'revisionNumber'),
    sourceRevisionVersion: normalizePositiveInteger(projection.sourceRevisionVersion, 'sourceRevisionVersion'),
    sourceUpdatedAt: normalizeTimestamp(projection.sourceUpdatedAt, 'sourceUpdatedAt'),
  };
}

function normalizeTransportMetadata(transportMetadata) {
  assertExactFields(
    transportMetadata,
    ['requestKey'],
    'H2_TRANSPORT_INVALID',
    'Client-0 H2 transport metadata must contain only requestKey.',
  );
  const { requestKey } = transportMetadata;
  if (
    typeof requestKey !== 'string'
    || requestKey.trim() !== requestKey
    || requestKey.length === 0
    || requestKey.length > 255
    || /[\u0000-\u001f\u007f]/.test(requestKey)
  ) {
    throw boundaryError('H2_TRANSPORT_INVALID', 'Client-0 H2 requestKey is invalid.', {
      field: 'transportMetadata.requestKey',
    });
  }
  assertWellFormedUnicode(requestKey, 'transportMetadata.requestKey');
  return { requestKey };
}

function compareUnicodeScalars(left, right) {
  if (left === right) return 0;
  const leftPoints = [...left];
  const rightPoints = [...right];
  const commonLength = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < commonLength; index += 1) {
    const leftValue = leftPoints[index].codePointAt(0);
    const rightValue = rightPoints[index].codePointAt(0);
    if (leftValue !== rightValue) return leftValue < rightValue ? -1 : 1;
  }
  return leftPoints.length - rightPoints.length;
}

function canonicalize(value) {
  if (typeof value === 'string') {
    assertWellFormedUnicode(value, 'canonical string');
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw boundaryError('H2_CANONICAL_JSON_INVALID', 'Client-0 H2 canonical JSON contains an unsupported number.');
    }
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (plainObject(value)) {
    const fields = Object.keys(value).sort(compareUnicodeScalars);
    return `{${fields.map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  throw boundaryError('H2_CANONICAL_JSON_INVALID', 'Client-0 H2 canonical JSON contains an unsupported value.');
}

function canonicalBusinessJson(projection) {
  return canonicalize({
    assignments: projection.assignments,
    month: projection.month,
    revisionId: projection.revisionId,
    revisionNumber: projection.revisionNumber,
    sourceRevisionVersion: projection.sourceRevisionVersion,
    sourceUpdatedAt: projection.sourceUpdatedAt,
  });
}

/**
 * Convert an already-approved R2 projection into the direct H2 publication
 * value. The result is inert data only: requestKey stays beside the body, no
 * transport is invoked, and no receiver state is created.
 */
export function toClient0H2WirePublication(projection, transportMetadata) {
  const normalizedProjection = normalizeProducerProjection(projection);
  const normalizedTransport = normalizeTransportMetadata(transportMetadata);
  const body = {
    schemaVersion: CLIENT0_H2_WIRE_SCHEMA_VERSION,
    month: normalizedProjection.month,
    revisionId: normalizedProjection.revisionId,
    revisionNumber: normalizedProjection.revisionNumber,
    sourceRevisionVersion: normalizedProjection.sourceRevisionVersion,
    sourceUpdatedAt: normalizedProjection.sourceUpdatedAt,
    assignments: normalizedProjection.assignments,
  };
  assertExactFields(body, H2_FIELDS, 'H2_BODY_INVALID', 'Client-0 H2 body shape is invalid.');
  body.assignments.forEach((assignment, index) => {
    assertExactFields(
      assignment,
      H2_ASSIGNMENT_FIELDS,
      'H2_BODY_INVALID',
      'Client-0 H2 body assignment shape is invalid.',
    );
  });
  const canonicalJson = canonicalBusinessJson(body);
  const fingerprint = createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
  return {
    transportMetadata: normalizedTransport,
    body,
    canonicalJson,
    fingerprint,
  };
}

/**
 * Compute the independent H2 wire fingerprint from an approved R2 projection.
 * This is intentionally separate from the producer-local R2 fingerprint.
 */
export function client0H2WireFingerprint(projection) {
  return createHash('sha256')
    .update(canonicalBusinessJson(normalizeProducerProjection(projection)), 'utf8')
    .digest('hex');
}
