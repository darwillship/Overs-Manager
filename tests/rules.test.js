import test from 'node:test'; import assert from 'node:assert/strict';
import { computeStatus, approvalFingerprint, chicagoToDate } from '../js/rules.js';
const P = { job_number: '0012345', product_type: 'Envelopes', description: '#10 window env', segment: 'A' };
const base = { shipping_checked: 'Y', ticket_checked: 'Y', open_records: 'N', future_dates: 'N', item_match: 'NOT_FOUND', last_ship_date: '2026-10-12', last_ship_time: '09:00' };
const s = (o) => computeStatus({ product: P, now: new Date('2026-10-13T20:00:00Z'), ...o }).status;

test('no review -> needs review', () => assert.equal(s({}), 'NEEDS_REVIEW'));
test('open record -> hold open, even with everything else done + final check', () => {
  const review = { ...base, open_records: 'Y' };
  assert.equal(s({ review, finalCheck: { all_closed: true, no_future: true, not_found: true, by: 'X', fingerprint: approvalFingerprint(P, review) } }), 'HOLD_OPEN');
});
test('future ship date -> hold open', () => assert.equal(s({ review: { ...base, future_dates: 'Y' } }), 'HOLD_OPEN'));
test('unknowns -> needs review', () => {
  assert.equal(s({ review: { ...base, open_records: 'U' } }), 'NEEDS_REVIEW');
  assert.equal(s({ review: { ...base, future_dates: 'U' } }), 'NEEDS_REVIEW');
  assert.equal(s({ review: { ...base, shipping_checked: 'N' } }), 'NEEDS_REVIEW');
  assert.equal(s({ review: { ...base, ticket_checked: 'N' } }), 'NEEDS_REVIEW');
  assert.equal(s({ review: { ...base, item_match: 'NOT_CHECKED' } }), 'NEEDS_REVIEW');
});
test('blank item number never means not found', () => assert.equal(s({ review: { ...base, item_match: undefined, verified_item_number: '' } }), 'NEEDS_REVIEW'));
test('found requires verified item', () => {
  assert.equal(s({ review: { ...base, item_match: 'FOUND', verified_item_number: '' } }), 'NEEDS_REVIEW');
  assert.equal(s({ review: { ...base, item_match: 'FOUND', verified_item_number: '004417' } }), 'RETURN_INV');
});
test('found conflicting with product verified item -> review', () =>
  assert.equal(computeStatus({ product: { ...P, verified_item_number: '1' }, review: { ...base, item_match: 'FOUND', verified_item_number: '2' } }).status, 'NEEDS_REVIEW'));
test('missing last ship date blocks eligibility', () => assert.equal(s({ review: { ...base, last_ship_date: '' } }), 'NEEDS_REVIEW'));
test('<24h -> waiting; >=24h -> eligible final check; countdown never sets ready', () => {
  const review = { ...base, last_ship_date: '2026-10-13', last_ship_time: '08:00' };
  const r = computeStatus({ product: P, review, now: new Date('2026-10-13T20:00:00Z') });
  assert.equal(r.status, 'HOLD_24H'); assert.equal(r.eligibleAt.toISOString(), '2026-10-14T13:00:00.000Z');
  assert.equal(computeStatus({ product: P, review, now: new Date('2026-10-14T13:00:00Z') }).status, 'ELIGIBLE_FINAL');
  assert.equal(computeStatus({ product: P, review, now: new Date('2026-11-14T13:00:00Z') }).status, 'ELIGIBLE_FINAL');
});
test('final check -> ready; changed findings invalidate', () => {
  const fc = { all_closed: true, no_future: true, not_found: true, by: 'Jonathan', fingerprint: approvalFingerprint(P, base) };
  assert.equal(s({ review: base, finalCheck: fc }), 'READY_RECYCLE');
  assert.equal(s({ review: { ...base, last_ship_time: '09:30' }, finalCheck: fc }), 'ELIGIBLE_FINAL');
  assert.equal(computeStatus({ product: { ...P, description: 'other' }, review: base, finalCheck: fc, now: new Date('2026-10-13T20:00:00Z') }).status, 'ELIGIBLE_FINAL');
  assert.equal(s({ review: base, finalCheck: { ...fc, not_found: false } }), 'ELIGIBLE_FINAL');
  assert.equal(s({ review: { ...base, open_records: 'Y' }, finalCheck: fc }), 'HOLD_OPEN');
});
test('date-only default requires review; end_of_day policy assumes 23:59 and shows assumption', () => {
  const review = { ...base, last_ship_time: '' };
  assert.equal(s({ review }), 'NEEDS_REVIEW');
  const r = computeStatus({ product: P, review, settings: { date_only_policy: 'end_of_day' }, now: new Date('2026-10-13T20:00:00Z') });
  assert.equal(r.status, 'HOLD_24H'); assert.ok(r.assumption);
});
test('different products under one job get different statuses', () => {
  const a = s({ review: { ...base, item_match: 'FOUND', verified_item_number: '0099' } });
  const b = s({ review: base });
  assert.notEqual(a, b);
});
test('future last ship date is a conflict', () => assert.equal(s({ review: { ...base, last_ship_date: '2026-10-20' } }), 'NEEDS_REVIEW'));
test('Chicago DST conversion', () => {
  assert.equal(chicagoToDate('2026-07-01', '12:00').toISOString(), '2026-07-01T17:00:00.000Z');
  assert.equal(chicagoToDate('2026-12-01', '12:00').toISOString(), '2026-12-01T18:00:00.000Z');
});
test('completion is terminal', () => assert.equal(s({ review: base, completion: { type: 'RECYCLED' } }), 'RECYCLED'));
test('date-only shipped TODAY with end_of_day policy -> waiting 24h (not a conflict)', () => {
  const r = computeStatus({ product: P, review: { ...base, last_ship_date: '2026-10-13', last_ship_time: '' }, settings: { date_only_policy: 'end_of_day' }, now: new Date('2026-10-13T20:00:00Z') });
  assert.equal(r.status, 'HOLD_24H'); assert.equal(r.eligibleAt.toISOString(), '2026-10-15T04:59:00.000Z');
  assert.equal(computeStatus({ product: P, review: { ...base, last_ship_date: '2026-10-14', last_ship_time: '' }, settings: { date_only_policy: 'end_of_day' }, now: new Date('2026-10-13T20:00:00Z') }).status, 'NEEDS_REVIEW');
});
