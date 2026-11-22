// Who may change the team (2026-11-20, "Give each store its own settings"): the owner anything;
// a manager (every store) and a store head (its own store) only counter logins.
import { test } from "node:test";
import assert from "node:assert/strict";
import { teamRefusal, type Actor } from "./people.service.js";

const owner: Actor = { userId: "o", role: "OWNER", homeLocationId: null };
const manager: Actor = { userId: "m", role: "MANAGER", homeLocationId: null };
const head: Actor = { userId: "h", role: "STAFF", homeLocationId: "S2", isHead: true };
const counter: Actor = { userId: "c", role: "STAFF", homeLocationId: "S2" };
const staffAt = (loc: string | null, isLocationHead = false) => ({ role: "STAFF", homeLocationId: loc, isLocationHead });

test("the owner may change anyone", () => {
  assert.equal(teamRefusal(owner, { role: "MANAGER", homeLocationId: null, isLocationHead: false }, { role: "SALES_AGENT" }), null);
  assert.equal(teamRefusal(owner, staffAt("S2"), { isLocationHead: true }), null);
});

test("a store head looks after counter logins of its own store only", () => {
  assert.equal(teamRefusal(head, staffAt("S2")), null);
  assert.equal(teamRefusal(head, null, { role: "STAFF", homeLocationId: "S2" }), null, "adds a counter login at its store");
  assert.ok(teamRefusal(head, null, { role: "STAFF", homeLocationId: "S3" }), "not at another store");
  assert.ok(teamRefusal(head, null, { role: "STAFF", homeLocationId: null }), "not an every-store login");
  assert.ok(teamRefusal(head, null, { role: "MANAGER", homeLocationId: "S2" }), "no other roles");
  assert.ok(teamRefusal(head, null, { homeLocationId: "S2", isLocationHead: true }), "cannot make a head");
  assert.ok(teamRefusal(head, staffAt("S3")), "people of another store");
  assert.ok(teamRefusal(head, staffAt("S2", true)), "another head");
  assert.ok(teamRefusal(head, staffAt("S2"), { homeLocationId: "S3" }), "cannot move someone away");
  assert.ok(teamRefusal(head, { role: "OWNER", homeLocationId: null, isLocationHead: false }));
});

test("a manager looks after the counter logins of their own store only (2026-11-22)", () => {
  const mgr: Actor = { userId: "m", role: "MANAGER", homeLocationId: "S1" };
  assert.equal(teamRefusal(mgr, staffAt("S1")), null);
  assert.ok(teamRefusal(mgr, staffAt("S3")), "not another store's");
  assert.ok(teamRefusal(mgr, staffAt("S1"), { homeLocationId: "S3" }), "cannot move someone to another store");
  assert.ok(teamRefusal(mgr, staffAt(null)), "an every-store staff login stays with the owner");
  assert.ok(teamRefusal(mgr, staffAt("S1"), { isLocationHead: true }));
  assert.ok(teamRefusal(mgr, { role: "MANAGER", homeLocationId: null, isLocationHead: false }));
  assert.ok(teamRefusal(manager, staffAt("S1")), "a manager with no store yet looks after no one");
});

test("counter staff may not change the team", () => {
  assert.ok(teamRefusal(counter, staffAt("S2")));
  assert.ok(teamRefusal(counter, null, { role: "STAFF", homeLocationId: "S2" }));
});
