// Demo seed for the Thin Slice — run with: npx tsx prisma/seed.ts
// Creates one store, settings, public link, categories, products, stock, and a demo cart.
// Destructive? No — upserts by stable slugs/tokens; safe to re-run.

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  // The demo accounts below have passwords written in this file. On a database that real
  // people use (the shared Supabase is one), running this would hand out an owner and a
  // platform-admin login to anyone who has read the repo. So it only runs when asked for
  // explicitly, and never in production. (scripts/lock-demo-accounts.ts re-locks them.)
  if (process.env.NODE_ENV === "production" || process.env.ALLOW_DEMO_SEED !== "true") {
    console.error("Refusing to seed demo accounts with known passwords. On a throwaway dev database only: set ALLOW_DEMO_SEED=true and run again.");
    process.exitCode = 1;
    return;
  }
  // Platform admin (demo) — public registration is restricted to STORE_OWNER, so this is seeded.
  const adminEmail = "platform@samstore.test";
  const existingAdmin = await prisma.user.findUnique({ where: { email: adminEmail } });
  if (existingAdmin) {
    // Ensure the seeded admin always has the platform role + known password.
    await prisma.user.update({
      where: { email: adminEmail },
      data: { role: "PLATFORM_ADMIN", passwordHash: await bcrypt.hash("platform-pass-123", 12), phone: "+639170000000" },
    });
  } else {
    await prisma.user.create({
      data: {
        email: adminEmail,
        passwordHash: await bcrypt.hash("platform-pass-123", 12),
        name: "Platform Admin",
        role: "PLATFORM_ADMIN",
        phone: "+639170000000",
      },
    });
    console.log("  platform admin: platform@samstore.test / platform-pass-123");
  }

  const store = await prisma.store.upsert({
    where: { slug: "sam-store" },
    update: {},
    create: {
      slug: "sam-store",
      name: "Sam's Store",
      currencyCode: "PHP",
      timezone: "Asia/Manila",
      status: "ACTIVE",
      settings: {
        create: {
          deliveryFeeMinor: 5000,
          minOrderAmountMinor: 0,
          allowGuestOrders: true,
        },
      },
      publicLink: {
        create: {
          slug: "sam-store",
          token: `lnk_${randomUUID().replace(/-/g, "")}`,
        },
      },
    },
  });

  // Store owner (demo) — ensure an OWNER membership so platform admin can manage/reset the owner.
  const ownerUser = await prisma.user.upsert({
    where: { email: "admin@samstore.test" },
    update: { role: "STORE_OWNER", name: "Test Admin", phone: "+639169000001" },
    create: { email: "admin@samstore.test", passwordHash: await bcrypt.hash("admin-pass-123", 12), name: "Test Admin", role: "STORE_OWNER", phone: "+639169000001" },
  });
  // Repair: if a store has no OWNER membership, this demo owner claims it (keeps owner-reset + owner-team rules working).
  const ownerExists = await prisma.userStore.findFirst({ where: { storeId: store.id, role: "OWNER" } });
  await prisma.userStore.upsert({
    where: { userId_storeId: { userId: ownerUser.id, storeId: store.id } },
    update: { role: "OWNER", status: "ACTIVE" },
    create: { userId: ownerUser.id, storeId: store.id, role: "OWNER", status: "ACTIVE" },
  });

  const drinks = await prisma.category.upsert({
    where: { storeId_slug: { storeId: store.id, slug: "drinks" } },
    update: {},
    create: { storeId: store.id, name: "Drinks", slug: "drinks", sortOrder: 1 },
  });

  const snackable = await prisma.category.upsert({
    where: { storeId_slug: { storeId: store.id, slug: "snacks" } },
    update: {},
    create: { storeId: store.id, name: "Snacks", slug: "snacks", sortOrder: 2 },
  });

  const products = [
    {
      sku: "KAPE-001",
      name: "Kape Barako",
      description: "Strong Filipino coffee",
      priceMinor: 12000,
      categoryId: drinks.id,
      stock: 50,
    },
    {
      sku: "TURON-001",
      name: "Turon (4 pcs)",
      description: "Fried banana rolls with caramelized sugar",
      priceMinor: 8000,
      categoryId: snackable.id,
      stock: 30,
    },
    {
      sku: "BIBINGKA-001",
      name: "Bibingka",
      description: "Rice cake with salted egg and cheese",
      priceMinor: 15000,
      categoryId: snackable.id,
      stock: 20,
    },
  ];

  const productIds: string[] = [];
  for (const p of products) {
    const product = await prisma.product.upsert({
      where: { storeId_sku: { storeId: store.id, sku: p.sku } },
      update: { priceMinor: p.priceMinor },
      create: {
        storeId: store.id,
        sku: p.sku,
        name: p.name,
        description: p.description,
        priceMinor: p.priceMinor,
        categoryId: p.categoryId,
        stockLevels: { create: { quantityOnHand: p.stock } },
      },
    });
    productIds.push(product.id);
  }

  // P2a demo: a VARIANT product with an ADD-ON group (own stock per variant).
  const kapeMalay = await prisma.product.upsert({
    where: { storeId_sku: { storeId: store.id, sku: "KAPE-MALAY" } },
    update: {},
    create: {
      storeId: store.id,
      sku: "KAPE-MALAY",
      name: "Kape Malay",
      description: "Specialty coffee — hot or iced, with extras.",
      priceMinor: 14000,
      categoryId: drinks.id,
      variants: {
        create: [
          { name: "Hot", sku: "KAPE-MALAY-HOT", priceMinor: 14000, quantityOnHand: 40, quantityReserved: 0 },
          { name: "Iced", sku: "KAPE-MALAY-ICED", priceMinor: 16000, quantityOnHand: 40, quantityReserved: 0 },
        ],
      },
      addons: {
        create: [
          {
            name: "Extras",
            sortOrder: 1,
            options: {
              create: [
                { name: "Extra shot", priceMinor: 2000, sortOrder: 1 },
                { name: "Soy/Silky milk", priceMinor: 3000, sortOrder: 2 },
              ],
            },
          },
        ],
      },
    },
  });
  productIds.push(kapeMalay.id);

  // P3a demo vouchers: percent + free-delivery (type engine v2).
  await prisma.voucher.upsert({
    where: { storeId_code: { storeId: store.id, code: "PINDIAN10" } },
    update: { type: "percent", percentBp: 1000, discountMinor: 0, minOrderMinor: 10000 },
    create: { storeId: store.id, code: "PINDIAN10", description: "10% off (P3a demo)", type: "percent", percentBp: 1000, discountMinor: 0, minOrderMinor: 10000, stackable: true },
  });
  await prisma.voucher.upsert({
    where: { storeId_code: { storeId: store.id, code: "FREESHIP" } },
    update: { type: "free_delivery", percentBp: null, discountMinor: 0 },
    create: { storeId: store.id, code: "FREESHIP", description: "Free delivery (P3a demo)", type: "free_delivery", discountMinor: 0, stackable: false },
  });

  // Demo guest cart (use this token for manual checkout tests).
  // Full reset: delete any previous cart with this token, then create fresh OPEN.
  await prisma.cart.deleteMany({ where: { token: "cart-demo-token" } });
  await prisma.cart.create({
    data: {
      storeId: store.id,
      token: "cart-demo-token",
      status: "OPEN",
      items: {
        create: [
          {
            storeId: store.id,
            productId: productIds[0]!,
            quantity: 2,
            unitPriceMinor: 12000,
          },
          {
            storeId: store.id,
            productId: productIds[1]!,
            quantity: 1,
            unitPriceMinor: 8000,
          },
        ],
      },
    },
  });

  const link = await prisma.publicStoreLink.findUnique({
    where: { storeId: store.id },
  });

  console.log("Seed complete:");
  console.log(`  store:   sam-store (${store.id})`);
  console.log(`  link:    sam-store + token ${link?.token ?? "(missing)"}`);
  console.log(`  products: ${products.map((p) => p.sku).join(", ")}, KAPE-MALAY (+variants, +add-ons)`);
  console.log(`  demo cart token: cart-demo-token`);

  // Ready-made demo logins for every staff role at Sam's Store (P1–P12 walkthrough).
  await seedDemoAccounts();
}

