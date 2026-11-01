# Design System Master File — Sam's Store Admin

> **LOGIC:** When building a specific page, first check `design-system/sam-s-store-admin/pages/[page-name].md`.
> If that file exists, its rules **override** this Master file.
> If not, strictly follow the rules below.

**Project:** Sam's Store Admin (admin console of the SAM STORE platform)
**Direction (operator-approved 2026-10-13):** Warm light, built on the existing brand. Storefront and auth pages are out of scope — this system governs the admin console only.
**Stack:** Bootstrap 5.3 (mandatory — no Tailwind/MUI/ANTD/copied dashboards). Icons: Bootstrap Icons (bi-*). No new dependencies.

---

## Global Rules

### Color Palette (existing brand tokens + admin extensions)

| Role | Hex | CSS Variable |
|------|-----|--------------|
| Primary (brand) | `#D94F2B` | `--sam-primary` (exists in globals.css) |
| Primary hover | `#B83C1E` | `--sam-primary-dark` |
| Sidebar (dark coffee brown) | `#2B2118` | `--sam-sidebar` |
| Sidebar muted text | `#B3A495` | `--sam-sidebar-muted` |
| Background (cream) | `#FAF7F2` | `--sam-bg` |
| Surface (cards/topbar) | `#FFFFFF` | `--sam-surface` |
| Border (warm neutral) | `#E9E2D8` | `--sam-border` |
| Text | `#33261D` | `--sam-text` |
| Muted text | `#8A7A6B` | `--sam-muted` |
| Success / Danger / Warning | Bootstrap defaults | (status colors stay semantic) |
| Focus ring | `rgba(217,79,43,.4)` | `--bs-focus-ring-color` |

**Color rules:** text on cream/cards must hold 4.5:1 contrast (the text/muted values above do); never gray-on-gray; status colors carry a text label or icon, never color alone.

**Easy-to-read pass (2026-10-31, `apps/web/src/app/easy-read.css`):** the owner is 65, so the admin console now aims at the comfortable 7:1 level for helper text (`--sam-muted` is `#5A4D42`, 7.6:1 on cream) and gives every colour ONE meaning on every screen:

| Colour | Means | Used for |
|--------|-------|----------|
| Green `#1F6F3F` | go, done, paid, money in | `.btn-primary` and `.btn-success` (the main button of a screen), success badges/alerts, switches that are on |
| Red `#A3201B` | stop, problem, owed, remove | `.btn-danger`, danger badges/alerts |
| Amber `#8A5A00` (text `#6F4800` on `#FFF3D6`) | careful, waiting, check | warning badges/alerts, `.btn-warning` |
| Blue `#0B4F8A` | information, print, view | links, `.btn-outline-primary`, `.btn-info`, info/primary badges |
| Dark ink `#33261D` / `#4A4844` | neutral choice | `.btn-outline-dark`, `.btn-secondary`, secondary badges, toggles (`btn-dark` / `btn-outline-dark`) |
| Terracotta `#C0421F` | you are here (brand) | active menu item, focus ring, role badge, headings — never a button fill |

Screens are grouped by what they are for (`NAV_GROUPS` in `lib/admin.ts`: Sell green, Money amber, Stock blue, Reports purple `#563A98`, People & settings dark ink) and the group colour is repeated on Home tiles, the Menu, the bottom bar and the top-bar chip (`.tone-*` classes).

### Typography

- **Body/UI:** system-ui stack (system-ui, -apple-system, "Segoe UI", Roboto) — already in use; no webfont dependency (admin works offline; the storefront stays consistent).
- Numbers in tables, KPIs and reports: `font-variant-numeric: tabular-nums` (`.register-report` already does this; apply to `.admin-shell .table` and KPI values).
- Base **18px** on every `/admin` page (Text size setting: Normal 16 / Large 18 (default) / Extra large 20, saved per tablet as `data-text-size` on `<html>`, see `lib/text-size.ts`); line-height 1.5; small print (`small`, `.form-text`, badges) never below **16px**; table headings 1rem bold sentence case in `--sam-text`; form labels 1rem bold. Use rem, never px, for anything that should grow with the setting. Store screens (`.rice-ui`) never drop below their 18px.

