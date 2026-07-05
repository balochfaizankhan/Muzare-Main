import assert from "node:assert/strict";
import { test } from "node:test";
import { validateLabourSettlementPaymentAccount } from "../src/lib/labour-settlement-account-validation.js";

const farmId = "613ab62b-d838-424b-a371-7b035af8452d";

test("labour settlement accepts partner settlement accounts", () => {
  const result = validateLabourSettlementPaymentAccount({
    id: "79a51f57-f255-49a6-a9f3-b936c9842927",
    farmId,
    name: "Younis Khan",
    accountType: "partner",
    active: true,
    oldAndroidId: "2",
    sourceType: "operational_account_repair",
  }, farmId);

  assert.equal(result.valid, true);
  assert.equal(result.reason, null);
  assert.equal(result.message, null);
});

test("labour settlement reports a missing payment account as unmapped", () => {
  const result = validateLabourSettlementPaymentAccount(null, farmId);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "not_mapped");
  assert.equal(result.message, "Payment account is not mapped. Please repair imported accounts.");
});

test("labour settlement reports wrong-farm settlement accounts clearly", () => {
  const result = validateLabourSettlementPaymentAccount({
    id: "acc-wrong-farm",
    farmId: "11111111-1111-1111-1111-111111111111",
    name: "Another Farm Account",
    accountType: "cash",
    active: true,
    oldAndroidId: null,
    sourceType: null,
  }, farmId);

  assert.equal(result.valid, false);
  assert.equal(result.reason, "wrong_farm");
  assert.equal(result.message, "Selected account belongs to another farm.");
});

test("labour settlement reports inactive accounts before other validation failures", () => {
  const result = validateLabourSettlementPaymentAccount({
    id: "acc-inactive",
    farmId,
    name: "Dormant Account",
    accountType: "partner",
    active: false,
    oldAndroidId: null,
    sourceType: null,
  }, farmId);

  assert.equal(result.valid, false);
  assert.equal(result.reason, "inactive");
  assert.equal(result.message, "Selected account is inactive.");
});

test("labour settlement rejects unsupported account types with the account type in the message", () => {
  const result = validateLabourSettlementPaymentAccount({
    id: "acc-unsupported",
    farmId,
    name: "Unsupported Account",
    accountType: "expense",
    active: true,
    oldAndroidId: null,
    sourceType: null,
  }, farmId, ["cash", "bank", "partner"]);

  assert.equal(result.valid, false);
  assert.equal(result.reason, "account_type");
  assert.equal(result.message, "Selected account type expense is not allowed for this action.");
});
