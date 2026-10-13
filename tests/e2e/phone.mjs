import { chromium, webkit, devices } from '/workspace/tools/node_modules/playwright/index.mjs';
const BASE = process.env.BASE || 'http://localhost:8799/';
const files = (process.env.FILES || 'phone_12mp.jpg,phone_12mp_exif6.jpg,phone_12mp.heic').split(',');
const runs = [['iphone-webkit', webkit, devices['iPhone 13']], ['android-chrome', chromium, devices['Pixel 7']]];
for (const [name, engine, dev] of runs) {
  const b = await engine.launch(); const ctx = await b.newContext({ ...dev });
  await ctx.addInitScript(() => { try { localStorage.setItem('overs_test_mode', '1'); localStorage.setItem('overs_staff_name', 'Jonathan Bernabe'); } catch {} });
  const p = await ctx.newPage(); p.on('pageerror', e => console.log(name, 'PAGEERR', e.message));
  p.on('console', m => m.type() === 'error' && console.log(name, 'CONSOLE', m.text().slice(0, 200)));
  if (engine === chromium && process.env.SLOW) { const c = await ctx.newCDPSession(p); await c.send('Network.enable'); await c.send('Network.emulateNetworkConditions', { offline: false, latency: 300, downloadThroughput: 1.6e6 / 8 * 4, uploadThroughput: 750e3 / 8 }); console.log(name, 'slow 4G-ish network'); }
  await p.goto(BASE); await p.fill('#pw', process.env.PW); await p.click('#go'); await p.waitForSelector('#cols', { timeout: 30000 });
  for (const f of files) {
    await p.goto('about:blank'); await p.goto(BASE + '#/new'); await p.waitForSelector('#cam', { state: 'attached' });
    const t0 = Date.now(); await p.setInputFiles('#cam', f);
    let sawProgress = '';
    try { await p.waitForSelector('[data-ocrstatus] #pr', { timeout: 30000 }); sawProgress = await p.innerText('[data-ocrstatus]'); } catch {}
    await p.waitForFunction(() => document.querySelector('#ocrmsg') && !document.querySelector('#ocrmsg [data-ocrstatus]'), null, { timeout: 240000 });
    const v = n => p.inputValue(`#fm [name=${n}]`);
    console.log(name, f, { secs: Math.round((Date.now() - t0) / 1000), progress: sawProgress.replace(/\s+/g, ' ').slice(0, 60), job: await v('job_number'), customer: await v('customer'), desc: await v('description'), seg: await v('segment'), ocrItem: await v('ocr_item_number'), verItem: await v('verified_item_number'), date: await v('label_date'), qty: await v('quantity'), msg: (await p.innerText('#ocrmsg')).slice(0, 120).replace(/\n/g, ' ') });
    if (f === files[0]) await p.screenshot({ path: `shots/phone_auto_${name}.png`, fullPage: true });
  }
  await b.close();
}
