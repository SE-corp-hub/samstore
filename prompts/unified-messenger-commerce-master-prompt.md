# Upgraded Master Prompt: Bootstrap-Ready Multi-Store Messenger Commerce Platform

Copy and use the prompt below with a coding agent or software development team.

---

## Role

You are a principal software architect, product engineer, UX engineer, security engineer, and QA engineer. Build a production-ready, multi-tenant Messenger commerce and ordering platform from the requirements below. Treat this as an upgraded specification: identify omissions, close security and operational gaps, and do not remove any requirement stated here.

Before writing code, inspect the existing repository, identify its framework and conventions, and preserve useful existing patterns. If the repository is empty, create the project using the reference stack in this prompt. Do not pretend that a feature is complete when it is only a placeholder. Make reasonable decisions, document them, and keep the implementation maintainable.

## Product Goal

Build an original platform that lets a platform administrator create and manage multiple stores. Each store owner can manage a catalog, customers, orders, inventory, discounts, loyalty, payments, shipping, Messenger conversations, and analytics. Customers can discover a store through Facebook Messenger or a shareable store ordering link, browse products, check out from a mobile device, receive eligible Messenger notifications or consented fallback notifications, and track their orders.

The product may provide workflows comparable to established Messenger commerce tools, but it must not copy Pancake or any other product's code, UI, branding, text, proprietary assets, or protected implementation. Reproduce only general commerce and conversation workflows using original design and code.

Use Meta's official Messenger Platform and Graph APIs only. Follow Meta Platform Terms, Messenger policies, messaging windows, consent rules, data-use rules, app-review requirements, and all applicable privacy and consumer-protection laws. Do not scrape Facebook, automate a personal account, or use unofficial Messenger APIs.

The application must be mobile-first because the store link will commonly be opened from Facebook Messenger, but it must also work well on desktop screens.

## Reference Technology Stack

Use this stack unless an existing repository requires an equivalent choice. Record any deviation in an architecture decision record.

- Frontend: Next.js App Router, React, and TypeScript with strict type checking.
- UI framework: Bootstrap 5.3 is mandatory as the primary styling and layout system. Use the `bootstrap` package, `react-bootstrap` for React components, and `bootstrap-icons` for icons. Use Bootstrap's grid, utilities, forms, tables, cards, navbar, offcanvas, modal, toast, alert, pagination, and responsive helpers instead of Tailwind, Material UI, Ant Design, or a competing UI framework.
- Bootstrap theme: customize Bootstrap through Sass variables and a small original theme layer. Load Bootstrap consistently, avoid a CDN dependency, avoid duplicated CSS, and do not mix multiple component libraries. Use controlled React state for Bootstrap interactions so the application remains SSR and hydration safe.
- Admin dashboard and customer storefront: Next.js applications or clearly separated areas in one Next.js application, sharing a typed design system and reusable Bootstrap-ready components.
- Backend: NestJS with TypeScript, REST API, WebSocket gateway using Socket.IO, and background jobs.
- Database: PostgreSQL with Prisma or another type-safe migration-based ORM.
- Cache, sessions, queues, and rate limiting: Redis with BullMQ or an equivalent durable queue system.
- File storage: S3-compatible object storage for product images, payment evidence, invoices, and shipping labels.
- Reverse proxy: Nginx.
- Local and production packaging: Docker and Docker Compose, with separate development and production configurations.
- API contract: OpenAPI/Swagger, versioned REST routes, and generated or shared TypeScript types where practical.
- Testing: unit, integration, end-to-end, webhook, contract, security, and load tests.
- CI/CD: automated linting, type checking, tests, migrations, image builds, vulnerability scanning, and deployment.

Use a modular monolith first, with clear domain boundaries so high-volume modules can later be extracted into services. Do not introduce microservices merely for appearance.

## Engineering and Product Standards

Apply these standards throughout the implementation:

- Use strict TypeScript, domain-oriented modules, small testable services, clear DTOs, and dependency injection.
- Keep business rules in the backend domain layer. UI validation improves usability but never replaces server validation.
- Use one shared pricing, tax, discount, loyalty, inventory, checkout, order, notification, and identity flow for every channel.
- Use configuration and feature flags for provider-specific behavior. Never hard-code credentials, store IDs, API versions, tax rates, currency assumptions, or business hours.
- Use an outbox or equivalent reliable event pattern for important side effects such as notifications, inventory events, analytics, and integrations.
- Define API, database, queue, and WebSocket contracts before implementing consumers. Version breaking changes.
- Provide seed data, deterministic local development data, `.env.example`, migration scripts, and clear setup commands.
- If the repository is empty, prefer a clear workspace structure such as `apps/web`, `apps/api`, `apps/worker`, `packages/ui`, `packages/contracts`, `packages/config`, `prisma` or `database`, `docs`, and `tests`; adapt names to the selected tooling and document the final structure.
- Support localization, store-specific timezone and currency, locale-aware dates and numbers, translated system messages, and an RTL-ready layout even if the first release ships one language.
- Target WCAG 2.2 AA, modern Chrome, Firefox, Safari, and Edge, with tested mobile breakpoints and keyboard navigation.
- Set measurable performance budgets: fast storefront first load on a typical mobile connection, server-side catalog pagination, no unbounded dashboard queries, and a documented p95 target for API and webhook processing.
- Use semantic HTML, accessible Bootstrap components, alt text, focus management, reduced-motion support, and meaningful error messages.
- Build original visual language and content. Do not copy another product's visual identity or wording.

## Critical Business Rules and Edge Cases

Handle these cases explicitly in domain services, UI states, tests, and documentation:

- A suspended, archived, or closed store must not accept orders, while its owner and platform administrator can still see the correct explanation and operational controls.
- A revoked or rotated public link must stop new sessions without exposing whether a previous token was valid. Existing private order claims must follow their own expiry and revocation rules.
- A product, variant, price, promotion, warehouse, or delivery zone can change while a customer has a cart. Re-price and revalidate before order creation, explain changes, and never silently charge a stale total.
- Concurrent checkouts must not oversell stock or exceed voucher, loyalty, or per-customer usage limits.
- A payment redirect can be lost, repeated, delayed, or forged. Only a verified provider event or an authorized manual review can change the payment state.
- Failed, expired, cancelled, refunded, and partially fulfilled orders must release or reverse the correct reservation, loyalty, voucher, and delivery records exactly once.
- Messenger events can be duplicated, delayed, out of order, malformed, or delivered after a Page is disconnected. Process them safely and preserve an operator-visible failure record.
- Customer approval, account creation, guest order claiming, Messenger identity linking, and customer merging must not allow account takeover or duplicate rewards.
- Time windows, holidays, delivery schedules, voucher expiry, loyalty expiry, and analytics dates must use the store timezone while persistence remains UTC.
- Provider outages must degrade gracefully with retry, manual fallback, customer-safe messaging, and no false success state.
- Deleting or anonymizing a customer must preserve legally required financial and audit records while removing or masking unnecessary personal data.

## Tenancy and Account Model

Implement strict tenant isolation. Every store-owned record must be associated with a store, and every authenticated request must be authorized against the active store membership. A user must never be able to read or mutate another store's data by changing an ID in a URL or request body.

Support these actors and states:

