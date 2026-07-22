import type {
  accounts,
  accountTransactions,
  labourAccountingEntries,
  labourAdvanceApplications,
  labourDues,
  labourPaymentAllocations,
  labourPaymentVouchers,
} from "../db/schema.js";
import { calculateLabourDuePosition } from "./labour-payments.js";

type Account = typeof accounts.$inferSelect;
type AccountTransaction = typeof accountTransactions.$inferSelect;
type Journal = typeof labourAccountingEntries.$inferSelect;
type Application = typeof labourAdvanceApplications.$inferSelect;
type Due = typeof labourDues.$inferSelect;
type Allocation = typeof labourPaymentAllocations.$inferSelect;
type Voucher = typeof labourPaymentVouchers.$inferSelect;

export type LabourReconciliationFailure = {
  name: string;
  passed: false;
  sourceType: string;
  sourceId: string;
  originalJournalId?: string;
  reversalJournalId?: string;
  ledgerCode?: string;
  expected: string;
  actual: string;
  difference?: string;
  workspaceId: string;
  farmId: string;
  seasonId: string;
  detail?: string;
};

const checkNames = [
  "journal-balance",
  "source-completeness",
  "reversal-integrity",
  "due-equation",
  "advance-equation",
  "account-equation",
  "partner-equation",
  "expense-equation",
] as const;

const cents = (value: unknown) => Math.round(Number(value ?? 0) * 100);
const money = (value: number) => (value / 100).toFixed(2);
const eventBase = (entryKey: string) => entryKey.replace(/:(debit|credit)$/, "");

