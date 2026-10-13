# Darwill Overs Manager

Live app: **https://darwillship.github.io/Overs-Manager/**

Tracks production leftovers (overs) from receiving → manual PrintStream review → hold / return to inventory / recycle, with photos, printable flags and full history. Separate from the Dispatch Dashboard (own `overs_` tables and `overs-photos` bucket in the same Supabase project).

> The app does **not** connect to PrintStream and never knows whether a job is closed. Every status comes from what staff record in the manual PrintStream review form.

## How staff log in
1. Open the link on a phone or PC (add to home screen on phones).
2. Sign in with the shared team login: **overs-team@darwill.com** + the team password (Jonathan has it).
3. Tap your name ("Who is using this device?"). Your name is recorded as *checked by* on every review and action. Use *Settings → Switch user on this device* to change.

## Adding users / names
- **New staff name:** Settings → Staff names → Add (or type it on the "Who is using this device?" screen).
- **Separate logins (optional):** In Supabase → Authentication → Users → *Add user* (email + password, auto-confirm). Then in the SQL editor run:
  `insert into overs_members(user_id, label) select id, 'Name' from auth.users where email = 'person@darwill.com';`
  Only accounts in `overs_members` can see or change overs data (Dispatch Dashboard users cannot).
- **Change team password:** Supabase → Authentication → Users → overs-team@darwill.com → Reset/Update password.

## Daily use
- **+ Receive:** take/upload a photo → (optional) drag a box around one label → **Read label** → check the yellow (uncertain) fields → pick product type, containers, location → tick the confirmation → Save. Photos save automatically with the record. If any photo fails it says **NOT saved** with a Retry button.
- **Record page:** PrintStream review form, final check, Mark Returned / Mark Recycled, add containers, add products, add photos, choose main photo, print flags, full history.
- **Dashboard:** six status columns (tabs on phones), search, select cards → *Print flags for selected* (1, 2 or 4 per letter page).
- **Work list:** what needs checking or clearing today. **History:** returned & recycled items with photos.

## Status rules (js/rules.js, unit tested)
1. Any open shipping record or future ship date → **HOLD — OPEN JOB** (recycling blocked).
2. Anything not checked / unknown / conflicting → **NEEDS REVIEW**.
3. All closed, no future dates, matching item verified → **RETURN TO INVENTORY**.
4. All closed, no future dates, both checked, item confirmed not found: < 24 h since last actual shipment → **HOLD — WAITING 24 HOURS**; ≥ 24 h → **ELIGIBLE — FINAL CHECK REQUIRED**.
5. Missing last shipment date blocks eligibility. Times are America/Chicago.
- Date-only shipments: per Jonathan (Oct 13, 2026) treated as shipped **11:59 PM CT** that day; the 24 h wait starts then. The assumption is shown on the record and flag. (Settings can switch back to manual review.)
- The countdown never sets Ready. **READY TO RECYCLE** only after a staff final check (all closed, no future dates, not found). Changing shipping/item findings, product identity or last ship date recalculates and cancels the approval.
- Return to Inventory / Ready to Recycle are instructions; use **Mark Returned** / **Mark Recycled** to record who, when and quantity. Reviews and status changes are append-only history.

## OCR
Uses **Tesseract.js in the browser**. The photo is read on the device and is never sent to any OCR service (free, no API key). The OCR engine and English language file (~10 MB) are downloaded once from the jsDelivr CDN and cached. OCR fills fields as suggestions only: uncertain readings are yellow, unreadable fields stay blank, leading zeros are kept, the label's "Item Number" field only fills the *unverified* label item number (and text there is never treated as an item number), label date is never a ship date, and if more than one job number is found nothing is filled — crop to one label. If OCR fails the app says so; manual entry always works.

## Photos
Compressed in the browser (long side 2200 px, JPEG 85% – label text stays readable) plus a 360 px thumbnail, stored in the private Supabase bucket `overs-photos` under the record id. Viewed via short-lived signed links.

## Backup
Settings → **Export backup** downloads a zip (`data.json` with all overs tables + `photos/`). **Import backup** restores it (adds missing rows/photos, never overwrites).

## Setup / config (already done)
- Supabase project `hqhfstosclasgwgxubip`: tables `overs_*` (RLS on, members only; reviews/events insert-only), bucket `overs-photos` (private). See `supabase/migrations`.
- `js/config.js`: Supabase URL + publishable key (safe to be public; RLS protects the data).
- Hosting: GitHub Pages from `main` branch root. No build step.
- Tests: `npm test` (rule + OCR-parser unit tests). End-to-end Playwright test used during build: `tests/e2e/`.
- Test mode (Settings) keeps practice records flagged `is_test` and hidden from normal views.

## Cost
$0: GitHub Pages (public repo) and Supabase free tier (500 MB database, 1 GB storage). At ~400 KB per photo, 1 GB ≈ 2,000+ photos; export and prune old history if it fills.
