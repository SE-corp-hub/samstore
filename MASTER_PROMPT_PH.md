# MASTER PROMPT — "Pindian": A Philippines-Ready Messenger Commerce + POS + ERP Platform

> **How to use this file:** Paste this entire document as a single prompt into an AI coding agent (or drop it in the repo as `MASTER_PROMPT.md`). It is written to be **standalone, self-contained, and unambiguous** so the agent can build the system incrementally without re-asking 100 setup questions Anders. All contextual references (Pancake Messenger ordering, NexoPOS POS workflow, ERPNext ERP concepts) are already folded in below — you do not need to fetch them.

---

## 0. ROLE & NON-NEGOTIABLE RULES

Act as a **senior full-stack architect + product engineer** who builds a production-ready platform for **Philippine small-to-medium businesses (SMBs) and sari-sari & online stores**. Before writing any code:

1. **Audit first, then build.** Inspect the existing repo, database, routes, auth, UI, and deployment. Reuse existing components and patterns. **Never do a destructive rewrite.** Preserve working features, design language, auth, data, and integrations.
2. **Do not fake integrations.** Never emit "success" for a real integration (GCash, PayMongo, Messenger webhook, Lalamove, GrabExpress, BIR) that was not actually wired up. Use **sandbox adapters, env-driven mocks, and clear setup docs** when credentials are unavailable, and mark them as `PENDING_CREDENTIALS`.
3. **Build in Virginia real contexts only.** Every number format uses PHP (₱), every timestamp uses `Asia/Manila` (UTC+8), every address uses Philippine hierarchy (Region → Province → City/Municipality → Barangay → Street/Blk-Lot → Landmark), and every message supports **English, Filipino (Tagalog), and Taglish**.
4. **One module at a time.** Before each module: explain the design + data flow. After each module: run relevant tests and report results. Finish with a full integration test + production-readiness checklist.
5. **Mobile-first.** Most Filipino customers and store owners use phones on restrictive mobile data. Everything must be touch-friendly, small-DOM, low-bandwidth and respolve gracefully offline.
6. **Compliance is a feature.** Philippine Data Privacy Act (R.A. 10173 / NPC), BIR sales-invoice & e-invoice rules, SIM-friendly OTP flows, PWD/Senior Citizen statutory 20% discount, VAT reg/vat-exempt branches, and PCI-DSS (no raw card storage).

---

## 1. PRODUCT VISION

Build **Pindian** — a multi-tenant, **Messenger-first commerce + point-of-sale + ERP** platform where a store owner runs their entire business:

- **Sell** through Facebook Messenger (Pancake-style), a public store link, and an in-store POS terminal.
- **Manage** inventory, orders, customers (CRM), loyalty, vouchers, payments, deliveries, staff, and accounting.
- **Report** with BIR-compliant receipts, invoices, and analytics.

Businesses: sari-sari stores, online resellers, food & beverage, clothing, pharmacies, hardware, services (loyalty/vouchers apply where sensible).

---

## 2. PLATFORM ARCHITECTURE

Choose the architecture best matching the existing codebase. If greenfield or a new backend is required, use this default:

- **Frontend:** React or Next.js (admin dashboard), responsive and mobile-first; Vite build.
- **Backend:** Node.js + **NestJS (preferred)** or Laravel; REST API; OpenAPI/Swagger docs.
- **Database:** PostgreSQL (multi-tenant, row-level security), Redis (sessions, queues, cache, rate limits), idempotency-friendly schema.
- **Realtime:** WebSocket or Server-Sent Events for live order/chat/dashboard updates.
- **Infra:** Docker + Docker Compose, Nginx reverse proxy, object storage for images/documents, HTTPS.
- **Workers:** Background workers for notifications, abandoned-cart recovery, analytics rollups, webhooks, BIR/e-invoice sync.
- **Ops:** CI/CD, structured logging, monitoring + health checks, backups, migration + rollback procedure.

---

## 3. MULTI-TENANT MODEL & ROLES