- Platform administrator: creates, edits, suspends, archives, and manages multiple stores; manages platform users, roles, permissions, integrations, audit logs, and global settings.
- Store owner: can create an account or accept an invitation, completes store setup, manages the store, and invites staff.
- Store manager or staff: receives permissions assigned by the owner.
- Sales agent or customer-service agent: works in the conversation inbox and can be assigned customers and conversations.
- Customer: may create an optional account, or may order as a guest from a public store link without logging in.
- Messenger user: a customer identity associated with a Meta Page-scoped Messenger ID. Never assume a Messenger ID is globally portable between Pages.

Implement:

- User registration, login, logout, password reset, email or phone verification, account suspension, and session revocation.
- Short-lived access tokens and rotating refresh tokens, preferably delivered through secure, HttpOnly cookies for browser sessions.
- Optional MFA for administrators and store owners, with a path to require it by policy.
- Store memberships with explicit roles and permissions.
- Customer account statuses such as pending approval, approved, rejected, suspended, and deleted.
- A configurable store policy for whether customer accounts require approval. The public order link remains login-free; if a store requires approval before ordering, support a clear contact or approval flow rather than silently failing.
- A global customer identity plus a store-specific customer profile so the same person can have independent data, loyalty, and history per store.
- Passwordless customer access using one-time OTP or a secure order-claim link when an account is desired. Never expose a customer's orders merely because someone possesses the public store link.
- An explicit approval workflow with pending queues, approve, reject, suspend, reason, reviewer, timestamps, and customer notification. Approval decisions must be audited and must not be bypassed by changing a client-side status.
- Invitation expiry, resend, cancellation, and onboarding status for owners, staff, and agents.
- A safe support or impersonation mode for platform administrators only when required, with read-only default behavior, visible banners, time limits, reason capture, and a complete audit trail.

## Core Store Management

The platform administrator must be able to:

- Create multiple stores and assign or invite a store owner.
- Edit store name, logo, colors, contact information, business hours, timezone, locale, currency, tax settings, address, service areas, and order policies.
- Activate, suspend, archive, and restore a store.
- View store health, order activity, integration status, and audit history.
- Manage platform-level users, roles, permissions, feature flags, and configuration.
- Manage or support store-owned records according to explicit platform permissions, including users, customers, products, orders, payments, inventory, integrations, and settings. Any cross-store action must show the active store context and create an immutable audit record.

The store owner must be able to:

- Complete onboarding and configure the store without platform-admin assistance.
- Invite, deactivate, and permission staff and agents.
- Configure catalog, inventory, payments, shipping, notifications, Messenger, loyalty, vouchers, promotions, and business policies.
- View and export store data permitted by their role.

Provide an onboarding wizard and setup checklist covering store profile, business hours, service area, catalog, inventory, payment method, delivery method, Messenger connection, notification templates, loyalty rules, and legal policies. The store owner must be able to pause ordering, set holidays or blackout periods, configure order cutoffs, minimum order amounts, delivery or pickup availability, maximum open orders, and customer-facing closed-store messaging.

Each store must have one canonical public ordering link. The owner can copy it, share it, preview it, generate a QR code, open it in Messenger, and revoke or rotate its public token. Keep optional campaign or referral links as an extension, but do not remove the canonical single-link experience. Use a stable human-readable store slug plus a high-entropy token or signed link identifier; never expose sequential database IDs. Record link status, creation, rotation, revocation, and optional campaign attribution. A public link must identify only its store, be difficult to guess, be rate limited, and never grant access to private administrative data.

## Customer Storefront and Ordering Link

Create a fast, mobile-first, accessible storefront opened from the store link or Messenger webview. No login is required to browse or place an order through the public link by default. A store may explicitly require customer approval before accepting an order, but must provide a clear request or approval flow and must not silently convert the shareable link into an unexplained login wall.

The storefront must provide:

- Store branding, business hours, service status, contact details, and delivery coverage.
- Open, closed, paused, holiday, and temporarily unavailable states with configured messaging and ordering rules.
- Server-rendered or statically optimized public catalog pages with metadata, Open Graph previews, canonical URLs, sitemap support where appropriate, and a shareable store preview.
- Category browsing, product search, filtering, sorting, and product availability.
- Product detail pages with images, descriptions, price, variants, modifiers, add-ons, quantity limits, stock state, and allergen or policy information where configured.
- Add to cart, remove from cart, update quantity, clear cart, save draft cart, and restore a cart.
- A persistent cart associated with a guest session, Messenger identity when available, or customer account. Prevent cart data from crossing stores.
- A mobile-first cart experience with a visible cart summary or sticky cart action, touch-friendly controls, and a desktop layout that does not hide essential actions.
- Accurate subtotal, item-level discounts, voucher discounts, loyalty redemption, tax, delivery fee, and final total calculations. The server is always authoritative.
- Guest checkout with customer name, phone number, delivery address, landmark, delivery schedule, payment method, and order notes. Support the store's configured delivery or pickup option and validate service coverage before payment.
- Optional account creation after or during checkout without forcing account creation before the order.
- A confirmation page with order number, line items, payment state, delivery estimate, and tracking information when available.
- A secure way for a guest to claim and view an order through OTP or a single-use signed claim link.
- Optional customer dashboard with pending orders, order history, loyalty balance and ledger, earned or redeemed rewards, vouchers, settings, saved addresses, and communication preferences.
- Securely merge an eligible guest cart or order into a verified customer profile without allowing identity takeover, duplicate loyalty rewards, or duplicate notifications.
- Required consent, terms, privacy, marketing preference, and age or policy acknowledgements where configured by the store or jurisdiction.
- Clear loading, empty, unavailable, validation, payment failure, and network-error states.
- Keyboard accessibility, screen-reader labels, sufficient contrast, touch-friendly controls, and responsive layouts for small phones through desktop.

Use the same catalog, cart, checkout, order, payment, inventory, and notification services for web, Messenger, and future channels. Do not implement separate business logic that can disagree between channels.

## Messenger Integration

Integrate each store with an authorized Facebook Page using Meta's official APIs.

Implement:

- Facebook Login or the current official Meta authorization flow.
- Page selection and secure storage of the Page ID and encrypted Page access token.
- OAuth state validation, redirect validation, permission handling, disconnect, reconnect, and token health checks.
- Page subscription setup, permission diagnostics, connection health, token-expiry warnings, reconnect guidance, and a safe disconnect flow that stops outbound messaging without deleting historical records.
- Webhook verification and `X-Hub-Signature-256` verification using the app secret. Keep secrets in environment variables or a secret manager, never in source code or logs.
- The GET webhook verification handshake and a public POST webhook endpoint that acknowledges quickly, deduplicates events by provider event or message ID, queues processing, retries transient failures, and records dead-letter events.
- Configurable Meta Graph API version rather than scattering a stale version through the code.
- Message events, postback events, quick replies, referrals, attachments, delivery receipts, read receipts, and handover events as supported by the selected API version.
- Typing indicators, Get Started button, persistent menu, welcome message, and store-configurable main menu.
- Generic, button, carousel, image, and other supported message templates.
- Location sharing and attachment handling with file-type, size, malware, and storage validation.
- Messenger deep links and referral parameters that identify the store and campaign without trusting unvalidated client input.
- Mapping of Page-scoped Messenger users to store customer profiles and conversations.
- A versioned conversation state machine for welcome, browsing, product selection, cart, checkout handoff, order lookup, agent handoff, resolved, and fallback states. Persist state safely and recover when a message arrives late or out of order.
- Secure handoff from Messenger to the public storefront or webview, preserving only a short-lived signed context. Do not put private order data, access tokens, or trusted prices in query parameters.
- Outbound message queue with idempotency, retry/backoff, rate-limit handling, delivery state, and provider error logging without exposing tokens.
- Human-agent handoff using the official supported handover mechanism when applicable.
- Meta-required app privacy, data-deletion callback, user data request, consent, and retention workflows, documented for app review and production setup.

