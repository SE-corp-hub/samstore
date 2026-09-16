import { test } from "node:test";
import assert from "node:assert/strict";
import { NotificationsService } from "./notifications.service.js";
import { MessengerService, MockMessengerProvider } from "../messenger/messenger.adapter.js";
import { prisma } from "../persistence/prisma-repositories.js";

function makeSvc(connected: boolean) {
  const mock = new MockMessengerProvider();
  const messenger = new MessengerService(mock, () => connected);
  return { svc: new NotificationsService(messenger), mock };
}

// Use the seeded demo store (FK requirement for the audit log).
const STORE_ID = "cmtifdks2000094ic1j9w8th7";

test("templates render with data", async () => {
  const { svc } = makeSvc(true);
  const out = await svc.notify({
    storeId: STORE_ID,
    customerPhone: "+639170000001",
    template: "order_received",
    data: { orderNumber: "SAMSTO-000001", total: "₱100.00", currency: "PHP" },
  });
  assert.equal(out.delivered.sms, true);
  assert.equal(out.suppressedMessenger, true); // no PSID → suppressed
  assert.equal(out.delivered.email, false);
});

test("messenger is attempted when PSID present + connected", async () => {
  const { svc, mock } = makeSvc(true);
  const out = await svc.notify({
    storeId: STORE_ID,
    psid: "PSID-1",
    customerPhone: null,
    template: "order_status",
    data: { orderNumber: "X", status: "DELIVERED" },
  });
  assert.equal(out.delivered.messenger, true);
  assert.equal(mock.sentMessages().length, 1);
  assert.equal(out.suppressedMessenger, false);
});

test("no PSID → messenger suppressed, no false success", async () => {
  const { svc, mock } = makeSvc(true);
  const out = await svc.notify({
    storeId: STORE_ID,
    customerPhone: "+639170000001",
    template: "order_status",
    data: { orderNumber: "X", status: "CONFIRMED" },
  });
  assert.equal(out.delivered.messenger, false);
  assert.equal(out.suppressedMessenger, true);
  assert.equal(mock.sentMessages().length, 0); // nothing leaked to the network
});

test("notification log is written", async () => {
  const { svc } = makeSvc(true);
  await svc.notify({
    storeId: STORE_ID,
    customerPhone: "+639170000001",
    template: "order_out_for_delivery",
    data: { orderNumber: "X" },
  });
  const row = await prisma.notificationLog.findFirst({ where: { template: "order_out_for_delivery" }, orderBy: { createdAt: "desc" } });
  assert.ok(row);
  assert.equal(row!.delivered, true);
  assert.match(row!.text, /out for delivery/);
});