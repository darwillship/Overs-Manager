import { chromium } from '/workspace/tools/node_modules/playwright/index.mjs';
import fs from 'fs';
const BASE = process.env.BASE || 'http://localhost:8799/'; const PW = process.env.PW /* team password via env */;
const out = []; const ok = (n, c, extra = '') => { out.push(`${c ? 'PASS' : 'FAIL'} ${n} ${extra}`); console.log(out.at(-1)); };
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1366, height: 900 }, acceptDownloads: true });
await ctx.addInitScript(() => { localStorage.setItem('overs_test_mode', '1'); });
const pg = await ctx.newPage(); pg.on('pageerror', e => console.log('PAGEERR', e.message));
await pg.goto(BASE); await pg.fill('#pw', PW); await pg.click('#go');
await pg.click('text=Jonathan Bernabe'); await pg.waitForSelector('#cols');
const go = async h => { await pg.goto('about:blank'); await pg.goto(BASE + h); };
const S = 'shots'; fs.mkdirSync(S, { recursive: true });

async function ocrOn(file, crop) {
  await go('#/new'); await pg.waitForSelector('#upl', { state: 'attached' });
  await pg.setInputFiles('#upl', file); await pg.waitForSelector('#ocr');
  if (crop) await pg.evaluate(c => window.__setCrop(c), crop);
  await pg.click('#ocr'); await pg.waitForFunction(() => !document.querySelector('#ocrmsg .pending'), null, { timeout: 120000 });
  const v = n => pg.inputValue(`#fm [name=${n}]`);
  return { job: await v('job_number'), customer: await v('customer'), desc: await v('description'), seg: await v('segment'), ocrItem: await v('ocr_item_number'), verItem: await v('verified_item_number'), date: await v('label_date'), qty: await v('quantity'), msg: await pg.innerText('#ocrmsg'), unc: await pg.$$eval('#fm .uncertain', e => e.length), lines: await pg.evaluate(() => window.__lastOCR?.lines.map(l => l.text.trim() + ' (' + Math.round(l.confidence) + ')')) };
}
// 1. label with leading zeros
let r = await ocrOn('label1.png'); console.log(r);
ok('OCR job number w/ leading zeros', r.job === '0012345', r.job);
ok('OCR customer', /Midwest Credit Union/i.test(r.customer), r.customer);
ok('OCR item -> unverified field only', r.ocrItem === '004417' && r.verItem === '', `${r.ocrItem}/${r.verItem}`);
ok('OCR label date -> label date', r.date === '2026-10-09', r.date);
ok('OCR quantity', r.qty === '2500', r.qty);
await pg.click('[data-pt="Envelopes"]'); await pg.click('#cp [data-plus]');
await pg.selectOption('#fm [name=location]', 'Overs Area A'); await pg.check('#conf');
await pg.click('#save'); await pg.waitForSelector('#after a', { timeout: 60000 });
ok('photo saved with record', (await pg.$$('[data-upl=ok]')).length === 1);
await pg.click('#after a.primary'); await pg.waitForSelector('[data-prod]');
const rec1 = pg.url().match(/#\/r\/([^?]+)/)[1];
ok('photo persists on reopen', (await pg.$$('#ph img')).length === 1);
ok('no review -> NEEDS REVIEW', await pg.getAttribute('[data-status]', 'data-status') === 'NEEDS_REVIEW');
// 2. description in item field
r = await ocrOn('label_desc_item.png'); console.log(r);
ok('description in Item field NOT treated as item number', r.ocrItem === '' && r.verItem === '' && /item number/i.test(r.msg), `ocrItem='${r.ocrItem}' desc='${r.desc}'`);
// 3. two labels
r = await ocrOn('two_labels.png'); console.log(r);
ok('two labels detected, nothing combined/filled', r.job === '' && r.customer === '' && /More than one job/i.test(r.msg), r.msg.slice(0, 120));
r = await ocrOn('two_labels.png', { x: 170, y: 330, w: 560, h: 330 }); console.log(r);
ok('crop to one label -> only that job', r.job === '0011111' && /Acme/i.test(r.customer) && !/Beta/i.test(r.customer), `${r.job} ${r.customer}`);
// 4. unreadable
r = await ocrOn('unreadable.png'); console.log(r);
ok('unreadable -> blank + flagged', r.job === '' && /manually|could not/i.test(r.msg), r.msg.slice(0, 100));
// phone screenshot of capture
{ const ph = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, storageState: await ctx.storageState() }); const p2 = await ph.newPage();
  await p2.goto(BASE + '#/new'); await p2.waitForSelector('#upl', { state: 'attached' }); await p2.setInputFiles('#upl', 'label1.png'); await p2.click('#ocr');
  await p2.waitForFunction(() => !document.querySelector('#ocrmsg .pending'), null, { timeout: 120000 }); await p2.evaluate(() => scrollTo(0, 0));
  await p2.screenshot({ path: `${S}/phone_capture_390.png`, fullPage: true }); await ph.close(); }
