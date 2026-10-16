import test from 'node:test';
import assert from 'node:assert/strict';
import { installOrderData } from './fixtures/admin-order-data.mjs';
import { filterOrders, summarizeOrders, orderCsvRows } from '../src/lib/orderAnalytics.js';
import { visitorPassLabel } from '../src/lib/casualVisit.js';

const query = (table, params = {}) => new URL(`https://fixture.invalid/rest/v1/${table}?${new URLSearchParams(params)}`);
test('order fixture preserves full server pages, mixed-currency states and purchased snapshots', () => {
  const fixture = installOrderData();
  const first = fixture.read('orders', query('orders', { offset: 0, limit: 500 }));
  const second = fixture.read('orders', query('orders', { offset: 500, limit: 500 }));
  assert.equal(first.total, 503);
  assert.equal(first.rows.length, 500);
  assert.equal(second.rows.length, 3);
  assert.equal(second.offset, 500);
  const rows = [...first.rows, ...second.rows];
  assert.equal(new Set(rows.map(row => row.id)).size, 503);
  assert.deepEqual([...new Set(rows.map(row => row.status))].sort(), ['failed', 'paid', 'pending', 'refunded']);
  assert.deepEqual(summarizeOrders(rows).currencies.sort(), ['aud', 'usd']);
  assert.equal(filterOrders(rows, { search: 'order.buyer.503', days: 'all' }).length, 1);
  assert.equal(rows[0].credit_total, 4);
  assert.equal(rows[0].credit_validity_days, 90);
  assert.equal(rows[1].credit_total, null);
  assert.equal(orderCsvRows(rows).length, 503);
  assert.equal(orderCsvRows(rows)[3].credits_revoked, 3);
  first.rows[0].products.name = 'changed';
  assert.notEqual(fixture.read('orders', query('orders', { limit: 1 })).rows[0].products.name, 'changed');
});

test('visitor fixture is a separate bounded ledger and has no mutation handler', () => {
  const fixture = installOrderData();
  const visits = fixture.read('casual_visit_payments', query('casual_visit_payments', { limit: 200 }));
  assert.equal(visits.rows.length, 61);
  assert.equal(fixture.read('casual_visit_payments', query('casual_visit_payments', { limit: 50 })).rows.length, 50);
  assert.deepEqual([...new Set(visits.rows.map(row => row.pass_kind))].sort(), ['casual', 'ten_session_pack', 'three_day_pass']);
  assert.deepEqual([...new Set(visits.rows.map(row => visitorPassLabel(row.pass_kind)))].sort(), ['10 Session Pack', 'Casual visit', 'Three Day Pass']);
  assert.ok(visits.rows.some(row => row.status === 'refunded'));
  assert.equal(fixture.read('admin_refund_order', query('rpc/admin_refund_order')), undefined);
  assert.equal(fixture.mutate, undefined);
  assert.ok(visits.rows.every(row => row.email.endsWith('@example.invalid') && !row.phone));
});
