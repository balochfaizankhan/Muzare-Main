import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildAdvancePoolLedger,
  buildMembershipDirectory,
  dueAdvancePoolPosition,
  type AdvancePoolApplicationRow,
  type AdvancePoolVoucherRow,
} from "../src/lib/labour-advance-pools.js";

const labourer = (id: string, payload: Record<string, unknown> = {}) => ({
  clientRecordId: id,
  payload: { name: `Labourer ${id}`, ...payload },
});
const group = (id: string, payload: Record<string, unknown> = {}) => ({
  clientRecordId: id,
  payload: { name: `Group ${id}`, ...payload },
});
let sequence = 0;
const voucher = (input: Partial<AdvancePoolVoucherRow>): AdvancePoolVoucherRow => ({
  id: input.id ?? `voucher-${++sequence}`,
  voucherNumber: input.voucherNumber ?? `LAV-${String(sequence).padStart(4, "0")}`,
  voucherDate: input.voucherDate ?? "2026-07-01",
  nature: input.nature ?? "ADVANCE",
  status: input.status ?? "POSTED",
  description: input.description ?? "Advance",
  paymentAmount: input.paymentAmount ?? 0,
  paymentAccountId: input.paymentAccountId ?? null,
  labourerId: input.labourerId ?? null,
  labourGroupId: input.labourGroupId ?? null,
  financialScopeKey: input.financialScopeKey ?? "legacy:none",
  recipientScope: input.recipientScope ?? "INDIVIDUAL",
  recipientSnapshot: input.recipientSnapshot ?? {},
  relatedAdvanceVoucherId: input.relatedAdvanceVoucherId ?? null,
  reversalReference: input.reversalReference ?? null,
  createdAt: null,
});
const application = (input: Partial<AdvancePoolApplicationRow>): AdvancePoolApplicationRow => ({
  id: input.id ?? `application-${++sequence}`,
  amount: input.amount ?? 0,
  status: input.status ?? "ACTIVE",
  createdAt: input.createdAt ?? new Date("2026-07-10T00:00:00Z"),
  reversedAt: input.reversedAt ?? null,
  dueId: input.dueId ?? `due-${sequence}`,
  dueNumber: input.dueNumber ?? `LPD-${String(sequence).padStart(4, "0")}`,
  dueRecipientScope: input.dueRecipientScope ?? "LABOUR_GROUP",
  dueLabourGroupId: input.dueLabourGroupId ?? null,
  dueLabourerId: input.dueLabourerId ?? null,
  dueFinancialScopeKey: input.dueFinancialScopeKey ?? "",
  dueRecipientSnapshot: input.dueRecipientSnapshot ?? {},
});

const saleemDirectory = () => buildMembershipDirectory(
  [
    labourer("L-LEAD"),
    labourer("L-A", { groupId: "G-SALEEM" }),
    labourer("L-B", { groupId: "G-SALEEM" }),
    labourer("L-FREE"),
  ],
  [group("G-SALEEM", { name: "SALEEM", foremanLabourId: "L-LEAD" })],
);

test("advances for multiple current members plus group-directed vouchers combine into one group pool", () => {
  const ledger = buildAdvancePoolLedger(saleemDirectory(), [
    voucher({ labourerId: "L-A", paymentAmount: 20_000 }),
    voucher({ labourerId: "L-B", paymentAmount: 10_000 }),
    voucher({ labourerId: "L-LEAD", paymentAmount: 5_000 }),
    voucher({ labourGroupId: "G-SALEEM", recipientScope: "LABOUR_GROUP", financialScopeKey: "group:G-SALEEM", paymentAmount: 15_000 }),
    voucher({ labourerId: "L-FREE", paymentAmount: 999 }),
  ], []);
  const pool = ledger.pools.get("group:G-SALEEM")!;
  assert.equal(pool.totalAdvances, 50_000);
  assert.equal(pool.voucherCount, 4);
  assert.equal(pool.availableAdvances, 50_000);
  assert.equal(pool.memberCount, 3); // two members + the leader
  assert.equal(ledger.pools.get("individual:L-FREE")?.totalAdvances, 999);
});

