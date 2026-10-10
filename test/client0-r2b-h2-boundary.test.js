import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CLIENT0_H2_WIRE_SCHEMA_VERSION,
  client0H2WireFingerprint,
  toClient0H2WirePublication,
} from '../src/lib/client0/rosterH2Publication.js';
import {
  CLIENT0_ROSTER_PROJECTION_SCHEMA_VERSION,
  client0RosterProjectionFingerprint,
  projectClient0RosterRevision,
} from '../src/lib/client0/rosterProjection.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const sharedVectors = JSON.parse(readFileSync(
  path.join(currentDirectory, 'client0-r2b-h2-shared-vectors.json'),
  'utf8',
));

const revisionId = '7f0c9f39-62ae-4c05-9df2-46bb77190f32';
const staffA = '11111111-1111-4111-8111-111111111111';
const staffB = '22222222-2222-4222-8222-222222222222';
const sessionA = '33333333-3333-4333-8333-333333333333';

const publishedRevision = {
  id: revisionId,
  month: '2026-11',
  number: 3,
  state: 'published',
  version: 8,
  published_at: '2026-10-09T01:23:45.678Z',
};

const staffPublicNames = [
  { staffId: staffA, publicCoachName: 'Ada Coach' },
  { staffId: staffB, publicCoachName: 'Bo Coach' },
];

function assertThrows(errorAssertion, action) {
  assert.throws(action, errorAssertion);
}

test('converts every shared vector without changing producer assignments', async () => {
  assert.equal(sharedVectors.canonicalRules, 'PR #386');
  assert.equal(sharedVectors.schemaVersion, 1);
  assert.equal(sharedVectors.vectors.length > 0, true);

  for (const vector of sharedVectors.vectors) {
    const projectionSnapshot = structuredClone(vector.producerProjection);
    const result = toClient0H2WirePublication(
      vector.producerProjection,
      { requestKey: vector.requestKeys[0] },
    );

    assert.deepEqual(vector.producerProjection, projectionSnapshot);
    assert.equal(result.body.schemaVersion, CLIENT0_H2_WIRE_SCHEMA_VERSION);
    assert.equal(result.body.sourceUpdatedAt, vector.expected.sourceUpdatedAt);
    assert.deepEqual(Object.keys(result.body), [
      'schemaVersion',
      'month',
      'revisionId',
      'revisionNumber',
      'sourceRevisionVersion',
      'sourceUpdatedAt',
      'assignments',
    ]);
    assert.equal(Buffer.byteLength(result.canonicalJson, 'utf8'), vector.expected.canonicalByteCount);
    assert.equal(result.fingerprint, vector.expected.canonicalSha256);
    assert.equal(
      client0H2WireFingerprint(vector.producerProjection),
      vector.expected.canonicalSha256,
    );
  }
});

test('keeps requestKey outside the body and outside canonical fingerprint bytes', () => {
  const vector = sharedVectors.vectors.find(candidate => candidate.id === 'base');
  const [firstRequestKey, secondRequestKey] = vector.requestKeys;
  const first = toClient0H2WirePublication(vector.producerProjection, { requestKey: firstRequestKey });
  const second = toClient0H2WirePublication(vector.producerProjection, { requestKey: secondRequestKey });

  assert.equal(first.transportMetadata.requestKey, firstRequestKey);
  assert.equal(second.transportMetadata.requestKey, secondRequestKey);
  assert.deepEqual(first.body, second.body);
  assert.equal(Object.prototype.hasOwnProperty.call(first.body, 'requestKey'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(second.body, 'requestKey'), false);
  assert.equal(first.canonicalJson, second.canonicalJson);
  assert.equal(first.fingerprint, second.fingerprint);
});

test('distinguishes the H2 wire fingerprint from the producer-local R2 fingerprint', () => {
  const vector = sharedVectors.vectors.find(candidate => candidate.id === 'base');
  const h2Fingerprint = client0H2WireFingerprint(vector.producerProjection);
  const producerFingerprint = client0RosterProjectionFingerprint(vector.producerProjection);

  assert.equal(h2Fingerprint, vector.expected.canonicalSha256);
  assert.notEqual(h2Fingerprint, producerFingerprint);
});

test('accepts an actual R2 projection and preserves its exact public assignment fields', () => {
  const projection = projectClient0RosterRevision({
    revision: publishedRevision,
    assignments: [
      { session_id: sessionA, slot_key: 'lead', staff_id: staffA, role: 'lead' },
      { session_id: sessionA, slot_key: 'assistant', staff_id: staffB, role: 'assistant' },
    ],
    staffPublicNames,
  });
  const result = toClient0H2WirePublication(projection, { requestKey: 'req_c0_r2b_actual_r2' });

  assert.equal(result.body.schemaVersion, 1);
  assert.deepEqual(result.body.assignments, projection.assignments.map(assignment => ({
    publicCoachName: assignment.publicCoachName,
    sessionId: assignment.sessionId,
    slotKey: assignment.slotKey,
    sourceStaffId: assignment.sourceStaffId,
  })));
  assert.equal(Object.prototype.hasOwnProperty.call(result.body.assignments[0], 'role'), false);
});

test('fails closed when producer input is not the exact approved R2 shape', () => {
  const vector = sharedVectors.vectors.find(candidate => candidate.id === 'base');
  const cases = [
    () => toClient0H2WirePublication(null, { requestKey: 'req' }),
    () => toClient0H2WirePublication({ ...vector.producerProjection, schemaVersion: 1 }, { requestKey: 'req' }),
    () => toClient0H2WirePublication(
      { ...vector.producerProjection, requestKey: 'req_wrong_location' },
      { requestKey: 'req' },
    ),
    () => toClient0H2WirePublication(
      {
        ...vector.producerProjection,
        assignments: [{ ...vector.producerProjection.assignments[0], role: 'lead' }],
      },
      { requestKey: 'req' },
    ),
  ];

  for (const action of cases) {
    assertThrows(error => error.code === 'H2_PROJECTION_INVALID' || error.code === 'H2_ASSIGNMENT_INVALID', action);
  }
});

test('fails closed on invalid transport metadata and keeps requestKey out of the body', () => {
  const vector = sharedVectors.vectors.find(candidate => candidate.id === 'base');
  const cases = [
    () => toClient0H2WirePublication(vector.producerProjection),
    () => toClient0H2WirePublication(vector.producerProjection, {}),
    () => toClient0H2WirePublication(vector.producerProjection, { requestKey: 'req', body: {} }),
    () => toClient0H2WirePublication(vector.producerProjection, { requestKey: ' padded ' }),
    () => toClient0H2WirePublication(vector.producerProjection, { requestKey: '' }),
  ];

  for (const action of cases) {
    assertThrows(error => error.code === 'H2_TRANSPORT_INVALID', action);
  }
});

test('does not mutate producer input or transport metadata', () => {
  const vector = sharedVectors.vectors.find(candidate => candidate.id === 'base');
  const projection = Object.freeze(structuredClone(vector.producerProjection));
  const transportMetadata = Object.freeze({ requestKey: vector.requestKeys[0] });
  const before = structuredClone({ projection, transportMetadata });
  toClient0H2WirePublication(projection, transportMetadata);

  assert.deepEqual({ projection, transportMetadata }, before);
});
