import { SUPABASE_URL, SUPABASE_KEY, APP_URL, DEFAULT_LOGIN_EMAIL, BUCKET } from './config.js';
import { computeStatus, approvalFingerprint, STATUS_LABEL, ACTIVE_STATUSES, DATE_ONLY_POLICIES } from './rules.js';
import { parseLabel } from './ocrparse.js';

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true } });
window.__sb = sb;
const TZ = 'America/Chicago';
const $ = s => document.querySelector(s);
const app = $('#app');
const esc = v => (v == null ? '' : String(v)).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const todayCT = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const fmtDT = d => d ? new Date(d).toLocaleString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' CT' : '';
const fmtD = d => d ? new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '';
const daysSince = d => d ? Math.max(0, Math.floor((Date.parse(todayCT()) - Date.parse(d)) / 864e5)) : '';
const testMode = () => localStorage.getItem('overs_test_mode') === '1';
const staff = () => localStorage.getItem('overs_staff_name') || '';
function toast(msg, ms = 3500) { const t = $('#toast'); t.textContent = msg; t.style.display = 'block'; clearTimeout(t._h); t._h = setTimeout(() => t.style.display = 'none', ms); }
const PRODUCT_TYPES = ['Envelopes', 'Flat sheets', 'Brochures', 'Cards', 'Other'];
const CONTAINER_TYPES = ['Trays', 'Boxes', 'Skids'];

let settings = { date_only_policy: 'review' }, locations = [], staffList = [];
async function loadRef() {
  const [s, l, st] = await Promise.all([sb.from('overs_settings').select('*'), sb.from('overs_locations').select('*').eq('active', true).order('sort'), sb.from('overs_staff').select('*').eq('active', true).order('name')]);
  (s.data || []).forEach(r => settings[r.key] = r.value); locations = l.data || []; staffList = st.data || [];
}
async function must(p) { const r = await p; if (r.error) { throw new Error(r.error.message); } return r.data; }

// ---------- status engine glue ----------
function evalProduct(p, rec) {
  return computeStatus({ product: { ...p, job_number: rec.job_number }, review: p.review, finalCheck: p.final_check, completion: p.completion, settings, now: new Date() });
}
async function logEvent(record_id, product_id, event_type, data = {}, from_status = null, to_status = null) {
  await must(sb.from('overs_events').insert({ record_id, product_id, event_type, data, from_status, to_status, actor: staff() }));
}
/** Recompute and persist a product's status. Invalidates stale recycle approvals. */
async function applyStatus(p, rec, why) {
  const before = p.status; const patch = {};
  if (p.final_check && p.final_check.fingerprint !== approvalFingerprint({ ...p, job_number: rec.job_number }, p.review)) {
    await logEvent(rec.id, p.id, 'APPROVAL_INVALIDATED', { previous: p.final_check, why });
    p.final_check = null; patch.final_check = null;
  }
  const r = evalProduct(p, rec);
  Object.assign(patch, { status: r.status, status_reason: r.reason + (r.assumption ? ` (${r.assumption})` : ''), eligible_at: r.eligibleAt ? r.eligibleAt.toISOString() : null, updated_at: new Date().toISOString() });
  Object.assign(p, patch);
  await must(sb.from('overs_products').update(patch).eq('id', p.id));
  if (before !== r.status) await logEvent(rec.id, p.id, 'STATUS_CHANGE', { why, reason: patch.status_reason }, before, r.status);
  return r;
}
async function loadRecords(filter) {
  let q = sb.from('overs_records').select('*, overs_products(*), overs_containers(*), overs_photos(*)').eq('is_test', testMode()).order('created_at', { ascending: false });
  if (filter) q = filter(q);
  const recs = await must(q);
  // time-based transitions (24h countdown ending -> Eligible, never Ready)
  for (const rec of recs) for (const p of rec.overs_products) {
    if (['RETURNED', 'RECYCLED'].includes(p.status)) continue;
    const r = evalProduct(p, rec);
    if (r.status !== p.status) await applyStatus(p, rec, 'Automatic recalculation (time passed or settings changed)');
  }
  return recs;
}
const urlCache = new Map();
async function signed(paths) {
  const need = [...new Set(paths.filter(p => p && !urlCache.has(p)))];
  for (let i = 0; i < need.length; i += 100) {
    const { data } = await sb.storage.from(BUCKET).createSignedUrls(need.slice(i, i + 100), 3600 * 6);
    (data || []).forEach(d => d.signedUrl && urlCache.set(d.path, d.signedUrl));
  }
  return p => urlCache.get(p) || '';
}
function mainPhoto(p, rec) {
  const ph = rec.overs_photos || [];
  return ph.find(x => x.id === p.main_photo_id) || ph.find(x => x.product_id === p.id) || ph[0] || null;
}
const containersText = rec => { const m = {}; (rec.overs_containers || []).forEach(c => m[c.container_type] = (m[c.container_type] || 0) + c.count); return Object.entries(m).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(', ') || '—'; };

// ---------- layout ----------
function nav() {
  const r = location.hash.split('?')[0];
  const link = (h, t) => `<a href="${h}" class="${r === h ? 'on' : ''}">${t}</a>`;
  $('#top').innerHTML = `<span class="brand">Darwill Overs Manager</span>${link('#/', 'Dashboard')}${link('#/new', '+ Receive')}${link('#/work', 'Work list')}${link('#/history', 'History')}${link('#/settings', 'Settings')}
   <span class="who">${testMode() ? '<b style="background:#c62828;padding:2px 6px;border-radius:4px">TEST MODE</b> ' : ''}${esc(staff())} · <a href="#/logout" style="padding:4px">Log out</a></span>`;
}
async function router() {
  const { data: { session } } = await sb.auth.getSession();
  const [path, qs] = location.hash.slice(1).split('?'); const params = new URLSearchParams(qs || '');
  if (!session) { $('#top').innerHTML = ''; return viewLogin(); }
  if (path === '/logout') { await sb.auth.signOut(); localStorage.removeItem('overs_staff_name'); location.hash = '#/'; return; }
  if (!window.__refLoaded) { await loadRef(); window.__refLoaded = true; }
  if (!staff() && path !== '/staff') return viewStaff();
  nav();
  try {
    if (path === '/' || path === '') return await viewDashboard(params);
    if (path === '/new') return await viewReceive(params);
    if (path.startsWith('/r/')) return await viewRecord(path.slice(3), params);
    if (path === '/work') return await viewWork();
    if (path === '/history') return await viewHistory(params);
    if (path === '/flags') return await viewFlags(params);
    if (path === '/settings') return await viewSettings();
    if (path === '/staff') return viewStaff();
    app.innerHTML = '<p class="pad">Not found</p>';
  } catch (e) { console.error(e); app.innerHTML = `<div class="err">Error: ${esc(e.message)}</div>`; }
}
window.addEventListener('hashchange', router);

// ---------- login ----------
function viewLogin() {
  app.innerHTML = `<div class="card" style="max-width:420px;margin:40px auto">
  <h2>Darwill Overs Manager</h2><p class="muted">Sign in with the overs team login.</p>
  <label class="f"><span>Email</span><input id="em" type="email" value="${esc(localStorage.getItem('overs_email') || DEFAULT_LOGIN_EMAIL)}"></label>
  <label class="f"><span>Password</span></label><div class="row" style="flex-wrap:nowrap"><input id="pw" type="password" autocomplete="current-password" class="grow"><button type="button" class="btn" id="eye" aria-label="Show password" aria-pressed="false">👁 Show</button></div>
  <button class="btn primary big" id="go" style="width:100%">Sign in</button><div id="msg"></div></div>`;
  const go = async () => {
    const { error } = await sb.auth.signInWithPassword({ email: $('#em').value.trim(), password: $('#pw').value });
    if (error) { $('#msg').innerHTML = `<div class="err">${esc(error.message)}</div>`; return; }
    const ok = await sb.rpc('overs_is_member');
    if (!ok.data) { await sb.auth.signOut(); $('#msg').innerHTML = '<div class="err">This account is not on the overs team. Ask Jonathan to add it.</div>'; return; }
    localStorage.setItem('overs_email', $('#em').value.trim()); router();
  };
  $('#go').onclick = go; $('#pw').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  $('#eye').onclick = () => { const pw = $('#pw'); const show = pw.type === 'password'; pw.type = show ? 'text' : 'password'; $('#eye').textContent = show ? '🙈 Hide' : '👁 Show'; $('#eye').setAttribute('aria-pressed', show); pw.focus(); };
}
function viewStaff() {
  $('#top').innerHTML = '';
  app.innerHTML = `<div class="card" style="max-width:520px;margin:30px auto"><h2>Who is using this device?</h2>
  <p class="muted">Your name is recorded as "checked by" on reviews and actions.</p>
  <div class="row">${staffList.map(s => `<button class="btn big" data-n="${esc(s.name)}">${esc(s.name)}</button>`).join('')}</div>
  <label class="f"><span>Not listed? Type your name</span><input id="nn" placeholder="First Last"></label><button class="btn primary" id="add">Use this name</button></div>`;
  app.querySelectorAll('[data-n]').forEach(b => b.onclick = () => { localStorage.setItem('overs_staff_name', b.dataset.n); location.hash = '#/'; router(); });
  $('#add').onclick = async () => { const n = $('#nn').value.trim(); if (!n) return; await sb.from('overs_staff').upsert({ name: n }, { onConflict: 'name', ignoreDuplicates: true }); localStorage.setItem('overs_staff_name', n); window.__refLoaded = false; location.hash = '#/'; router(); };
}

