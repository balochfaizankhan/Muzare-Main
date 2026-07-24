import { test } from "node:test";
import assert from "node:assert/strict";
import {
  advanceDirectedGroupId,
  advanceRecipientLabourerId,
  buildMembershipDirectory,
  duePoolKey,
  labourerCurrentPoolKey,
  resolveAdvancePoolOwnership,
} from "../src/lib/labour-advance-pools.js";

const labourer = (id: string, payload: Record<string, unknown> = {}) => ({
  clientRecordId: id,
  payload: { name: `Labourer ${id}`, ...payload },
});
const group = (id: string, payload: Record<string, unknown> = {}) => ({
  clientRecordId: id,
  payload: { name: `Group ${id}`, ...payload },
});

test("an ungrouped labourer's advance vouchers resolve to their individual pool", () => {
  const directory = buildMembershipDirectory([labourer("L1")], []);
  const ownership = resolveAdvancePoolOwnership({ labourerId: "L1" }, directory);
  assert.deepEqual(ownership, { kind: "INDIVIDUAL", poolKey: "individual:L1", labourerId: "L1" });
});

test("joining a group moves every valid advance voucher into that group's pool, without any historical snapshot", () => {
  // The voucher itself carries NO preserved group evidence — current
  // membership alone resolves the pool.
  const directory = buildMembershipDirectory(
    [labourer("L1", { groupId: "G-SALEEM" })],
    [group("G-SALEEM", { name: "SALEEM" })],
  );
  const ownership = resolveAdvancePoolOwnership({ labourerId: "L1" }, directory);
  assert.deepEqual(ownership, { kind: "GROUP", poolKey: "group:G-SALEEM", groupId: "G-SALEEM" });
});

test("moving to another group re-resolves the same vouchers to the new current group", () => {
  const voucher = { labourerId: "L1", labourGroupId: "G-SALEEM" }; // stale stamped evidence stays for audit
  const before = buildMembershipDirectory(
    [labourer("L1", { groupId: "G-SALEEM" })],
    [group("G-SALEEM"), group("G-OTHER")],
  );
  const after = buildMembershipDirectory(
    [labourer("L1", { groupId: "G-OTHER" })],
    [group("G-SALEEM"), group("G-OTHER")],
  );
  assert.equal(resolveAdvancePoolOwnership(voucher, before).poolKey, "group:G-SALEEM");
  // Current membership wins over the preserved labourGroupId stamp.
  assert.equal(resolveAdvancePoolOwnership(voucher, after).poolKey, "group:G-OTHER");
});

test("removing the labourer from all groups returns their vouchers to the individual pool", () => {
  const directory = buildMembershipDirectory([labourer("L1")], [group("G-SALEEM")]);
  const ownership = resolveAdvancePoolOwnership({ labourerId: "L1", labourGroupId: "G-SALEEM" }, directory);
  // Recipient identity outranks the stale group stamp: the labourer is
  // currently ungrouped, so the voucher is individual again.
  assert.deepEqual(ownership, { kind: "INDIVIDUAL", poolKey: "individual:L1", labourerId: "L1" });
});

test("a group-directed voucher (no labourer recipient) stays with its group", () => {
  const directory = buildMembershipDirectory([], [group("G-SALEEM")]);
  const ownership = resolveAdvancePoolOwnership({ labourGroupId: "G-SALEEM" }, directory);
  assert.deepEqual(ownership, { kind: "GROUP", poolKey: "group:G-SALEEM", groupId: "G-SALEEM" });
});

test("the group leader belongs to the group's settlement unit even without an explicit member assignment", () => {
  const directory = buildMembershipDirectory(
    [labourer("L-LEAD")],
    [group("G-SALEEM", { foremanLabourId: "L-LEAD" })],
  );
  assert.equal(labourerCurrentPoolKey("L-LEAD", directory), "group:G-SALEEM");
  assert.equal(directory.groups.get("G-SALEEM")?.leaderName, "Labourer L-LEAD");
});