export function reconcileLabourFinancialScope(input: {
  workspaceId: string;
  farmId: string;
  seasonId: string;
  accounts: Account[];
  accountTransactions: AccountTransaction[];
  journal: Journal[];
  applications: Application[];
  dues: Due[];
  allocations: Allocation[];
  vouchers: Voucher[];
}) {
  const failures: LabourReconciliationFailure[] = [];
  const checked = new Map<string, number>(checkNames.map((name) => [name, 0]));
  const fail = (failure: Omit<LabourReconciliationFailure, "passed" | "workspaceId" | "farmId" | "seasonId">) => {
    failures.push({ ...failure, passed: false, workspaceId: input.workspaceId, farmId: input.farmId, seasonId: input.seasonId });
  };
  const mark = (name: typeof checkNames[number]) => checked.set(name, (checked.get(name) ?? 0) + 1);
  const accountById = new Map(input.accounts.map((row) => [row.id, row]));
  const transactionById = new Map(input.accountTransactions.map((row) => [row.id, row]));
  const journalById = new Map(input.journal.map((row) => [row.id, row]));
  const originalRows = input.journal.filter((row) => !row.reversalOf && row.eventType !== "REVERSAL");
  const reversalRows = input.journal.filter((row) => row.reversalOf || row.eventType === "REVERSAL");
  const originalsByBase = new Map<string, Journal[]>();
  for (const row of originalRows) originalsByBase.set(eventBase(row.entryKey), [...(originalsByBase.get(eventBase(row.entryKey)) ?? []), row]);
  const reversalsByOriginal = new Map<string, Journal[]>();
  for (const row of reversalRows) if (row.reversalOf) reversalsByOriginal.set(row.reversalOf, [...(reversalsByOriginal.get(row.reversalOf) ?? []), row]);

  for (const [base, rows] of originalsByBase) {
    mark("journal-balance");
    const debit = rows.reduce((sum, row) => sum + cents(row.debit), 0);
    const credit = rows.reduce((sum, row) => sum + cents(row.credit), 0);
    if (debit !== credit) fail({ name: "journal-balance", sourceType: "journal_event", sourceId: base, expected: money(debit), actual: money(credit), difference: money(debit - credit), detail: "Original event debits and credits differ." });
  }

  type ExpectedEvent = { base: string; sourceType: string; sourceId: string; eventType: string; dueId?: string | null; voucherId?: string | null; applicationId?: string | null; amount: number; debitCode: string; creditCode: string; reversed: boolean };
  const expectedEvents: ExpectedEvent[] = [];
  for (const due of input.dues.filter((row) => !row.legacy)) {
    const base = `due:${due.id}`;
    if (!originalsByBase.has(base)) continue;
    expectedEvents.push({
      base, sourceType: "labour_due", sourceId: due.id, eventType: "DUE_RECOGNITION", dueId: due.id,
      amount: cents(Number(due.grossAmount) + Number(due.adjustmentAmount) - Number(due.authorizedDeductions)),
      debitCode: "LABOUR_EXPENSE", creditCode: "LABOUR_PAYABLE", reversed: due.paymentStatus === "VOIDED",
    });
  }
  for (const voucher of input.vouchers.filter((row) => !row.legacy && row.nature !== "REVERSAL")) {
    const account = voucher.paymentAccountId ? accountById.get(voucher.paymentAccountId) : undefined;
    const cashCode = account?.accountType === "partner" ? "PARTNER_PAYABLE" : "CASH_CONTROL";
    const refund = voucher.nature === "REFUND_RECOVERY";
    const advance = voucher.nature === "ADVANCE";
    expectedEvents.push({
      base: `voucher:${voucher.id}`, sourceType: "labour_payment_voucher", sourceId: voucher.id,
      eventType: advance ? "ADVANCE_PAYMENT" : refund ? "ADVANCE_REFUND" : "DUE_PAYMENT",
      dueId: voucher.linkedDueId, voucherId: voucher.id, amount: cents(voucher.paymentAmount),
      debitCode: advance ? "LABOUR_ADVANCE" : refund ? cashCode : "LABOUR_EXPENSE",
      creditCode: advance ? cashCode : refund ? "LABOUR_ADVANCE" : cashCode,
      reversed: voucher.status === "VOIDED",
    });
  }
  for (const application of input.applications) expectedEvents.push({
    base: `advance-application:${application.id}`, sourceType: "labour_advance_application", sourceId: application.id,
    eventType: "ADVANCE_APPLICATION", dueId: application.dueId, applicationId: application.id,
    amount: cents(application.amount), debitCode: "LABOUR_EXPENSE", creditCode: "LABOUR_ADVANCE", reversed: application.status === "REVERSED",
  });
  const expectedBases = new Set(expectedEvents.map((event) => event.base));
  for (const event of expectedEvents) {
    mark("source-completeness");
    const rows = originalsByBase.get(event.base) ?? [];
    if (rows.length !== 2) {
      fail({ name: "source-completeness", sourceType: event.sourceType, sourceId: event.sourceId, expected: "2 original journal lines", actual: `${rows.length} original journal lines`, detail: `Expected immutable event ${event.base}.` });
      continue;
    }
    const debit = rows.find((row) => cents(row.debit) > 0);
    const credit = rows.find((row) => cents(row.credit) > 0);
    const dimensionsMatch = rows.every((row) => row.workspaceId === input.workspaceId && row.farmId === input.farmId && row.seasonId === input.seasonId && (event.dueId === undefined || row.dueId === event.dueId) && (event.voucherId === undefined || row.voucherId === event.voucherId) && (event.applicationId === undefined || row.advanceApplicationId === event.applicationId));
    const actual = debit && credit ? `${debit.ledgerCode} Dr ${money(cents(debit.debit))}; ${credit.ledgerCode} Cr ${money(cents(credit.credit))}` : "invalid debit/credit lines";
    if (!debit || !credit || debit.ledgerCode !== event.debitCode || credit.ledgerCode !== event.creditCode || cents(debit.debit) !== event.amount || cents(credit.credit) !== event.amount || rows.some((row) => row.eventType !== event.eventType) || !dimensionsMatch)
      fail({ name: "source-completeness", sourceType: event.sourceType, sourceId: event.sourceId, expected: `${event.debitCode} Dr ${money(event.amount)}; ${event.creditCode} Cr ${money(event.amount)}`, actual, detail: dimensionsMatch ? "Journal classification or amount does not match its source." : "Journal scope or source dimensions do not match." });
    for (const row of rows) {
      const reversals = reversalsByOriginal.get(row.id) ?? [];
      if (event.reversed !== (reversals.length === 1)) fail({ name: "source-completeness", sourceType: event.sourceType, sourceId: event.sourceId, originalJournalId: row.id, reversalJournalId: reversals[0]?.id, ledgerCode: row.ledgerCode, expected: event.reversed ? "one reversal" : "no reversal", actual: `${reversals.length} reversals`, detail: "Source lifecycle and journal lifecycle disagree." });
    }
  }
  for (const [base, rows] of originalsByBase) if (!expectedBases.has(base)) {
    mark("source-completeness");
    fail({ name: "source-completeness", sourceType: "journal_event", sourceId: base, originalJournalId: rows[0]?.id, expected: "valid canonical source", actual: "orphan original journal", detail: "Original journal event has no valid canonical source." });
  }

  for (const reversal of reversalRows) {
    mark("reversal-integrity");
    const original = reversal.reversalOf ? journalById.get(reversal.reversalOf) : undefined;
    if (!original) {
      fail({ name: "reversal-integrity", sourceType: "journal_reversal", sourceId: reversal.id, reversalJournalId: reversal.id, expected: "valid original journal row", actual: "missing original", detail: "Reversal has no resolvable original." });
      continue;
    }
    if (original.reversalOf || original.eventType === "REVERSAL") fail({ name: "reversal-integrity", sourceType: "journal_reversal", sourceId: reversal.id, originalJournalId: original.id, reversalJournalId: reversal.id, ledgerCode: reversal.ledgerCode, expected: "non-reversal original", actual: "reversal references another reversal", detail: "Routine reversal-of-reversal is prohibited." });
    const sameDimensions = reversal.workspaceId === original.workspaceId && reversal.farmId === original.farmId && reversal.seasonId === original.seasonId && reversal.dueId === original.dueId && reversal.voucherId === original.voucherId && reversal.advanceApplicationId === original.advanceApplicationId && reversal.ledgerCode === original.ledgerCode;
    const inverse = cents(reversal.debit) === cents(original.credit) && cents(reversal.credit) === cents(original.debit);
    if (!sameDimensions || !inverse) fail({ name: "reversal-integrity", sourceType: "journal_reversal", sourceId: reversal.id, originalJournalId: original.id, reversalJournalId: reversal.id, ledgerCode: reversal.ledgerCode, expected: `${money(cents(original.credit))} debit / ${money(cents(original.debit))} credit with identical dimensions`, actual: `${money(cents(reversal.debit))} debit / ${money(cents(reversal.credit))} credit`, difference: money((cents(reversal.debit) - cents(reversal.credit)) + (cents(original.debit) - cents(original.credit))), detail: sameDimensions ? "Reversal is not the exact inverse." : "Reversal dimensions differ from the original." });
  }
  for (const [originalId, rows] of reversalsByOriginal) if (rows.length > 1) {
    mark("reversal-integrity");
    fail({ name: "reversal-integrity", sourceType: "journal_original", sourceId: originalId, originalJournalId: originalId, reversalJournalId: rows[0]?.id, expected: "one reversal maximum", actual: `${rows.length} reversals`, detail: "Original journal line has duplicate inverses." });
  }

  for (const due of input.dues) {
    mark("due-equation");
    const paid = input.allocations.filter((row) => row.dueId === due.id && row.status === "ACTIVE").reduce((sum, row) => sum + cents(row.amount), 0);
    const applied = input.applications.filter((row) => row.dueId === due.id && row.status === "ACTIVE").reduce((sum, row) => sum + cents(row.amount), 0);
    const expectedRemaining = cents(Number(due.grossAmount) + Number(due.adjustmentAmount) - Number(due.authorizedDeductions)) - paid - applied;
    const position = calculateLabourDuePosition({ grossAmount: due.grossAmount, adjustmentAmount: due.adjustmentAmount, authorizedDeductions: due.authorizedDeductions, previousPayments: paid / 100, advancesApplied: applied / 100 });
    if (expectedRemaining < 0 || (due.paymentStatus !== "VOIDED" && due.paymentStatus !== "ON_HOLD" && due.paymentStatus !== position.paymentStatus)) fail({ name: "due-equation", sourceType: "labour_due", sourceId: due.id, expected: `${money(Math.max(expectedRemaining, 0))} remaining / ${due.paymentStatus === "VOIDED" ? "VOIDED" : position.paymentStatus}`, actual: `${money(expectedRemaining)} remaining / ${due.paymentStatus}`, difference: expectedRemaining < 0 ? money(expectedRemaining) : undefined, detail: "Gross minus deductions, applications, and payments does not agree with due status." });
    if (due.paymentStatus === "VOIDED" && (paid !== 0 || applied !== 0)) fail({ name: "due-equation", sourceType: "labour_due", sourceId: due.id, expected: "no active clearing on voided due", actual: `${money(applied)} applied / ${money(paid)} paid`, detail: "Voided due retains active allocations." });
  }

  const refundsByAdvance = new Map<string, number>();
  for (const voucher of input.vouchers.filter((row) => row.nature === "REFUND_RECOVERY" && row.status === "POSTED" && row.relatedAdvanceVoucherId)) refundsByAdvance.set(voucher.relatedAdvanceVoucherId!, (refundsByAdvance.get(voucher.relatedAdvanceVoucherId!) ?? 0) + cents(voucher.paymentAmount));
  for (const advance of input.vouchers.filter((row) => row.nature === "ADVANCE")) {
    mark("advance-equation");
    const applied = input.applications.filter((row) => row.advanceVoucherId === advance.id && row.status === "ACTIVE").reduce((sum, row) => sum + cents(row.amount), 0);
    const refunded = refundsByAdvance.get(advance.id) ?? 0;
    const outstanding = cents(advance.paymentAmount) - applied - refunded;
    if (outstanding < 0) fail({ name: "advance-equation", sourceType: "labour_payment_voucher", sourceId: advance.id, expected: "outstanding advance >= 0.00", actual: money(outstanding), difference: money(outstanding), detail: "Applications and recoveries exceed the original advance." });
    if (advance.status === "VOIDED" && applied !== 0) fail({ name: "advance-equation", sourceType: "labour_payment_voucher", sourceId: advance.id, expected: "no active applications on voided advance", actual: money(applied), detail: "Voided advance still funds an active due." });
  }

  for (const voucher of input.vouchers.filter((row) => !row.legacy && row.status === "POSTED")) {
    mark("account-equation");
    const transaction = voucher.accountTransactionId ? transactionById.get(voucher.accountTransactionId) : undefined;
    const account = voucher.paymentAccountId ? accountById.get(voucher.paymentAccountId) : undefined;
    const original = voucher.nature === "REVERSAL" && voucher.reversalReference ? input.vouchers.find((row) => row.id === voucher.reversalReference) : undefined;
    const isReverse = voucher.nature === "REVERSAL" ? original?.nature !== "REFUND_RECOVERY" : voucher.nature === "REFUND_RECOVERY";
    const normalType = account?.accountType === "partner" ? "credit" : "debit";
    const expectedType = isReverse ? (normalType === "credit" ? "debit" : "credit") : normalType;
    if (!transaction || !account || transaction.referenceId !== voucher.id || transaction.accountId !== voucher.paymentAccountId || cents(transaction.amount) !== cents(voucher.paymentAmount) || transaction.type !== expectedType)
      fail({ name: "account-equation", sourceType: "labour_payment_voucher", sourceId: voucher.id, expected: `${voucher.paymentAccountId ?? "account"} ${expectedType} ${money(cents(voucher.paymentAmount))}`, actual: transaction ? `${transaction.accountId} ${transaction.type} ${money(cents(transaction.amount))}` : "missing account transaction", detail: "Canonical voucher and account movement disagree." });
  }
  for (const application of input.applications) {
    mark("account-equation");
    const unexpected = input.accountTransactions.filter((row) => row.referenceId === application.id);
    if (unexpected.length) fail({ name: "account-equation", sourceType: "labour_advance_application", sourceId: application.id, expected: "no cash transaction", actual: `${unexpected.length} account transactions`, detail: "Non-cash advance application created a cash effect." });
  }

  mark("partner-equation");
  const partnerAccountIds = new Set(input.accounts.filter((row) => row.accountType === "partner").map((row) => row.id));
  const partnerAccountNet = input.accountTransactions.filter((row) => partnerAccountIds.has(row.accountId)).reduce((sum, row) => sum + (row.type === "credit" ? cents(row.amount) : -cents(row.amount)), 0);
  const partnerJournalNet = input.journal.filter((row) => row.ledgerCode === "PARTNER_PAYABLE").reduce((sum, row) => sum + cents(row.credit) - cents(row.debit), 0);
  if (partnerAccountNet !== partnerJournalNet) fail({ name: "partner-equation", sourceType: "financial_scope", sourceId: `${input.farmId}:${input.seasonId}`, ledgerCode: "PARTNER_PAYABLE", expected: money(partnerAccountNet), actual: money(partnerJournalNet), difference: money(partnerJournalNet - partnerAccountNet), detail: "Farm Owes Partner differs between account movements and journal." });

  for (const due of input.dues.filter((row) => !row.legacy)) {
    mark("expense-equation");
    const paymentRows = input.vouchers
      .filter((row) => row.linkedDueId === due.id && row.status === "POSTED" && row.nature !== "ADVANCE" && row.nature !== "REFUND_RECOVERY" && row.nature !== "REVERSAL")
      .map((row) => `voucher:${row.id}`);
    const applicationRows = input.applications
      .filter((row) => row.dueId === due.id && row.status === "ACTIVE")
      .map((row) => `advance-application:${row.id}`);
    const sourceBases = new Set([...paymentRows, ...applicationRows]);
    const sourceRows = [...sourceBases].flatMap((base) => originalsByBase.get(base) ?? []);
    const sourceIds = new Set(sourceRows.map((row) => row.id));
    const currentRows = input.journal.filter((row) => sourceIds.has(row.id) || (row.reversalOf ? sourceIds.has(row.reversalOf) : false));
    const actualExpense = currentRows.filter((row) => row.ledgerCode === "LABOUR_EXPENSE").reduce((sum, row) => sum + cents(row.debit) - cents(row.credit), 0);
    const paid = input.allocations.filter((row) => row.dueId === due.id && row.status === "ACTIVE").reduce((sum, row) => sum + cents(row.amount), 0);
    const applied = input.applications.filter((row) => row.dueId === due.id && row.status === "ACTIVE").reduce((sum, row) => sum + cents(row.amount), 0);
    const payable = cents(Number(due.grossAmount) + Number(due.adjustmentAmount) - Number(due.authorizedDeductions));
    const expectedExpense = due.paymentStatus === "VOIDED" ? 0 : Math.min(payable, paid + applied);
    if (actualExpense !== expectedExpense) fail({ name: "expense-equation", sourceType: "labour_due", sourceId: due.id, ledgerCode: "LABOUR_EXPENSE", expected: money(expectedExpense), actual: money(actualExpense), difference: money(actualExpense - expectedExpense), detail: "Wage expense is missing, duplicated, or active after void." });
  }

  const checks = checkNames.map((name) => ({ name, passed: !failures.some((failure) => failure.name === name), checkedCount: checked.get(name) ?? 0, failureCount: failures.filter((failure) => failure.name === name).length }));
  return { reconciled: failures.length === 0, checks, failures };
}
