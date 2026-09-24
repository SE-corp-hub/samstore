// Phase 12 staging fixture helper.
// Creates two disposable public stores with independent catalogs and writes their
// tokenized URLs to a gitignored local file. It never deletes data; cleanup requires
// an explicit operator action outside this script.
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { prisma } from "../apps/api/src/persistence/prisma-repositories.js";

const run = `P12${Date.now()}`.toLowerCase();
const output = process.env.PHASE12_FIXTURE_FILE ?? ".phase12.env.local";

async function createStore(label: string, sku: string, productName: string) {
  const slug = `${run}-${label}`;
  const token = `lnk_${randomBytes(24).toString("base64url")}`;
  const store = await prisma.store.create({
    data: {
      slug,
      name: label === "a" ? "Lola's Sari-Sari" : "Kape PH",
      publicLink: { create: { slug, token } },
      settings: {
        create: {
          allowGuestOrders: true,
          deliveryFeeMinor: 5000,
          pickupEnabled: true,
          orderNumberPrefix: `P12${label.toUpperCase()}`,
        },
      },
    },
  });
  const category = await prisma.category.create({ data: { storeId: store.id, name: label === "a" ? "Pantry" : "Coffee", slug: `${label}-${run}`, sortOrder: 0 } });
  const product = await prisma.product.create({ data: { storeId: store.id, categoryId: category.id, sku, name: productName, priceMinor: label === "a" ? 15000 : 18000, featured: true, tags: ["phase12"] } });
  await prisma.stockLevel.create({ data: { storeId: store.id, productId: product.id, quantityOnHand: 50, quantityReserved: 0 } });
  return { slug, token, storeId: store.id };
}

async function main() {
  const a = await createStore("a", `${run}-A`, "Phase 12 Rice");
  const b = await createStore("b", `${run}-B`, "Phase 12 Kape");
  const web = process.env.PHASE12_WEB_URL ?? "http://localhost:3000";
  await writeFile(output, [
    `PH_E2E_TWO_STORE=1`,
    `PH_E2E_STORE_A_URL=${web}/${a.slug}?token=${a.token}`,
    `PH_E2E_STORE_B_URL=${web}/${b.slug}?token=${b.token}`,
    `PHASE12_STORE_A_ID=${a.storeId}`,
    `PHASE12_STORE_B_ID=${b.storeId}`,
  ].join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
  console.log(`Created two staging stores. Tokenized URLs written to ${output}; do not commit or paste that file.`);
  console.log(`Store slugs: ${a.slug}, ${b.slug}`);
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