The Messenger conversation must support:

1. A customer clicks an authorized Facebook ad or store Messenger entry point.
2. Messenger opens and the customer receives a welcome message.
3. The customer sees the main menu.
4. The customer browses categories and products.
5. The customer views product details and selects variants or add-ons.
6. The customer adds products to a cart and views the cart.
7. The customer proceeds to checkout in Messenger or an official Messenger webview/store link.
8. The system collects the required customer information.
9. The customer selects a payment method.
10. The system validates stock, discounts, tax, delivery, and totals, then creates the order.
11. The customer receives confirmation and the store receives an admin or agent notification.
12. The customer can request order status and receive permitted lifecycle updates.

Respect Meta's messaging windows, consent, unsubscribe behavior, rate limits, message tags, and template rules. Build the integration so policy or API-version changes can be handled through configuration and isolated adapters.

## Website-to-Messenger Notification Bridge

The website and backend must be able to notify a customer through Facebook Messenger after a qualifying website action. Send the message through the connected Facebook Page's official Messenger Send API, never directly from the browser. Implement this flow as:

`Website or admin action -> authenticated API -> domain event -> outbox -> Redis worker -> Messenger adapter -> Meta Send API -> Messenger delivery/read webhook -> notification log`

This bridge must never turn a public website order into an automatic Messenger message without a verified Messenger identity and explicit permission. A direct website visit is enough to place a guest order, but it is not enough to discover a PSID, start a Messenger conversation, or authorize a Messenger notification.

Identity, consent, and eligibility rules:

- If a customer starts in Messenger, capture and store the Page-scoped Messenger ID only from a verified official Messenger event, referral, or supported Messenger webview context. Link it to the correct store profile and order.
- If a customer opens the public ordering link directly, do not assume that the website knows the customer's Messenger ID. At checkout and on the order confirmation page, offer an explicit `Get updates in Messenger` action.
- The opt-in action must use an official Messenger deep link, referral parameter, Messenger webview, or supported Messenger Extensions flow. Use a short-lived, single-use, signed context token to connect the conversation to the order or customer after the customer initiates the conversation. Never accept an arbitrary PSID from a browser query string and never put private order data or access tokens in a URL.
- Require appropriate customer consent and record consent timestamp, source, Page, purpose, policy version, and opt-out status. Keep transactional order updates separate from promotional or marketing consent.
- A customer may have different Messenger identities for different stores or Pages. Do not merge Page-scoped identities without verified account linking.
- If no verified Messenger identity, consent, or current Meta eligibility exists, do not attempt the send. Show the status in the customer portal and use an enabled email or SMS fallback only with its own consent and provider rules.

Required scenarios:

- Messenger-originated order: the customer starts a verified Messenger conversation, opens the official storefront webview or signed handoff, places an order, and receives eligible updates through that Page-scoped identity.
- Direct-link order: the customer browses and orders as a guest with no Messenger identity. The website displays the optional connection action, but sends nothing to Messenger until the customer initiates the linked conversation and the webhook securely resolves the single-use context.
- Declined or incomplete connection: the order remains valid, the customer is not contacted through Messenger, and the system uses the customer portal or a separately consented fallback channel.

Website and order events that must be able to trigger Messenger notifications include:

- Order created or confirmed.
- Payment received, payment failed, payment link created, or payment action required.
- Order preparing, packed, shipped, out for delivery, and delivered.
- Order cancelled, refund initiated, and refund processed.
- Tracking number or delivery estimate changed.
- Loyalty points earned, reward voucher issued, or a voucher about to expire when permitted.
- A store-approved operational message that is not promotional and is allowed by the current Meta policy.

Notification implementation requirements:

- Every eligible website or admin status change must publish a typed, tenant-scoped domain event. Do not send Messenger messages directly from a browser request.
- Render a store-configurable, localized Messenger template from a server-side order snapshot. Include only the minimum necessary information, such as store name, order number, status, total, and a secure order-status link.
- Check consent, customer preference, Page connection health, message window, current Meta policy, rate limits, and template eligibility immediately before sending.
- Use the official Send API and record queued, sent, delivered, read, failed, retrying, suppressed, and opted-out states. Delivery and read receipts must update the same notification record idempotently.
- Deduplicate by order event, customer, notification type, and policy-defined time window. Retrying a job must never send a duplicate order confirmation or charge a customer.
- Retry transient provider failures with exponential backoff and a dead-letter queue. Surface permanent failures, disconnected Pages, expired tokens, policy suppression, and missing identities to store staff.
- Provide staff with a permission-controlled resend action that re-checks eligibility and creates an audit record.
- Provide customer controls to connect Messenger, view notification preferences, stop or resume permitted updates, and choose an available fallback channel.
- Do not send promotional offers as transactional updates. Outside the applicable messaging window, send only through a currently Meta-approved mechanism; otherwise suppress the Messenger send and use a consented fallback or the customer portal.

## Catalog and Product Management

Implement a store-scoped catalog with:

- Categories and nested categories.
- Products, SKUs, variants, attributes, modifiers, add-ons, bundles, and product relationships.
- Product descriptions, images, image ordering, alt text, and S3-compatible storage.
- Regular price, sale price, cost where permitted, currency, tax class, and scheduling.
- Active, draft, archived, and out-of-stock states.
- Store-specific availability, warehouse availability, minimum and maximum quantities, and delivery restrictions.
- Bulk import and export with validation and an error report.
- Draft preview, publish/unpublish, scheduled availability, bulk archive, bulk price or stock updates, optimistic concurrency protection, and an audit entry for each changed record.
- Image resizing, thumbnail generation, orientation correction, alt-text validation, cache invalidation, and safe deletion of unused media.
- Product recommendations and related products for cross-selling and up-selling.
- Change history for sensitive product and price changes.

## Cart, Checkout, and Orders

Implement a persistent shopping cart with:

- Add product, remove product, update quantity, clear cart, subtotal calculation, discount calculation, tax calculation, delivery estimate, delivery fee calculation, and total calculation.
- Draft cart persistence and abandoned-cart detection.
- Safe cart recovery for eligible customers through policy-compliant notifications.
- Server-side price and availability revalidation at checkout.
- A single pricing and quote service that applies deterministic ordering for item discounts, promotions, loyalty redemption, tax, delivery, rounding, and totals. Return a quote version and expiration time so stale checkout screens are revalidated.
- Atomic voucher usage reservation and release, with clear reasons when a promotion or loyalty reward is rejected. Never trust a client-supplied total, discount, stock level, or voucher state.
- Guest-session expiry, cart merge rules, abandoned-cart consent checks, and protection against cart fixation or cross-store session reuse.
- Idempotency keys so retries cannot create duplicate orders or payments.
- Transactional order creation with stock reservation and an auditable status history.