### Super Admin (platform operator)
- Create/edit/archive stores; create & approve store-owner accounts; create staff/agent/administrator accounts.
- Approve, suspend, or reject customer accounts. Manage global roles, permissions, settings, audit logs, platform analytics.
- **View all stores only in a "support/read" mode — never breaking tenant isolation.**

### Store Owner (per store)
- Manage **only their own store**: branding, logo, contact details, business hours, delivery settings, payment methods, Messenger page connection.
- Create/manage staff & sales agents. Approve or suspend their own customers.
- Products, categories, vouchers, promotions, loyalty rules, warehouses, delivery settings.
- Conversations, orders, customers, inventory, analytics, notifications.

### Customer
- Optional account; can order **without login** via public store link / Messenger.
- View pending orders, history, loyalty points, vouchers, profile settings, saved addresses.
- Link account to Messenger ID, phone number, or email. Receive order/delivery notifications.

### Guest
- Open store public link without registration; browse, cart, checkout, and track their order via a **secure signed order-token**.
- **Never** access another customer's order or personal data.

**Hard requirement:** strict tenant isolation at database (RLS), API, cache, storage, and UI levels. Cross-tenant read/write is a critical bug.

---

## 4. PUBLIC STORE ORDER LINK

- One secure, shareable public link per store: `/store/{storeSlug}`.
- Generate a **Facebook Messenger deep link** for the store; copy-link button + optional QR code.
- Support **guest ordering without login**.
- Show: store branding, categories, products, cart, checkout, order status, loyalty prompt, vouchers, contact options.
- Secure guest sessions + signed order-tracking tokens. Never expose internal IDs, private customer data, or other stores' data.
- Touch-friendly, mobile-first, no horizontal scroll, works on 2G/3G mobile data.

---

## 5. PRODUCT CATALOG

Store owner manages:
- Products, categories & subcategories, descriptions, image galleries.
- **Variants** (e.g., size/color), **add-ons & modifiers** (e.g., rice platter, size upgrades), SKU, barcode (bypassable for sari-sari).
- Price + sale price with **₱ PHP formatting**; availability; stock quantity; low-stock threshold; warehouse assignment.
- Featured products, delivery restrictions, tags, visibility, search & filters.
- Related / upsell / cross-sell products.

---

## 6. SHOPPING CART

Persistent carts supporting: add/remove/update qty, clear; variants & add-ons; subtotal; apply voucher/coupon; redeem loyalty points; discounts; **tax (incl. VAT & senior/PWD statutory discount)**, estimated delivery fees; save drafts; recover abandoned carts; block checkout when stock unavailable; lock price+inventory at checkout; **idempotency keys** for duplicate-request safety.

---

## 7. CHECKOUT

Collect: customer name; mobile number (PH format: `09XX-XXX-XXXX` / +63); email; delivery address (**Region–Province–City/Municipality–Barangay** dropdowns + Street/Blk/Lot + Landmark + Delivery instructions); preferred delivery schedule; payment method; order notes; voucher code; loyalty points to redeem; **privacy & marketing consent (DPA) checkbox**.

Generate: unique order number (e.g., `PIN-2026-XXXXXX`); order summary; receipt; invoice where required; **secure order-tracking link**; Messenger confirmation; store-owner notification; customer notification.

Support both **guest checkout** and **logged-in checkout**.

---

## 8. ORDER MANAGEMENT

Order stages: Pending → Confirmed → Preparing → Packed → Ready for Pickup → Shipped → Out for Delivery → Delivered; plus Cancelled, Refunded, Partially Refunded, Payment Review.

Provide: order dashboard; order details; edit items before confirmation; status-update history; internal notes; customer-visible notes; cancellation/refund reasons; partial fulfillment; partial refund; customer notifications on every status change; real-time dashboard updates; search & filters; bulk status updates; printable order slips (BIR-ready); CSV export.

---

## 9. INVENTORY & WAREHOUSES

