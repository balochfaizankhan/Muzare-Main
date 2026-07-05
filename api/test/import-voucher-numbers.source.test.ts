import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { canonicalImportedVoucherNumber, resolveVoucherPayloadForWrite } from "../src/lib/import-voucher-numbers.js";

test("canonicalImportedVoucherNumber prefers Android original voucher numbers over stale generated values", () => {
  assert.equal(canonicalImportedVoucherNumber({
    voucherNumber: "V-0132",
    originalVoucherNumber: "V-0141",
    legacyVoucherNumber: "V-0141",
  }), "V-0141");
});

test("canonicalImportedVoucherNumber falls back to the stored voucher number when no Android original is present", () => {
  assert.equal(canonicalImportedVoucherNumber({
    voucherNumber: "V-0201",
  }), "V-0201");
});

test("canonicalImportedVoucherNumber returns an empty string when no usable voucher number exists", () => {
  assert.equal(canonicalImportedVoucherNumber({ voucherNumber: "   " }), "");
});

test("resolveVoucherPayloadForWrite keeps canonical Android voucher number when stale cache retries without explicit edit", () => {
  const result = resolveVoucherPayloadForWrite({
    incomingPayload: {
      source_type: "expense",
      voucherNumber: "V-0132",
      originalVoucherNumber: "V-0141",
      legacyVoucherNumber: "V-0141",
    },
    existingPayload: {
      source_type: "expense",
      voucherNumber: "V-0141",
      originalVoucherNumber: "V-0141",
      legacyVoucherNumber: "V-0141",
    },
    sourceType: "expense",
    requestedVoucherNumber: "V-0132",
  });
  assert.equal(result.resolvedVoucherNumber, "V-0141");
  assert.equal(result.nextPayload.voucherNumber, "V-0141");
  assert.equal(result.nextPayload.voucherNumberEdited, false);
});

test("resolveVoucherPayloadForWrite allows explicit imported voucher renumber edits", () => {
  const result = resolveVoucherPayloadForWrite({
    incomingPayload: {
      source_type: "expense",
      voucherNumber: "V-0200",
      originalVoucherNumber: "V-0141",
      legacyVoucherNumber: "V-0141",
      allowVoucherNumberEdit: true,
    },
    existingPayload: {
      source_type: "expense",
      voucherNumber: "V-0141",
      originalVoucherNumber: "V-0141",
      legacyVoucherNumber: "V-0141",
    },
    sourceType: "expense",
    requestedVoucherNumber: "V-0200",
  });
  assert.equal(result.resolvedVoucherNumber, "V-0200");
  assert.equal(result.nextPayload.voucherNumber, "V-0200");
  assert.equal(result.nextPayload.originalVoucherNumber, "V-0141");
  assert.equal(result.nextPayload.voucherNumberEdited, true);
});

test("normal expense voucher duplicate checks ignore labour wage settlement vouchers", () => {
  const voucherNumberSource = readFileSync(new URL("../src/lib/voucher-numbers.ts", import.meta.url), "utf8");
  const syncRouteSource = readFileSync(new URL("../src/routes/operational-sync.ts", import.meta.url), "utf8");
  assert.ok(voucherNumberSource.includes("voucherPurpose', '') <> 'labour_wage_settlement'"));
  assert.ok(voucherNumberSource.includes("nonCashSettlement', 'false') <> 'true'"));
  assert.ok(voucherNumberSource.includes("ignoredForExpenseVoucherNumbering', 'false') <> 'true'"));
  assert.ok(voucherNumberSource.includes("recalculateExpenseVoucherSequences"));
  assert.ok(syncRouteSource.includes("normalExpenseVoucherWhereSql()"));
});
