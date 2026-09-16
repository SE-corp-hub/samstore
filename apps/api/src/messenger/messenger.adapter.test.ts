import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MockMessengerProvider,
  SuppressedMessengerProvider,
  MessengerService,
} from "./messenger.adapter.js";

test("mock provider records sent messages", async () => {
  const mock = new MockMessengerProvider();
  const svc = new MessengerService(mock, () => true);
  const result = await svc.notifyCustomer({ psid: "PSID-1", text: "Order on the way!", storeId: "s1" });
  assert.equal(result.delivered, true);
  if (result.delivered) assert.match(result.messageId, /^mock_/);
  assert.equal(mock.sentMessages().length, 1);
  assert.equal(mock.sentMessages()[0]?.psid, "PSID-1");
});

test("suppressed provider is used when store is not connected", async () => {
  const suppressed = new SuppressedMessengerProvider();
  const svc = new MessengerService(suppressed, () => false);
  const result = await svc.notifyCustomer({ psid: "PSID-1", text: "hi", storeId: "s1" });
  assert.equal(result.delivered, false);
  if (!result.delivered) assert.equal(result.reason, "not_connected");
  assert.equal(suppressed.suppressedLog().length, 0); // service short-circuits
});

test("messenger service routes to provider only when connected", async () => {
  const mock = new MockMessengerProvider();
  const svc = new MessengerService(mock, (storeId) => storeId === "s1");
  const ok = await svc.notifyCustomer({ psid: "P1", text: "x", storeId: "s1" });
  assert.equal(ok.delivered, true);
  const blocked = await svc.notifyCustomer({ psid: "P1", text: "x", storeId: "s2" });
  assert.equal(blocked.delivered, false);
  assert.equal(mock.sentMessages().length, 1); // only s1 went through
});

test("provider error surfaces as undelivered", async () => {
  const mock = new MockMessengerProvider();
  mock.queueFailure();
  const svc = new MessengerService(mock, () => true);
  const result = await svc.notifyCustomer({ psid: "P1", text: "x", storeId: "s1" });
  assert.equal(result.delivered, false);
  if (!result.delivered) assert.equal(result.reason, "provider_error");
});