Automatic: stock reservation at checkout; deduction on confirmation/payment; restoration on cancellation/refund where applicable; low-stock alerts; out-of-stock handling; **multiple warehouses**; warehouse assignment; stock transfers; inventory adjustments; inventory history; stock audit trail; inventory valuation; inventory reports; **negative-stock prevention**; unit-of-measure handling (pieces, sachets, kilos, packs — common in PH retail).

---

## 10. LOYALTY PROGRAM

Configurable per store: points per % of purchase; fixed points; eligible products/categories; minimum order amount; point expiry; welcome points; bonus campaigns; referral points; max redemption/order; refund & cancellation point reversal.

Customer: view points; full points ledger; redeem points; convert to store vouchers; view expiry; apply at checkout.

**Anti-abuse:** transaction-linked points, reversal logic, audit logs, duplicate-redemption protection.

---

## 11. VOUCHERS & PROMOTIONS

Store owners create: % discounts; fixed-value discounts; special-customer discounts; product-specific; category-specific; free-delivery vouchers; loyalty-redemption vouchers; first-order vouchers; date-based promotions; minimum-spend vouchers; usage limits; per-customer limits; storewide promos; stackable/non-stackable rules; expiry; active/inactive.

---

## 12. MESSENGER INTEGRATION

Use **Meta official Messenger Platform APIs** and support: Facebook Login; Page connection; webhook verification; webhook signature verification; message & postback events; quick replies; persistent menu; Get Started button; typing indicator; read/delivery receipts; generic/button/carousel/image templates; product cards; location sharing; attachment handling; Messenger identity mapping; deep links from Facebook Ads; human handoff; conversation assignment; rate-limit & retry handling.

**Messenger customer journey:** Facebook Ad/store link → Messenger opens → welcome message → main menu → browse categories → browse products → view product details → add to cart → view cart → checkout → collect customer details → select payment method → generate order → send confirmation → notify store owner → track order.

---

## 13. CHATBOT & AI ASSISTANT

Chatbot supports: FAQs; product recommendations; product search; product comparison; upselling; cross-selling; order-status lookup; payment/delivery/return/refund policy questions; store hours & location; voucher questions; loyalty-point questions; cart recovery; conversation memory; human-agent handoff; confidence thresholds; safe fallback; conversation audit history.

**Hard rule:** The AI must **never invent** order status, stock, price, payment, or delivery info — it must query live data, and say "I'll ask our staff" when unsure. Taglish-friendly.

---

## 14. HUMAN AGENT DASHBOARD

Live conversations; conversation list; take-over-chat button; bot/human status; assignment; agent availability; internal notes; customer timeline; order history; product history; quick replies; canned responses; tags; conversation search; conversation status; SLA & response-time indicators; unread messages; agent performance metrics; customer handoff history.

---

## 15. CRM

Auto-store: Messenger ID; customer account ID; name; phone; email; address; purchase history; lifetime value; average order value; favorite products; customer tags; loyalty balance; voucher history; last conversation; assigned sales agent; consent records; customer source; campaign source; abandoned-cart history.

Support customer **segmentation** and follow-up campaigns (Messenger/broadcast where permitted).

---

## 16. PAYMENTS (PHILIPPINES)

Support: **Cash on Delivery (COD)**; **Bank transfer** (BDO, BPI, UnionBank, RCBC, Metrobank, EastWest, PNB, Landbank, Security Bank); **e-wallets GCash & Maya**; **PayMongo** (preferred gateway: GCash, Maya, cards, GrabPay via PayMongo); other gateway adapters; payment-proof upload (screenshot of GCash/Maya transfer); payment links; automatic payment verification; manual payment review; receipts; invoices; refund management; partial refunds; payment-status history; webhook idempotency; secure payment references.

**Never store raw card data.** Use gateway-hosted checkout or tokenized methods. Separate "Payment received" from "Payment reviewed" states (common for PH bank-transfer verification).

---

## 17. SHIPPING & DELIVERY (PHILIPPINES)

Provider-adapter system for: delivery-fee calculation; **pickup / same-day local delivery**; **Lalamove**; **GrabExpress**; **couriers** (J&T Express, JRS, Ninja Van, Flash Express, LBC, Shopee Xpress-style config); shipping labels; tracking numbers; delivery status updates; estimated arrival; **delivery zones & barangay/city coverage** with PHP fees; failed-delivery handling; **COD remittance tracking** (courier vs. driver vs. owner pickup).