// 5. failed photo save + retry
await go('#/r/' + rec1); await pg.waitForSelector('#addph', { state: 'attached' });
let fail = true; await pg.route('**/storage/v1/object/overs-photos/**', rt => fail && rt.request().method() === 'POST' ? rt.fulfill({ status: 500, body: '{"message":"simulated network failure"}', contentType: 'application/json' }) : rt.continue());
await pg.setInputFiles('#addph', 'label_desc_item.png'); await pg.waitForSelector('[data-upl=fail]', { timeout: 30000 });
ok('failed photo save shown, not claimed saved', /NOT saved/.test(await pg.innerText('#phq')));
await pg.screenshot({ path: `${S}/photo_fail_retry.png` });
fail = false; await pg.click('[data-retry]'); await pg.waitForSelector('#ph img:nth-child(1)'); await pg.waitForTimeout(2500);
await go('#/r/' + rec1); await pg.waitForSelector('[data-prod]');
ok('retry saved photo to same record (2 photos after reopen)', (await pg.$$('#ph img')).length === 2);
await pg.unroute('**/storage/v1/object/overs-photos/**');
// 6. review rules
const pid = async i => (await pg.$$eval('[data-prod]', e => e.map(x => x.dataset.prod)))[i];
const status = async id => pg.getAttribute(`#p_${id} [data-status]`, 'data-status');
async function review(id, o) {
  for (const [k, v] of Object.entries(o)) if (['shipping_checked', 'ticket_checked', 'open_records', 'future_dates', 'item_match'].includes(k)) await pg.click(`#p_${id} [data-seg=${k}] button[data-v=${v}]`);
  if ('item' in o) await pg.fill(`#p_${id} [name=rv_item]`, o.item);
  if ('date' in o) await pg.fill(`#p_${id} [name=rv_date]`, o.date);
  if ('time' in o) await pg.fill(`#p_${id} [name=rv_time]`, o.time);
  await pg.click(`#p_${id} [data-act=review]`); await pg.waitForTimeout(2500); await pg.waitForSelector(`#p_${id}`);
  return status(id);
}
const A = await pid(0);
ok('blank item / not checked cannot authorize', await review(A, { shipping_checked: 'Y', ticket_checked: 'Y', open_records: 'N', future_dates: 'N', item_match: 'NOT_CHECKED', item: '' }) === 'NEEDS_REVIEW');
ok('unknown open records -> NEEDS REVIEW', await review(A, { open_records: 'U' }) === 'NEEDS_REVIEW');
ok('open record -> HOLD OPEN JOB', await review(A, { open_records: 'Y', item_match: 'NOT_FOUND', date: '2026-10-01', time: '08:00' }) === 'HOLD_OPEN');
ok('open job: recycle button disabled', !(await pg.$(`#p_${A} [data-act=recycled]:not([disabled])`)) && !(await pg.$(`#p_${A} [data-act=final]`)));
ok('future ship date -> HOLD OPEN JOB', await review(A, { open_records: 'N', future_dates: 'Y' }) === 'HOLD_OPEN');
ok('Found w/ verified item -> RETURN TO INVENTORY', await review(A, { future_dates: 'N', item_match: 'FOUND', item: '004417' }) === 'RETURN_INV');
// second & third product, same job
async function addProduct(desc) { await pg.click('#npf [data-pt="Brochures"]'); await pg.fill('#npf [name=description]', desc); await pg.click('#addp'); await pg.waitForTimeout(2500); await pg.waitForSelector('[data-prod]'); }
await addProduct('Test insert sheet'); const B = await pid(1);
ok('date-only ship date -> NEEDS REVIEW by default', await review(B, { shipping_checked: 'Y', ticket_checked: 'Y', open_records: 'N', future_dates: 'N', item_match: 'NOT_FOUND', date: '2026-10-11', time: '' }) === 'NEEDS_REVIEW');
ok('missing ship date blocks eligibility', await review(B, { date: '' }) === 'NEEDS_REVIEW');
ok('>=24h since ship -> ELIGIBLE FINAL CHECK (not Ready)', await review(B, { date: '2026-10-11', time: '09:00' }) === 'ELIGIBLE_FINAL');
await pg.click(`#p_${B} [data-act=final]`); await pg.waitForTimeout(800);
ok('final check needs all confirmations', await status(B) === 'ELIGIBLE_FINAL');
for (const n of ['fc1', 'fc2', 'fc3']) await pg.check(`#p_${B} [name=${n}]`);
await pg.click(`#p_${B} [data-act=final]`); await pg.waitForTimeout(2500);
ok('staff final check -> READY TO RECYCLE', await status(B) === 'READY_RECYCLE');
ok('changed findings invalidate approval', await review(B, { time: '10:00' }) === 'ELIGIBLE_FINAL');
for (const n of ['fc1', 'fc2', 'fc3']) await pg.check(`#p_${B} [name=${n}]`); await pg.click(`#p_${B} [data-act=final]`); await pg.waitForTimeout(2500);
await pg.fill(`#p_${B} [data-pf] [name=description]`, 'Test insert sheet v2'); await pg.click(`#p_${B} [data-act=saveprod]`); await pg.waitForTimeout(2500);
ok('changed product identity invalidates approval', await status(B) === 'ELIGIBLE_FINAL');
await addProduct('Test reply card'); const C = await pid(2);
const now = new Date(); const ct = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(now);
const hr = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(now - 3600e3));
ok('<24h since ship -> HOLD WAITING 24H', await review(C, { shipping_checked: 'Y', ticket_checked: 'Y', open_records: 'N', future_dates: 'N', item_match: 'NOT_FOUND', date: ct, time: hr }) === 'HOLD_24H');
ok('different products under one job differ', new Set([await status(A), await status(B), await status(C)]).size === 3, `${await status(A)} ${await status(B)} ${await status(C)}`);
// completion
await pg.fill(`#p_${A} [name=cqty]`, '1800'); await pg.click(`#p_${A} [data-act=returned]`); await pg.waitForTimeout(2500);
ok('Mark returned records who/when/qty', await status(A) === 'RETURNED' && /Jonathan Bernabe/.test(await pg.innerText(`#p_${A}`)) && /1800/.test(await pg.innerText(`#p_${A}`)));
for (const n of ['fc1', 'fc2', 'fc3']) await pg.check(`#p_${B} [name=${n}]`); await pg.click(`#p_${B} [data-act=final]`); await pg.waitForTimeout(2500);
await pg.click(`#p_${B} [data-act=recycled]`); await pg.waitForTimeout(2500);
ok('Mark recycled', await status(B) === 'RECYCLED');
const hist = await pg.innerText('table.h:last-of-type'); ok('history logged (append-only)', /APPROVAL_INVALIDATED/.test(await pg.content()) && /MARKED_RECYCLED/.test(await pg.content()));
await pg.screenshot({ path: `${S}/record_detail.png`, fullPage: true });
// a few more records for dashboard variety
async function quick(job, cust, desc, loc) { await go('#/new'); await pg.waitForSelector('#fm'); await pg.fill('#fm [name=job_number]', job); await pg.fill('#fm [name=customer]', cust); await pg.click('[data-pt="Flat sheets"]'); await pg.fill('#fm [name=description]', desc); await pg.selectOption('#fm [name=location]', loc); await pg.check('#conf'); await pg.click('#save'); await pg.waitForSelector('#after a'); }
await quick('0011111', 'Acme Bank', 'Flat sheet 8.5x11', 'Overs Rack');
await go('#/new'); await pg.waitForSelector('#fm'); await pg.fill('#fm [name=job_number]', '0011111'); await pg.press('#fm [name=job_number]', 'Tab'); await pg.waitForTimeout(1500);
ok('duplicate warning offers add containers', /already in overs/.test(await pg.innerText('#dup')) && !!(await pg.$('#dup a[href*="add=containers"]')));
await quick('0098799', 'Lakeview Health', 'Tri-fold brochure', 'Overs Area B');
// dashboard + search
await go('#/'); await pg.waitForSelector('.pcard'); await pg.waitForTimeout(1500);
await pg.screenshot({ path: `${S}/dashboard_1366.png`, fullPage: true });
await pg.fill('#q', 'Lakeview'); ok('search by customer', (await pg.$$('.pcard')).length === 1); await pg.fill('#q', '');
// flags batch
await pg.$$eval('[data-sel]', e => e.forEach(c => c.checked = true)); await pg.click('#pf'); await pg.waitForSelector('.sheet');
await pg.screenshot({ path: `${S}/flags_2up_screen.png`, fullPage: true });
await pg.emulateMedia({ media: 'print' }); await pg.pdf({ path: `${S}/flags_2up.pdf`, format: 'Letter', printBackground: true, preferCSSPageSize: true });
await pg.emulateMedia({ media: 'screen' }); await pg.click('[data-seg=per] button[data-v="4"]'); await pg.waitForSelector('.sheet.per-4');
await pg.emulateMedia({ media: 'print' }); await pg.pdf({ path: `${S}/flags_4up.pdf`, format: 'Letter', printBackground: true, preferCSSPageSize: true }); await pg.emulateMedia({ media: 'screen' });
ok('flags have QR + DO NOT RECYCLE on hold/review', (await pg.$$('.flag svg')).length >= 3 && /DO NOT RECYCLE/.test(await pg.innerText('main')));
await go('#/history'); await pg.waitForSelector('.pcard'); ok('history shows returned & recycled with photo', (await pg.$$('#h1 .pcard img')).length >= 1 && (await pg.$$('#h2 .pcard')).length >= 1);
await go('#/work'); await pg.waitForSelector('h2'); await pg.screenshot({ path: `${S}/worklist.png`, fullPage: true });
// export backup
await go('#/settings'); await pg.waitForSelector('#exp'); const [dl] = await Promise.all([pg.waitForEvent('download', { timeout: 120000 }), pg.click('#exp')]);
await dl.saveAs(`${S}/backup.zip`); ok('backup export downloaded', fs.statSync(`${S}/backup.zip`).size > 10000, fs.statSync(`${S}/backup.zip`).size + ' bytes');
// persistence: fresh context
const c2 = await b.newContext({ viewport: { width: 1366, height: 900 }, storageState: await ctx.storageState() }); const p3 = await c2.newPage();
await p3.goto(BASE + '#/r/' + rec1); await p3.waitForSelector('[data-prod]'); await p3.waitForTimeout(1500);
ok('persisted after fresh session (statuses+photos)', (await p3.$$('#ph img')).length === 2 && (await p3.$$('[data-status=RETURNED],[data-status=RECYCLED],[data-status=HOLD_24H]')).length === 3);
fs.writeFileSync('results.txt', out.join('\n')); await b.close();