// ---------- dashboard ----------
function matches(rec, p, q) {
  if (!q) return true; q = q.toLowerCase();
  return [rec.job_number, rec.customer, p.description, p.verified_item_number, p.ocr_item_number, p.segment, rec.location].some(v => (v || '').toLowerCase().includes(q));
}
function productCard(rec, p, url, selectable) {
  const ph = mainPhoto(p, rec);
  return `<div class="pcard" data-rec="${rec.id}" data-pid="${p.id}">
   ${ph ? `<img src="${esc(url(ph.thumb_path || ph.path))}" alt="">` : '<div class="noimg"></div>'}
   <div><b>${esc(rec.job_number)}</b> · ${esc(rec.customer || '')}<br>${esc(p.product_type || '')} ${esc(p.description || '')}${p.segment ? ' · Seg ' + esc(p.segment) : ''}
   <br>📍 ${esc(rec.location || '—')} · 📦 ${esc(containersText(rec))}<br>In overs ${daysSince(rec.received_date)}d · Last check: ${p.review ? esc(fmtD((p.review.checked_at || '').slice(0, 10))) : 'never'}
   ${p.status === 'HOLD_OPEN' || p.status === 'NEEDS_REVIEW' || p.status === 'HOLD_24H' ? `<br><i>${esc(p.status_reason || '')}</i>` : ''}
   ${p.eligible_at && p.status === 'HOLD_24H' ? `<br>Eligible: ${esc(fmtDT(p.eligible_at))}` : ''}
   ${p.next_review_date ? `<br>Next review: ${esc(fmtD(p.next_review_date))}` : ''}
   ${p.completion ? `<br>${esc(p.completion.by)} · ${esc(fmtDT(p.completion.at))}${p.completion.quantity != null ? ' · qty ' + esc(p.completion.quantity) : ''}` : ''}</div>
   ${selectable ? `<input type="checkbox" class="sel" data-sel="${p.id}" title="Select for flag printing" style="width:24px;height:24px">` : ''}</div>`;
}
function wireCards() {
  app.querySelectorAll('.pcard').forEach(c => c.onclick = e => { if (e.target.matches('input')) return; location.hash = `#/r/${c.dataset.rec}?p=${c.dataset.pid}`; });
}
async function viewDashboard(params) {
  const recs = await loadRecords();
  const all = recs.flatMap(rec => rec.overs_products.filter(p => ACTIVE_STATUSES.includes(p.status)).map(p => ({ rec, p })));
  const url = await signed(all.map(({ rec, p }) => { const m = mainPhoto(p, rec); return m && (m.thumb_path || m.path); }));
  const tab = params.get('tab') || 'NEEDS_REVIEW';
  const draw = () => {
    const q = $('#q').value.trim();
    const items = all.filter(({ rec, p }) => matches(rec, p, q));
    $('#cols').innerHTML = ACTIVE_STATUSES.map(s => { const list = items.filter(x => x.p.status === s);
      return `<div class="col s-${s} ${s === (window.__tab || tab) ? 'on' : ''}" data-col="${s}"><h3>${STATUS_LABEL[s]} (${list.length})</h3>${list.map(x => productCard(x.rec, x.p, url, true)).join('') || '<p class="muted small">None</p>'}</div>`; }).join('');
    $('#tabs').innerHTML = ACTIVE_STATUSES.map(s => `<button class="btn sm s-${s} ${s === (window.__tab || tab) ? 'sel' : ''}" data-tab="${s}">${STATUS_LABEL[s]} (${items.filter(x => x.p.status === s).length})</button>`).join('');
    $('#tabs').querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { window.__tab = b.dataset.tab; draw(); });
    wireCards();
  };
  app.innerHTML = `<div class="row noprint" style="margin-bottom:10px"><input id="q" class="grow" placeholder="Search job, customer, description, item number…" style="max-width:520px">
   <a class="btn primary big" href="#/new">📷 Receive overs</a><button class="btn" id="pf">🖨 Print flags for selected</button><button class="btn sm" id="sa">Select all shown</button></div>
   <div class="tabs" id="tabs"></div><div class="cols" id="cols"></div>`;
  $('#q').oninput = draw; draw();
  $('#sa').onclick = () => app.querySelectorAll('.col.on [data-sel], .cols [data-sel]').forEach(c => { if (c.offsetParent) c.checked = true; });
  $('#pf').onclick = () => { const ids = [...app.querySelectorAll('[data-sel]:checked')].map(c => c.dataset.sel); if (!ids.length) return toast('Select one or more cards first (checkbox on each card).'); location.hash = `#/flags?ids=${ids.join(',')}`; };
}
async function viewWork() {
  const recs = await loadRecords(); const today = todayCT();
  const groups = { 'Final check needed (24h passed)': [], 'Needs PrintStream review': [], 'Return to inventory — do it & mark done': [], 'Ready to recycle — do it & mark done': [], 'Open-job holds due for re-check': [] };
  for (const rec of recs) for (const p of rec.overs_products) {
    const x = { rec, p };
    if (p.status === 'ELIGIBLE_FINAL') groups['Final check needed (24h passed)'].push(x);
    else if (p.status === 'NEEDS_REVIEW') groups['Needs PrintStream review'].push(x);
    else if (p.status === 'RETURN_INV') groups['Return to inventory — do it & mark done'].push(x);
    else if (p.status === 'READY_RECYCLE') groups['Ready to recycle — do it & mark done'].push(x);
    else if (p.status === 'HOLD_OPEN' && (!p.next_review_date || p.next_review_date <= today)) groups['Open-job holds due for re-check'].push(x);
  }
  const all = Object.values(groups).flat(); const url = await signed(all.map(({ rec, p }) => { const m = mainPhoto(p, rec); return m && (m.thumb_path || m.path); }));
  const waiting = recs.flatMap(r => r.overs_products.filter(p => p.status === 'HOLD_24H').map(p => ({ rec: r, p })));
  app.innerHTML = `<h2>Daily work list — ${esc(fmtD(today))}</h2>` + Object.entries(groups).map(([k, v]) => `<div class="card"><h3>${k} (${v.length})</h3>${v.map(x => productCard(x.rec, x.p, url)).join('') || '<p class="muted">Nothing.</p>'}</div>`).join('')
    + `<div class="card"><h3>Waiting out 24 hours (${waiting.length})</h3>${waiting.map(x => `<div>${esc(x.rec.job_number)} ${esc(x.p.description || '')} — eligible ${esc(fmtDT(x.p.eligible_at))}</div>`).join('') || '<p class="muted">None.</p>'}</div>`;
  wireCards();
}
async function viewHistory(params) {
  const recs = await loadRecords();
  const all = recs.flatMap(rec => rec.overs_products.filter(p => ['RETURNED', 'RECYCLED'].includes(p.status)).map(p => ({ rec, p })))
    .sort((a, b) => (b.p.completion?.at || '').localeCompare(a.p.completion?.at || ''));
  const url = await signed(all.map(({ rec, p }) => { const m = mainPhoto(p, rec); return m && (m.thumb_path || m.path); }));
  app.innerHTML = `<h2>History — Returned to Inventory & Recycled</h2><input id="q" placeholder="Search job, customer, description, item number…" style="max-width:520px"><div class="row" style="align-items:flex-start;margin-top:10px">
   <div class="col s-RETURNED grow"><h3>Returned to inventory</h3><div id="h1"></div></div><div class="col s-RECYCLED grow"><h3>Recycled</h3><div id="h2"></div></div></div>`;
  const draw = () => { const q = $('#q').value.trim(); const it = all.filter(x => matches(x.rec, x.p, q));
    $('#h1').innerHTML = it.filter(x => x.p.status === 'RETURNED').map(x => productCard(x.rec, x.p, url)).join('') || '<p class="muted">None</p>';
    $('#h2').innerHTML = it.filter(x => x.p.status === 'RECYCLED').map(x => productCard(x.rec, x.p, url)).join('') || '<p class="muted">None</p>'; wireCards(); };
  $('#q').oninput = draw; draw();
}

