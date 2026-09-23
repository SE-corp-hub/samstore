// P11d: lightweight OpenAPI contract gate without adding a YAML parser dependency.
// This checks the high-risk/public and newly-added module routes are represented in
// docs/openapi.yaml. Full schema correctness remains reviewable in the YAML file.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const file = resolve("docs/openapi.yaml");
const text = await readFile(file, "utf8");
const required = [
  "/health:",
  "/public/stores/{slug}:",
  "/public/stores/{slug}/messenger/opt-in:",
  "/admin/orders/{id}/payment-link:",
  "/admin/orders/{id}/payments/proof:",
  "/admin/orders/{id}/payments/review:",
  "/webhooks/paymongo:",
  "/admin/delivery-zones:",
  "/admin/orders/{id}/delivery/booking:",
  "/admin/messenger:",
  "/admin/chatbot/conversations:",
  "/admin/crm/customers:",
  "/admin/crm/campaigns/{id}/run:",
  "/admin/erp/trial-balance:",
  "/admin/bir/sales-journal:",
  "/admin/privacy/retention:",
  "/admin/security/incidents:",
];

const missing = required.filter((path) => !text.includes(`  ${path}`));
if (missing.length) {
  console.error(`OpenAPI contract is missing ${missing.length} required path(s):`);
  for (const path of missing) console.error(`- ${path}`);
  process.exit(1);
}
console.log(`OpenAPI contract check passed (${required.length} critical paths)`);
