# Rice Ops — go-live checklist

Work top to bottom. Each box needs a name and a date. **Nothing in this list deploys by
itself:** putting the new version live is a separate step that needs the owner's explicit
"yes" (AGENTS.md: deploys need operator approval).

## A. Before go-live day (the week before)

**System**

- [ ] `verify.bat` shows **VERIFY RESULT: PASS** on the release branch (paste the summary into `docs/progress.md`).
- [ ] Production settings are in the hosting dashboard (never in the repo or a chat):
  - `NODE_ENV=production`
  - `JWT_SECRET` and `CLAIM_SIGNING_SECRET`: each 32+ random characters, different from each other. The API refuses to start with a missing, short or placeholder value.
  - `CORS_ORIGINS`: the web app's https address(es), comma-separated. The API refuses to start without it.
  - `DATABASE_URL`, `REDIS_URL`.
  - `ALLOW_OWNER_SIGNUP` unset (sign-up stays closed).
  - SMS: leave `SMS_PROVIDER` unset until the owner picks a provider and approves real texts. Until then texts are recorded but **not sent**.
- [ ] Backup taken and restorable (`npm run db:backup`; the file opens).
- [ ] `npx prisma migrate deploy` run against production after the backup.
- [ ] Locations set: `npm run setup:locations -- --store <slug>` (dry run), then `--apply`. S1 · S2 · S3 · WH with the right names and addresses.
- [ ] Old ledger rebased if the dry run asks for it: `npm run ledger:rebase -- --store <slug>` (dry run first).

**Lists (M12 import)** — fill the four files from `docs/rice-ops/import-templates/` into a `go-live/` folder (git ignores it):

- [ ] `products.csv` — every way rice is sold (25 kg, 5 kg, kilo…), main price, per-location price only where different, cost.
- [ ] `customers.csv` — everyone allowed utang: name, mobile, limit, **current utang and since when**, from the paper notebook.
- [ ] `staff.csv` — everyone except the owner: mobile, role, home location, PIN (optional).
- [ ] `kargadors.csv` — names, usual location.
- [ ] Dry run: `npm run rice:import -- --store <slug>` → **0 problems**.
- [ ] Apply: `npm run rice:import -- --store <slug> --apply`.
- [ ] **Owner sign-off:** print `go-live/pirmahan-<date>.html`. The owner checks every product price and every utang balance against the notebook, ticks each line, and signs. Any mistake: fix the CSV, apply again, print again.
- [ ] `go-live/staff-logins-<date>.txt` handed out privately, one person at a time — **then delete the file**.
- [ ] Kargador photos: the app takes an https link for now (Kargadors → Litrato). Upload each photo somewhere the owner controls and paste the link — or leave blank; staff pick kargadors by name. (Known limit: no in-app camera for kargador photos yet.)

**People**

- [ ] Every staff phone: app installed to the home screen, staff logged in with PIN once, language checked (Taglish / English).
- [ ] Usability check done with one real staff member (`docs/rice-ops/usability-test.md`); problems fixed or written down.
- [ ] Guides printed (`docs/rice-ops/gabay/`) and placed at each counter: 00, 01, 02, 06, 09 at every store; 04, 05, 08 at WH.
- [ ] Numbered paper slip pads at each location (for no signal / no phone).
- [ ] Each staff member has done once, on a test item: a Benta, a Bayad sa utang, an Ilabas/Tanggapin pair, a quick count.

## B. Go-live day (pick a slow day)

- [ ] Before opening: **full blind count at all 4 locations**, signed (Bilangin → Simulan ang buong bilangan). The owner approves each; this becomes the opening stock.
- [ ] Spot-check Stock Live against the shelves for the top 5 items per location.
- [ ] Paper log runs **alongside** the app for the first 3 days (safety net, not a replacement).
- [ ] Each evening: every location does Pagsasara; the owner reviews the Daily report, open hand-offs and Para sa iyo.

## C. End of week 1

- [ ] Full count per location; open the **Balance** report — how close is the system to the shelves? Write the result in `docs/progress.md`.
- [ ] Review: utang texts (or the decision to start real SMS), approvals waiting, items still "Susuriin", write-offs over 1%.
- [ ] Owner decides: stop the paper log, or run another week.

## If something goes badly wrong

- Stop using the app for the affected flow; switch that location to the paper slip pad. Nothing is lost: slips are encoded later (Galing sa papel).
- Do **not** edit the database by hand. Wrong signed entries are voided by the owner/manager with a reason.
- Restoring a backup or rolling back a deploy needs the owner's explicit approval.

## Sign-off

| | Name | Signature | Date |
|---|---|---|---|
| Product list and prices checked | | | |
| Utang balances checked | | | |
| Ready to go live | | | |