test("a group settlement consumes one aggregate pool amount and the cash payable math never goes negative", () => {
  // Group earnings 70,000; combined pool 50,000 → apply 50,000, pay 20,000.
  const ledger = buildAdvancePoolLedger(saleemDirectory(), [
    voucher({ labourerId: "L-A", paymentAmount: 30_000 }),
    voucher({ labourerId: "L-B", paymentAmount: 20_000 }),
  ], [
    application({ amount: 50_000, dueRecipientScope: "LABOUR_GROUP", dueLabourGroupId: "G-SALEEM" }),
  ]);
  const pool = ledger.pools.get("group:G-SALEEM")!;
  assert.equal(pool.appliedAdvances, 50_000);
  assert.equal(pool.availableAdvances, 0);
  // No per-voucher rows exist anywhere in this model: the application is one
  // pool-level amount, attributed to the due's pool only.
  assert.equal(ledger.activity.filter((event) => event.type === "APPLIED_TO_DUE").length, 1);
});

test("when advances exceed earnings the unapplied balance carries forward in the pool", () => {
  const directory = saleemDirectory();
  const ledger = buildAdvancePoolLedger(directory, [
    voucher({ labourerId: "L-A", paymentAmount: 50_000 }),
  ], [
    application({ amount: 40_000, dueRecipientScope: "LABOUR_GROUP", dueLabourGroupId: "G-SALEEM" }),
  ]);
  assert.equal(ledger.pools.get("group:G-SALEEM")!.availableAdvances, 10_000);
  // A due of 40,000 fully settled by advances leaves zero cash payable and
  // the 10,000 remains available for the next settlement.
  const due = { recipientScope: "LABOUR_GROUP", labourGroupId: "G-SALEEM", labourerId: null, financialScopeKey: "group:G-SALEEM" };
  assert.equal(dueAdvancePoolPosition(ledger, due).availableAdvances, 10_000);
});

test("pool-level recovery reduces the available balance without touching any voucher", () => {
  const ledger = buildAdvancePoolLedger(saleemDirectory(), [
    voucher({ labourerId: "L-A", paymentAmount: 30_000 }),
    voucher({
      nature: "REFUND_RECOVERY",
      labourGroupId: "G-SALEEM",
      recipientScope: "LABOUR_GROUP",
      financialScopeKey: "group:G-SALEEM",
      paymentAmount: 10_000,
      description: "Advance recovery from SALEEM",
    }),
  ], []);
  const pool = ledger.pools.get("group:G-SALEEM")!;
  assert.equal(pool.recoveredAdvances, 10_000);
  assert.equal(pool.availableAdvances, 20_000);
  assert.equal(pool.totalAdvances, 30_000);
});

test("voided advance vouchers are excluded from totals but stay visible as recorded+reversed activity", () => {
  const original = voucher({ id: "voided-1", labourerId: "L-A", paymentAmount: 500, status: "VOIDED" });
  const ledger = buildAdvancePoolLedger(saleemDirectory(), [
    original,
    voucher({ nature: "REVERSAL", reversalReference: "voided-1", paymentAmount: 500 }),
    voucher({ labourerId: "L-A", paymentAmount: 1_000 }),
  ], []);
  const pool = ledger.pools.get("group:G-SALEEM")!;
  assert.equal(pool.totalAdvances, 1_000);
  assert.equal(pool.voucherCount, 1);
  assert.ok(ledger.activity.some((event) => event.type === "VOUCHER_REVERSED" && event.amount === 500));
});