Collect at checkout:

- Customer name.
- Phone number.
- Delivery address.
- Landmark.
- Delivery schedule or requested time window.
- Payment method.
- Order notes.

Generate a unique human-readable order number and a non-sequential internal ID. Store an immutable order snapshot of product names, SKUs, prices, tax, discounts, address, and selected options so later catalog edits do not change historical orders.

Implement an explicit order state machine with role-based transition permissions, configurable cancellation windows, customer-visible and internal statuses, and a reason for every manual override. Support order search, filters, pagination, bulk-safe actions, printable or downloadable order details, and a packing or fulfillment view. Do not allow an order to skip payment, inventory, or delivery invariants through a UI shortcut.

Support order statuses and explicit transition rules for:

- Pending.
- Confirmed.
- Preparing.
- Packed.
- Shipped or out for delivery.
- Delivered.
- Cancelled.
- Refunded.

Also track payment status separately, including pending, authorized, paid, failed, partially refunded, and refunded. Support cancellation rules, partial or full refunds, order notes, internal notes, status history, and customer notifications. Every status change must record who or what caused it, when it happened, and the previous and new values.

## Inventory and Warehouses

Implement:

- Multiple warehouses per store.
- Product and variant stock levels, reserved quantity, available quantity, reorder threshold, and optional cost valuation.
- Warehouse assignment based on availability, delivery area, and store rules.
- Stock transfers between warehouses, receiving and adjustment workflows, cycle counts, reconciliation reports, and role-protected approval for large adjustments.
- Atomic stock reservation during checkout.
- Reservation expiration and release for failed or abandoned checkouts.
- Deduction when the configured order stage is reached.
- Return of inventory on eligible cancellation or refund.
- Manual adjustments with reason and authorization.
- Low-stock and out-of-stock alerts.
- Inventory movement and history with before and after quantities.
- Protection against overselling under concurrent checkout requests.
- Inventory value, stock reports, and export.

## CRM and Customer Management

Automatically maintain a store-scoped customer profile containing, where lawfully collected and consented:

- Messenger ID and connected Page.
- Customer name.
- Phone number.
- Address and saved addresses.
- Purchase history.
- Lifetime value.
- Favorite or frequently purchased products.
- Customer tags.
- Last conversation and last order.
- Assigned sales or support agent.
- Account approval and communication preferences.

Provide customer search, filtering, segmentation, and owner or authorized-staff editing of customer profiles. Also provide import/export subject to permissions, customer timeline, order history, conversation history, internal notes, tags, assignment, merge handling, consent history, data export, and deletion or anonymization workflows.

## Loyalty Program

Implement a configurable loyalty program for each store.

The owner can configure:

- Earning as a percentage of an eligible purchase or a fixed number of points per purchase.
- Whether points are calculated from subtotal, paid total, or another explicitly documented eligible amount.
- Excluded products, categories, taxes, shipping, discounts, cancelled orders, and refunded amounts.
- Minimum order amount, earning caps, point expiration, and activation timing.
- Redemption conversion, such as a configured number of points becoming a fixed-value voucher.
- Minimum redemption balance, voucher value, expiry, usage limit, and whether the voucher can be combined with other promotions.
- Point rounding, earning and redemption caps, excluded payment or fulfillment states, expiration reminders, and a store-configurable loyalty program start or end date.

Implement:

- A non-editable or compensating-entry loyalty ledger rather than directly overwriting balances.
- Pending, earned, expired, redeemed, reversed, and adjusted point states.
- Automatic earning after the configured order/payment event.
- Automatic reversal after cancellation or refund.
- Secure redemption that prevents replay, double-spending, negative balances, and race conditions.
- Customer balance, ledger, reward vouchers, and history in the customer portal and permitted Messenger flows.
- Owner and authorized staff controls for manual adjustments with reasons and audit logs.
- Scheduled expiry and reversal jobs must be idempotent and visible in the loyalty audit history.

## Vouchers, Coupons, and Promotions

Allow store owners to create, edit, pause, expire, and revoke promotional offers, including:

- Percentage discount.
- Fixed-value discount.
- Loyalty-generated voucher.
- Product, category, customer-segment, or order-level scope.
- Minimum spend and maximum discount.
- Start and end time in the store timezone.
- Usage limit, per-customer limit, and current usage count.
- First-order, campaign, or referral restrictions.
- Free or discounted delivery where supported.
- Stackability and priority rules.
- Active, scheduled, expired, exhausted, and revoked states.

Validate every discount on the server. Make discount application deterministic and explain the applied discounts in the cart, order, receipt, and audit trail.

## Payments, Receipts, and Invoices

Use a provider-adapter interface so gateways can be replaced without changing checkout logic. Support:

- Cash on delivery.
- Bank transfer with configurable instructions and optional proof upload.
- Payment links.
- At least one online payment gateway selected for the deployment region.
- Automatic payment verification through signed provider webhooks.
- Payment retries and expired payment links.
- Idempotent payment creation and webhook processing.
- Payment method enablement per store, amount and currency validation, reconciliation between provider events and internal records, manual bank-transfer review, and an exception queue for mismatches.
- Receipts and invoices with store identity, tax details, order lines, discounts, payment state, and totals.
- Full and partial refunds with authorization, reason, provider synchronization, and audit trail.

Do not store raw card numbers, CVV, or unnecessary payment secrets. Use hosted payment pages or tokenized provider integrations and document PCI responsibilities. Never mark a payment paid based only on a browser redirect.

## Shipping and Delivery

Use a provider-adapter interface and support a manual delivery provider so the product works before an external carrier is configured. Implement:

- Delivery zones, service areas, schedules, and fee rules.
- Postal-code, radius, or polygon-based coverage where appropriate; address validation; delivery blackout dates; order cutoff rules; and configurable pickup locations if pickup is enabled.
- Delivery fee calculation and estimated arrival time.
- Warehouse or fulfillment assignment.
- Delivery records linked to orders.
- Generate shipping labels where the provider supports it.
- Tracking numbers and customer-visible tracking links.
- Provider webhook updates for shipment status.
- Manual status updates with authorization.
- Shipped, out-for-delivery, delivered, failed, returned, and cancelled states.
- Delivery notes and proof of delivery where applicable.

## Human Agent Dashboard and Conversations

Create a real-time inbox for authorized store agents and managers with:

- Live conversations and unread counts.
- Search and filters by status, tag, agent, customer, order, and channel.
- Take-over-chat and release-to-AI controls.
- Conversation assignment and reassignment.
- Open, pending, snoozed, resolved, and closed conversation states.
- Internal notes that customers cannot see.
- Customer timeline, order history, loyalty information, and relevant cart details beside the conversation.
- Quick replies and editable canned responses.
- Typing, sent, delivered, read, failed, and attachment states where provided by Meta.
- WebSocket updates with reconnect and eventual consistency handling.
- Collision prevention or clear presence indicators when multiple agents view the same conversation.
- Full conversation audit trail and permission checks.

## AI Assistant

Integrate an AI assistant behind a provider abstraction and store-level feature flag. The assistant must be grounded in store-approved content and tools, not allowed to invent business facts, and not allowed to bypass authorization.

Support:

