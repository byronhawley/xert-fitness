import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  CLIENT0_ROSTER_PROJECTION_FINGERPRINT_VERSION,
  CLIENT0_ROSTER_PROJECTION_MAX_ASSIGNMENTS,
  canonicalClient0RosterProjectionJson,
  client0RosterProjectionFingerprint,
  projectClient0RosterRevision,
} from '../src/lib/client0/rosterProjection.js';

const revisionId = '7f0c9f39-62ae-4c05-9df2-46bb77190f32';
const staffA = '11111111-1111-4111-8111-111111111111';
const staffB = '22222222-2222-4222-8222-222222222222';
const sessionA = '33333333-3333-4333-8333-333333333333';
const sessionB = '44444444-4444-4444-8444-444444444444';

const publishedRevision = {
  id: revisionId,
  month: '2026-11-01',
  number: 3,
  state: 'published',
  version: 8,
  published_at: '2026-10-09T01:23:45.678Z',
};

const staffPublicNames = [
  { staffId: staffA, publicCoachName: 'Ada Coach' },
  { staffId: staffB, publicCoachName: 'Bo Coach' },
];

function unsortedAssignments() {
  return [
    { session_id: sessionB, slot_key: 'assistant', staff_id: staffB, role: 'assistant' },
    { session_id: sessionA, slot_key: 'assistant', staff_id: staffB, role: 'assistant' },
    { session_id: sessionA, slot_key: 'lead', staff_id: staffA, role: 'lead' },
  ];
}

function projected() {
  return projectClient0RosterRevision({
    revision: publishedRevision,
    assignments: unsortedAssignments(),
    staffPublicNames,
  });
}

test('projects only a published revision into the exact merged H2 shape', () => {
  const projection = projected();
  assert.deepEqual(projection, {
    schemaVersion: 'client0.roster.projection.v1',
    month: '2026-11',
    revisionId,
    revisionNumber: 3,
    sourceRevisionVersion: 8,
    sourceUpdatedAt: '2026-10-09T01:23:45.678Z',
    assignments: [
      {
        sessionId: sessionA,
        slotKey: 'assistant',
        sourceStaffId: staffB,
        publicCoachName: 'Bo Coach',
      },
      {
        sessionId: sessionA,
        slotKey: 'lead',
        sourceStaffId: staffA,
        publicCoachName: 'Ada Coach',
      },
      {
        sessionId: sessionB,
        slotKey: 'assistant',
        sourceStaffId: staffB,
        publicCoachName: 'Bo Coach',
      },
    ],
  });
  assert.deepEqual(Object.keys(projection), [
    'schemaVersion',
    'month',
    'revisionId',
    'revisionNumber',
    'sourceRevisionVersion',
    'sourceUpdatedAt',
    'assignments',
  ]);
  assert.deepEqual(Object.keys(projection.assignments[0]), [
    'sessionId',
    'slotKey',
    'sourceStaffId',
    'publicCoachName',
  ]);
});

test('canonical ordering and JSON are deterministic and independent of input order', () => {
  const first = projected();
  const second = projectClient0RosterRevision({
    revision: {
      revisionId,
      month: '2026-11',
      revisionNumber: 3,
      state: 'published',
      sourceRevisionVersion: 8,
      sourceUpdatedAt: '2026-10-09T01:23:45.678Z',
    },
    assignments: [...unsortedAssignments()].reverse(),
    staffPublicNames: new Map([
      [staffA, 'Ada Coach'],
      [staffB, 'Bo Coach'],
    ]),
  });

  assert.deepEqual(first, second);
  assert.equal(
    canonicalClient0RosterProjectionJson(first),
    '{"assignments":[{"publicCoachName":"Bo Coach","sessionId":"33333333-3333-4333-8333-333333333333","slotKey":"assistant","sourceStaffId":"22222222-2222-4222-8222-222222222222"},{"publicCoachName":"Ada Coach","sessionId":"33333333-3333-4333-8333-333333333333","slotKey":"lead","sourceStaffId":"11111111-1111-4111-8111-111111111111"},{"publicCoachName":"Bo Coach","sessionId":"44444444-4444-4444-8444-444444444444","slotKey":"assistant","sourceStaffId":"22222222-2222-4222-8222-222222222222"}],"month":"2026-11","revisionId":"7f0c9f39-62ae-4c05-9df2-46bb77190f32","revisionNumber":3,"schemaVersion":"client0.roster.projection.v1","sourceRevisionVersion":8,"sourceUpdatedAt":"2026-10-09T01:23:45.678Z"}',
  );
  assert.equal(client0RosterProjectionFingerprint(first), client0RosterProjectionFingerprint(second));
});

