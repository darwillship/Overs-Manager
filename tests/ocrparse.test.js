import test from 'node:test'; import assert from 'node:assert/strict';
import { parseLabel } from '../js/ocrparse.js';
const L = (...t) => t.map(x => ({ text: x, confidence: 92 }));
test('reads fields and keeps leading zeros', () => {
  const r = parseLabel(L('JOB #: 0012345', 'CUSTOMER: Acme Bank', 'ITEM NUMBER: 004417', 'DATE: 10/09/2026', 'QTY: 2,500'));
  assert.equal(r.fields.job_number.value, '0012345'); assert.equal(r.fields.ocr_item_number.value, '004417');
  assert.equal(r.fields.label_date.value, '2026-10-09'); assert.equal(r.fields.quantity.value, '2500');
  assert.equal(r.fields.verified_item_number, undefined); assert.equal(r.fields.last_ship_date, undefined);
});
test('description in item field is not an identifier', () => {
  const r = parseLabel(L('JOB: 0098765', 'ITEM NUMBER: Blue tri-fold brochure'));
  assert.equal(r.fields.ocr_item_number, undefined); assert.equal(r.fields.description.value, 'Blue tri-fold brochure'); assert.ok(r.warnings.length);
});
test('two labels never combined', () => {
  const r = parseLabel(L('JOB: 0011111', 'CUSTOMER: A', 'JOB: 0022222', 'CUSTOMER: B'));
  assert.equal(r.multipleLabels, true); assert.deepEqual(r.fields, {});
});
test('low confidence flagged; nothing readable -> warning', () => {
  assert.equal(parseLabel([{ text: 'JOB: 0012345', confidence: 40 }]).fields.job_number.uncertain, true);
  assert.ok(parseLabel(L('@@##', '~~')).warnings[0].includes('manually'));
});
test('two labels on the same OCR line never combined', () => {
  const r = parseLabel(L('JOB #: 0011111 JOB #: 0022222', 'CUSTOMER: Acme Bank CUSTOMER: Beta'));
  assert.equal(r.multipleLabels, true); assert.deepEqual(r.fields, {});
});
