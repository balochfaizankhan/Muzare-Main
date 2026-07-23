import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { parseSarMinorUnits, sarFromMinorUnits } from "../src/lib/money.js";

const route = readFileSync(new URL("../src/routes/labour-payments.ts", import.meta.url), "utf8");
const page = readFileSync(new URL("../../web/src/pages/workspace/WorkforcePayments.tsx", import.meta.url), "utf8");

test("direct due SAR values normalize without decimal truncation", () => {
  for (const [input, expected] of [[7107.5, 710750], ["7107.50", 710750], ["0.00", 0], ["25.50", 2550], ["0.10", 10]] as const) {
    const result = parseSarMinorUnits(input);
    assert.equal(result.success, true);
    if (result.success) assert.equal(result.minorUnits, expected);
  }
  assert.equal(sarFromMinorUnits(710750), 7107.5);
});

test("direct due SAR normalization rejects unsupported precision and invalid values", () => {
  for (const input of ["100.001", "", null, undefined, Number.NaN])
    assert.equal(parseSarMinorUnits(input).success, false);
});

test("deduction comparisons use the same minor-unit representation", () => {
  const gross = parseSarMinorUnits("100.00");
  const lower = parseSarMinorUnits("25.50");
  const equal = parseSarMinorUnits("100");
  const greater = parseSarMinorUnits("100.01");
  assert.ok(gross.success && lower.success && equal.success && greater.success);
  if (gross.success && lower.success && equal.success && greater.success) {
    assert.ok(lower.minorUnits < gross.minorUnits);
    assert.equal(equal.minorUnits, gross.minorUnits);
    assert.ok(greater.minorUnits > gross.minorUnits);
  }
});

test("direct due contract accepts canonical historical IDs and returns field errors", () => {
  const schema = route.slice(route.indexOf("const directDueSchema"), route.indexOf("const sarAmountSchema"));
  assert.match(schema, /labourerId: z\.string\(\)\.trim\(\)\.min\(1\)\.max\(200\)/);
  assert.doesNotMatch(schema, /labourerId: z\.string\(\)\.uuid/);
  assert.match(schema, /agreedGrossAmount: moneyMinorUnitsSchema/);
  assert.match(schema, /Deductions cannot exceed the agreed amount/);
  assert.match(route, /Please correct the highlighted fields/);
});

test("direct due UI submits canonical IDs and canonical money fields", () => {
  const form = page.slice(page.indexOf("function DirectDueForm"), page.indexOf("function VoucherRegister"));
  assert.match(form, /labourerId: scope === "INDIVIDUAL" \? labourerId : null/);
  assert.match(form, /agreedGrossAmount,/);
  assert.match(form, /authorizedDeductions: authorizedDeductions \|\| "0\.00"/);
  assert.doesNotMatch(form, /parseInt/);
  assert.doesNotMatch(form, /createLabourEarning|createLabourWageSettlement|paymentAccountId/);
});

test("no-specific-recipient uses one canonical crew identity with optional contact", () => {
  const schema = route.slice(route.indexOf("const directDueSchema"), route.indexOf("const sarAmountSchema"));
  const form = page.slice(page.indexOf("function DirectDueForm"), page.indexOf("function VoucherRegister"));
  assert.match(schema, /recipientReference: z\.string\(\)\.trim\(\)\.max\(200\)/);
  assert.match(schema, /path: \["recipientReference"\], message: "Enter a crew or reference name\."/);
  assert.match(schema, /recipientReference: value\.recipientReference \|\| value\.crewReference \|\| value\.contractorReference \|\| value\.batchIdentity/);
  assert.match(form, /workforcePaymentsPage\.crewReferenceName/);
  assert.match(form, /workforcePaymentsPage\.contactPersonOptional/);
  assert.match(form, /recipientReference: !\["INDIVIDUAL", "LABOUR_GROUP"\]\.includes\(scope\) \? reference : null/);
  assert.doesNotMatch(form, />Batch identity</);
  assert.match(form, /className=\{fieldErrors\.recipientReference \? "has-error"/);
  assert.match(form, /Object\.values\(responseErrors\)\[0\]/);
});
