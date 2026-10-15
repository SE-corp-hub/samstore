// Test-fixture sweeper (Module 6/11 fix) — DRY-RUN BY DEFAULT.
//
// Unit tests create throwaway stores/products/customers named from a per-run prefix
// (M4*, M5*, RC*, SG*, OBX*, PAY*, TXJ*, TZO*, posx-*, probe-*) and delete them in an
// `after()` hook. When a run ABORTS, that hook never fires and the fixtures stay in the
// database — which is why reconciliation reports drift for rows nobody owns any more
// (a balance whose ledger rows were deleted with the aborted attempt).
//
//   npx tsx scripts/cleanup-test-fixtures.ts            # list what would be deleted
//   npx tsx scripts/cleanup-test-fixtures.ts --apply    # delete it (FK-safe order)
//
// ONLY rows matching the known test prefixes are touched; anything else is left alone.

import { prisma } from "../apps/api/src/persistence/prisma-repositories.js";

/** Store slugs created by test runs (see the prefixes in the api test files). */
const TEST_STORE_SLUG = /^(?:m[456]\d{6,}|m5|rc\d{6,}|sg\d{6,}|obx\d{6,}|pay\d{6,}|tx[joz]-\w+|probe-|pay-|m5-idem|p1c\d+|p1ad\d+|p2c\d+|posx-|v6t\d+|\d{2}p3v\d+|m[123]r\d{6,}|[a-p]{6}-m3r\d{6,})/i; // Rice Ops M1–M3 test stores

async function main() {
  const apply = process.argv.includes("--apply");

  const stores = await prisma.store.findMany({ select: { id: true, slug: true, name: true, createdAt: true } });
  const junk = stores.filter((s) => TEST_STORE_SLUG.test(s.slug));

  if (junk.length === 0) {
    console.log("No leaked test fixtures found — nothing to do.");
    await prisma.$disconnect();
    return;
  }

  console.log(`Leaked test stores: ${junk.length}`);
  for (const s of junk) console.log(`  ${s.slug}  (${s.name})  created ${s.createdAt.toISOString().slice(0, 10)}`);

  if (!apply) {
    console.log("\nDry-run: nothing deleted. Re-run with --apply to remove these fixtures.");
    await prisma.$disconnect();
    return;
  }

  for (const s of junk) {
    const orderIds = (await prisma.order.findMany({ where: { storeId: s.id }, select: { id: true } })).map((o) => o.id);
    // Rice Ops M1–M3 tables (children first).
    await prisma.auditLog.deleteMany({ where: { storeId: s.id } });
    await prisma.signature.deleteMany({ where: { storeId: s.id } });
    await prisma.approvalRequest.deleteMany({ where: { storeId: s.id } });
    await prisma.flowDraft.deleteMany({ where: { storeId: s.id } });
    await prisma.stockReturn.deleteMany({ where: { storeId: s.id } });
    await prisma.stockTransfer.deleteMany({ where: { storeId: s.id } });
    await prisma.locationPrice.deleteMany({ where: { storeId: s.id } });
    await prisma.notificationLog.deleteMany({ where: { storeId: s.id } });
    await prisma.outboxEvent.deleteMany({ where: { storeId: s.id } });
    await prisma.stockMovement.deleteMany({ where: { storeId: s.id } });
    if (orderIds.length) {
      await prisma.orderClaimToken.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.voucherRedemption.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.loyaltyEntry.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.creditEntry.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.payment.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    }
    await prisma.voucherRedemption.deleteMany({ where: { storeId: s.id } });
    await prisma.voucher.deleteMany({ where: { storeId: s.id } });
    await prisma.loyaltyEntry.deleteMany({ where: { storeId: s.id } });
    await prisma.creditEntry.deleteMany({ where: { storeId: s.id } });
    await prisma.cartItem.deleteMany({ where: { storeId: s.id } });
    await prisma.cart.deleteMany({ where: { storeId: s.id } });
    await prisma.stockLevel.deleteMany({ where: { storeId: s.id } });
    await prisma.product.deleteMany({ where: { storeId: s.id } });
    await prisma.storeCustomer.deleteMany({ where: { storeId: s.id } });
    await prisma.storeSettings.deleteMany({ where: { storeId: s.id } });
    await prisma.publicStoreLink.deleteMany({ where: { storeId: s.id } });
    await prisma.storeCounter.deleteMany({ where: { storeId: s.id } });
    await prisma.cashMovement.deleteMany({ where: { storeId: s.id } });
    await prisma.registerSession.deleteMany({ where: { storeId: s.id } });
    await prisma.register.deleteMany({ where: { storeId: s.id } });
    await prisma.expense.deleteMany({ where: { storeId: s.id } });
    await prisma.purchaseItem.deleteMany({ where: { storeId: s.id } });
    await prisma.purchase.deleteMany({ where: { storeId: s.id } });
    await prisma.supplier.deleteMany({ where: { storeId: s.id } });
    await prisma.kargador.deleteMany({ where: { storeId: s.id } });
    await prisma.userStore.deleteMany({ where: { storeId: s.id } });
    await prisma.warehouse.deleteMany({ where: { storeId: s.id } });
    await prisma.store.delete({ where: { id: s.id } });
    console.log(`  deleted ${s.slug}`);
  }

  // Test customers carry a synthetic name/customer row; drop the ones left with no
  // store membership at all (the aborted-run leftovers).
  const orphanSc = await prisma.storeCustomer.findMany({ where: { storeId: { in: junk.map((s) => s.id) } }, select: { customerId: true } });
  const customerIds = [...new Set(orphanSc.map((o) => o.customerId))];
  if (customerIds.length) {
    const stillUsed = await prisma.storeCustomer.findMany({ where: { customerId: { in: customerIds } }, select: { customerId: true } });
    const used = new Set(stillUsed.map((s) => s.customerId));
    const deletable = customerIds.filter((id) => !used.has(id));
    if (deletable.length) await prisma.customer.deleteMany({ where: { id: { in: deletable } } });
  }

  // P1: PH address reference fixtures (region → … cascades via FK). Only rows whose
  // code matches the P1 test prefixes are touched; seeded regions (reg-*) are never.
  const phRegions = await prisma.phRegion.findMany({
    where: { OR: [{ code: { startsWith: "P1C" } }, { code: { startsWith: "P1T" } }, { code: { startsWith: "P1AD" } }] },
    select: { id: true, code: true },
  });
  if (phRegions.length > 0) {
    const phRegionIds = phRegions.map((r) => r.id);
    console.log(`P1 address fixtures: ${phRegions.length} region tree(s) to remove.`);
    if (apply) {
      await prisma.phBarangay.deleteMany({ where: { city: { province: { regionId: { in: phRegionIds } } } } });
      await prisma.phCity.deleteMany({ where: { province: { regionId: { in: phRegionIds } } } });
      await prisma.phProvince.deleteMany({ where: { regionId: { in: phRegionIds } } });
      await prisma.phRegion.deleteMany({ where: { id: { in: phRegionIds } } });
    }
  }

  console.log(`\nDeleted ${junk.length} leaked test store(s).`);
  await prisma.$disconnect();
}

void main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