- Frequently asked questions.
- Business hours, delivery areas, payment methods, and store policies.
- Store-managed knowledge sources for FAQs, policies, delivery zones, and business information, with draft, publish, version, rollback, and owner approval states.
- Product search and recommendations.
- Up-selling and cross-selling based on catalog rules and customer context.
- Cart assistance.
- Order status lookup after securely identifying the customer and verifying the order context.
- Loyalty balance and voucher guidance through authorized tools.
- Human-agent handoff when the customer asks, sentiment is negative, confidence is low, or the request involves a sensitive action.
- Conversation memory with configurable retention, customer consent, store isolation, and PII minimization.
- Agent-visible AI suggestion mode and automatic mode with separate permissions.
- AI transcript, tool-call, response, escalation, and error logging without storing secrets.
- AI usage, latency, token or cost metrics, provider fallback, per-store quotas, and an emergency disable switch.

All actions that create, cancel, refund, discount, alter customer data, or expose private order data must require validated server-side tools and appropriate authorization. Add prompt-injection defenses, unsafe-content handling, confidence thresholds, rate limits, cost controls, provider timeouts, and a safe fallback to a human agent.

## AI Model Strategy and Routing

Use a hybrid model strategy and implement it behind the AI Gateway. Do not use one expensive model for every request, and do not make an LLM authoritative for commerce data.

- Use deterministic backend services for prices, stock, tax, delivery fees, vouchers, loyalty balances, order status, payments, customer approval, Messenger identity, consent, and notification eligibility.
- Use Qwen3-8B locally for high-volume intent classification, FAQ responses grounded in store knowledge, simple product search, summaries, translation, and routine support. If no suitable GPU or local service is available, use paid GPT-5.6 Luna for these tasks.
- Use paid GPT-5.6 Luna as the low-cost hosted fallback for routine support, then GPT-5.6 Terra for multi-step recommendations, ambiguous support questions, multilingual conversations, and agent replies that need additional context.
- Use GPT-5.6 Sol with `max` reasoning effort for difficult engineering, security review, complex internal analysis, low-confidence escalations, and agent copilot work. Do not use it for every customer message.
- For the low-budget path, support Qwen3-8B as the default local, non-GPT open-weight model through Ollama, vLLM, llama.cpp, or LM Studio for development, synthetic data, non-sensitive summaries, and routine customer traffic after evaluation. Test Qwen3-14B or Qwen3-30B-A3B only when the available hardware and quality results justify it. Local inference is not free because infrastructure and operations still cost money.
- Do not rely on a free hosted quota for production availability. If no suitable GPU is available, use the non-GPT model for development and route production traffic to an approved low-cost hosted model with documented privacy, quota, latency, and uptime terms.
- Use an embedding model and a free or approved moderation service for retrieval and safety screening. Make model IDs configurable and verify current pricing, availability, data processing, and licenses before deployment.
- Keep prompts, model versions, routing policies, tool schemas, knowledge versions, token budgets, and provider settings versioned and auditable.
- Route by intent, risk, confidence, language, latency, store feature flag, and budget. Use fallbacks, circuit breakers, per-store quotas, spend alerts, and an emergency disable switch.
- Evaluate every candidate model on answer correctness, tool-call accuracy, privacy, hallucination refusal, handoff quality, multilingual quality, latency, and cost before changing the production default.
- When Hermes Agent is used to implement this project, use the exact OpenRouter model chain and staged workflow in `hermes-openrouter-project-plan.md`: `z-ai/glm-5.2:free`, `cohere/north-mini-code:free`, and `deepseek/deepseek-v4-flash-0731`. Do not use the random `openrouter/free` router as the primary coding model.

Use the detailed model selection, evaluation, rollout, configuration, and cost plan in `ai-model-selection-and-rollout-plan.md`, plus the Hermes/OpenRouter execution plan in `hermes-openrouter-project-plan.md`, as implementation references.

## Hermes Agent and OpenRouter Execution Plan

When Hermes Agent is used to implement this project, use OpenRouter with a stable model chain rather than changing models randomly between requests. The goal is to use free models for most development work and reserve a small paid budget for reliable fallback and high-risk review.

### Required Model Chain

Use these exact OpenRouter model IDs unless the current OpenRouter catalog has retired them. Verify availability before starting:

1. Free quality-first primary: `z-ai/glm-5.2:free`.
2. Free coding and tool-use fallback: `cohere/north-mini-code:free`.
3. Low-cost paid fallback: `deepseek/deepseek-v4-flash-0731`.
4. Occasional premium review: `anthropic/claude-sonnet-5` or another current premium model approved by the operator.

Do not use `openrouter/free` as the main coding model because it randomly selects among free models and can change tool behavior, output quality, and instructions between requests. Use it only for disposable experiments if needed.

Model roles:

- Use `z-ai/glm-5.2:free` for repository discovery, planning, normal implementation, Bootstrap UI, tests, documentation, and long project tasks. It supports tools and structured output, but its free endpoint is rate limited.
- Use `cohere/north-mini-code:free` when the primary free model is unavailable or when a coding-focused tool call is more reliable. It supports tool calls but does not enforce JSON Schema response format, so validate all outputs in Hermes.
- Use `deepseek/deepseek-v4-flash-0731` when both free models are rate limited, fail twice on the same issue, produce invalid tool calls, or leave incomplete patches. Use it for payment, Messenger, tenancy, concurrency, and difficult debugging when reliability matters.
- Use a premium model only for final security, architecture, payment, Messenger, deployment, or release reviews. Do not use premium models for every code generation request.

### Hermes Configuration

Hermes Agent is free and stores its configuration under `~/.hermes/`. Store `OPENROUTER_API_KEY` in `~/.hermes/.env`, never in the repository, prompt, `AGENTS.md`, logs, or a Git commit.

Configure the provider with `hermes model` and configure fallbacks with `hermes fallback`. The intended configuration is:

```yaml
model:
  provider: openrouter
  default: z-ai/glm-5.2:free

fallback_providers:
  - provider: openrouter
    model: cohere/north-mini-code:free
  - provider: openrouter
    model: deepseek/deepseek-v4-flash-0731

provider_routing:
  sort: price
  require_parameters: true
```

To switch an existing session for one task, use `/model openrouter:z-ai/glm-5.2:free`. A model change affects new sessions unless an explicit session switch is made. Use a fresh Hermes session or a compact checkpoint for each project module to reduce repeated context.

For private source code, production logs, customer records, or any personal or payment data, use only a provider endpoint whose current data policy is acceptable. Use `data_collection: deny` or `zdr: true` when supported. If the free endpoint cannot satisfy that policy, use the paid fallback or an approved private endpoint. Never send `.env` files, API keys, Messenger tokens, payment data, customer PII, or production database dumps to free endpoints.

Free OpenRouter variants are not a production SLA. Current limits are approximately 20 requests per minute and 50 requests per day when the account has purchased less than $10 in credits; an account with at least $10 in purchased credits may receive approximately 1,000 free-model requests per day. These limits and provider policies can change. Handle HTTP 429, 402, 5xx, invalid responses, empty streams, and provider outages with backoff, fallback, and visible progress reporting.

The user's GTX 1660 Super is not used for OpenRouter inference. Hermes runs project tools locally while OpenRouter runs the model remotely. A local model may be used only as an optional experiment; it must not be required for the project to progress.

### Hermes Safety and Progress Rules