// Ready-made demo logins for every staff role at Sam's Store (P1–P12 walkthrough).
// All upserted by email — safe to re-run; passwords are fixed and known.
async function seedDemoAccounts() {
  const store = await prisma.store.findUnique({ where: { slug: "sam-store" } });
  if (!store) {
    console.log("  (skip demo accounts — sam-store not seeded)");
    return;
  }

  const demos: { email: string; name: string; role: string; password: string; phone?: string; memberships: boolean }[] = [
    { email: "manager@samstore.test", name: "Demo Manager", role: "MANAGER", password: "manager-pass-123", phone: "+639170000001", memberships: true },
    { email: "staff@samstore.test", name: "Demo Staff", role: "STAFF", password: "staff-pass-123", phone: "+639170000002", memberships: true },
    { email: "agent@samstore.test", name: "Demo Sales Agent", role: "SALES_AGENT", password: "agent-pass-123", phone: "+639170000003", memberships: true },
    { email: "delivery@samstore.test", name: "Demo Courier", role: "DELIVERY", password: "delivery-pass-123", phone: "+639170000004", memberships: true },
    { email: "customer@samstore.test", name: "Demo Customer", role: "CUSTOMER", password: "customer-pass-123", phone: "+639170000005", memberships: false },
  ];

  for (const d of demos) {
    const hash = await bcrypt.hash(d.password, 12);
    const user = await prisma.user.upsert({
      where: { email: d.email },
      update: { name: d.name, role: d.role, passwordHash: hash, phone: d.phone },

      create: { email: d.email, name: d.name, role: d.role, passwordHash: hash, phone: d.phone },
    });
    if (d.memberships) {
      await prisma.userStore.upsert({
        where: { userId_storeId: { userId: user.id, storeId: store.id } },
        update: { role: d.role as never, status: "ACTIVE" },
        create: { userId: user.id, storeId: store.id, role: d.role as never, status: "ACTIVE" },
      });
    }
    console.log(`  demo ${d.role.toLowerCase()}: ${d.email} / ${d.password}`);
  }
}

// Ready-made demo accounts (staff roles + customer) at Sam's Store.
main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());