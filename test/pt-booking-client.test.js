import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bookingDetailsError, createPtClient, formatDuration, formatPrice, groupSlotsByDay, packageSaving, parsePrice, ptError,
} from '../src/lib/ptBookingData.js';
import { gymInstantIso } from '../src/lib/staffRoster/time.js';

test('prices read the way a coach types and a client reads them', () => {
  assert.equal(formatPrice(9000), '$90');
  assert.equal(formatPrice(7950), '$79.50');
  assert.equal(parsePrice('$80'), 8000);
  assert.equal(parsePrice('79.5'), 7950);
  assert.equal(parsePrice('1,200'), 120000);
  assert.equal(parsePrice('eighty'), null);
  assert.equal(parsePrice('80.999'), null);
  assert.equal(formatDuration(45), '45 min');
  assert.equal(formatDuration(60), '1 hr');
  assert.equal(formatDuration(90), '1 hr 30 min');
  assert.equal(packageSaving(9000, { sessions_count: 5, price_cents: 40000 }), 5000);
  assert.equal(packageSaving(9000, { sessions_count: 5, price_cents: 50000 }), 0);
});

test('open times group by the gym’s day, not the browser’s', () => {
  const slots = [gymInstantIso('2026-11-03', 360), gymInstantIso('2026-11-03', 390), gymInstantIso('2026-11-04', 1410)];
  const days = groupSlotsByDay(slots);
  assert.deepEqual(days.map(day => day.date), ['2026-11-03', '2026-11-04']);
  assert.deepEqual(days[0].times.map(time => time.minute), [360, 390]);
  assert.equal(days[1].times[0].minute, 1410);
});

test('the booking form asks for a name and a real email', () => {
  assert.equal(bookingDetailsError({ full_name: '', email: 'a@b.co' }), 'Enter your name.');
  assert.match(bookingDetailsError({ full_name: 'Casey', email: 'nope' }), /valid email/);
  assert.equal(bookingDetailsError({ full_name: 'Casey', email: 'casey@example.test', phone: '' }), '');
});

test('database error codes become plain messages, and calls use the pt_ entry points', async () => {
  const error = ptError({ message: 'SLOT_UNAVAILABLE' });
  assert.equal(error.code, 'SLOT_UNAVAILABLE');
  assert.match(error.message, /Pick another time/);
  assert.equal(ptError({ message: 'boom' }).message, 'Something went wrong. Try again.');

  const calls = [];
  const client = createPtClient(async (name, params) => { calls.push([name, params]); return name === 'pt_public_cancel' ? { error: { message: 'CANCEL_TOO_LATE' } } : { data: { ok: true } }; });
  await client.slots('svc', '2026-11-03', 7);
  await client.book({ service_id: 'svc' }, 'req-1');
  await assert.rejects(() => client.cancel('token'), error => error.code === 'CANCEL_TOO_LATE');
  assert.deepEqual(calls[0], ['pt_public_slots', { p_service_id: 'svc', p_from: '2026-11-03', p_days: 7 }]);
  assert.deepEqual(calls[1], ['pt_public_book', { p_booking: { service_id: 'svc' }, p_request_id: 'req-1' }]);
});