---

## 18. NOTIFICATIONS

Customer (Messenger / email / SMS): order received; confirmed; payment received/review; preparing; packed; out for delivery; delivered; cancelled; refund processed; voucher received; loyalty earned/redeemed; abandoned-cart recovery.

Store owner/agents: new order; new payment proof; low inventory; new customer; new/unassigned conversation; failed delivery; refund request.

(Use PH SMS providers such as **Semaphore / Chikka-style adapters** behind an interface; keep credentials env-driven.)

---

## 19. ANALYTICS

Metrics: sales; revenue; conversion rate; abandoned carts; top products; best customers; average order value; Messenger response time; agent performance; inventory value; daily/weekly/monthly orders; repeat-customer rate; voucher usage; loyalty points issued/redeemed; refund & cancellation rate; payment-method breakdown; delivery performance; store comparison (Super Admin).

---

## 20. DATABASE DESIGN

Normalized migrations + ER diagram. Suggested tables (tenant-aware, RLS, soft-delete, audit):

`users`, `roles`, `permissions`, `stores`, `store_members`, `customers`, `customer_approvals`, `messenger_users`, `messenger_pages`, `products`, `categories`, `product_images`, `product_variants`, `product_addons`, `warehouses`, `inventory`, `inventory_history`, `carts`, `cart_items`, `abandoned_carts`, `orders`, `order_items`, `order_status_history`, `payments`, `refunds`, `addresses` (PH hierarchy), `deliveries`, `delivery_events`, `coupons`, `vouchers`, `promotions`, `loyalty_accounts`, `loyalty_ledger`, `loyalty_rewards`, `voucher_redemptions`, `conversations`, `messages`, `conversation_tags`, `agents`, `conversation_assignments`, `notifications`, `ai_conversations`, `webhook_events`, `idempotency_keys`, `activity_logs`, `audit_logs`, `consent_records`, plus **`suppliers`, `purchases`, `expenses`, `chart_of_accounts`, `journal_entries` (for ERP/accounting)**.

---

## 21. PHILIPPINE COMPLIANCE & TAX (BIR)

- Emit **BIR-compliant sales receipts / invoices** (printed + e-invoice-ready), correct VAT (12%) vs. VAT-exempt handling, and the **statutory 20% discount for Senior Citizens & PWDs** (with ID capture).
- Support BIR **e-invoice / e-records (CSF)** sync config as an optional adapter (mark `PENDING_CREDENTIALS`).
- Books/records export (Sales Journal, Cash Receipts Journal) ready for BIR filing.
- Company/store tax profile field: VAT-registered or VAT-exempt/non-VAT; withholdable suppliers for purchases.
- Note: tax rules are evolving — keep the tax engine **config-driven** with clear docs to update rates.

---

## 22. SECURITY & DPA COMPLIANCE

JWT auth; secure refresh tokens; RBAC; store-level tenant isolation; row-level security; encrypted secrets; webhook signature verification; Meta token protection; rate limiting; CSRF; SQL-injection protection; input validation; output encoding; XSS protection; secure guest order tokens; idempotent order creation; audit logs; login monitoring; password policies; file-upload validation; privacy consent; data-retention controls; **Republic Act 10173 (Data Privacy Act) compliance & NPC breach-notification hooks**; no raw card storage; secure error messages; backup & recovery.

---

## 23. RESPONSIVE / ACCESSIBLE UI

Mobile-first layout; responsive admin dashboard & store link; touch-friendly; Messenger-friendly ordering; no horizontal overflow; bottom navigation where appropriate; responsive tables; mobile card layouts; accessible form controls; **WCAG 2.2 AA** contrast + keyboard support; loading/empty/error/success states; offline-friendly draft-cart where practical.

---

## 24. ERP MODULE (ERPNext-style depth, kept pragmatic)

