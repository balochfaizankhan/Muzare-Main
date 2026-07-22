import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = (relativePath: string) => readFile(new URL(`../../${relativePath}`, import.meta.url), "utf8");

test("partner ledger reconciliation modal sources purchase vouchers and funds received from the canonical merged partner position", async () => {
  const modulePage = await source("web/src/pages/ModulePage.tsx");
  const overviewBody = modulePage.match(/const rawPartnerLedgerOverview = useMemo\(\(\) => \{[\s\S]*?\n {2}\}, \[[^\]]*\]\);/);
  assert.ok(overviewBody, "rawPartnerLedgerOverview useMemo block should exist");
  const body = overviewBody![0];

  assert.match(
    body,
    /const cardPosition = mergedPartnerPositionsByAccountId\.get\(canonicalAccountId\) \?\? mergedPartnerPositionsByAccountId\.get\(selectedAccount\.id\);/,
    "reconciliation overview must look up the canonical merged partner position (the same source the accounts-page cards use)",
  );
  assert.match(
    body,
    /overview\.purchaseVouchersPaid = cardPosition\?\.purchaseVouchersPaid \?\? overview\.purchaseVouchersPaid;/,
    "Purchase vouchers must be overridden from the canonical merged position, not left as the tag-summed (and easily zeroed) ledger-row total",
  );
  assert.match(
    body,
    /overview\.transfersIn = cardPosition\?\.transfersIn \?\? overview\.transfersIn;/,
    "Business Funds Received (transfersIn) must be overridden from the canonical merged position",
  );

  assert.match(body, /\[ledgerRows, selectedPartnerSnapshot, selectedAccount, selectedDisplayAccount\?\.canonicalAccountId, mergedPartnerPositionsByAccountId\]/);
});

test("partner ledger reconciliation modal keeps funds-received partner-only (transfersIn comes from partner settlement transfers only)", async () => {
  const partnerAccounting = await source("web/src/lib/partnerAccounting.ts");
  assert.match(
    partnerAccounting,
    /transfersIn: fundsReceived,/,
    "transfersIn on a partner position must be fundsReceived, which is derived only from partner-ledger settlement entries",
  );
  assert.match(
    partnerAccounting,
    /direction: "given" \| "received" \| "other" = entry\.type === "settlement"/,
    "fundsReceived direction classification must originate from partner settlement entries, not general vouchers or sales",
  );
});
