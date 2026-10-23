# How to fill the four lists (products, customers, staff, kargadors)

Each list is one file. Open it in Excel, fill one row per item, and save it **as CSV UTF-8** (File, Save As, "CSV UTF-8 (Comma delimited)") in the `go-live` folder with the same file name. The files in `go-live` start empty (only the top row). The files in this folder (`import-templates`) show examples; the names there say "Halimbawa" (example), so do not import them.

You do not have to fill all four. Start with products.

## Before you type (Excel traps)
- **Phone numbers:** type them with spaces, like `0917 123 4567`. Excel then keeps the zero at the front. (Or format the column as Text first.)
- **Dates:** write `2026-09-01` (year-month-day). Format the date column as Text first, or Excel turns it into `9/1/2026` and the check will refuse it.
- **Money:** type `1,250.50` or `1250.50`. No ₱ sign needed.
- Do not add or rename columns. Do not leave a row half filled; delete a row you do not need.
- You can reuse the same file again later: rows that did not change are left alone.

## products.csv: every way you sell rice
| Column | What to write |
|---|---|
| `sku` | A short code you choose, letters and numbers, no spaces. Different for each row. Example `SIN-25`. |
| `name` | What staff see. Example `Sinandomeng 25 kg`. Different for each row. |
| `variety` | The kind of rice (optional). Example `Sinandomeng`. Used to add up kilos per kind. |
| `sold_as` | `SACK` (a whole sack or bag), `KILO` (loose rice sold by the kilo) or `PIECE` (anything else). |
| `kg_per_sack` | Only for `SACK`: the weight of one sack in kilos (25, 50, 5). Leave blank for `KILO` and `PIECE`. |
| `cost` | What you pay for one (per sack, per kilo or per piece). Staff never see it. Needed for profit and for what Store 2 owes. |
| `price` | The normal selling price for one (per sack, per kilo or per piece). |
| `price_S1`, `price_S2`, `price_S3`, `price_WH` | Only where a place sells at a different price. Leave blank to use `price`. |

The same rice in a different pack is a different row: for example `Sinandomeng 25 kg` (SACK, 25), `Sinandomeng 5 kg` (SACK, 5) and `Sinandomeng (kilo)` (KILO). The check does not set how many are on the shelf. That comes from the opening count on go-live day.

## customers.csv: everyone allowed credit (utang)
| Column | What to write |
|---|---|
| `name` | The customer's name. |
| `phone` | Mobile number, `0917 123 4567`. Different for each customer. |
| `limit` | The most they may owe at once. **Blank means no credit allowed (₱0).** Give a limit to everyone who may buy on credit, at least as much as what they owe now. |
| `utang` | What they owe **today** from the paper notebook. Blank if nothing. |
| `utang_since` | When that credit started, `YYYY-MM-DD`. **Needed whenever `utang` is filled** (for the reminders). |
| `note` | Anything useful, for example `lumang listahan p.3` (optional). |

## staff.csv: everyone except the owner
| Column | What to write |
|---|---|
| `name`, `phone` | Name and mobile number. The phone is the login. Different for each person. |
| `role` | `STAFF` (counter), `MANAGER`, `SALES_AGENT` or `DELIVERY`. |
| `home` | The place they work: `S1`, `S2`, `S3` or `WH`. **Needed for `STAFF` and `SALES_AGENT`.** |
| `pin` | A 4-digit PIN (optional). Leave blank and a one-time password is made. Not the same number four times (`1111`) and not numbers in a row (`1234`). |

A file with logins is made (`go-live\staff-logins-<date>.txt`). Hand each person theirs privately, then delete the file.

## kargadors.csv: the porters
| Column | What to write |
|---|---|
| `name` | Their name. Different for each person. |
| `phone` | Optional. |
| `home` | Where they usually work (`S1`, `S2`, `S3`, `WH`), optional. |
| `photo_url` | Leave blank. You can take their photo in the app. |

## The steps (Claude or you)
1. Fill the files in `go-live`, save as CSV UTF-8.
2. **Dry run** (nothing is saved): `npm run rice:import -- --store sam-store`. It must say **0 problems**. Each problem names the file and the row.
3. When it is clean and you are happy, `npm run rice:import -- --store sam-store --apply` saves it and makes `go-live\pirmahan-<date>.html`.
4. Print that page. Check every price and every credit balance against your notebook, tick each line, and sign. A mistake: fix the file, run again, print again.

Claude can do steps 2 and 3 for you when the files are ready. Tell Claude "files are ready".
