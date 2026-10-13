// Pure parser: turns Tesseract lines into suggested field values. Never invents values.
const UNCERTAIN = 80;
const clean = s => s.replace(/[|_]+/g, ' ').replace(/\s+/g, ' ').trim();
// For values that are mostly digits, OCR often reads 0 as O; fix but mark uncertain. Leading zeros are kept (text).
function digitsFix(v) {
  const digits = (v.match(/\d/g) || []).length;
  if (digits >= v.length - 2 && /[OoQDIl]/.test(v)) return { v: v.replace(/[OoQD]/g, '0').replace(/[Il]/g, '1'), fixed: true };
  return { v, fixed: false };
}
export function looksLikeIdentifier(v) {
  return /^[A-Z0-9][A-Z0-9.\-\/]{2,}$/i.test(v) && /\d/.test(v) && !/\s/.test(v);
}
function parseDate(v) {
  let m = v.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (m) { let y = +m[3]; if (y < 100) y += 2000; const mo = +m[1], d = +m[2];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`; }
  m = v.match(/(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}
const KEYS = [
  ['job_number', /^(?:JOB|J0B|JOB\s*NO\.?|JOB\s*NUMBER|JOB\s*#)\s*[#:.\-]*\s*(.+)$/i],
  ['customer', /^(?:CUSTOMER|CUST(?:OMER)?\.?|CLIENT)\s*(?:NAME)?\s*[#:.\-]*\s*(.+)$/i],
  ['segment', /^(?:SEGMENT|SEG\.?|VERSION|VER\.?)\s*[#:.\-]*\s*(.+)$/i],
  ['description', /^(?:DESCRIPTION|DESC\.?|PRODUCT)\s*[#:.\-]*\s*(.+)$/i],
  ['item', /^(?:ITEM\s*(?:NUMBER|NO\.?|#)?|ITEM)\s*[#:.\-]*\s*(.+)$/i],
  ['label_date', /^(?:DATE|LABEL\s*DATE|PRINTED|PROD(?:UCTION)?\s*DATE)\s*[#:.\-]*\s*(.+)$/i],
  ['quantity', /^(?:QTY|QUANTITY|COUNT)\s*[#:.\-]*\s*(.+)$/i],
];
/**
 * lines: [{text, confidence}] -> {fields:{name:{value, confidence, uncertain, note}}, warnings:[], multipleLabels:boolean}
 */
export function parseLabel(lines) {
  const fields = {}; const warnings = []; const jobs = [];
  for (const ln of lines) {
    const text = clean(ln.text || ''); const conf = Math.round(ln.confidence ?? 0);
    if (!text) continue;
    for (const [key, re] of KEYS) {
      const m = text.match(re); if (!m) continue;
      let v = m[1].trim();
      if (!v || v.length < 1) break;
      if (key === 'job_number') {
        const tok = v.split(' ')[0].replace(/[^A-Z0-9\-]/gi, ''); const f = digitsFix(tok);
        if (f.v.length >= 3 && /\d/.test(f.v)) jobs.push({ value: f.v, confidence: conf, uncertain: conf < UNCERTAIN || f.fixed, note: f.fixed ? 'Letters read as digits — check' : '' });
      } else if (key === 'item') {
        const tok = v.replace(/\s+/g, ' ');
        if (looksLikeIdentifier(tok)) set('ocr_item_number', digitsFix(tok).v, conf, 'UNVERIFIED — confirm in PrintStream');
        else warnings.push(`"Item Number" field on the tag contains text ("${tok}"), not an identifier — not used as an item number.`),
          fields.description || set('description', tok, conf, 'Came from the tag\'s Item Number field — check');
      } else if (key === 'label_date') {
        const d = parseDate(v); if (d) set('label_date', d, conf, 'Label date (not a ship date)'); else warnings.push(`Date on label unreadable: "${v}"`);
      } else if (key === 'quantity') {
        const q = v.match(/^[\d,]+/); if (q && /\d/.test(q[0])) set('quantity', q[0].replace(/,/g, ''), conf, '');
      } else set(key, v, conf, '');
      break;
    }
  }
  function set(name, value, confidence, note) { if (!fields[name]) fields[name] = { value, confidence, uncertain: confidence < UNCERTAIN || /check/i.test(note), note }; }
  // Also scan every line for several job markers on one line (side-by-side labels)
  for (const ln of lines) for (const m of clean(ln.text || '').matchAll(/\bJ[O0]B\s*(?:#|NO\.?|NUMBER)?\s*[:#.\-]*\s*([A-Z0-9\-]{3,})/gi)) {
    const f = digitsFix(m[1]); if (/\d/.test(f.v)) jobs.push({ value: f.v, confidence: Math.round(ln.confidence ?? 0), uncertain: true, note: '' });
  }
  const distinct = [...new Set(jobs.map(j => j.value))];
  const multipleLabels = distinct.length > 1;
  if (multipleLabels) {
    warnings.unshift(`More than one job number found (${distinct.join(', ')}). Multiple labels are in this photo — crop to ONE label and read again. Nothing was filled.`);
    return { fields: {}, warnings, multipleLabels: true };
  }
  if (jobs.length) fields.job_number = jobs.sort((a, b) => b.confidence - a.confidence)[0];
  if (!Object.keys(fields).length) warnings.push('OCR could not read any label fields. Please enter details manually.');
  return { fields, warnings, multipleLabels: false };
}