Before implementation:

- Create `AGENTS.md` with concise architecture, security, Bootstrap, testing, and one-module-at-a-time rules.
- Create `docs/progress.md` with completed modules, current module, tests run, known defects, model used, fallback usage, and the next task.
- Create a Git branch or checkpoint for every module. Do not lose a working checkpoint when an AI model fails.
- Use Hermes Docker terminal isolation when available. Otherwise review commands before allowing them to run locally.
- Keep production credentials and customer data outside the working tree and model context.

For every module, use this sequence:

1. Ask the model to inspect the relevant files and state the goal, dependencies, risks, data changes, API changes, and acceptance criteria.
2. Implement one complete vertical slice with production code, migrations, validation, authorization, Bootstrap UI where applicable, tests, and documentation.
3. Run formatter, linter, type checking, relevant unit and integration tests, and build checks.
4. Review the changed files, update `docs/progress.md`, and create a Git checkpoint.
5. Escalate from the free model to paid DeepSeek after two repeated failures, invalid tool calls, incomplete patches, or high-risk uncertainty.
6. Use a premium review only for high-risk modules or final release review.
7. Report actual results and stop. Wait for `CONTINUE` before starting the next module.

Never allow the model to delete databases, expose local services publicly, rotate production credentials, deploy to production, or run destructive commands without explicit operator approval.

### AI Development Budget

This is an estimate for Hermes and OpenRouter model usage only, including implementation, tests, debugging, retries, compression, and reviews:

| Scenario | Estimated model usage | Practical cash budget |
| --- | ---: | ---: |
| Free-only experiment | $0 token charge | $0-$10, with strict limits and low reliability |
| Recommended full build | About $1-$30 | $25-$50 OpenRouter credits |
| Heavy debugging or rework | About $30-$150 | $50-$200 |
| Premium model used frequently | $150-$500+ | Avoid for a low-budget build |

Assume approximately 20M-60M input tokens and 5M-20M output or reasoning tokens for the full project. Current listed DeepSeek V4 Flash 0731 pricing is approximately $0.03 per million input tokens and $0.10 per million output tokens, but prices, discounts, provider routing, and model availability can change. OpenRouter credits used only to increase free-model quota are still a cash outlay, and unused balance follows OpenRouter's credit rules.

This budget excludes hosting, domain, PostgreSQL, Redis, object storage, monitoring, email/SMS, payment gateway fees, shipping providers, Meta operations, web search, browser tools, and production customer-chat usage after launch.

## Notifications

Implement an event-driven notification service with templates, localization, preferences, delivery status, retry/backoff, deduplication, quiet hours, and an outbox or equivalent reliable event mechanism. Messenger support is required, but a Messenger send is attempted only when the bridge has a verified Messenger identity, customer permission, and current Meta eligibility. Add email and SMS provider adapters as optional channels without coupling core order logic to them. Every qualifying order or payment event created by the website, admin dashboard, worker, or Messenger flow must use the Website-to-Messenger Notification Bridge rather than sending directly from UI code.

Notify customers through Messenger when policy and consent permit for:

- Order confirmation.
- Payment received.
- Order preparing.
- Order packed where configured.
- Out for delivery.
- Delivered.
- Cancelled.
- Refund processed.
- Payment failure or action required.
- Shipping and tracking updates.
- Loyalty rewards or voucher issuance where permitted.

Notify store owners, agents, and platform administrators for new orders, low stock, failed payments, webhook failures, and other configured operational events. Support a template editor with preview and variable validation. Respect customer opt-out and channel restrictions.

## Analytics and Reporting

Create store-scoped dashboards with date range, channel, product, category, agent, payment, delivery, and campaign filters. Include:

- Sales.
- Revenue.
- Conversion rate.
- Abandoned carts.
- Top products.
- Best customers.
- Average order value.
- Messenger response time.
- Agent performance.
- Inventory value.
- Daily orders.
- Monthly orders.
- Order status distribution.
- Payment success and failure rate.
- Refunds and cancellations.
- Loyalty earned and redeemed.
- Voucher usage.
- Delivery performance.
- Messenger or referral funnel from entry to product view, cart, checkout, and completed order; campaign attribution; repeat purchase rate; customer approval conversion; and loyalty or voucher redemption rate.

Define each metric, timezone, currency, attribution window, and inclusion rule. Avoid double-counting retries or duplicated webhook events. Provide pagination, CSV or JSON export where permitted, scheduled report jobs where useful, and an efficient aggregation strategy. Do not query unbounded raw message data on every dashboard request.

## Database and Domain Model

Create normalized migrations, foreign keys, indexes, unique constraints, check constraints where supported, timestamps, soft deletion where appropriate, and tenant-scoped authorization. Use integer minor units or a safe decimal strategy for money and store currency on monetary records. Use UTC timestamps and render them in the store timezone.

At minimum model these entities, including all relationships and history needed for auditing:

- Users.
- Stores and store settings.
- Store onboarding checklists, business hours, holidays, tax rules, delivery zones, pickup locations, and store policies.
- Store memberships.
- Owner or store applications and invitation records.
- Customers and store customer profiles.
- Customer approval history, consent records, communication preferences, and secure access sessions.
- Messenger users and connected Meta Pages.
- Meta OAuth connections, webhook subscriptions, provider configuration, and connection health events.
- Messenger linking sessions, notification consents, and policy or eligibility decisions.
- Products.
- Categories.
- Product images.
- Product variants, modifiers, and add-ons.
- Product price histories and scheduled availability.
- Warehouses.
- Inventory.
- Inventory reservations.
- Inventory movements and history.
- Shopping carts.
- Cart items.
- Pricing quotes, discount applications, and cart recovery events.
- Orders.
- Order items and order status history.
- Order fulfillment, returns, and cancellation reasons.
- Payments and payment events.
- Addresses.
- Deliveries or shipments.
- Coupons, vouchers, and promotions.
- Loyalty accounts, loyalty rules, loyalty ledger entries, and reward vouchers.
- Conversations.
- Messages and message attachments.
- Tags and customer or conversation tag assignments.
- Agents and conversation assignments.
- Roles, permissions, and role assignments.
- Notifications and notification deliveries.
- Notification template versions, delivery attempts, fallback records, and opt-out events.
- AI conversations, AI messages, and AI tool events.
- AI knowledge sources and published knowledge versions.
- Activity logs.
- Audit logs.
- Public store links, referral links, and order claim tokens.
- Webhook events and idempotency records.
- Outbox events, job attempts, report snapshots, and system health events.

Produce an ER diagram and explain important invariants, such as stock never becoming negative, a voucher not exceeding its usage limit, loyalty entries being reversible, and a webhook or payment event being processed once.

## REST API and Real-Time API

Build a versioned REST API with consistent status codes, error format, pagination, filtering, sorting, validation, authorization, and correlation IDs. Document every endpoint in OpenAPI/Swagger, including request schemas, response schemas, authentication, errors, and examples.

Cover at least these API areas:

