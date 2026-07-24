import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { calculateAdvancePosition, calculateLabourDuePosition, labourFinancialScopeKey } from "../src/lib/labour-payments.js";

const routeSource = readFileSync(new URL("../src/routes/labour-payments.ts", import.meta.url), "utf8");
const paymentServiceSource = readFileSync(new URL("../src/lib/labour-payments.ts", import.meta.url), "utf8");
const settlementRouteSource = readFileSync(new URL("../src/routes/labour-wage-settlements.ts", import.meta.url), "utf8");
const migrationSource = readFileSync(new URL("../../database/migrations/0035_unified_labour_payments.sql", import.meta.url), "utf8");
const groupPoolGuardMigration = readFileSync(new URL("../../database/migrations/0039_group_due_member_advance_applications.sql", import.meta.url), "utf8");
const legacyIndividualGuardMigration = readFileSync(new URL("../../database/migrations/0040_legacy_individual_advance_application_scope.sql", import.meta.url), "utf8");
const startupMigrationSource = readFileSync(new URL("../src/db/migrations.ts", import.meta.url), "utf8");

test("the group-member advance guard migration runs during API startup", () => {
  assert.match(startupMigrationSource, /0039_group_due_member_advance_applications\.sql/);
  assert.match(startupMigrationSource, /key: "0039_group_due_member_advance_applications"[\s\S]*required: true/);
  assert.match(startupMigrationSource, /0040_legacy_individual_advance_application_scope\.sql/);
  assert.match(startupMigrationSource, /key: "0040_legacy_individual_advance_application_scope"[\s\S]*required: true/);
});

test("attendance settlement creation is retired; historical dues keep the unpaid-by-default contract", () => {
  // The former create flow (the only caller of ensureSettlementLabourDue)
  // now rejects with the clear retirement message and never moves cash.
  assert.match(settlementRouteSource, /ATTENDANCE_DUES_RETIRED_MESSAGE/);
  assert.match(migrationSource, /payment_status text NOT NULL DEFAULT 'UNPAID'/);
});

test("due position supports unpaid, partial, cash-paid, advance-only, and mixed clearing", () => {
  assert.deepEqual(calculateLabourDuePosition({ grossAmount: 50_000 }), {
    grossAmount: 50_000, adjustmentAmount: 0, authorizedDeductions: 0, payableAmount: 50_000,
    previousPayments: 0, advancesApplied: 0, outstandingBalance: 50_000, paymentStatus: "UNPAID",
  });
  assert.equal(calculateLabourDuePosition({ grossAmount: 50_000, advancesApplied: 20_000, previousPayments: 10_000 }).outstandingBalance, 20_000);
  assert.equal(calculateLabourDuePosition({ grossAmount: 50_000, advancesApplied: 20_000, previousPayments: 10_000 }).paymentStatus, "PARTIALLY_SETTLED");
  assert.equal(calculateLabourDuePosition({ grossAmount: 50_000, advancesApplied: 50_000 }).paymentStatus, "SETTLED_BY_ADVANCE");
  assert.equal(calculateLabourDuePosition({ grossAmount: 50_000, advancesApplied: 20_000, previousPayments: 30_000 }).paymentStatus, "PAID");
});

test("authorized deductions reduce payable without overwriting original gross", () => {
  const result = calculateLabourDuePosition({ grossAmount: 12_000, adjustmentAmount: 500, authorizedDeductions: 1_000 });
  assert.equal(result.grossAmount, 12_000);
  assert.equal(result.payableAmount, 11_500);
  assert.equal(result.outstandingBalance, 11_500);
});

test("advance position supports partial applications, multi-due carry-forward, excess, and refunds", () => {
  assert.deepEqual(calculateAdvancePosition({ originalAmount: 20_000, appliedAmount: 7_500 }), {
    originalAmount: 20_000, appliedAmount: 7_500, refundedAmount: 0,
    outstandingAmount: 12_500, advanceStatus: "PARTIALLY_APPLIED",
  });
  assert.equal(calculateAdvancePosition({ originalAmount: 20_000, appliedAmount: 7_500, refundedAmount: 2_500 }).outstandingAmount, 10_000);
  assert.equal(calculateAdvancePosition({ originalAmount: 20_000, appliedAmount: 20_000 }).advanceStatus, "FULLY_APPLIED");
  assert.equal(calculateAdvancePosition({ originalAmount: 20_000, refundedAmount: 20_000 }).advanceStatus, "FULLY_REFUNDED");
});

test("financial scope prevents a leader personal advance from clearing a group due", () => {
  const person = labourFinancialScopeKey({ recipientScope: "INDIVIDUAL", labourerId: "leader-1" });
  const group = labourFinancialScopeKey({ recipientScope: "LABOUR_GROUP", labourGroupId: "group-1" });
  assert.notEqual(person, group);
  assert.equal(group, labourFinancialScopeKey({ recipientScope: "LABOUR_GROUP", labourGroupId: "group-1", labourerId: "leader-1" }));
});

test("unnamed labour advances require a stable settlement identity", () => {
  assert.throws(() => labourFinancialScopeKey({ recipientScope: "UNREGISTERED_LABOUR" }), /stable recipient/i);
  assert.equal(labourFinancialScopeKey({ recipientScope: "UNREGISTERED_LABOUR", crewReference: "Onion Loading Crew" }), "unregistered:onion loading crew");
});