// ---------- images ----------
async function loadBitmap(file) { try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { return await createImageBitmap(file); } }
function toCanvas(bmp, maxSide, crop) {
  const sx = crop ? crop.x : 0, sy = crop ? crop.y : 0, sw = crop ? crop.w : bmp.width, sh = crop ? crop.h : bmp.height;
  const k = Math.min(1, maxSide / Math.max(sw, sh)); const c = document.createElement('canvas');
  c.width = Math.round(sw * k); c.height = Math.round(sh * k); c.getContext('2d').drawImage(bmp, sx, sy, sw, sh, 0, 0, c.width, c.height); return c;
}
const canvasBlob = (c, q) => new Promise(r => c.toBlob(r, 'image/jpeg', q));
/** Compress: long side 2200px @ JPEG 0.85 keeps label text readable; plus a 360px thumbnail. */
async function compress(file) {
  const bmp = await loadBitmap(file);
  const full = toCanvas(bmp, 2200), th = toCanvas(bmp, 360);
  return { full: await canvasBlob(full, 0.85), thumb: await canvasBlob(th, 0.7), width: full.width, height: full.height };
}
/** Upload one photo and link it to the record. Returns photo row or throws. Never reports success unless both storage + DB succeed. */
async function savePhoto(file, rec_id, product_id, kind) {
  const c = await compress(file); const id = crypto.randomUUID();
  const path = `${rec_id}/${id}.jpg`, thumb_path = `${rec_id}/${id}_t.jpg`;
  let r = await sb.storage.from(BUCKET).upload(path, c.full, { contentType: 'image/jpeg' }); if (r.error) throw new Error('Photo upload failed: ' + r.error.message);
  r = await sb.storage.from(BUCKET).upload(thumb_path, c.thumb, { contentType: 'image/jpeg' }); if (r.error) throw new Error('Thumbnail upload failed: ' + r.error.message);
  const row = await must(sb.from('overs_photos').insert({ id, record_id: rec_id, product_id, path, thumb_path, kind, width: c.width, height: c.height, bytes: c.full.size, created_by: staff() }).select().single());
  return row;
}
/** Renders an upload queue with visible failure + retry. */
function uploadQueue(el, items, rec_id, product_id, onDone) {
  const st = items.map(f => ({ f, state: 'pending', msg: '' }));
  const draw = () => { el.innerHTML = st.map((s, i) => `<div class="upl ${s.state}" data-upl="${s.state}">Photo ${i + 1}: ${s.state === 'ok' ? '✅ Saved to this record' : s.state === 'fail' ? '❌ NOT saved — ' + esc(s.msg) + ` <button class="btn sm" data-retry="${i}">Retry</button>` : '⏳ Saving…'}</div>`).join('');
    el.querySelectorAll('[data-retry]').forEach(b => b.onclick = () => run(+b.dataset.retry)); };
  const run = async i => { st[i].state = 'pending'; draw(); try { st[i].row = await savePhoto(st[i].f, rec_id, product_id, st[i].f.__kind || 'photo'); st[i].state = 'ok'; } catch (e) { st[i].state = 'fail'; st[i].msg = e.message; } draw(); if (st.every(s => s.state !== 'pending')) onDone && onDone(st); };
  draw(); return Promise.all(st.map((_, i) => run(i))).then(() => st);
}

// ---------- OCR (in-browser, Tesseract.js) ----------
let ocrWorker;
async function runOCR(canvas, onProgress) {
  if (!window.Tesseract) throw new Error('OCR library did not load (offline?)');
  if (!ocrWorker) ocrWorker = await Tesseract.createWorker('eng', 1, { logger: m => m.status === 'recognizing text' && onProgress && onProgress(m.progress) });
  // upscale + grayscale for better accuracy
  const k = Math.max(1, Math.min(3, 1600 / Math.max(canvas.width, canvas.height)));
  const c = document.createElement('canvas'); c.width = canvas.width * k; c.height = canvas.height * k;
  const g = c.getContext('2d'); g.filter = 'grayscale(1) contrast(1.4)'; g.drawImage(canvas, 0, 0, c.width, c.height);
  const { data } = await ocrWorker.recognize(c);
  const lines = (data.lines || []).map(l => ({ text: l.text, confidence: l.confidence }));
  return { lines, text: data.text };
}

// ---------- receive ----------
function seg(name, opts, val) { return `<div class="seg" data-seg="${name}">${opts.map(([v, t]) => `<button type="button" data-v="${esc(v)}" class="${String(val) === String(v) ? 'on' : ''}">${esc(t)}</button>`).join('')}</div>`; }
function wireSegs(root, onChange) { root.querySelectorAll('[data-seg]').forEach(s => s.querySelectorAll('button').forEach(b => b.onclick = () => { s.querySelectorAll('button').forEach(x => x.classList.remove('on')); b.classList.add('on'); s.dataset.val = b.dataset.v; onChange && onChange(s.dataset.seg, b.dataset.v); })); root.querySelectorAll('[data-seg]').forEach(s => { const on = s.querySelector('.on'); if (on) s.dataset.val = on.dataset.v; }); }
const segVal = (root, n) => root.querySelector(`[data-seg="${n}"]`)?.dataset.val ?? '';
function productFields(p = {}) {
  return `<label class="f"><span>Product type</span></label><div class="row">${PRODUCT_TYPES.map(t => `<button type="button" class="btn ${p.product_type === t ? 'sel' : ''}" data-pt="${t}">${t}</button>`).join('')}</div>
  <label class="f"><span>Product description</span><input name="description" value="${esc(p.description)}"></label>
  <label class="f"><span>Segment / version</span><input name="segment" value="${esc(p.segment)}"></label>
  <label class="f"><span>Item # read from label (UNVERIFIED — not used for decisions)</span><input name="ocr_item_number" value="${esc(p.ocr_item_number)}"></label>
  <label class="f"><span>Verified item number (only if confirmed in PrintStream & matches the physical product)</span><input name="verified_item_number" value="${esc(p.verified_item_number)}"></label>
  <div class="row"><label class="f grow"><span>Label date (as printed — NOT a ship date)</span><input name="label_date" type="date" value="${esc(p.label_date)}"></label>
  <label class="f grow"><span>Quantity</span><div class="row"><label><input type="checkbox" name="qty_unknown" style="width:auto" ${p.quantity == null ? 'checked' : ''}> Unknown</label><input name="quantity" type="number" min="0" inputmode="numeric" value="${p.quantity ?? ''}" style="max-width:140px" ${p.quantity == null ? 'disabled' : ''}></div></label></div>`;
}
function wireProductFields(root) {
  root.querySelectorAll('[data-pt]').forEach(b => b.onclick = () => { root.querySelectorAll('[data-pt]').forEach(x => x.classList.remove('sel')); b.classList.add('sel'); });
  const u = root.querySelector('[name=qty_unknown]'), q = root.querySelector('[name=quantity]');
  u.onchange = () => { q.disabled = u.checked; if (!u.checked) q.focus(); };
  q.oninput = () => { if (q.value !== '') u.checked = false; };
}
function readProductFields(root) {
  const v = n => (root.querySelector(`[name=${n}]`)?.value ?? '').trim();
  const unknown = root.querySelector('[name=qty_unknown]').checked;
  return { product_type: root.querySelector('[data-pt].sel')?.dataset.pt || null, description: v('description') || null, segment: v('segment') || null,
    ocr_item_number: v('ocr_item_number') || null, verified_item_number: v('verified_item_number') || null, label_date: v('label_date') || null,
    quantity: unknown || v('quantity') === '' ? null : parseInt(v('quantity'), 10) };
}
function containerPicker(id) { return `<div id="${id}"><div class="row" data-crow><select data-ctype style="max-width:140px">${CONTAINER_TYPES.map(t => `<option>${t}</option>`).join('')}</select>
  <button type="button" class="btn" data-minus>−</button><input data-ccount type="number" min="1" value="1" style="max-width:80px;text-align:center" inputmode="numeric"><button type="button" class="btn" data-plus>+</button></div>
  <button type="button" class="btn sm" data-addc>+ another container type</button></div>`; }
