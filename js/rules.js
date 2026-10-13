// Pure decision rules for Darwill Overs Manager. No I/O, no DOM. Unit-tested in tests/rules.test.js
export const STATUS = {
  NEEDS_REVIEW: 'NEEDS_REVIEW', HOLD_OPEN: 'HOLD_OPEN', HOLD_24H: 'HOLD_24H',
  ELIGIBLE_FINAL: 'ELIGIBLE_FINAL', RETURN_INV: 'RETURN_INV', READY_RECYCLE: 'READY_RECYCLE',
  RETURNED: 'RETURNED', RECYCLED: 'RECYCLED',
};
export const STATUS_LABEL = {
  NEEDS_REVIEW: 'NEEDS REVIEW', HOLD_OPEN: 'HOLD — OPEN JOB', HOLD_24H: 'HOLD — WAITING 24 HOURS',
  ELIGIBLE_FINAL: 'ELIGIBLE — FINAL CHECK REQUIRED', RETURN_INV: 'RETURN TO INVENTORY',
  READY_RECYCLE: 'READY TO RECYCLE', RETURNED: 'RETURNED TO INVENTORY', RECYCLED: 'RECYCLED',
};
export const ACTIVE_STATUSES = ['NEEDS_REVIEW','HOLD_OPEN','HOLD_24H','ELIGIBLE_FINAL','RETURN_INV','READY_RECYCLE'];
export const DATE_ONLY_POLICIES = {
  review: 'Date-only shipment: manual review required (no time is assumed)',
  end_of_day: 'Date-only shipment: assumed shipped at 11:59 PM Chicago time (latest possible)',
};
const TZ = 'America/Chicago';

function tzOffsetMs(utcMs, tz = TZ) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(utcMs)).map(x => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - utcMs;
}
/** Convert Chicago wall-clock date (YYYY-MM-DD) + time (HH:MM) to a Date (UTC instant). */
export function chicagoToDate(dateStr, timeStr = '00:00') {
  const [y, m, d] = dateStr.split('-').map(Number); const [hh, mm] = timeStr.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let t = guess - tzOffsetMs(guess);
  t = guess - tzOffsetMs(t);
  return new Date(t);
}
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isTime = s => typeof s === 'string' && /^\d{2}:\d{2}$/.test(s);
const norm = v => (v == null ? '' : String(v).trim());

/** Fingerprint of everything a recycle approval depends on. Changing any of it invalidates the approval. */
export function approvalFingerprint(product, review) {
  const r = review || {};
  return JSON.stringify([
    norm(product.job_number), norm(product.product_type), norm(product.description), norm(product.segment),
    norm(product.verified_item_number),
    r.shipping_checked ?? null, r.ticket_checked ?? null, r.open_records ?? null, r.future_dates ?? null,
    r.item_match ?? null, norm(r.verified_item_number), norm(r.last_ship_date), norm(r.last_ship_time),
  ]);
}

/**
 * computeStatus({product, review, finalCheck, completion, settings, now}) -> {status, reason, eligibleAt, assumption, finalCheckValid}
 * product: {job_number, product_type, description, segment, verified_item_number}
 * review: {shipping_checked:'Y'|'N', ticket_checked:'Y'|'N', open_records:'Y'|'N'|'U', future_dates:'Y'|'N'|'U',
 *          item_match:'FOUND'|'NOT_FOUND'|'NOT_CHECKED', verified_item_number, last_ship_date, last_ship_time}
 * finalCheck: {fingerprint, all_closed:true, no_future:true, not_found:true, by, at}
 * completion: {type:'RETURNED'|'RECYCLED', ...}
 */
export function computeStatus({ product = {}, review = null, finalCheck = null, completion = null, settings = {}, now = new Date() }) {
  const out = (status, reason, extra = {}) => ({ status, reason, eligibleAt: null, assumption: null, finalCheckValid: false, ...extra });
  if (completion && (completion.type === 'RETURNED' || completion.type === 'RECYCLED')) return out(completion.type, 'Completed');
  if (!norm(product.job_number)) return out('NEEDS_REVIEW', 'Job number missing');
  if (!review) return out('NEEDS_REVIEW', 'No PrintStream review recorded yet');
  const r = review;
  // Rule 1: open job / future ship date always wins and blocks recycling
  if (r.open_records === 'Y' && r.future_dates === 'Y') return out('HOLD_OPEN', 'Open shipping record and future ship date');
  if (r.open_records === 'Y') return out('HOLD_OPEN', 'Open shipping record in PrintStream');
  if (r.future_dates === 'Y') return out('HOLD_OPEN', 'Future ship date in PrintStream');
  // Rule 2: incomplete / unknown / conflicting
  if (r.shipping_checked !== 'Y') return out('NEEDS_REVIEW', 'Shipping records not checked');
  if (r.ticket_checked !== 'Y') return out('NEEDS_REVIEW', 'Work ticket not checked');
  if (r.open_records !== 'N') return out('NEEDS_REVIEW', 'Open shipping records unknown');
  if (r.future_dates !== 'N') return out('NEEDS_REVIEW', 'Future ship dates unknown');
  const item = r.item_match;
  if (item !== 'FOUND' && item !== 'NOT_FOUND') return out('NEEDS_REVIEW', 'Inventory item number not checked');
  if (item === 'FOUND') {
    const v = norm(r.verified_item_number);
    if (!v) return out('NEEDS_REVIEW', 'Item marked Found but no verified item number entered');
    const pv = norm(product.verified_item_number);
    if (pv && pv !== v) return out('NEEDS_REVIEW', `Conflict: verified item number ${v} differs from product's ${pv}`);
    // Rule 3
    return out('RETURN_INV', `Matching inventory item ${v} verified`);
  }
  if (item === 'NOT_FOUND' && norm(product.verified_item_number))
    return out('NEEDS_REVIEW', 'Conflict: item marked Not Found but product has a verified item number');
  // Rule 4/5: confirmed not found -> depends on last actual shipment
  if (!isDate(r.last_ship_date)) return out('NEEDS_REVIEW', 'Last actual ship date missing — cannot determine eligibility');
  let shipAt, assumption = null;
  if (isTime(r.last_ship_time)) shipAt = chicagoToDate(r.last_ship_date, r.last_ship_time);
  else {
    const policy = settings.date_only_policy || 'review';
    if (policy !== 'end_of_day') return out('NEEDS_REVIEW', 'Last ship date has no time — manual review required (date-only policy)');
    shipAt = chicagoToDate(r.last_ship_date, '23:59'); assumption = DATE_ONLY_POLICIES.end_of_day;
  }
  const nowMs = +new Date(now);
  if (+shipAt > nowMs + 5 * 60000) return out('NEEDS_REVIEW', 'Conflict: last actual ship date is in the future');
  const eligibleAt = new Date(+shipAt + 24 * 3600 * 1000);
  if (nowMs < +eligibleAt) return out('HOLD_24H', 'Waiting 24 hours after last actual shipment', { eligibleAt, assumption });
  const fp = approvalFingerprint(product, review);
  const fcValid = !!(finalCheck && finalCheck.all_closed === true && finalCheck.no_future === true && finalCheck.not_found === true && finalCheck.fingerprint === fp && finalCheck.by);
  if (fcValid) return out('READY_RECYCLE', `Final check by ${finalCheck.by}`, { eligibleAt, assumption, finalCheckValid: true });
  return out('ELIGIBLE_FINAL', '24 hours passed — staff final check required', { eligibleAt, assumption });
}