test('fingerprint is version-bound SHA-256 of canonical JSON bytes', () => {
  const projection = projected();
  const canonicalJson = canonicalClient0RosterProjectionJson(projection);
  const expected = createHash('sha256')
    .update(`${CLIENT0_ROSTER_PROJECTION_FINGERPRINT_VERSION}\n${canonicalJson}`, 'utf8')
    .digest('hex');
  assert.equal(client0RosterProjectionFingerprint(projection), expected);
  assert.match(client0RosterProjectionFingerprint(projection), /^[0-9a-f]{64}$/);
});

test('rejects every non-published revision state and contradictory supersession', () => {
  for (const state of ['draft', 'superseded', 'discarded']) {
    assert.throws(
      () => projectClient0RosterRevision({
        revision: { ...publishedRevision, state },
        assignments: [],
        staffPublicNames,
      }),
      error => error.code === 'REVISION_NOT_PUBLISHED',
    );
  }
  assert.throws(
    () => projectClient0RosterRevision({
      revision: { ...publishedRevision, superseded_at: '2026-10-10T00:00:00Z' },
      assignments: [],
      staffPublicNames,
    }),
    error => error.code === 'REVISION_NOT_PUBLISHED',
  );
});

test('rejects missing, ambiguous, and invalid staff mappings', () => {
  assert.throws(
    () => projectClient0RosterRevision({
      revision: publishedRevision,
      assignments: unsortedAssignments(),
      staffPublicNames: [],
    }),
    error => error.code === 'STAFF_MAPPING_MISSING',
  );
  assert.throws(
    () => projectClient0RosterRevision({
      revision: publishedRevision,
      assignments: unsortedAssignments(),
      staffPublicNames: [...staffPublicNames, { staffId: staffA, publicCoachName: 'Different Name' }],
    }),
    error => error.code === 'STAFF_MAPPING_AMBIGUOUS',
  );
  assert.throws(
    () => projectClient0RosterRevision({
      revision: publishedRevision,
      assignments: unsortedAssignments(),
      staffPublicNames: [...staffPublicNames, { staffId: staffA, publicCoachName: ' Padded ' }],
    }),
    error => error.code === 'STAFF_MAPPING_INVALID',
  );
});

test('rejects out-of-contract revision fields', () => {
  const cases = [
    { revision: { ...publishedRevision, state: undefined } },
    { revision: { ...publishedRevision, published_at: undefined } },
    { revision: { ...publishedRevision, id: 'not-a-uuid' } },
    { revision: { ...publishedRevision, month: '2026-11-02' } },
    { revision: { ...publishedRevision, number: 0 } },
    { revision: { ...publishedRevision, version: 1.5 } },
  ];
  for (const { revision } of cases) {
    assert.throws(
      () => projectClient0RosterRevision({
        revision,
        assignments: [],
        staffPublicNames,
      }),
      error => ['REVISION_NOT_PUBLISHED', 'REVISION_FIELD_REQUIRED', 'REVISION_FIELD_INVALID'].includes(error.code),
    );
  }
  assert.throws(
    () => projectClient0RosterRevision({
      revision: {
        ...publishedRevision,
        published_at: '2026-10-10T00:00:00Z',
        sourceUpdatedAt: '2026-10-09T00:00:00Z',
      },
      assignments: [],
      staffPublicNames,
    }),
    error => error.code === 'REVISION_FIELD_CONFLICT',
  );
});

test('rejects out-of-contract assignments and enforces bounds and uniqueness', () => {
  const invalidAssignments = [
    [{ session_id: sessionA, slot_key: 'shadow-slot', staff_id: staffA, role: 'lead' }],
    [{ session_id: sessionA, slot_key: 'lead', staff_id: staffA, role: 'shadow' }],
    [{ session_id: 'not-a-uuid', slot_key: 'lead', staff_id: staffA, role: 'lead' }],
    [{ session_id: sessionA, slot_key: 'lead', staff_id: staffA, role: 'lead' }, { session_id: sessionA, slot_key: 'lead', staff_id: staffB, role: 'assistant' }],
    [{ session_id: sessionA, slot_key: 'lead', staff_id: staffA, role: 'lead' }, { session_id: sessionA, slot_key: 'assistant', staff_id: staffA, role: 'assistant' }],
  ];
  for (const assignments of invalidAssignments) {
    assert.throws(
      () => projectClient0RosterRevision({
        revision: publishedRevision,
        assignments,
        staffPublicNames,
      }),
      error => ['ASSIGNMENT_OUT_OF_CONTRACT', 'REVISION_FIELD_INVALID', 'DUPLICATE_ASSIGNMENT'].includes(error.code),
    );
  }

  assert.throws(
    () => projectClient0RosterRevision({
      revision: publishedRevision,
      assignments: Array.from({ length: CLIENT0_ROSTER_PROJECTION_MAX_ASSIGNMENTS + 1 }, (_, index) => ({
        session_id: sessionA,
        slot_key: 'lead',
        staff_id: staffA,
        role: 'lead',
        _index: index,
      })),
      staffPublicNames,
    }),
    error => error.code === 'TOO_MANY_ASSIGNMENTS',
  );
});