function wireContainers(root) {
  const wire = row => { const c = row.querySelector('[data-ccount]'); row.querySelector('[data-minus]').onclick = () => c.value = Math.max(1, (+c.value || 1) - 1); row.querySelector('[data-plus]').onclick = () => c.value = (+c.value || 0) + 1; };
  root.querySelectorAll('[data-crow]').forEach(wire);
  root.querySelector('[data-addc]').onclick = () => { const r = root.querySelector('[data-crow]').cloneNode(true); r.querySelector('[data-ccount]').value = 1; root.querySelector('[data-addc]').before(r); wire(r); };
}
const readContainers = root => [...root.querySelectorAll('[data-crow]')].map(r => ({ container_type: r.querySelector('[data-ctype]').value, count: parseInt(r.querySelector('[data-ccount]').value, 10) })).filter(c => c.count > 0);

async function viewReceive(params) {
  const photos = []; // {file, bmp, kind}
  let cur = -1, crop = null;
  app.innerHTML = `<h2>Receive overs</h2><div class="capture">
  <div><div class="card"><div class="row">
    <label class="btn primary big grow">📷 Take photo<input id="cam" type="file" accept="image/*" capture="environment" hidden></label>
    <label class="btn big grow">🖼 Upload photo<input id="upl" type="file" accept="image/*" multiple hidden></label></div>
    <p class="small muted">Photo of the product, the label/overs tag, or both. Optional — manual entry always works. OCR runs on this device; photos are not sent anywhere for reading.</p>
    <div class="imgwrap" id="iw" style="display:none"><canvas id="cv"></canvas></div>
    <div class="thumbs" id="pt" style="margin-top:8px"></div>
    <div id="ocrbar" style="display:none;margin-top:8px"><p class="small">Several labels in the photo? <b>Drag a box around ONE label</b>, then read it.</p>
     <div class="row"><select id="kind" style="max-width:200px"><option value="label">Label / tag</option><option value="product">Product</option><option value="both">Both</option></select>
     <button class="btn primary" id="ocr">🔎 Read label</button><button class="btn sm" id="clr">Clear selection</button></div><div id="ocrmsg"></div></div></div></div>
  <div><form class="card" id="fm" onsubmit="return false">
   <div id="dup"></div>
   <label class="f"><span>Job number *</span><input name="job_number" required inputmode="text" autocomplete="off"></label>
   <label class="f"><span>Customer</span><input name="customer"></label>
   <div id="pf">${productFields()}</div>
   <label class="f"><span>Containers</span></label>${containerPicker('cp')}
   ${locations.length === 1 ? `<input type="hidden" name="location" value="${esc(locations[0].name)}"><p class="small">📍 Location: <b>${esc(locations[0].name)}</b></p>` : `<label class="f"><span>Location</span><select name="location"><option value="">—</option>${locations.map((l, i) => `<option ${i === 0 ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>`}
   <label class="f"><span>Date received</span><input name="received_date" type="date" value="${todayCT()}"></label>
   <label class="f"><span>Notes</span><textarea name="notes" rows="2"></textarea></label>
   <label class="row small"><input type="checkbox" id="conf" style="width:24px;height:24px"> I checked the job number and item numbers against the photo/label.</label>
   <button class="btn green big" id="save" style="width:100%;margin-top:10px">💾 Save record${''}</button><div id="saveres"></div></form></div></div>`;
  const fm = $('#fm'); wireProductFields(fm); wireContainers($('#cp'));
  const cv = $('#cv'), ctx = cv.getContext('2d');
  const draw = () => { if (cur < 0) return; const b = photos[cur].bmp; const c = toCanvas(b, 1400); cv.width = c.width; cv.height = c.height; ctx.drawImage(c, 0, 0);
    if (crop) { ctx.fillStyle = '#0007'; ctx.fillRect(0, 0, cv.width, cv.height); const k = cv.width / b.width; ctx.drawImage(c, crop.x * k, crop.y * k, crop.w * k, crop.h * k, crop.x * k, crop.y * k, crop.w * k, crop.h * k); ctx.strokeStyle = '#ffd400'; ctx.lineWidth = 4; ctx.strokeRect(crop.x * k, crop.y * k, crop.w * k, crop.h * k); }
    $('#pt').innerHTML = photos.map((p, i) => `<div class="t"><img src="${p.url}" class="${i === cur ? 'main' : ''}" data-i="${i}"><br><small>${i === 0 ? 'Main' : ''}</small> <button class="btn sm" data-del="${i}">✕</button></div>`).join('');
    $('#pt').querySelectorAll('[data-i]').forEach(im => im.onclick = () => { cur = +im.dataset.i; crop = null; draw(); });
    $('#pt').querySelectorAll('[data-del]').forEach(b => b.onclick = () => { photos.splice(+b.dataset.del, 1); cur = photos.length - 1; crop = null; if (cur < 0) { $('#iw').style.display = 'none'; $('#ocrbar').style.display = 'none'; $('#pt').innerHTML = ''; } else draw(); }); };
  const add = async files => { for (const f of files) { const bmp = await loadBitmap(f); photos.push({ file: f, bmp, url: URL.createObjectURL(f) }); } cur = photos.length - 1; crop = null; $('#iw').style.display = ''; $('#ocrbar').style.display = ''; draw(); };
  $('#cam').onchange = e => add(e.target.files); $('#upl').onchange = e => add(e.target.files);
  // crop by drag
  let start = null; const pos = e => { const r = cv.getBoundingClientRect(); const b = photos[cur].bmp; return { x: (e.clientX - r.left) / r.width * b.width, y: (e.clientY - r.top) / r.height * b.height }; };
  cv.onpointerdown = e => { if (cur < 0) return; start = pos(e); cv.setPointerCapture(e.pointerId); };
  cv.onpointermove = e => { if (!start) return; const p = pos(e); crop = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) }; draw(); };
  cv.onpointerup = () => { start = null; if (crop && (crop.w < 20 || crop.h < 20)) crop = null; draw(); };
  $('#clr').onclick = () => { crop = null; draw(); };
  window.__setCrop = c => { crop = c; draw(); }; // test hook
  $('#ocr').onclick = async () => {
    if (cur < 0) return; const msg = $('#ocrmsg'); msg.innerHTML = '<div class="upl pending">Reading label on this device… <span id="pr">0%</span></div>';
    try {
      const { lines } = await runOCR(toCanvas(photos[cur].bmp, 3000, crop), p => { const e = $('#pr'); if (e) e.textContent = Math.round(p * 100) + '%'; });
      const res = parseLabel(lines); window.__lastOCR = { lines, res };
      fm.querySelectorAll('.uncertain').forEach(x => x.classList.remove('uncertain')); fm.querySelectorAll('.ocrnote').forEach(x => x.remove());
      let filled = 0;
      for (const [k, f] of Object.entries(res.fields)) {
        const inp = fm.querySelector(`[name=${k}]`); if (!inp) continue;
        if (k === 'quantity') { fm.querySelector('[name=qty_unknown]').checked = false; inp.disabled = false; }
        inp.value = f.value; filled++;
        if (f.uncertain) inp.classList.add('uncertain');
        inp.insertAdjacentHTML('afterend', `<div class="ocrnote">OCR ${f.confidence}%${f.uncertain ? ' — uncertain, please check' : ''}${f.note ? ' · ' + esc(f.note) : ''}</div>`);
      }
      msg.innerHTML = (res.warnings.map(w => `<div class="warn">${esc(w)}</div>`).join('')) + (filled ? `<div class="upl ok">Filled ${filled} field(s). Yellow = uncertain. Check everything before saving.</div>` : '');
      if (fm.job_number.value) checkDup();
    } catch (e) { msg.innerHTML = `<div class="err">OCR failed: ${esc(e.message)}. Please enter the details manually.</div>`; }
  };
  // duplicates
  let dupRec = null;
  const checkDup = async () => {
    const j = fm.job_number.value.trim(); $('#dup').innerHTML = ''; dupRec = null; if (!j) return;
    const recs = await must(sb.from('overs_records').select('id, job_number, customer, location, received_date, overs_products(status, description)').eq('job_number', j).eq('is_test', testMode()));
    const open = recs.filter(r => r.overs_products.some(p => !['RETURNED', 'RECYCLED'].includes(p.status)) || !r.overs_products.length);
    if (open.length) { dupRec = open[0];
      $('#dup').innerHTML = `<div class="warn"><b>Job ${esc(j)} is already in overs</b> (${open.map(r => `${esc(r.location || 'no location')}, received ${esc(fmtD(r.received_date))}: ${r.overs_products.map(p => esc(p.description || p.status)).join('; ')}`).join(' | ')}).
       <div class="row" style="margin-top:6px"><a class="btn primary" href="#/r/${open[0].id}?add=containers">Add containers to existing record</a><a class="btn" href="#/r/${open[0].id}?add=product">Add a different product to it</a><span class="small">or save as a separate record below.</span></div></div>`; }
  };
  fm.job_number.onblur = checkDup;
  $('#save').onclick = async () => {
    const res = $('#saveres'); const job = fm.job_number.value.trim();
    if (!job) { res.innerHTML = '<div class="err">Job number is required.</div>'; return; }
    if (!$('#conf').checked) { res.innerHTML = '<div class="err">Please confirm you checked the job number and item numbers.</div>'; return; }
    $('#save').disabled = true; res.innerHTML = '<div class="upl pending">Saving record…</div>';
    try {
      const rec = await must(sb.from('overs_records').insert({ job_number: job, customer: fm.customer.value.trim() || null, location: fm.location.value || null, received_date: fm.received_date.value || null, notes: fm.notes.value.trim() || null, is_test: testMode(), created_by: staff() }).select().single());
      const pf = readProductFields(fm);
      const p = await must(sb.from('overs_products').insert({ ...pf, record_id: rec.id, is_test: testMode(), created_by: staff() }).select().single());
      const cs = readContainers($('#cp'));
      if (cs.length) await must(sb.from('overs_containers').insert(cs.map(c => ({ ...c, record_id: rec.id, product_id: p.id, added_by: staff() }))));
      await logEvent(rec.id, p.id, 'RECEIVED', { containers: cs, product: pf });
      await applyStatus(p, { ...rec }, 'Received');
      res.innerHTML = `<div class="upl ok">✅ Record saved (job ${esc(job)}).</div><div id="uq"></div><div id="after"></div>`;
      const go = `<a class="btn primary big" href="#/r/${rec.id}?p=${p.id}">Open record</a> <a class="btn big" href="#/new" onclick="setTimeout(()=>location.reload(),10)">Receive another</a>`;
      if (photos.length) {
        photos.forEach(x => x.file.__kind = $('#kind').value);
        const st = await uploadQueue($('#uq'), photos.map(x => x.file), rec.id, p.id);
        const first = st.find(s => s.state === 'ok'); if (first) await sb.from('overs_products').update({ main_photo_id: first.row.id }).eq('id', p.id);
        $('#after').innerHTML = (st.some(s => s.state === 'fail') ? '<div class="err">Some photos were NOT saved. Press Retry above, or add them again from the record page.</div>' : '') + go;
      } else $('#after').innerHTML = go;
    } catch (e) { res.innerHTML = `<div class="err">Save failed: ${esc(e.message)} — nothing was saved. Try again.</div>`; $('#save').disabled = false; }
  };
}

// ---------- record ----------
async function viewRecord(id, params) {
  const recs = await loadRecords(q => q.eq('id', id));
  if (!recs.length) { app.innerHTML = '<div class="err">Record not found (or it belongs to test mode).</div>'; return; }
  const rec = recs[0]; rec.overs_products.sort((a, b) => a.created_at.localeCompare(b.created_at));
  const events = await must(sb.from('overs_events').select('*').eq('record_id', id).order('at', { ascending: false }));
  const url = await signed(rec.overs_photos.flatMap(p => [p.path, p.thumb_path]));
  app.innerHTML = `<div class="card"><div class="row"><h2 style="margin:0" class="grow">Job <span id="jn">${esc(rec.job_number)}</span> · ${esc(rec.customer || '')}</h2>
   <a class="btn" href="#/flags?ids=${rec.overs_products.map(p => p.id).join(',')}">🖨 Print flag(s)</a></div>
   <div class="row" style="margin-top:8px"><label class="f grow"><span>Job number</span><input id="r_job" value="${esc(rec.job_number)}"></label><label class="f grow"><span>Customer</span><input id="r_cust" value="${esc(rec.customer)}"></label>
   <label class="f grow"><span>Location</span><select id="r_loc"><option value="">—</option>${[...new Set([...locations.map(l => l.name), rec.location].filter(Boolean))].map(l => `<option ${l === rec.location ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
   <label class="f"><span>Received</span><input id="r_rd" type="date" value="${esc(rec.received_date)}"></label></div>
   <label class="f"><span>Notes</span><textarea id="r_notes" rows="2">${esc(rec.notes)}</textarea></label><button class="btn" id="r_save">Save job details</button>
   <p class="small muted">In overs ${daysSince(rec.received_date)} days · created by ${esc(rec.created_by || '')} ${esc(fmtDT(rec.created_at))}</p></div>
  <div class="card"><h3>Photos (${rec.overs_photos.length})</h3><div class="thumbs" id="ph">${rec.overs_photos.map(p => `<div class="t"><img data-full="${esc(url(p.path))}" src="${esc(url(p.thumb_path || p.path))}" data-photo="${p.id}"></div>`).join('') || '<span class="muted">No photos.</span>'}</div>
   <div class="row" style="margin-top:8px"><label class="btn primary">📷 Add photos<input id="addph" type="file" accept="image/*" multiple hidden></label><span class="small muted">Tap a photo for full size.</span></div><div id="phq"></div></div>
  <div class="card" id="cont"><h3>Containers: ${esc(containersText(rec))}</h3>
   <table class="h">${rec.overs_containers.map(c => `<tr><td>${c.count} ${esc(c.container_type)}</td><td>${esc(c.added_by || '')}</td><td>${esc(fmtDT(c.added_at))}</td></tr>`).join('')}</table>
   <div style="margin-top:8px">${containerPicker('addcp')}<button class="btn primary" id="addc" style="margin-top:6px">+ Add these containers</button></div></div>
  <div id="prods">${rec.overs_products.map(p => productPanel(rec, p, url)).join('')}</div>
  <div class="card" id="newprod"><h3>Add another product under this job</h3><div id="npf">${productFields()}</div><button class="btn primary" id="addp">+ Add product</button></div>
  <div class="card"><h3>History (append-only)</h3><table class="h">${events.map(e => `<tr><td class="small">${esc(fmtDT(e.at))}</td><td>${esc(e.actor || '')}</td><td><b>${esc(e.event_type)}</b> ${e.from_status || e.to_status ? `${esc(STATUS_LABEL[e.from_status] || e.from_status || '')} → ${esc(STATUS_LABEL[e.to_status] || e.to_status || '')}` : ''}<div class="small muted">${esc(eventSummary(e, rec))}</div></td></tr>`).join('')}</table></div>`;
  // job details
  $('#r_save').onclick = async () => {
    const patch = { job_number: $('#r_job').value.trim(), customer: $('#r_cust').value.trim() || null, location: $('#r_loc').value || null, received_date: $('#r_rd').value || null, notes: $('#r_notes').value.trim() || null, updated_at: new Date().toISOString() };
    if (!patch.job_number) return toast('Job number required');
    const changed = Object.keys(patch).filter(k => k !== 'updated_at' && (patch[k] || null) !== (rec[k] || null));
    await must(sb.from('overs_records').update(patch).eq('id', id)); await logEvent(id, null, 'RECORD_EDITED', { changed, before: Object.fromEntries(changed.map(k => [k, rec[k]])), after: Object.fromEntries(changed.map(k => [k, patch[k]])) });
    Object.assign(rec, patch); if (changed.includes('job_number')) for (const p of rec.overs_products) await applyStatus(p, rec, 'Job number changed');
    toast('Saved'); router();
  };
  // photos
  app.querySelectorAll('[data-full]').forEach(im => im.onclick = () => { const d = document.createElement('div'); d.className = 'full'; d.innerHTML = `<img src="${im.dataset.full}">`; d.onclick = () => d.remove(); document.body.append(d); });
  $('#addph').onchange = async e => { const files = [...e.target.files]; if (!files.length) return;
    const st = await uploadQueue($('#phq'), files, id, params.get('p') || rec.overs_products[0]?.id || null);
    if (st.some(s => s.state === 'ok')) { await logEvent(id, null, 'PHOTOS_ADDED', { count: st.filter(s => s.state === 'ok').length }); }
    if (st.every(s => s.state === 'ok')) router(); };
  wireContainers($('#addcp'));
  $('#addc').onclick = async () => { const cs = readContainers($('#addcp')); if (!cs.length) return; await must(sb.from('overs_containers').insert(cs.map(c => ({ ...c, record_id: id, added_by: staff() })))); await logEvent(id, null, 'CONTAINERS_ADDED', { containers: cs }); toast('Containers added'); router(); };
  wireProductFields($('#npf'));
  $('#addp').onclick = async () => { const pf = readProductFields($('#npf')); const p = await must(sb.from('overs_products').insert({ ...pf, record_id: id, is_test: rec.is_test, created_by: staff() }).select().single()); await logEvent(id, p.id, 'PRODUCT_ADDED', { product: pf }); await applyStatus(p, rec, 'Product added'); router(); };
  for (const p of rec.overs_products) wireProductPanel(rec, p);
  if (params.get('add') === 'containers') $('#cont').scrollIntoView(); else if (params.get('add') === 'product') $('#newprod').scrollIntoView(); else if (params.get('p')) document.getElementById('p_' + params.get('p'))?.scrollIntoView();
}
function eventSummary(e, rec) {
  const d = e.data || {}; const p = rec.overs_products.find(x => x.id === e.product_id);
  const pre = p ? `[${p.description || p.product_type || 'product'}] ` : '';
  if (e.event_type === 'REVIEW_SAVED') return pre + `ship checked ${d.shipping_checked}, ticket ${d.ticket_checked}, open ${d.open_records}, future ${d.future_dates}, item ${d.item_match}${d.verified_item_number ? ' ' + d.verified_item_number : ''}, last ship ${d.last_ship_date || '—'} ${d.last_ship_time || ''}`;
  if (e.event_type === 'STATUS_CHANGE') return pre + (d.reason || '') + (d.why ? ' · ' + d.why : '');
  if (e.event_type === 'CONTAINERS_ADDED' || e.event_type === 'RECEIVED') return pre + (d.containers || []).map(c => `${c.count} ${c.container_type}`).join(', ');
  if (e.event_type === 'APPROVAL_INVALIDATED') return pre + 'Recycle approval cleared: ' + (d.why || '');
  if (e.event_type === 'PRODUCT_EDITED' || e.event_type === 'RECORD_EDITED') return pre + (d.changed || []).map(k => `${k}: "${d.before?.[k] ?? ''}" → "${d.after?.[k] ?? ''}"`).join('; ');
  if (e.event_type === 'MARKED_RETURNED' || e.event_type === 'MARKED_RECYCLED') return pre + `qty ${d.quantity ?? 'unknown'}${d.note ? ' · ' + d.note : ''}`;
  return pre + (d.note || d.date || '');
}
function productPanel(rec, p, url) {
  const r = p.review || {}; const done = ['RETURNED', 'RECYCLED'].includes(p.status);
  const yn = (n, v) => seg(n, [['Y', 'Yes'], ['N', 'No']], v); const ynu = (n, v) => seg(n, [['Y', 'Yes'], ['N', 'No'], ['U', 'Unknown']], v);
  return `<div class="card" id="p_${p.id}" data-prod="${p.id}" style="border-left:10px solid var(--${{ NEEDS_REVIEW: 'nrb', HOLD_OPEN: 'hob', HOLD_24H: 'hwb', ELIGIBLE_FINAL: 'hwb', RETURN_INV: 'rib', READY_RECYCLE: 'rrb', RETURNED: 'rib', RECYCLED: 'rrb' }[p.status]})">
  <div class="bigstatus b-${p.status}" data-status="${p.status}">${STATUS_LABEL[p.status]}${['NEEDS_REVIEW', 'HOLD_OPEN', 'HOLD_24H', 'ELIGIBLE_FINAL'].includes(p.status) ? ' · DO NOT RECYCLE' : ''}</div>
  ${r.last_ship_date && !r.last_ship_time ? `<div class="warn small">Last ship date has no time — ${settings.date_only_policy === 'end_of_day' ? 'assumed shipped 11:59 PM CT that day; 24h wait starts then.' : 'manual review required.'}</div>` : ''}<div class="small">${esc(p.status_reason || '')}${p.eligible_at ? ` · Eligibility time: ${esc(fmtDT(p.eligible_at))}` : ''}</div>
  ${p.completion ? `<div class="upl ok">${p.completion.type === 'RETURNED' ? 'Returned to inventory' : 'Recycled'} by ${esc(p.completion.by)} on ${esc(fmtDT(p.completion.at))}${p.completion.quantity != null ? ` · quantity ${p.completion.quantity}` : ' · quantity unknown'}</div>` : ''}
  <details ${done ? '' : 'open'}><summary><b>Product: ${esc(p.product_type || '')} ${esc(p.description || '')}</b> ${p.verified_item_number ? `· Verified item ${esc(p.verified_item_number)}` : p.ocr_item_number ? `· Label item ${esc(p.ocr_item_number)} (UNVERIFIED)` : ''}</summary>
   <div data-pf>${productFields(p)}</div><button class="btn" data-act="saveprod" ${done ? 'disabled' : ''}>Save product details</button>
   <p class="small muted">Changing product identity recalculates status and cancels any recycle approval.</p></details>
  ${done ? '' : `<details open><summary><b>PrintStream review (manual)</b> ${r.checked_by ? `<span class="small muted">last by ${esc(r.checked_by)} ${esc(fmtDT(r.checked_at))}</span>` : ''}</summary><div data-rv>
   <div class="row"><div class="grow"><label class="f"><span>Shipping records checked?</span></label>${yn('shipping_checked', r.shipping_checked)}</div><div class="grow"><label class="f"><span>Work ticket checked?</span></label>${yn('ticket_checked', r.ticket_checked)}</div></div>
   <div class="row"><div class="grow"><label class="f"><span>Any OPEN shipping records?</span></label>${ynu('open_records', r.open_records)}</div><div class="grow"><label class="f"><span>Any FUTURE ship dates?</span></label>${ynu('future_dates', r.future_dates)}</div></div>
   <label class="f"><span>Matching inventory item number (must match the physical product)</span></label>${seg('item_match', [['FOUND', 'Found'], ['NOT_FOUND', 'Confirmed not found'], ['NOT_CHECKED', 'Not checked']], r.item_match)}
   <label class="f"><span>Verified item number (required when Found)</span><input name="rv_item" value="${esc(r.verified_item_number || p.verified_item_number)}"></label>
   <div class="row"><label class="f grow"><span>Last ACTUAL ship date</span><input type="date" name="rv_date" value="${esc(r.last_ship_date)}"></label><label class="f grow"><span>Time (leave blank if unknown)</span><input type="time" name="rv_time" value="${esc(r.last_ship_time)}"></label></div>
   <label class="f"><span>Review notes</span><textarea name="rv_notes" rows="2">${esc(r.notes)}</textarea></label>
   <button class="btn primary big" data-act="review">✔ Save review as ${esc(staff())}</button></div></details>
   ${p.status === 'HOLD_OPEN' || p.status === 'NEEDS_REVIEW' ? `<div class="row" style="margin-top:8px"><label class="f"><span>Next review date</span><input type="date" name="nrd" value="${esc(p.next_review_date)}"></label><button class="btn" data-act="nrd">Set</button></div>` : ''}
   ${p.status === 'ELIGIBLE_FINAL' ? `<div class="warn"><b>Final check before recycling</b> — re-check PrintStream now and confirm:<br>
     <label class="row"><input type="checkbox" name="fc1" style="width:24px;height:24px"> All shipping records are closed</label>
     <label class="row"><input type="checkbox" name="fc2" style="width:24px;height:24px"> No future ship dates</label>
     <label class="row"><input type="checkbox" name="fc3" style="width:24px;height:24px"> No matching inventory item number (confirmed not found)</label>
     <button class="btn red big" data-act="final">Approve: Ready to recycle</button></div>` : ''}
   <div class="row" style="margin-top:10px"><label class="f"><span>Quantity (optional)</span><input type="number" min="0" name="cqty" style="max-width:140px" placeholder="unknown"></label>
    <button class="btn green big" data-act="returned" ${p.status === 'RETURN_INV' ? '' : 'disabled title="Only when status is Return to Inventory"'}>✅ Mark Returned to Inventory</button>
    <button class="btn red big" data-act="recycled" ${p.status === 'READY_RECYCLE' ? '' : 'disabled title="Only when status is Ready to Recycle"'}>♻ Mark Recycled</button></div>`}
  <div class="row" style="margin-top:6px">${(rec.overs_photos || []).length ? `<span class="small">Main photo:</span>${rec.overs_photos.map(ph => `<img src="${esc(url(ph.thumb_path || ph.path))}" data-main="${ph.id}" style="width:48px;height:48px;object-fit:cover;border-radius:6px;cursor:pointer;border:3px solid ${mainPhoto(p, rec)?.id === ph.id ? '#0b5ed7' : 'transparent'}">`).join('')}` : ''}
   <a class="btn sm" href="#/flags?ids=${p.id}">🖨 Flag</a></div></div>`;
}
function wireProductPanel(rec, p) {
  const el = document.getElementById('p_' + p.id); wireSegs(el); wireProductFields(el.querySelector('[data-pf]'));
  const act = (n, f) => { const b = el.querySelector(`[data-act=${n}]`); if (b) b.onclick = async () => { b.disabled = true; try { await f(); } catch (e) { toast('Error: ' + e.message, 6000); b.disabled = false; } }; };
  act('saveprod', async () => {
    const pf = readProductFields(el.querySelector('[data-pf]')); const changed = Object.keys(pf).filter(k => (pf[k] ?? null) !== (p[k] ?? null));
    if (!changed.length) return toast('No changes');
    await must(sb.from('overs_products').update(pf).eq('id', p.id));
    await logEvent(rec.id, p.id, 'PRODUCT_EDITED', { changed, before: Object.fromEntries(changed.map(k => [k, p[k]])), after: Object.fromEntries(changed.map(k => [k, pf[k]])) });
    Object.assign(p, pf); await applyStatus(p, rec, 'Product details changed: ' + changed.join(', ')); router();
  });
  act('review', async () => {
    const rv = el.querySelector('[data-rv]'); const v = n => rv.querySelector(`[name=${n}]`).value.trim();
    const data = { shipping_checked: segVal(rv, 'shipping_checked') || null, ticket_checked: segVal(rv, 'ticket_checked') || null, open_records: segVal(rv, 'open_records') || null, future_dates: segVal(rv, 'future_dates') || null,
      item_match: segVal(rv, 'item_match') || 'NOT_CHECKED', verified_item_number: v('rv_item') || null, last_ship_date: v('rv_date') || null, last_ship_time: v('rv_time') || null, notes: v('rv_notes') || null, checked_by: staff(), checked_at: new Date().toISOString() };
    if (data.item_match === 'FOUND' && !data.verified_item_number) { toast('Enter the verified item number when the item is Found.', 6000); el.querySelector('[data-act=review]').disabled = false; return; }
    if (data.item_match !== 'FOUND') data.verified_item_number = null;
    const patch = { review: data };
    if (data.item_match === 'FOUND' && data.verified_item_number !== p.verified_item_number) { patch.verified_item_number = data.verified_item_number; }
    const fpBefore = approvalFingerprint({ ...p, job_number: rec.job_number }, p.review);
    await must(sb.from('overs_products').update(patch).eq('id', p.id)); Object.assign(p, patch);
    const r = evalProduct(p, rec);
    await must(sb.from('overs_reviews').insert({ product_id: p.id, data, computed_status: r.status, checked_by: staff() }));
    await logEvent(rec.id, p.id, 'REVIEW_SAVED', data);
    await applyStatus(p, rec, fpBefore !== approvalFingerprint({ ...p, job_number: rec.job_number }, p.review) ? 'PrintStream findings changed' : 'PrintStream review saved');
    toast('Review saved → ' + STATUS_LABEL[p.status]); router();
  });
  act('nrd', async () => { const d = el.querySelector('[name=nrd]').value || null; await must(sb.from('overs_products').update({ next_review_date: d }).eq('id', p.id)); await logEvent(rec.id, p.id, 'NEXT_REVIEW_SET', { date: d }); toast('Next review date set'); router(); });
  act('final', async () => {
    if (!['fc1', 'fc2', 'fc3'].every(n => el.querySelector(`[name=${n}]`).checked)) { toast('All three confirmations are required.', 5000); el.querySelector('[data-act=final]').disabled = false; return; }
    const fc = { all_closed: true, no_future: true, not_found: true, by: staff(), at: new Date().toISOString(), fingerprint: approvalFingerprint({ ...p, job_number: rec.job_number }, p.review) };
    await must(sb.from('overs_products').update({ final_check: fc }).eq('id', p.id)); p.final_check = fc;
    await logEvent(rec.id, p.id, 'FINAL_CHECK_APPROVED', fc); await applyStatus(p, rec, 'Staff final check'); router();
  });
  const complete = type => async () => {
    const r = evalProduct(p, rec); const need = type === 'RETURNED' ? 'RETURN_INV' : 'READY_RECYCLE';
    if (r.status !== need) throw new Error('Status changed — reload'); const q = el.querySelector('[name=cqty]').value;
    const completion = { type, by: staff(), at: new Date().toISOString(), quantity: q === '' ? null : parseInt(q, 10), from_status: r.status };
    await must(sb.from('overs_products').update({ completion }).eq('id', p.id)); p.completion = completion;
    await logEvent(rec.id, p.id, type === 'RETURNED' ? 'MARKED_RETURNED' : 'MARKED_RECYCLED', completion); await applyStatus(p, rec, type === 'RETURNED' ? 'Marked returned to inventory' : 'Marked recycled'); router();
  };
  act('returned', complete('RETURNED')); act('recycled', complete('RECYCLED'));
  el.querySelectorAll('[data-main]').forEach(im => im.onclick = async () => { await must(sb.from('overs_products').update({ main_photo_id: im.dataset.main }).eq('id', p.id)); toast('Main photo set'); router(); });
}

// ---------- flags ----------
function qrSvg(text, cell) { const q = qrcode(0, 'M'); q.addData(text); q.make(); return q.createSvgTag({ cellSize: cell, margin: 0 }); }
async function viewFlags(params) {
  const ids = (params.get('ids') || '').split(',').filter(Boolean); const per = +(params.get('per') || localStorage.getItem('overs_flag_per') || 2);
  const prods = ids.length ? await must(sb.from('overs_products').select('*, overs_records(*, overs_containers(*))').in('id', ids)) : [];
  const flag = p => { const rec = p.overs_records; const s = p.status; const dnr = ['NEEDS_REVIEW', 'HOLD_OPEN', 'HOLD_24H', 'ELIGIBLE_FINAL'].includes(s);
    const icon = { NEEDS_REVIEW: '?', HOLD_OPEN: '■', HOLD_24H: '⏳', ELIGIBLE_FINAL: '⚠', RETURN_INV: '✔', READY_RECYCLE: '♻', RETURNED: '✔', RECYCLED: '♻' }[s];
    const r = p.review || {};
    return `<div class="flag f-${s}"><div class="st">${icon} ${STATUS_LABEL[s]}</div>${dnr ? '<div class="dnr">✖ DO NOT RECYCLE ✖</div>' : ''}
     <div class="job">JOB ${esc(rec.job_number)}</div><div class="kv">
     <b>Customer</b><span>${esc(rec.customer || '—')}</span><b>Product</b><span>${esc([p.product_type, p.description].filter(Boolean).join(' — ') || '—')}</span>
     <b>Segment</b><span>${esc(p.segment || '—')}</span>${s === 'RETURN_INV' || s === 'RETURNED' ? `<b>Verified item #</b><span><b>${esc(p.verified_item_number || '')}</b></span>` : ''}
     <b>Location</b><span>${esc(rec.location || '—')}</span><b>Containers</b><span>${esc(containersText(rec))}</span>
     <b>Checked</b><span>${r.checked_by ? `${esc(r.checked_by)} · ${esc(fmtDT(r.checked_at))}` : 'Not yet checked'}</span>
     ${p.eligible_at && ['HOLD_24H', 'ELIGIBLE_FINAL', 'READY_RECYCLE'].includes(s) ? `<b>Eligible</b><span>${esc(fmtDT(p.eligible_at))}${s === 'HOLD_24H' ? ' — then FINAL CHECK' : ''}</span>` : ''}
     ${s === 'READY_RECYCLE' && p.final_check ? `<b>Final check</b><span>${esc(p.final_check.by)} · ${esc(fmtDT(p.final_check.at))}</span>` : ''}
     <b>Reason</b><span>${esc(p.status_reason || '')}</span>${r.last_ship_date && !r.last_ship_time ? `<b>Ship time</b><span>Date-only (${esc(fmtD(r.last_ship_date))}) — assumed 11:59 PM CT</span>` : ''}<b>Received</b><span>${esc(fmtD(rec.received_date))}</span></div>
     <div class="qr">${qrSvg(`${APP_URL}#/r/${rec.id}?p=${p.id}`, per === 4 ? 2 : 3)}Scan: record & photos</div></div>`; };
  const pages = []; for (let i = 0; i < prods.length; i += per) pages.push(prods.slice(i, i + per));
  app.innerHTML = `<div class="noprint card row"><b>${prods.length} flag(s)</b> Layout: ${seg('per', [[1, '1 per page'], [2, '2 per page'], [4, '4 per page']], per)}<button class="btn primary big" onclick="print()">🖨 Print</button><span class="small muted">Letter size. Colors + patterns + text, readable in black & white.</span></div>
   ${pages.map(pg => `<div class="sheet per-${per}">${pg.map(flag).join('')}</div>`).join('') || '<p class="pad">No flags selected.</p>'}`;
  wireSegs(app, (_, v) => { localStorage.setItem('overs_flag_per', v); params.set('per', v); location.hash = '#/flags?' + params.toString(); });
}

// ---------- settings + backup ----------
async function viewSettings() {
  const pol = settings.date_only_policy || 'review';
  app.innerHTML = `<h2>Settings</h2>
  <div class="card"><h3>Date-only shipments</h3><p class="small">When PrintStream shows a last ship date without a time:</p>${seg('pol', Object.entries(DATE_ONLY_POLICIES).map(([k, v]) => [k, v]), pol)}<p class="small muted">Default is manual review until Jonathan confirms the policy. Changing this recalculates statuses.</p></div>
  <div class="card"><h3>Staff names</h3>${staffList.map(s => `<span class="badge b-NEEDS_REVIEW" style="margin:3px">${esc(s.name)} <a href="#" data-rmstaff="${s.id}">✕</a></span>`).join('')}<div class="row" style="margin-top:8px"><input id="ns" placeholder="Name" style="max-width:260px"><button class="btn" id="ans">Add</button><button class="btn" onclick="localStorage.removeItem('overs_staff_name');location.hash='#/staff'">Switch user on this device</button></div></div>
  <div class="card"><h3>Locations</h3>${locations.map(s => `<span class="badge b-NEEDS_REVIEW" style="margin:3px">${esc(s.name)} <a href="#" data-rmloc="${s.id}">✕</a></span>`).join('')}<div class="row" style="margin-top:8px"><input id="nl" placeholder="Location" style="max-width:260px"><button class="btn" id="anl">Add</button></div></div>
  <div class="card"><h3>Backup</h3><p class="small">Export downloads a .zip with all records, reviews, history (data.json) and every photo. Import restores a backup (existing rows are kept; missing ones added).</p>
   <div class="row"><button class="btn primary" id="exp">⬇ Export backup</button><label class="btn">⬆ Import backup<input id="imp" type="file" accept=".zip" hidden></label></div><div id="bk"></div></div>
  <div class="card"><h3>Test mode</h3><p class="small">Test mode keeps practice records separate (flagged is_test, hidden from normal views).</p><button class="btn" id="tm">${testMode() ? 'Turn OFF test mode' : 'Turn ON test mode'}</button></div>`;
  wireSegs(app, async (n, v) => { if (n !== 'pol') return; await must(sb.from('overs_settings').upsert({ key: 'date_only_policy', value: v, updated_by: staff(), updated_at: new Date().toISOString() })); settings.date_only_policy = v; await logEvent(null, null, 'SETTING_CHANGED', { date_only_policy: v }); await loadRecords(); toast('Policy saved; statuses recalculated'); });
  $('#ans').onclick = async () => { const n = $('#ns').value.trim(); if (!n) return; await sb.from('overs_staff').upsert({ name: n, active: true }, { onConflict: 'name' }); window.__refLoaded = false; await loadRef(); window.__refLoaded = true; viewSettings(); };
  $('#anl').onclick = async () => { const n = $('#nl').value.trim(); if (!n) return; await sb.from('overs_locations').upsert({ name: n, active: true, sort: locations.length + 1 }, { onConflict: 'name' }); await loadRef(); viewSettings(); };
  app.querySelectorAll('[data-rmstaff]').forEach(a => a.onclick = async e => { e.preventDefault(); await sb.from('overs_staff').update({ active: false }).eq('id', a.dataset.rmstaff); await loadRef(); viewSettings(); });
  app.querySelectorAll('[data-rmloc]').forEach(a => a.onclick = async e => { e.preventDefault(); await sb.from('overs_locations').update({ active: false }).eq('id', a.dataset.rmloc); await loadRef(); viewSettings(); });
  $('#tm').onclick = () => { localStorage.setItem('overs_test_mode', testMode() ? '0' : '1'); router(); };
  $('#exp').onclick = exportBackup; $('#imp').onchange = e => e.target.files[0] && importBackup(e.target.files[0]);
}
const TABLES = ['overs_staff', 'overs_locations', 'overs_settings', 'overs_records', 'overs_products', 'overs_containers', 'overs_photos', 'overs_reviews', 'overs_events'];
async function fetchAll(t) { const out = []; for (let i = 0; ; i += 1000) { const d = await must(sb.from(t).select('*').range(i, i + 999)); out.push(...d); if (d.length < 1000) return out; } }
async function exportBackup() {
  const bk = $('#bk'); bk.innerHTML = '<div class="upl pending">Exporting…</div>'; const zip = new JSZip(); const data = { app: 'darwill-overs-manager', version: 1, exported_at: new Date().toISOString(), tables: {} };
  for (const t of TABLES) data.tables[t] = await fetchAll(t);
  let n = 0, fail = 0;
  for (const ph of data.tables.overs_photos) for (const path of [ph.path, ph.thumb_path].filter(Boolean)) {
    const { data: blob, error } = await sb.storage.from(BUCKET).download(path); if (error) { fail++; continue; } zip.file('photos/' + path, blob); n++; bk.innerHTML = `<div class="upl pending">Exporting photos… ${n}</div>`; }
  zip.file('data.json', JSON.stringify(data, null, 1));
  const blob = await zip.generateAsync({ type: 'blob' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `overs-backup-${todayCT()}.zip`; a.click();
  bk.innerHTML = `<div class="upl ${fail ? 'fail' : 'ok'}">Backup: ${data.tables.overs_records.length} records, ${n} photo files${fail ? `, ${fail} photo files FAILED to download` : ''}.</div>`;
}
async function importBackup(file) {
  const bk = $('#bk'); bk.innerHTML = '<div class="upl pending">Importing…</div>';
  try {
    const zip = await JSZip.loadAsync(file); const data = JSON.parse(await zip.file('data.json').async('string'));
    if (data.app !== 'darwill-overs-manager') throw new Error('Not an Overs Manager backup');
    for (const t of TABLES) { const rows = data.tables[t] || []; for (let i = 0; i < rows.length; i += 500) await must(sb.from(t).upsert(rows.slice(i, i + 500), { onConflict: t === 'overs_settings' ? 'key' : 'id', ignoreDuplicates: true })); }
    let n = 0, fail = 0; const files = Object.keys(zip.files).filter(f => f.startsWith('photos/') && !zip.files[f].dir);
    for (const f of files) { const blob = await zip.file(f).async('blob'); const { error } = await sb.storage.from(BUCKET).upload(f.slice(7), blob, { contentType: 'image/jpeg' }); if (error && !/exists|Duplicate/i.test(error.message)) fail++; else n++; }
    bk.innerHTML = `<div class="upl ${fail ? 'fail' : 'ok'}">Import done: ${data.tables.overs_records.length} records, ${n} photo files ok${fail ? `, ${fail} FAILED` : ''}.</div>`;
  } catch (e) { bk.innerHTML = `<div class="err">Import failed: ${esc(e.message)}</div>`; }
}
router();
