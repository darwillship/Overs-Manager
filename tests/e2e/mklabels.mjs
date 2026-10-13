import { chromium } from '/workspace/tools/node_modules/playwright/index.mjs';
const label = (job, cust, seg, desc, item, date, qty) => `<div class="lbl"><div class="hd">DARWILL — OVERS TAG</div>
<div>JOB #: ${job}</div><div>CUSTOMER: ${cust}</div><div>SEGMENT: ${seg}</div><div>DESCRIPTION: ${desc}</div><div>ITEM NUMBER: ${item}</div><div>DATE: ${date}</div>${qty ? `<div>QTY: ${qty}</div>` : ''}</div>`;
const page = (body, rot) => `<html><body style="margin:0;background:radial-gradient(circle at 30% 30%,#9c8f7e,#5d5246);width:1400px;height:1000px;display:flex;gap:40px;align-items:center;justify-content:center;filter:blur(0.6px)">
<style>.lbl{background:linear-gradient(170deg,#fffef6,#ece8da);padding:28px 34px;font:600 30px 'DejaVu Sans Mono',monospace;color:#222;line-height:1.5;box-shadow:12px 16px 30px #0008;transform:rotate(${rot}deg);border-radius:4px}.hd{font-weight:900;border-bottom:3px solid #333;margin-bottom:8px}</style>
${body}<div style="position:absolute;inset:0;background:linear-gradient(120deg,#ffffff22,#00000033);pointer-events:none"></div></body></html>`;
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1400, height: 1000 } });
const shots = {
  label1: page(label('0012345', 'Midwest Credit Union', 'B / VERSION 2', '#10 Window Envelope', '004417', '10/09/2026', '2,500'), -2.5),
  label_desc_item: page(label('0098765', 'Lakeview Health', 'A', 'Tri-fold brochure', 'Blue tri-fold brochure', '10/08/2026', ''), 1.5),
  two_labels: page(label('0011111', 'Acme Bank', 'A', 'Flat sheet 8.5x11', '000732', '10/01/2026', '') .replace('class="lbl"', 'class="lbl" style="font-size:22px"') + label('0022222', 'Beta Insurance', 'C', 'Postcard 6x9', '000915', '10/02/2026', '').replace('class="lbl"', 'class="lbl" style="font-size:22px"'), 1),
  unreadable: `<html><body style="margin:0;width:1400px;height:1000px;background:#777;filter:blur(14px)"><div style="font:40px sans-serif;padding:200px">JOB 0055555 CUSTOMER X</div></body></html>`,
};
for (const [n, h] of Object.entries(shots)) { await p.setContent(h); await p.screenshot({ path: `/workspace/overs-test/${n}.png` }); }
await b.close(); console.log('done');