test("deleted labourers and deleted groups never resolve to a pool", () => {
  const directory = buildMembershipDirectory(
    [labourer("L1", { deletedAt: "2026-01-01T00:00:00Z" })],
    [group("G1", { status: "deleted" })],
  );
  assert.equal(labourerCurrentPoolKey("L1", directory), null);
  assert.equal(resolveAdvancePoolOwnership({ labourerId: "L1" }, directory).kind, "REVIEW");
  assert.equal(resolveAdvancePoolOwnership({ labourGroupId: "G1" }, directory).kind, "REVIEW");
});

test("legacy group-name references resolve only when they map to exactly one live group", () => {
  const unambiguous = buildMembershipDirectory(
    [labourer("L1", { group: "saleem" })],
    [group("G1", { name: "SALEEM" })],
  );
  assert.equal(labourerCurrentPoolKey("L1", unambiguous), "group:G1");
  const ambiguous = buildMembershipDirectory(
    [labourer("L1", { group: "saleem" })],
    [group("G1", { name: "SALEEM" }), group("G2", { name: "Saleem" })],
  );
  assert.equal(labourerCurrentPoolKey("L1", ambiguous), "individual:L1");
});

test("snapshot recipient fallbacks and scope-key group evidence still identify the original recipient", () => {
  assert.equal(advanceRecipientLabourerId({ recipientSnapshot: { advanceLabourerId: "L9" } }), "L9");
  assert.equal(advanceDirectedGroupId({ financialScopeKey: "group:G7" }), "G7");
  assert.equal(advanceDirectedGroupId({ recipientSnapshot: { groupId: "G8" } }), "G8");
});

test("contractor/crew scope vouchers keep their own scope pool and never enter group pools", () => {
  const directory = buildMembershipDirectory([], [group("G1")]);
  const ownership = resolveAdvancePoolOwnership({ financialScopeKey: "contractor:acme" }, directory);
  assert.deepEqual(ownership, { kind: "SCOPE", poolKey: "contractor:acme" });
});

test("a voucher with no recipient reference at all is the only ordinary review case", () => {
  const directory = buildMembershipDirectory([], []);
  const ownership = resolveAdvancePoolOwnership({ financialScopeKey: "legacy:abc" }, directory);
  assert.equal(ownership.kind, "REVIEW");
});

test("a group due settles against its own frozen group pool; an individual due follows the labourer's current pool", () => {
  const directory = buildMembershipDirectory(
    [labourer("L1", { groupId: "G-SALEEM" }), labourer("L2")],
    [group("G-SALEEM")],
  );
  assert.equal(duePoolKey({ recipientScope: "LABOUR_GROUP", labourGroupId: "G-SALEEM", labourerId: null, financialScopeKey: "group:G-SALEEM" }, directory), "group:G-SALEEM");
  // A grouped member's individual due draws on the group's combined balance.
  assert.equal(duePoolKey({ recipientScope: "INDIVIDUAL", labourGroupId: null, labourerId: "L1", financialScopeKey: "individual:L1" }, directory), "group:G-SALEEM");
  assert.equal(duePoolKey({ recipientScope: "INDIVIDUAL", labourGroupId: null, labourerId: "L2", financialScopeKey: "individual:L2" }, directory), "individual:L2");
});

test("pool totals and voucher group labels come from the same resolver output", () => {
  const directory = buildMembershipDirectory(
    [labourer("L1", { groupId: "G-SALEEM" })],
    [group("G-SALEEM", { name: "SALEEM" })],
  );
  const ownership = resolveAdvancePoolOwnership({ labourerId: "L1" }, directory);
  assert.equal(ownership.kind, "GROUP");
  if (ownership.kind === "GROUP") {
    assert.equal(directory.groups.get(ownership.groupId)?.name, "SALEEM");
    assert.equal(ownership.poolKey, "group:G-SALEEM");
  }
});