- Authentication, sessions, MFA, and passwordless customer access.
- Platform stores, owner onboarding, customer approval, store members, settings, policies, and public links.
- Messenger connection, configuration, webhook verification handshake, inbound events, outbound messages, app data deletion, and connection health.
- Website-to-Messenger linking, customer consent, notification eligibility, notification history, resend, opt-out, and fallback-channel preferences.
- Public catalog, products, categories, product media, and availability.
- Shopping carts, cart recovery, pricing quotes, vouchers, loyalty, consent, guest order claims, and checkout.
- Orders, status transitions, cancellations, refunds, receipts, and invoices.
- Payments, payment links, bank-transfer evidence, gateway webhooks, and verification.
- Customers, CRM profiles, tags, notes, assignments, consent, export, and deletion.
- Inventory, warehouses, reservations, adjustments, alerts, and reports.
- Deliveries, rates, labels, tracking, and carrier webhooks.
- Conversations, messages, handoff, quick replies, canned responses, and WebSocket events.
- AI settings, knowledge sources, conversations, and handoff.
- Notifications, templates, preferences, and delivery logs.
- Analytics and exports.
- Activity and audit logs for authorized administrators.
- Health, readiness, feature flags, job status, and provider diagnostics for authorized operators.

Use WebSockets for live orders, inventory alerts, conversation messages, assignments, typing state, and dashboard updates. Authenticate WebSocket connections, authorize rooms by store, handle reconnects, and do not broadcast private customer information to the wrong tenant.

## Bootstrap-Ready Website Requirements

Bootstrap must be visible in the actual implementation, not merely listed as a dependency. Build a small reusable UI layer on top of Bootstrap 5.3 and use it consistently across the admin dashboard, agent inbox, customer portal, and public ordering storefront.

Implement:

- A Bootstrap Sass theme with original brand tokens for colors, typography, spacing, borders, shadows, focus rings, status colors, and dark-mode readiness. Keep custom CSS small and purposeful.
- Store branding must be applied through validated CSS custom properties or theme classes, with automatic contrast checks so owner-selected colors do not make text or controls inaccessible. Keep the platform shell and store storefront visually distinct but consistent with the same component contracts.
- Reusable typed components for application shell, responsive navigation, sidebar, offcanvas menu, breadcrumbs, page headers, cards, stat cards, forms, field errors, tables, responsive table-to-card views, filters, pagination, tabs, badges, alerts, modals, confirmations, toasts, dropdowns, empty states, loading skeletons, and error states.
- Desktop admin navigation with a sidebar and top bar, collapsing into a Bootstrap offcanvas navigation on phones. Preserve the active route, keyboard focus, breadcrumbs, and unsaved-form warnings.
- Mobile customer storefront patterns using a compact navbar, responsive category controls, product cards, accessible quantity controls, a sticky or bottom cart action, an offcanvas cart, a step-based checkout, responsive forms, and touch-friendly buttons.
- Responsive admin tables that remain usable on narrow screens through horizontal scrolling or an intentional card layout. Never hide critical order, payment, inventory, or customer actions only on mobile.
- Bootstrap form validation styles connected to server errors, accessible labels and descriptions, confirmation modals for destructive actions, toast feedback for completed actions, and non-color status indicators.
- Loading, empty, offline or retry, permission-denied, not-found, validation, success, and fatal-error screens using the same component layer.
- A documented component usage guide and visual examples for every shared component. Add visual or browser regression coverage for key mobile and desktop layouts.
- No Tailwind, Material UI, Ant Design, or an unapproved second UI framework. Do not copy another product's dashboard appearance.

## Admin and Customer Interfaces

Create original, coherent, mobile-responsive interfaces for:

- Platform admin: overview, stores, owner approvals, users, roles, permissions, global settings, integration health, audit logs, and platform analytics.
- Store owner: onboarding, store settings, canonical link and QR code, dashboard, catalog, categories, inventory, warehouses, orders, payments, deliveries, customers, CRM, conversations, agents, loyalty, vouchers, promotions, notifications, Messenger, AI, analytics, and audit history.
- Agent: assigned inbox, customer timeline, order context, notes, quick replies, canned responses, and handoff controls.
- Customer: public store ordering page, optional account creation, pending orders, order history, loyalty points, vouchers, saved settings and addresses, privacy controls, secure order claiming, Messenger connection, and notification preferences.

The UI must expose loading, empty, error, success, offline/retry, permission-denied, and confirmation states. Use optimistic UI only where server reconciliation is safe. Make destructive actions explicit and auditable.

The public storefront must also support mobile browser safe areas, sensible focus restoration after Bootstrap modals or offcanvas panels, no horizontal overflow, readable text at default zoom, and graceful behavior when JavaScript is delayed or a network request fails.

## Security, Privacy, and Reliability

Implement and test:

- JWT or equivalent authenticated sessions with refresh rotation and revocation.
- Strong password hashing such as Argon2id, secure cookie attributes, session fixation protection, login and reset abuse controls, and token or secret rotation procedures.
- Strict role-based access control and store-level authorization.
- Encrypted secrets and sensitive tokens at rest; secrets only through environment variables or a secret manager.
- Meta webhook signature verification and replay or duplicate protection.
- Payment and shipping webhook signature verification and idempotency.
- Input validation, output encoding, safe file upload handling, and parameterized queries or ORM protection.
- CSRF protection for cookie-authenticated browser mutations.
- CORS allowlists, secure headers, content security policy where compatible, and clickjacking protection.
- Explicit allowlists for Meta, payment, shipping, and storage origins required by the application; do not use wildcard production CORS or CSP values.
- Rate limiting by IP, user, store, Messenger identity, and sensitive action.
- Brute-force and OTP abuse protection.
- SQL injection, XSS, SSRF, command injection, and insecure direct-object-reference protections.
- Tenant isolation tests for every sensitive resource.
- Audit logs for authentication, permissions, customer approval, prices, discounts, inventory, orders, payments, refunds, Messenger configuration, AI actions, and exports.
- PII minimization, consent records, retention rules, data export, correction, deletion or anonymization, and privacy-policy links.
- No raw card data storage and no tokens or personal data in ordinary logs.
- Encrypt sensitive personal data where appropriate, redact request bodies and attachments from logs, define retention and deletion jobs, and provide a documented breach or incident response path.
- Run dependency, container, secret, and license scans in CI. Use non-root containers, least-privilege database and object-storage credentials, and a documented key rotation process.
- Health checks, structured logs, metrics, traces or correlation IDs, alerting, graceful shutdown, job retries, dead-letter handling, and backup/restore verification.
- Transactional consistency for checkout, stock, payments, loyalty, voucher usage, and order transitions.

## Testing Requirements

Write automated tests for:

- Domain services and calculations, including tax, delivery, discounts, vouchers, loyalty, totals, and status transitions.
- Authentication, authorization, RBAC, tenant isolation, customer approval, OTP, and order-claim flows.
- Database repositories and migrations.
- Messenger webhook verification, duplicate events, retries, message parsing, templates, receipts, attachments, referral links, and outbound failures.
- Complete Messenger-to-cart-to-checkout-to-order flow.
- Website-to-Messenger linking, explicit consent, order-status notifications, delivery or read receipts, duplicate suppression, policy-window suppression, disconnected Page handling, and fallback delivery.
- Public guest-link ordering without login.
- Customer account, pending order, history, settings, loyalty, and voucher flows.
- Concurrent checkout and inventory reservation, release, deduction, cancellation, and refund behavior.
- Payment provider adapters, signed callbacks, payment verification, receipts, invoices, and refund behavior.
- Shipping provider adapters, rates, labels, tracking, and status callbacks.
- AI tool authorization, order lookup privacy, handoff, provider failure, prompt injection boundaries, and memory isolation.
- Notification templates, policy-window handling, retries, and opt-out behavior.
- WebSocket authorization and reconnect behavior.
- REST API contract and error responses.
- Browser end-to-end tests on mobile and desktop breakpoints.
- Bootstrap component, keyboard navigation, focus management, responsive layout, visual regression, and WCAG or automated accessibility tests.
- Load tests for webhook intake, catalog reads, checkout, dashboard queries, and real-time conversations.
- Security scans, dependency audits, license checks, container scans, secret scans, performance budgets, and basic accessibility checks.

