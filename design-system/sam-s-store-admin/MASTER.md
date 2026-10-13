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

### Typography

- **Body/UI:** system-ui stack (system-ui, -apple-system, "Segoe UI", Roboto) — already in use; no webfont dependency (admin works offline; the storefront stays consistent).
- Numbers in tables, KPIs and reports: `font-variant-numeric: tabular-nums` (`.register-report` already does this; apply to `.admin-shell .table` and KPI values).
- Base 16px; line-height 1.5; body text never below 12px; small text ≥ 12px.

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
- Primary: terracotta (`--sam-primary`), white text, hover darkens (`--sam-primary-dark`), radius `.5rem`, `cursor: pointer`.
- Secondary/outline: warm-neutral borders (`--sam-border`-family), text `--sam-text`.
- One transition speed for all interactive states: `150ms ease-out` (background-color, border-color, color, box-shadow). No instant state changes.
- Icon buttons: keep a `title` and an aria-label where the icon carries the meaning alone.

### Cards
- White surface, `1px solid var(--sam-border)`, `var(--sam-radius)`, `var(--sam-shadow)`.
- Clickable cards lift `-1px` with a deeper shadow on hover.
- KPI cards: label small muted, value bold `tabular-nums`.

### Tables (admin console)
- `thead` th: small, uppercase, `letter-spacing .04em`, muted, background warm neutral.
- Row borders `var(--sam-border)`; hover row background warm tint.
- Never rely on color alone for status (badge + text).

### Inputs & Selects
- Focus ring: Bootstrap's `--bs-focus-ring-color` (terracotta tint) — visible on keyboard and mouse.
- `.form-select:not(:disabled)` gets `cursor: pointer`.
- Labels must be associated with controls (`htmlFor`/`id`) — never placeholder-only.

### Modals
- Radius `var(--sam-radius)`, border `var(--sam-border)`, header bottom-border warm neutral.
- Backdrop `rgba(43,33,24,.5)`.

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