### Spacing & Density

Dense dashboard density: cards pad `1rem 1.25rem`; table cells `0.5rem 0.75rem`; panel gutter `1.5rem`; interactive elements ≥ 44×44px on touch (buttons can be compact on desktop, but hit area min 24px with adequate spacing).

### Shadows & Radius

| Level | Value | Usage |
|-------|-------|-------|
| `--sam-radius` | `0.75rem` | Cards, modals, inputs |
| `--sam-shadow` | `0 1px 2px rgba(43,33,24,.05), 0 4px 12px rgba(43,33,24,.06)` | Cards |
| Hover lift | `translateY(-1px)` + deeper shadow, 150ms | Clickable cards only |

---

## Component Specs

### Buttons
- Primary (the ONE main action of a screen): green `#1F6F3F`, white text, hover `#185A33`, radius `.5rem`, `cursor: pointer`, bold label. (Was terracotta until 2026-10-31; terracotta now only marks "you are here".)
- Secondary: blue outline (`.btn-outline-primary`, information actions such as Print, View, Edit) or dark outline (`.btn-outline-dark` / `.btn-outline-secondary` for Back, Close, Cancel). Toggle groups use `btn-dark` / `btn-outline-dark`, never two colours.
- Touch (`(pointer: coarse)` or < 768px): every button, field, tab and list row ≥ 48px tall, labels 1rem.
- One transition speed for all interactive states: `150ms ease-out` (background-color, border-color, color, box-shadow). No instant state changes.
- Icon buttons: keep a `title` and an aria-label where the icon carries the meaning alone.

### Cards
- White surface, `1px solid var(--sam-border)`, `var(--sam-radius)`, `var(--sam-shadow)`.
- Clickable cards lift `-1px` with a deeper shadow on hover.
- KPI cards: label small muted, value bold `tabular-nums`.

### Tables (admin console)
- `thead` th: 1rem, bold, sentence case, `--sam-text`, background warm neutral (the 12px uppercase muted heading was retired on 2026-10-31: capitals in small grey type are the slowest text to read).
- Row borders `var(--sam-border)`; hover row background warm tint.
- Never rely on color alone for status (badge + text).

### Inputs & Selects
- Focus ring: Bootstrap's `--bs-focus-ring-color` (terracotta tint) — visible on keyboard and mouse.
- `.form-select:not(:disabled)` gets `cursor: pointer`.
- Labels must be associated with controls (`htmlFor`/`id`) — never placeholder-only.

### Modals
- Radius `var(--sam-radius)`, border `var(--sam-border)`, header bottom-border warm neutral.
- Backdrop `rgba(43,33,24,.5)`.