test("a posted group settlement stays attached to its group while the vouchers follow the departing member", () => {
  const vouchers = [voucher({ labourerId: "L-A", paymentAmount: 30_000 })];
  const applications = [application({ amount: 30_000, dueRecipientScope: "LABOUR_GROUP", dueLabourGroupId: "G-SALEEM" })];
  const after = buildMembershipDirectory(
    [labourer("L-A", { groupId: "G-OTHER" })],
    [group("G-SALEEM", { name: "SALEEM" }), group("G-OTHER")],
  );
  const ledger = buildAdvancePoolLedger(after, vouchers, applications);
  // The application never moves: SALEEM keeps the historical consumption and
  // reports the signed shortfall instead of clamping it to zero...
  assert.equal(ledger.pools.get("group:G-SALEEM")!.appliedAdvances, 30_000);
  assert.equal(ledger.pools.get("group:G-SALEEM")!.availableAdvances, -30_000);
  // ...and no further application is possible against the negative pool.
  const due = { recipientScope: "LABOUR_GROUP", labourGroupId: "G-SALEEM", labourerId: null, financialScopeKey: "group:G-SALEEM" };
  assert.equal(dueAdvancePoolPosition(ledger, due).availableAdvances, -30_000);
  // The voucher itself now funds the new group's pool.
  assert.equal(ledger.pools.get("group:G-OTHER")!.totalAdvances, 30_000);
});

test("an individual due's application follows the labourer's current pool", () => {
  const directory = saleemDirectory();
  const ledger = buildAdvancePoolLedger(directory, [
    voucher({ labourerId: "L-A", paymentAmount: 5_000 }),
  ], [
    application({ amount: 2_000, dueRecipientScope: "INDIVIDUAL", dueLabourerId: "L-A", dueFinancialScopeKey: "individual:L-A" }),
  ]);
  assert.equal(ledger.pools.get("group:G-SALEEM")!.appliedAdvances, 2_000);
  assert.equal(ledger.pools.get("group:G-SALEEM")!.availableAdvances, 3_000);
});

test("the settlement-date rule excludes only vouchers dated after the settlement", () => {
  const ledger = buildAdvancePoolLedger(saleemDirectory(), [
    voucher({ labourerId: "L-A", paymentAmount: 1_000, voucherDate: "2026-07-01" }),
    voucher({ labourerId: "L-A", paymentAmount: 700, voucherDate: "2026-08-01" }),
  ], []);
  const due = { recipientScope: "LABOUR_GROUP", labourGroupId: "G-SALEEM", labourerId: null, financialScopeKey: "group:G-SALEEM" };
  assert.equal(dueAdvancePoolPosition(ledger, due, "2026-07-15").availableAdvances, 1_000);
  assert.equal(dueAdvancePoolPosition(ledger, due).availableAdvances, 1_700);
});

test("a reversed application restores the pool and appears as its own activity", () => {
  const ledger = buildAdvancePoolLedger(saleemDirectory(), [
    voucher({ labourerId: "L-A", paymentAmount: 10_000 }),
  ], [
    application({ amount: 4_000, status: "REVERSED", reversedAt: new Date("2026-07-12T00:00:00Z"), dueRecipientScope: "LABOUR_GROUP", dueLabourGroupId: "G-SALEEM" }),
  ]);
  assert.equal(ledger.pools.get("group:G-SALEEM")!.availableAdvances, 10_000);
  assert.ok(ledger.activity.some((event) => event.type === "APPLICATION_REVERSED" && event.amount === 4_000));
});

test("farm-wide metric totals equal the sum of every pool — one canonical calculation for cards and summary", () => {
  const ledger = buildAdvancePoolLedger(saleemDirectory(), [
    voucher({ labourerId: "L-A", paymentAmount: 8_000 }),
    voucher({ labourerId: "L-FREE", paymentAmount: 2_000 }),
  ], [
    application({ amount: 1_500, dueRecipientScope: "LABOUR_GROUP", dueLabourGroupId: "G-SALEEM" }),
  ]);
  assert.equal(ledger.farmWide.totalAdvances, 10_000);
  assert.equal(ledger.farmWide.appliedAdvances, 1_500);
  assert.equal(ledger.farmWide.availableAdvances, 8_500);
});
