import { chromium } from '/workspace/tools/node_modules/playwright/index.mjs';
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1344, height: 1008 }, deviceScaleFactor: 3 });
await p.setContent(`<html><body style="margin:0;width:1344px;height:1008px;overflow:hidden;background:
 linear-gradient(115deg,#7d6a52 0%,#a08a6b 40%,#6b5a45 100%);perspective:1400px">
 <div style="position:absolute;left:60px;top:80px;width:700px;height:820px;background:#c9b48f;transform:rotate(-4deg);box-shadow:0 0 0 4px #b39d78 inset"></div>
 <div style="position:absolute;left:300px;top:150px;width:720px;padding:34px 40px;background:linear-gradient(160deg,#fffdf4,#e9e3cf);
  transform:rotateX(14deg) rotateY(-9deg) rotateZ(3deg);box-shadow:30px 40px 60px #000a;font:600 31px 'DejaVu Sans',sans-serif;color:#1d1d1d;line-height:1.55;border-radius:3px">
  <div style="font:900 36px 'DejaVu Sans';border-bottom:4px solid #222;margin-bottom:10px">DARWILL INC. — OVERS TAG</div>
  <div>JOB #: 0045017</div><div>CUSTOMER: Heartland Savings Bank</div><div>SEGMENT: 03 / VERSION B</div>
  <div>DESCRIPTION: 6x9 Booklet Envelope</div><div>ITEM NUMBER: 0007731</div><div>DATE: 10/12/2026</div><div>QTY: 1,250</div>
  <div style="margin-top:14px;font-size:22px;color:#555">Checked by: ________  Location: ________</div></div>
 <div style="position:absolute;inset:0;background:radial-gradient(ellipse at 75% 20%,#fff3 0,#0000 40%),linear-gradient(200deg,#0000 55%,#0006 100%)"></div>
 </body></html>`);
await p.screenshot({ path: 'phone_raw.png' }); await b.close();