### Selling screens (POS Walk-in, Full sale, Pre-order) — `easy-read.css` §8
- Product buttons are one component, `components/admin/PickTile.tsx` (`.pick-tile`): white, 2px dark border, name 1rem, price 1.5rem bold `tabular-nums`, stock line ≥ 16px. **In the sale = green**: `#E4F3EA` face, `#1F6F3F` border and a `✓ 2 in sale` pill (never a black tile). Out of stock = amber `.pick-stock.out` badge ("None left here"): careful, not stop — the counter may still sell.
- The sale / order lives in a `.sale-card` (2px green frame) with a `.sale-card-title` ("This sale · 3 items"), lines in `.sale-line` (name · − qty + · amount, wrapping to two rows in narrow columns), and a `.sale-total` row whose amount (2rem, 800) is the largest number on the screen. "Customer pays" uses `.big-amount` (2.25rem); change due uses `.change-due` (1.75rem, green; "Short …" red).
- − / + are `.qty-btn` (3rem square, 1.5rem sign) around a `.qty-num`.
- Button meanings on these screens: green = the one next step (Cash exact, Pay, Finish sale, Complete sale, Save pre-order, Open the cash drawer); blue outline = second choices (Print, Receipt, Change price, Take from another store, New item, Text customer); dark outline = Back, Cancel, Keep it, Close and toggles (Cash / GCash / Credit, Waiting / Done); red = Delete, Clear this sale. Each pay method carries an icon.
- Sizes are rem inside `.sell-screen` (`max(18px, 1rem)`), so the Text size setting applies; never `style={{ fontSize: 18 }}` or px prices on a selling screen.
- **They fit the tablet with no page scroll (easy-read.css §9, 2026-11-01).** The screen wrapper is `.sell-screen.sell-fit` and `lib/use-fit-height.ts` sets its height to exactly the space between the top bar and the bottom bar (measured, so any text size and either orientation work; off on a phone, `FIT` = `(min-width: 600px)`). Inside it only two things scroll, each in its own box: the product list (`.fit-scroll`, rendered by `ProductFinder` with `fit`) and the lines of a long sale (`.sale-lines` inside a `.fit-card`). Everything else stays put: the Walk-in / Full sale switch (one line each on a tablet), the store chips (`StoreBar inline size="md"`), the search bar (`.finder-bar`: search box + variety buttons, and the "2 Tap items" heading on Pre-order), the total and the green button. Sideways = `.fit-row` with `.fit-main` (products) and `.fit-side` (the sale, 40 %, from the very top); upright = one `.fit-col` with the sale card last (`.fit-bottom`, at most 60 % of the fitted height, never a window unit, so the keyboard cannot squeeze it). The pay step and the Complete sale pop-up (`.modal-fit`) are two columns on a tablet: what and how on the left; the number pad, the signature, the new-customer form or the parts of a split on the right. The number pad keys are exactly 64 px, 48 px when the screen is under 760 px tall (sideways); for loose rice the Kilos / Pesos switch shares the amount row (`NumPad lead`). In the "How many?" card the new price and the Why drop-down share one row (`PriceReason short`), so the card with Change price open still fits sideways for a kilo item. Drop-downs and typing boxes on these screens are at least 44 px tall. The on-screen keyboard: `use-fit-height` keeps the fitted height while a box or drop-down has focus and the window only gets shorter, so the screen never re-fits and jumps mid-typing. Four product buttons to a row (`col-6 col-md-3`), 6 rem tall. Check with `/tmp`-style Playwright runs at 1280×720, 800×1200 and 800×1100 (and with the window shrunk while a box has focus): page overflow 0 and every key control fully visible, not clipped by a scrolling box, above the bottom bar.

### Sidebar (admin shell)
- Background `var(--sam-sidebar)`, light cream text, muted group labels (uppercase, letter-spacing).
- Nav items: pill radius `.5rem`, hover `rgba(255,255,255,.06)`, **active = terracotta pill** (`--sam-primary`) with white text — not Bootstrap's default blue.
- Icons: Bootstrap Icons, consistent 1em sizing with an 8px gap to the label.

---

## Motion

- Interactive transitions: `150ms ease-out` only.
- No width/height animation; no layout-shifting hovers.
- **`prefers-reduced-motion: reduce`** must collapse all transitions/animations to near-zero.

---

## Anti-Patterns (Do NOT Use)

- ❌ Emojis as icons or decorative text in the admin UI (the Overview "👋" is a live violation — removed).
- ❌ Bootstrap default blue primary (`--bs-primary`) anywhere in the admin console.
- ❌ Missing `cursor: pointer` on clickable elements.
- ❌ Instant state changes (0ms) and per-element ad-hoc transition timings.
- ❌ Text below 12px; muted-on-muted contrast.
- ❌ Invisible focus states.
- ❌ Horizontal scroll on mobile; fixed-width containers.
- ❌ Label-less inputs (placeholder as the only label).

---

## Pre-Delivery Checklist (admin console)

- [ ] No emojis used as icons or decoration
- [ ] Icons from Bootstrap Icons only (consistent set)
- [ ] `cursor-pointer` on all clickable elements
- [ ] Hover states with smooth transitions (150ms)
- [ ] Text contrast 4.5:1 minimum on cream/white
- [ ] Focus states visible for keyboard navigation
- [ ] `prefers-reduced-motion` respected
- [ ] Responsive: 375px, 768px, 1024px, 1440px
- [ ] No content hidden behind fixed navbars
- [ ] No horizontal scroll on mobile
- [ ] Bootstrap 5.3 only — no new dependencies