## Deployment and Operations

Provide production-ready Dockerfiles and Docker Compose configurations for local development and deployment. Configure:

- Nginx reverse proxy.
- HTTPS with automatic certificate renewal, such as Let's Encrypt.
- Environment variable examples with no real secrets.
- Separate development, staging, and production configuration, safe health and readiness probes, graceful deployment and rollback, and a release checklist.
- Separate web, API, worker, scheduler, PostgreSQL, Redis, and storage configuration as appropriate.
- Database migrations and seed data that are safe to run repeatedly.
- Automated encrypted database backups, retention, and tested restore instructions.
- Centralized structured logging and log redaction.
- Monitoring, health endpoints, metrics, error tracking, job dashboards, and alerts.
- CI/CD pipeline with quality gates and rollback guidance.
- Horizontal scaling notes for API, WebSocket, and worker processes.
- Document backup frequency, retention, recovery point objective, recovery time objective, failover assumptions, and how to restore without corrupting queues or payment state.
- Data migration, disaster recovery, and incident response procedures.
- Secure production configuration, least-privilege service accounts, firewall rules, and rotation procedures.

## Required Documentation and Deliverables

Produce:

1. Complete source code with clean module boundaries.
2. Database schema and migration history.
3. ER diagram.
4. OpenAPI/Swagger API documentation.
5. Messenger webhook and official Meta integration implementation.
6. Responsive platform admin dashboard.
7. Responsive store owner and agent dashboard.
8. AI chatbot with human handoff.
9. Customer ordering flow through Messenger and the public store link.
10. Inventory and warehouse system.
11. CRM and customer portal.
12. Loyalty points, reward vouchers, coupons, and promotions.
13. Payment, receipt, invoice, refund, shipping, and delivery integrations.
14. Analytics dashboard and exports.
15. Docker, Nginx, HTTPS, backup, monitoring, and CI/CD deployment files.
16. User manual.
17. Administrator manual.
18. Store owner and agent manual.
19. Production deployment and operations guide.
20. Security, privacy, Meta-policy, and integration configuration guide.
21. Test suite, test data, test report, and known limitations.
22. Bootstrap theme, reusable component library, responsive screen guide, and visual or accessibility test evidence.
23. AI model registry, routing policy, evaluation dataset and results, model-cost dashboard, and AI operations runbook.
24. Hermes Agent and OpenRouter configuration, fallback chain, staged progress plan, model bake-off results, and completion-budget report.

## Incremental Delivery Protocol

Implement one complete module at a time. Do not dump a large unverified codebase into one response. Before each module:

1. Explain the module's purpose, user value, dependencies, data model, API boundaries, security considerations, and acceptance criteria.
2. State assumptions and record architecture decisions.
3. Implement production-quality code, migrations, validation, authorization, UI where applicable, tests, and documentation for that module.
4. Show the changed file tree and explain important implementation choices.
5. Run the relevant formatter, linter, type checker, unit tests, integration tests, and build checks.
6. Report actual results, unresolved risks, and configuration needed from the operator.
7. Stop and wait for the explicit instruction `CONTINUE` before starting the next module.

Use this delivery order unless repository constraints require a documented change:

1. Repository discovery, architecture decisions, project scaffolding, Bootstrap 5.3 theme and reusable UI primitives, configuration, and local Docker environment.
2. Database foundation, tenancy, users, authentication, roles, permissions, store memberships, and audit infrastructure.
3. Platform admin store management, owner onboarding, store settings, customer approval, and canonical public ordering links.
4. Product catalog, media, categories, variants, modifiers, availability, and storefront foundation.
5. Persistent carts, pricing, taxes, delivery estimates, vouchers, promotions, and abandoned-cart state.
6. Checkout, orders, order status history, guest order claims, customer accounts, and customer portal.
7. Warehouses, inventory reservations, movements, low-stock alerts, and fulfillment assignment.
8. Payments, bank transfer, payment links, online gateway adapter, receipts, invoices, and refunds.
9. Shipping, delivery zones, provider adapter, labels, tracking, ETA, and delivery events.
10. Notifications, templates, preferences, queue workers, event outbox, fallback channels, and customer or store alerts.
11. Official Meta Messenger connection, OAuth, webhook, event processing, templates, deep links, website-to-Messenger linking, status notifications, and conversational ordering.
12. CRM, customer timeline, tags, assignments, agent inbox, real-time updates, and human handoff.
13. Loyalty points, reward-voucher redemption, loyalty ledger, and customer loyalty UI.
14. AI Gateway, model routing, knowledge sources, secure tools, memory, recommendations, evaluation, and handoff.
15. Analytics, reports, exports, performance optimization, and operational dashboards.
16. Full security hardening, accessibility, end-to-end tests, load tests, API documentation, manuals, deployment, backups, monitoring, and release readiness.

Do not move to the next module with failing tests, missing migrations, unprotected endpoints, fake integrations, or undocumented known defects. Use mock adapters only for local development and tests, and clearly separate them from production providers.

## Definition of Done

The platform is complete only when a platform administrator can create multiple stores, a store owner can configure a store and its canonical shareable ordering link, and a customer can use that link or an official Messenger flow without logging in to browse, add products, apply an eligible voucher or loyalty reward, check out, pay or select cash on delivery, and receive a secure order confirmation.

The store must then be able to reserve and fulfill stock, manage payment and delivery state, communicate through the Messenger inbox, hand off between AI and human agents, maintain CRM and loyalty records, issue notifications, and inspect accurate analytics. All relevant actions must be tenant-isolated, authorized, auditable, tested, documented, and deployable with the supplied operational files.

The website-to-Messenger path is complete only when a Messenger-originated or explicitly linked website order can trigger eligible status and payment notifications through the correct store's Facebook Page, delivery and read receipts are recorded, duplicates are suppressed, policy-blocked sends are not attempted, and customers without a Messenger link receive a clear consented fallback or portal update instead.

At the end, provide a requirements traceability checklist mapping every requirement in this prompt to its module, implementation location, test, and documentation.

---

## Initial Response Required From The Implementation Agent

Start by inspecting the repository and return:

- A concise assessment of the current codebase.
- The proposed architecture and module boundaries.
- The initial data model and ERD plan.
- Security and Meta-integration risks.
- The Bootstrap 5.3 setup, responsive layout strategy, and shared component plan.
- The AI Gateway, model-routing, local-model, evaluation, privacy, and cost-control plan.
- The Hermes Agent and OpenRouter model chain, fallback plan, project progress checkpoints, and completion budget.
- The phased implementation plan.
- The commands that will be used to verify the first module.

Then implement only Module 1 and wait for `CONTINUE`.