test("temporary and no-specific dues use canonical recipient references", () => {
  assert.equal(labourFinancialScopeKey({ recipientScope: "NO_SPECIFIC_RECIPIENT", recipientReference: "  lagah team  " }), "batch:lagah team");
  assert.equal(labourFinancialScopeKey({ recipientScope: "TEMPORARY_CREW", recipientReference: "February pruning workers" }), "crew:february pruning workers");
});

test("posting paths are transactional, locked, idempotent, account-linked, and allocation-based", () => {
  assert.match(routeSource, /db\.transaction/);
  assert.match(routeSource, /pg_advisory_xact_lock/);
  assert.match(routeSource, /labourPaymentVouchers\.idempotencyKey/);
  assert.match(routeSource, /labourPaymentAllocations/);
  assert.match(routeSource, /labourAdvanceApplications/);
  assert.match(routeSource, /insertAccountMovement/);
  assert.match(routeSource, /Payment exceeds the current outstanding due balance/);
  assert.match(routeSource, /of the combined advance pool is currently available/);
});

test("voucher voiding restores allocations and blocks unsafe advance void order", () => {
  assert.match(routeSource, /Reverse active advance applications before voiding this advance voucher/);
  assert.match(routeSource, /status: "REVERSED"/);
  assert.match(routeSource, /refreshLabourDuePaymentStatus/);
  assert.match(routeSource, /nature !== "REFUND_RECOVERY"/);
});

test("migration maps historical records without replaying cash and enforces normalized integrity", () => {
  assert.match(migrationSource, /No account transaction is inserted by this migration/i);
  assert.match(migrationSource, /ON CONFLICT ON CONSTRAINT labour_payment_vouchers_legacy_source_nature_key DO NOTHING/);
  assert.match(migrationSource, /CHECK \(amount > 0\)/);
  assert.match(migrationSource, /labour_advance_applications_workspace_idempotency_key UNIQUE\(workspace_id, idempotency_key\)/);
  assert.match(migrationSource, /labour_payment_vouchers_workspace_farm_number_uidx/);
  assert.match(migrationSource, /CREATE TABLE IF NOT EXISTS labour_accounting_entries/);
  assert.match(migrationSource, /labour_payment_allocation_guard/);
  assert.match(migrationSource, /labour_advance_application_guard/);
  assert.match(migrationSource, /labour_advance_refund_guard/);
});

test("labour subledger distinguishes expense, payable, advance, cash, and partner liability", () => {
  for (const ledger of ["LABOUR_EXPENSE", "LABOUR_PAYABLE", "LABOUR_ADVANCE", "CASH_CONTROL", "PARTNER_PAYABLE"]) {
    assert.match(migrationSource, new RegExp(ledger));
  }
  assert.match(routeSource, /postLabourDueRecognition/);
  assert.match(routeSource, /postLabourAdvanceApplicationJournal/);
  assert.match(routeSource, /postLabourVoucherJournal/);
  assert.match(routeSource, /reverseLabourJournal/);
});

test("advance issuance and due payments use distinct business voucher registers", () => {
  assert.match(routeSource, /allocateLabourAdvanceVoucherNumber/);
  assert.match(paymentServiceSource, /return `LAV-\$\{String\(next\)\.padStart\(4, "0"\)\}`/);
  assert.match(paymentServiceSource, /return `LAR-\$\{String\(next\)\.padStart\(4, "0"\)\}`/);
  assert.match(routeSource, /nature: "ADVANCE"/);
  assert.match(routeSource, /nature} not in \('ADVANCE', 'REFUND_RECOVERY'\)/);
  assert.match(routeSource, /original\.nature in \('ADVANCE', 'REFUND_RECOVERY'\)/);
  assert.match(routeSource, /allocateLabourPaymentVoucherNumber/);
  assert.match(routeSource, /allocateLabourAdvanceAdjustmentNumber/);
  assert.match(routeSource, /if \(input\.payment\)/);
});

test("database guard accepts only immutable snapshot members for group advance pooling", () => {
  assert.match(groupPoolGuardMigration, /target_due\.recipient_scope = 'LABOUR_GROUP'/);
  assert.match(groupPoolGuardMigration, /FROM labour_due_member_snapshots member/);
  assert.match(groupPoolGuardMigration, /member\.labourer_id = target_advance\.labourer_id/);
  assert.match(groupPoolGuardMigration, /other_applications \+ refunds \+ NEW\.amount > target_advance\.payment_amount/);
  assert.match(groupPoolGuardMigration, /due_payments \+ due_advances \+ NEW\.amount > payable/);
  assert.match(routeSource, /advance_application_insert_batch_/);
  assert.match(routeSource, /sqlState/);
});

test("database guard resolves legacy individual advance ownership from immutable voucher identity", () => {
  assert.match(legacyIndividualGuardMigration, /effective_advance_scope := target_advance\.financial_scope_key/);
  assert.match(legacyIndividualGuardMigration, /effective_advance_scope LIKE 'legacy:%'/);
  assert.match(legacyIndividualGuardMigration, /target_advance\.recipient_snapshot->>'labourerId'/);
  assert.match(legacyIndividualGuardMigration, /'individual:' \|\| snapshot_labourer_id/);
  assert.match(legacyIndividualGuardMigration, /scope_is_eligible := effective_advance_scope = target_due\.financial_scope_key/);
  assert.doesNotMatch(legacyIndividualGuardMigration, /FROM labourers/);
});
