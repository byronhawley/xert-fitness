// Shared fixtures for the roster push tests. SYNTHETIC DATA ONLY: fictional
// coaches, fake device tokens, and an APNs stand-in that never opens a socket.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';

import { ids, world, addSession, allWeek, submit, apply, publish, day, rpc } from './staff-roster-world.mjs';
import { as } from './staff-roster-db.mjs';
import { gymInstantIso } from '../../src/lib/staffRoster/time.js';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
export const APNS_ENV = Object.freeze({
  APNS_KEY_ID: 'KEY123', APNS_TEAM_ID: 'TEAM123', APNS_BUNDLE_ID: 'com.xertfitness.app',
  APNS_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
});

export const PUSH_TABLE = `
  create table public.push_subscriptions (
    id uuid primary key default gen_random_uuid(), user_id uuid not null, device_token text not null,
    environment text not null, enabled boolean not null default true
  );
  create table if not exists public.email_log (id uuid primary key, status text);`;

export const token = n => String(n).repeat(64).slice(0, 64);

/**
 * A published month with Ava on one class, push devices registered BEFORE
 * anything is published: Ava has a production and a sandbox phone (plus a
 * switched-off one), Ben and the owner one each.
 */
export async function pushWorld({ devices = true } = {}) {
  const { db, staff } = await world();
  await db.exec(PUSH_TABLE);
  let subs = [];
  if (devices) {
    ({ rows: subs } = await db.query(`insert into public.push_subscriptions (user_id, device_token, environment, enabled) values
      ($1, $4, 'production', true), ($1, $5, 'sandbox', true), ($1, $6, 'production', false), ($2, $7, 'production', true), ($3, $8, 'production', true)
      returning id, user_id, environment, enabled, device_token`, [ids.ava, ids.ben, ids.owner, token('a'), token('b'), token('c'), token('d'), token('e')]));
  }
  await submit(db, ids.ava, allWeek(0, 1440));
  const session = await addSession(db, day(12), 375, 60);
  await apply(db, [{ op: 'assign', session_id: session, slot_key: 'lead', staff_id: staff.ava }]);
  assert.equal((await publish(db)).ok, true);
  return { db, staff, subs, session };
}

/** Retime a class through the normal Class calendar RPC (not a roster action). */
export async function retime(db, session, minute, duration = 60) {
  await rpc(db, ids.owner, 'select public.admin_update_class_session($1, $2::jsonb)', [session, JSON.stringify({
    start_time: gymInstantIso(day(12), minute), end_time: gymInstantIso(day(12), minute + duration), duration_minutes: duration, title: 'Synthetic class' })]);
}

/**
 * A service-role client over PGlite: `.rpc(name, params)` calls the real SQL
 * function with named arguments, as PostgREST would. `fail` makes chosen
 * calls fail (count per function name) to simulate a lost connection.
 */
export function pgAdmin(db, { fail = {} } = {}) {
  const calls = [];
  return {
    calls,
    async rpc(name, params = {}) {
      calls.push({ name, params });
      if (fail[name] > 0) {
        fail[name] -= 1;
        return { data: null, error: { message: 'connection lost (simulated)' } };
      }
      await as(db, null);
      const keys = Object.keys(params);
      const values = keys.map(key => (params[key] !== null && typeof params[key] === 'object' ? JSON.stringify(params[key]) : params[key]));
      const args = keys.map((key, index) => `${key} => $${index + 1}${params[key] !== null && typeof params[key] === 'object' ? '::jsonb' : ''}`);
      try {
        const { rows } = await db.query(`select public.${name}(${args.join(', ')}) as result`, values);
        return { data: rows[0].result, error: null };
      } catch (error) {
        return { data: null, error: { message: error.message } };
      }
    },
  };
}

class FakeStream extends EventEmitter {
  constructor(outcome, sink, headers) { super(); this.outcome = outcome; this.sink = sink; this.headers = headers; }
  setEncoding() {}
  end(body) {
    const [status, reason] = this.outcome;
    if (status === 'refused') throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    this.sink.push({ headers: this.headers, body: JSON.parse(body) });
    if (status === 'hang') return;
    queueMicrotask(() => {
      if (status === 'reset') { this.emit('error', Object.assign(new Error('stream reset'), { code: 'ERR_HTTP2_STREAM_ERROR' })); return; }
      this.emit('response', { ':status': status });
      if (reason) this.emit('data', JSON.stringify({ reason }));
      this.emit('end');
    });
  }
  close() {}
}

/**
 * APNs stand-in. `outcomes[deviceToken]` is [status, reason], or ['hang'] (no
 * answer), ['reset'] (stream reset after sending) or ['refused'] (never sent).
 * `sent` records each request that left: headers and parsed payload.
 */
export function fakeAPNs(outcomes = {}) {
  const sent = [];
  const hosts = [];
  const connect = host => {
    hosts.push(host);
    return {
      on() {},
      close() {},
      request(headers) {
        const deviceToken = headers[':path'].split('/').at(-1);
        return new FakeStream(outcomes[deviceToken] || [200, null], sent, headers);
      },
    };
  };
  return { connect, sent, hosts };
}

export async function deliveries(db, where = 'true', params = []) {
  const { rows } = await db.query(`select d.*, s.device_token, n.kind from public.staff_notification_push_deliveries d
    join public.push_subscriptions s on s.id = d.subscription_id join public.staff_notifications n on n.id = d.notification_id
    where ${where} order by n.created_at, d.subscription_id`, params);
  return rows;
}

/** Makes every open lease look expired, as if the dispatcher holding it died. */
export async function expireLeases(db) {
  await db.query(`update public.staff_notification_push_deliveries set lease_expires_at = now() - interval '1 second' where status = 'sending'`);
}

/** Makes every pending retry due now (skips the backoff wait). */
export async function makeRetriesDue(db) {
  await db.query(`update public.staff_notification_push_deliveries set next_attempt_at = now() - interval '1 second' where status = 'pending'`);
}

export { ids };