Because POS + commerce alone isn't enough for owners, include a lean but real ERP layer:
- **Suppliers & Purchases:** vendor records, purchase orders, goods receipt, supplier payments.
- **Accounting:** chart of accounts, journal entries, receivable/payable, expense tracking, COGS at inventory valuation.
- **Sales & Profitability:** gross margin per product/store; sales journal; cash flow.
- **POS terminal mode:** offline-tolerant POS register shared with the online store's inventory (single source of truth), receipts printing (thermal printer adapter).
- **Payroll-lite (optional):** staff profiles, roles, commission on sales by agent.

Keep it modular so a small sari-sari store never sees ERP complexity they don't need (feature flags / menu groupings).

---

## 25. API DOCUMENTATION (OpenAPI/Swagger)

Document every endpoint: Authentication, Stores, Store links, Messenger, Products, Categories, Cart, Orders, Payments, Customers, Loyalty, Vouchers, Inventory, Warehouses, Delivery, Conversations, Agents, Notifications, Analytics, Webhooks, Suppliers/Purchases/Accounting (ERP), Admin operations.

---

## 26. TESTING

Unit, integration, DB-migration, role/permission, tenant-isolation, webhook-verification, Messenger-flow, product, cart, checkout, voucher, loyalty, inventory, payment, refund, shipping, order-status, AI-fallback, human-handoff, load, security, accessibility, mobile-viewport, and end-to-end tests.

**Required end-to-end flow (PH scenario):** create two stores (e.g., *Lola's Sari-Sari* & *Kape PH*) → separate store owners → separate catalogs → separate public links → browse as guest → add to cart → apply voucher → redeem loyalty points → checkout without login → create order → update payment → reserve inventory → update delivery → notify customer via Messenger → **verify Store A cannot read Store B data** → verify a customer sees only their own orders → print BIR-style receipt.

---

## 27. DEPLOYMENT

Dockerfiles; Docker Compose; Nginx; HTTPS; env-variable template (`.env.example`); DB migrations; seed data (**realistic Philippine demo data**: PH addresses, ₱ prices, Taglish store content); backup scripts; logging; monitoring; health checks; queue-worker deployment; cron/scheduler; CI/CD workflow; rollback procedure; production deployment guide; **Meta App + Messenger webhook setup guide**; payment gateway (PayMongo) setup guide; courier setup guide (Lalamove/GrabExpress/J&T); SMS setup guide; **BIR e-invoice setup guide**.

---

## 28. DOCUMENTATION & DELIVERABLES

1. Complete source code
2. Database schema + ER diagram
3. API documentation (OpenAPI)
4. Messenger webhook implementation
5. Multi-store admin dashboard
6. Store-owner dashboard
7. Customer account portal
8. Guest ordering link
9. AI chatbot
10. Human-agent dashboard
11. Product catalog
12. Shopping cart + checkout
13. Order management
14. Inventory system
15. CRM
16. Loyalty system
17. Vouchers & promotions
18. Payment integrations (PH)
19. Shipping integrations (PH couriers)
20. Notification system
21. Analytics dashboard
22. ERP-lite (suppliers, accounting, POS register)
23. Docker deployment files
24. User manual + Store-owner manual + Super Admin manual
25. Production deployment guide
26. Testing report
27. **Security & DPA compliance checklist**

---

## 29. IMPLEMENTATION RULES (repeat at the end of every run)

- Audit existing repo first; reuse; no destructive rewrites; preserve data/auth/UI/integrations.
- Implement one module at a time; explain design + data flow before; test after; report results.
- Reversible DB migrations; realistic Philippine demo data.
- **Never fake success for unavailable integrations** — sandbox/mock + `PENDING_CREDENTIALS`.
- Identify required credentials & external setup clearly.
- **Do not mark a feature complete** until UI flow, API flow, permissions, mobile layout, error states, and tests all pass.
- Finish every milestone with relevant tests **and** a production-readiness checklist (PHP/₱, Asia/Manila, Taglish, BIR, DPA, tenant isolation).

---

*End of Master Prompt — tools/navigate only as needed.*
