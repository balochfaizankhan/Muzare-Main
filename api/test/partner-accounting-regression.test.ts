import assert from "node:assert/strict";
import { test } from "node:test";
import { getPartnerAccountingSnapshot } from "../../web/src/lib/partnerAccounting";

const accounts = [
  { id: "79a51f57-f255-49a6-a9f3-b936c9842927", name: "Younis Khan", type: "partner", oldAndroidId: "2", sourceType: "operational_account_repair" },
  { id: "7d6d2f66-7d7c-4dbf-9d3b-111111111111", name: "Sajid Khan", type: "partner", oldAndroidId: "3", sourceType: "operational_account_repair" },
  { id: "5a7a1d66-7d7c-4dbf-9d3b-222222222222", name: "Saloom & Algaith", type: "partner", oldAndroidId: "6", sourceType: "operational_account_repair" },
];

test("partner accounting snapshot keeps legacy null-scoped business funds and labour settlements in the selected farm view", () => {
  const sales = [];
  const vouchers = [];
  const advances = [
    {
      id: "advance-1",
      date: "2026-07-05",
      amount: 142743,
      accountId: "android:legacy:account:2",
      sourceAccountName: null,
      farmId: null,
      seasonId: null,
      deletedAt: null,
      status: "posted",
    },
  ];
  const partnerEntries = [
    {
      id: "entry-1",
      type: "settlement",
      date: "2026-07-01",
      amount: 30000,
      fromAccountId: "android:legacy:partner:6",
      toAccountId: "android:legacy:partner:2",
      fromPartner: "Saloom & Algaith",
      toPartner: "Younis Khan",
      accountId: null,
      partnerAccountId: null,
      farmId: null,
      seasonId: null,
      deletedAt: null,
      status: "posted",
    },
    {
      id: "entry-2",
      type: "settlement",
      date: "2026-07-02",
      amount: 15000,
      fromAccountId: "android:legacy:partner:6",
      toAccountId: "android:legacy:partner:2",
      fromPartner: "Saloom & Algaith",
      toPartner: "Younis Khan",
      accountId: null,
      partnerAccountId: null,
      farmId: null,
      seasonId: null,
      deletedAt: null,
      status: "posted",
    },
    {
      id: "entry-3",
      type: "settlement",
      date: "2026-07-03",
      amount: 13000,
      fromAccountId: "android:legacy:partner:6",
      toAccountId: "android:legacy:partner:2",
      fromPartner: "Saloom & Algaith",
      toPartner: "Younis Khan",
      accountId: null,
      partnerAccountId: null,
      farmId: null,
      seasonId: null,
      deletedAt: null,
      status: "posted",
    },
    {
      id: "entry-4",
      type: "settlement",
      date: "2026-07-04",
      amount: 20000,
      fromAccountId: "android:legacy:partner:6",
      toAccountId: "android:legacy:partner:2",
      fromPartner: "Saloom & Algaith",
      toPartner: "Younis Khan",
      accountId: null,
      partnerAccountId: null,
      farmId: null,
      seasonId: null,
      deletedAt: null,
      status: "posted",
    },
    {
      id: "entry-5",
      type: "settlement",
      date: "2026-07-06",
      amount: 101140,
      fromAccountId: "android:legacy:partner:2",
      toAccountId: "android:legacy:partner:3",
      fromPartner: "Younis Khan",
      toPartner: "Sajid Khan",
      accountId: null,
      partnerAccountId: null,
      farmId: null,
      seasonId: null,
      deletedAt: null,
      status: "posted",
    },
  ];
  const settlements = [
    {
      id: "settlement-1",
      settlementNumber: "LW-0004",
      settlementDate: "2026-07-05",
      status: "posted",
      linkedAccountId: "android:legacy:partner:2",
      paymentAccountId: null,
      accountId: null,
      partnerAccountId: null,
      labourAccountId: null,
      totalEarned: 135042,
      advancesPaid: 135042,
      settledAdvanceAmount: 135042,
      cashPaid: 0,
      carryForwardAdvance: 7701,
      farmId: null,
      seasonId: null,
      deletedAt: null,
      voidedAt: null,
      reversedAt: null,
      accountingStatus: "posted",
    },
  ];

  const snapshot = getPartnerAccountingSnapshot(
    accounts[0] as never,
    sales as never,
    vouchers as never,
    advances as never,
    partnerEntries as never,
    settlements as never,
    accounts as never,
    { farmId: "613ab62b-d838-424b-a371-7b035af8452d", seasonId: "2026-season" },
  );

  assert.equal(snapshot.fundsReceived, 78000);
  assert.equal(snapshot.fundsGiven, 101140);
  assert.equal(snapshot.totalLabourAdvancesPaid, 142743);
  assert.equal(snapshot.labourAdvancesSettledThroughWageSettlements, 135042);
  assert.equal(snapshot.outstandingLabourAdvances, 7701);
  assert.equal(snapshot.labourSettlementCashPaid, 0);
  assert.equal(snapshot.labourSettlementNonCashApplied, 135042);
  assert.equal(snapshot.directExpensesPaid, 188495.5);
  assert.equal(snapshot.farmOwesPartner, 211635.5);
});
