import assert from "node:assert/strict";
import { test } from "node:test";
import { legacyAdvancePosition, mergeAdvancePositions, type LegacyAdvanceReadRow } from "../src/lib/labour-advance-read-model.js";

const row = (overrides: Partial<LegacyAdvanceReadRow> = {}): LegacyAdvanceReadRow => ({
  id: "legacy-operational:1", sourceId: "1", voucherNumber: "ADV-1", voucherDate: "2026-01-10",
  recipientScope: "INDIVIDUAL", financialScopeKey: "individual:worker-1", labourerId: "worker-1", labourGroupId: null,
  recipientSnapshot: { labourerName: "Historical worker" }, description: "Legacy advance", originalAmount: 1_000,
  appliedAmount: 0, refundedAmount: 0, paymentAccountId: null, paymentAccountName: "Partner Younis", status: "POSTED",
  createdAt: "2026-01-10T10:00:00Z", sourceKind: "LEGACY_OPERATIONAL", ...overrides,
});

test("legacy individual, group, leader-received, partner-funded and deactivated-recipient snapshots remain readable", () => {
  const individual = legacyAdvancePosition(row());
  const group = legacyAdvancePosition(row({ id: "legacy-operational:2", sourceId: "2", recipientScope: "LABOUR_GROUP", financialScopeKey: "group:g1", labourerId: null, labourGroupId: "g1", recipientSnapshot: { labourGroupName: "Harvest Team", receivedBy: "Old leader" } }));
  assert.equal(individual.recipientSnapshot.labourerName, "Historical worker");
  assert.equal(individual.paymentAccountName, "Partner Younis");
  assert.equal(group.financialScopeKey, "group:g1");
  assert.equal(group.recipientSnapshot.receivedBy, "Old leader");
});

test("remaining balance uses original minus applications, refunds, and reversals", () => {
  assert.equal(legacyAdvancePosition(row({ appliedAmount: 300 })).outstandingAmount, 700);
  assert.equal(legacyAdvancePosition(row({ refundedAmount: 250 })).outstandingAmount, 750);
  assert.equal(legacyAdvancePosition(row({ appliedAmount: 300, refundedAmount: 200 })).outstandingAmount, 500);
  assert.equal(legacyAdvancePosition(row({ status: "VOIDED" })).outstandingAmount, 0);
});

test("canonical coverage prevents a legacy advance from appearing twice and sorting is newest first", () => {
  const canonical = [{ sourceId: "legacy-client-1", legacySourceRecordId: "1", voucherDate: "2026-01-11", createdAt: new Date("2026-01-11"), status: "POSTED", outstandingAmount: 500 }];
  const duplicate = legacyAdvancePosition(row());
  const distinct = legacyAdvancePosition(row({ id: "legacy-operational:2", sourceId: "2", voucherDate: "2026-01-12" }));
  const merged = mergeAdvancePositions(canonical, [duplicate, distinct]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0]?.sourceId, "2");
});

test("similar-looking records are not merged unless a stable legacy or source id matches", () => {
  const canonical = [{ sourceId: "canonical-client-1", legacySourceRecordId: null, voucherDate: "2026-01-10", createdAt: new Date("2026-01-10"), status: "POSTED", outstandingAmount: 700 }];
  const sameDisplay = legacyAdvancePosition(row({
    id: "legacy-operational:display-twin",
    sourceId: "legacy-display-twin",
    voucherNumber: "ADV-1",
    voucherDate: "2026-01-10",
    originalAmount: 1_000,
    recipientSnapshot: { labourerName: "Historical worker" },
  }));
  const merged = mergeAdvancePositions(canonical, [sameDisplay]);
  assert.equal(merged.length, 2);
  assert.equal(merged[1]?.sourceId, "legacy-display-twin");
});

test("canonical coverage also suppresses legacy normalized mirrors linked by preserved source id", () => {
  const canonical = [{ sourceId: "legacy-normalized-client-1", legacySourceRecordId: null, voucherDate: "2026-01-11", createdAt: new Date("2026-01-11"), status: "POSTED", outstandingAmount: 500 }];
  const normalizedMirror = legacyAdvancePosition(row({ id: "legacy-normalized:1", sourceId: "legacy-normalized-client-1", sourceKind: "LEGACY_NORMALIZED" }));
  const merged = mergeAdvancePositions(canonical, [normalizedMirror]);
  assert.equal(merged.length, 1);
});
