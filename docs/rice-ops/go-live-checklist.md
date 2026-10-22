# Rice Ops: go-live checklist

## Status: 22 Oct 2026 (Claude)

**Built and pushed** (branch `release/rice-ops`, last commit `6c50588`):
staying signed in, staff bottom bar, offline selling, Stock check, Stock book, cost and price history, the one POS, Move stock,
Customer returns, Agent orders, Resack, Stock in, Buffer store, Store report, All records, Store payable and the consignment store
(Store 2), Days left, Top 10 customers, credit statements, net profit, Maya / bank / split payments, special prices per customer,
Supplier orders and what you owe suppliers, and the Count upgrade (search, any role counts, counts post at once, reasons,
reports by store, Needs a look, count accuracy, today's suggested list).

**Checks that have run**
- Full check on the shop database (22 Oct, commit `ab13edb`, after a backup): migrations applied up to Supplier orders; types and the new tests passed; 11 old tests needed updating and were fixed in `c0dc2bc`.
- Full check on the **beta** database (`verify-beta.bat`, 22 Oct): at `5e276ca` it passed (40 test files). At `9ada49c`, with the Count upgrade, every Count test passed; one old PIN-lock test failed only because the database clock and the Sam PC clock differed by a fraction of a second. The test was relaxed in `6c50588`. **Run `verify-beta.bat` once more; it should say PASS.**
- Quick check on the Sam PC (`verify-quick.bat`, 22 Oct, commit `9ada49c`): PASS (types and database-free tests).

**Not tested by a person yet:** everything in sections G to L of `claude/phone-test-checklist.md` (beta site, real phone, staff and owner logins).

**Still to do before go-live** (in this order):

1. [ ] **Run `verify-beta.bat` again** and confirm `VERIFY RESULT: PASS (BETA DATABASE)`.
2. [ ] **Phone test** of the new screens on the beta site: sections G to L of `claude/phone-test-checklist.md`, with a staff login and the owner login. Write down anything odd.
3. [ ] **Backup decision (owner).** The shop database is on the Free plan, which has no automatic backups. Choose the paid plan (daily backups) or a nightly backup job. Do not go live without one.
4. [ ] **Owner decision: how cost is counted.** "One cost for all locations" (simple) or "Each location has its own cost". Set it in Reports & closing, Stock book. Decide before the opening count.
5. [ ] **Real data.** Fill `products.csv`, `customers.csv`, `staff.csv` and `kargadors.csv` in `go-live/` (section A). The dry run must show 0 problems. Include the real cost per product.
6. [ ] **Production settings** in the hosting dashboard (section A, System). Needs the owner; secrets never go in chat or the repo.
7. [ ] **Back up, then apply the last migrations** to the shop database: `20261101090000_count_reasons` and `20261102090000_count_look`. They only add columns. Everything older is already applied there (22 Oct, after a backup).
8. [ ] **SMS provider.** The owner picks one and approves real texts. Until then texts are recorded, not sent. (On a phone, credit-sale texts open the phone's own text app instead.)
9. [ ] **Locations.** `setup:locations` dry run, then `--apply` (S1, S2, S3, WH). Check which one is the main location. Add one Buffer store per store (Locations, type "Buffer store"). Tick "Consignment store" on Store 2.
10. [ ] **Usability check** with one real staff member (`docs/rice-ops/usability-test.md`), then print the guides (`docs/rice-ops/guide/`).
11. [ ] **Owner sign-off** on printed prices and credit balances (section A).
12. [ ] **Deploy.** Only after the owner says "yes" in chat. Then section B (the opening count) on a slow day.

**Not built yet, can wait until after go-live:** courier signature and cash page, phone sign-up, Team "created by" history, cost carried through resack and counts when cost is per location (they use the product cost for now), reorder suggestions, a stock movement summary for all items, a weekly owner summary, a USB or print-dialog fallback for the printer (only if "Check my printer" shows Bluetooth does not work from Chrome), supplier price watch, SMS sending.

**Testing notes:** run `stop-dev.bat` before the full `verify.bat` (the running app locks a database file).
`verify-beta.bat` runs the full check (migrations, types, every database test) on the separate beta database, so the shop's database is never touched and no backup is needed. It asks for the beta database address each time (Supabase beta project, Connect, Session pooler, port 5432), or reads it from `go-live\beta-verify-url.txt` (one line; git ignores it). It refuses the shop's address. Its log is `verify-logs\latest-beta.txt`, and the result line ends with `(BETA DATABASE)`. `verify.bat` and `update-and-verify-full.bat` use the database in `.env`.
`verify-quick.bat` (about a minute) is enough for small changes. `test-setup.bat` makes a TEST Bigasan store with new logins in `go-live\test-logins.txt`.

Work top to bottom. Each box needs a name and a date. **Nothing in this list deploys by itself.** Putting the new version live is a separate step that needs the owner's explicit "yes" (AGENTS.md: deploys need operator approval).

## A. Before go-live day (the week before)

**System**

- [ ] `verify.bat` shows **VERIFY RESULT: PASS** on the release branch (paste the summary into `docs/progress.md`). Run it again if anything changes.
- [ ] Production settings are in the hosting dashboard (never in the repo or a chat):
  - `NODE_ENV=production`
  - `JWT_SECRET` and `CLAIM_SIGNING_SECRET`: each 32+ random characters, different from each other. The API refuses to start with a missing, short or placeholder value.
  - `CORS_ORIGINS`: the web app's https address(es), comma-separated. The API refuses to start without it.
  - `DATABASE_URL`, `REDIS_URL`.
  - `ALLOW_OWNER_SIGNUP` unset (sign-up stays closed).
  - SMS: leave `SMS_PROVIDER` unset until the owner picks a provider and approves real texts. Until then texts are recorded but **not sent**.
- [ ] Backup plan chosen (paid daily backups or a nightly job) and one backup taken and restorable (`npm run db:backup`; the file opens).
- [ ] `npx prisma migrate deploy` run against the shop database after that backup (the last two migrations are `count_reasons` and `count_look`).
- [ ] Locations set: `npm run setup:locations -- --store <slug>` (dry run), then `--apply`. S1, S2, S3 and WH with the right names and addresses. One Buffer store per store. Store 2 marked "Consignment store".
- [ ] Old ledger rebased if the dry run asks for it: `npm run ledger:rebase -- --store <slug>` (dry run first).

**Lists (M12 import).** Fill the four files from `docs/rice-ops/import-templates/` into a `go-live/` folder (git ignores it):

- [ ] `products.csv`: every way rice is sold (25 kg, 5 kg, kilo...), main price, per-location price only where different, cost.
- [ ] `customers.csv`: everyone allowed credit: name, mobile, limit, **current balance and since when**, from the paper notebook.
- [ ] `staff.csv`: everyone except the owner: mobile, role, home location, PIN (optional).
- [ ] `kargadors.csv`: names, usual location.
- [ ] Dry run: `npm run rice:import -- --store <slug>` shows **0 problems**.
- [ ] Apply: `npm run rice:import -- --store <slug> --apply`.
- [ ] **Owner sign-off:** print `go-live/pirmahan-<date>.html`. The owner checks every product price and every credit balance against the notebook, ticks each line, and signs. Any mistake: fix the CSV, apply again, print again.
- [ ] `go-live/staff-logins-<date>.txt` handed out privately, one person at a time. **Then delete the file.**
- [ ] Porter photos: the app takes an https link for now (Porters, photo). Upload each photo somewhere the owner controls and paste the link, or leave it blank; staff pick porters by name.

**People**

- [ ] Every staff phone: app added to the home screen, staff signed in with their PIN once.
- [ ] Usability check done with one real staff member (`docs/rice-ops/usability-test.md`); problems fixed or written down.
- [ ] Guides printed from `docs/rice-ops/guide/` and placed at each counter: 00, 01, 02, 03, 09, 10 and 14 at every store; 04, 06 and 07 also at the warehouse. Owner and manager also get 08, 11 and 13.
- [ ] Each staff member has done once, on a test item: a sale, a credit payment, a Move stock, a Count one item.

## B. Go-live day (pick a slow day)

- [ ] Before opening: **a full count at all 4 locations** (Count, Count a list, Everything here), signed. It posts at once and becomes the opening stock. Staff count blind; leave "Show the system numbers while counting" off.
- [ ] Spot-check the shelves against Store report, Stock left for the top 5 items per location.
- [ ] After the opening count: Reports & closing, **Stock check** shows all stocks agree. Pick one product in **Stock book** and read it from start to end.
- [ ] A paper log runs **alongside** the app for the first 3 days (a safety net, not a replacement).
- [ ] Each evening: every location does its closing in Reports & closing. The owner reviews the daily report, anything still open, **For your approval**, **Count, Needs a look**, and **Store payable**.

## C. End of week 1

- [ ] Full count per location. Open **Count, Report** and **Count, Balance**: how close is the system to the shelves? Write the result in `docs/progress.md`.
- [ ] Review: credit texts (or the decision to start real SMS), approvals waiting, Needs a look, write-offs over 1%, the Buffer store "to fix" list, what Store 2 owes and whether it paid.
- [ ] Owner decides: stop the paper log, or run another week.

## If something goes badly wrong

- Stop using the app for the affected flow and switch that location to paper. Nothing is lost: the paper is entered later.
- Do **not** edit the database by hand. Wrong signed entries are voided by the owner or manager with a reason.
- Restoring a backup or rolling back a deploy needs the owner's explicit approval.

## Sign-off

| | Name | Signature | Date |
|---|---|---|---|
| Product list and prices checked | | | |
| Credit balances checked | | | |
| Ready to go live | | | |
