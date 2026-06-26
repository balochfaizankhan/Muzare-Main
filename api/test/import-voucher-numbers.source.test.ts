import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalImportedVoucherNumber } from "../src/lib/import-voucher-numbers.js";

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
