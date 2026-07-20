import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  accounts,
  accountTransactions,
  labourAccountingEntries,
  labourAdvanceApplications,
  labourDues,
  labourPaymentAllocations,
  labourPaymentVouchers,
} from "../db/schema.js";

const amount = (value: unknown) => Number(Number(value ?? 0).toFixed(2));
const recipientName = (snapshot: Record<string, unknown>) => {
  for (const key of ["labourerName", "labourGroupName", "recipientName", "receivedByNameSnapshot", "contactPerson", "recipientReference"]) {
    const value = snapshot[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "Labour";
};
const originalEventBase = (entryKey: string) => entryKey.replace(/:(debit|credit)$/, "");

export async function loadLabourFinancialReadModel(input: { workspaceId: string; farmId: string; seasonId: string }) {
  const [scopeAccounts, transactions, vouchers, dues, applications, allocations, journal] = await Promise.all([
    db.select().from(accounts).where(eq(accounts.farmId, input.farmId)),
    db.select().from(accountTransactions).where(and(eq(accountTransactions.farmId, input.farmId), eq(accountTransactions.seasonId, input.seasonId))),
    db.select().from(labourPaymentVouchers).where(and(eq(labourPaymentVouchers.workspaceId, input.workspaceId), eq(labourPaymentVouchers.farmId, input.farmId), eq(labourPaymentVouchers.seasonId, input.seasonId))),
    db.select().from(labourDues).where(and(eq(labourDues.workspaceId, input.workspaceId), eq(labourDues.farmId, input.farmId), eq(labourDues.seasonId, input.seasonId))),
    db.select().from(labourAdvanceApplications).where(eq(labourAdvanceApplications.workspaceId, input.workspaceId)),
    db.select().from(labourPaymentAllocations).where(eq(labourPaymentAllocations.workspaceId, input.workspaceId)),
    db.select().from(labourAccountingEntries).where(and(eq(labourAccountingEntries.workspaceId, input.workspaceId), eq(labourAccountingEntries.farmId, input.farmId), eq(labourAccountingEntries.seasonId, input.seasonId))),
  ]);
  const dueIds = new Set(dues.map((row) => row.id));
  const scopedApplications = applications.filter((row) => dueIds.has(row.dueId));
  const scopedAllocations = allocations.filter((row) => dueIds.has(row.dueId));
  const accountById = new Map(scopeAccounts.map((row) => [row.id, row]));
  const voucherById = new Map(vouchers.map((row) => [row.id, row]));
  const dueById = new Map(dues.map((row) => [row.id, row]));
  const applicationById = new Map(scopedApplications.map((row) => [row.id, row]));
  const transactionById = new Map(transactions.map((row) => [row.id, row]));
  const canonicalTransactionIds = new Set(vouchers.map((row) => row.accountTransactionId).filter((id): id is string => Boolean(id)));

  const accountEntries = vouchers.flatMap((voucher) => {
    if (voucher.legacy) return [];
    const transaction = voucher.accountTransactionId ? transactionById.get(voucher.accountTransactionId) : undefined;
    const account = voucher.paymentAccountId ? accountById.get(voucher.paymentAccountId) : undefined;
    if (!transaction || !account || !canonicalTransactionIds.has(transaction.id)) return [];
    const numericAmount = amount(transaction.amount);
    return [{
      id: transaction.id,
      voucherId: voucher.id,
      voucherNumber: voucher.voucherNumber,
      sourceId: voucher.sourceId,
      legacySourceRecordId: voucher.legacySourceRecordId,
      accountId: account.id,
      accountName: account.name,
      accountType: account.accountType,
      transactionType: transaction.type,
      amount: numericAmount,
      balanceEffect: transaction.type === "credit" ? numericAmount : -numericAmount,
      date: transaction.transactionDate,
      nature: voucher.nature,
      status: voucher.status,
      description: voucher.description,
      reversalReference: voucher.reversalReference,
      recipientScope: voucher.recipientScope,
      labourerId: voucher.labourerId,
      labourGroupId: voucher.labourGroupId,
      recipientName: recipientName(voucher.recipientSnapshot),
      canonical: true as const,
    }];
  }).sort((left, right) => right.date.localeCompare(left.date) || right.id.localeCompare(left.id));

  const originalById = new Map(journal.filter((row) => !row.reversalOf && row.eventType !== "REVERSAL").map((row) => [row.id, row]));
  const journalGroups = new Map<string, typeof journal>();
  for (const row of journal) {
    const original = row.reversalOf ? originalById.get(row.reversalOf) : row;
    const base = original ? originalEventBase(original.entryKey) : `orphan:${row.id}`;
    const key = row.reversalOf ? `reversal:${base}` : `original:${base}`;
    journalGroups.set(key, [...(journalGroups.get(key) ?? []), row]);
  }
  const journalEvents = [...journalGroups.entries()].map(([key, rows]) => {
    const representative = rows[0]!;
    const original = representative.reversalOf ? originalById.get(representative.reversalOf) : representative;
    const due = original?.dueId ? dueById.get(original.dueId) : undefined;
    const voucher = original?.voucherId ? voucherById.get(original.voucherId) : undefined;
    const application = original?.advanceApplicationId ? applicationById.get(original.advanceApplicationId) : undefined;
    const snapshot = (due?.recipientSnapshot ?? voucher?.recipientSnapshot ?? {}) as Record<string, unknown>;
    const sum = (code: string, sign: "debit" | "credit") => rows.filter((row) => row.ledgerCode === code).reduce((total, row) => total + amount(row[sign]) - amount(row[sign === "debit" ? "credit" : "debit"]), 0);
    const isReversal = key.startsWith("reversal:");
    const sourceStatus = (() => {
      if (isReversal) return "REVERSED";
      if (original?.eventType === "ADVANCE_APPLICATION") return application?.status === "ACTIVE" ? "APPLIED" : "REVERSED";
      if (original?.eventType === "DUE_PAYMENT") return voucher?.status === "POSTED" ? "PAID" : voucher?.status ?? representative.status;
      if (original?.eventType === "ADVANCE_REFUND") return voucher?.status === "POSTED" ? "REFUNDED" : voucher?.status ?? representative.status;
      if (voucher) return voucher.status;
      if (due) return due.paymentStatus;
      return representative.status;
    })();
    return {
      id: key,
      eventType: isReversal ? "REVERSAL" : original?.eventType ?? representative.eventType,
      originalEventType: original?.eventType ?? null,
      status: sourceStatus,
      date: (voucher?.voucherDate ?? due?.workToDate ?? representative.postedAt.toISOString().slice(0, 10)),
      postedAt: representative.postedAt.toISOString(),
      dueId: original?.dueId ?? null,
      dueNumber: due?.dueNumber ?? null,
      voucherId: original?.voucherId ?? null,
      voucherNumber: voucher?.voucherNumber ?? null,
      advanceApplicationId: original?.advanceApplicationId ?? null,
      recipientScope: due?.recipientScope ?? voucher?.recipientScope ?? null,
      financialScopeKey: due?.financialScopeKey ?? voucher?.financialScopeKey ?? null,
      labourerId: due?.labourerId ?? voucher?.labourerId ?? null,
      labourGroupId: due?.labourGroupId ?? voucher?.labourGroupId ?? null,
      recipientName: recipientName(snapshot),
      description: voucher?.description ?? due?.description ?? (isReversal ? "Financial reversal" : "Labour financial event"),
      legacy: Boolean(due?.legacy || voucher?.legacy),
      labourDueEffect: sum("LABOUR_PAYABLE", "credit"),
      labourAdvanceEffect: sum("LABOUR_ADVANCE", "debit"),
      expenseEffect: sum("LABOUR_EXPENSE", "debit"),
      partnerEffect: sum("PARTNER_PAYABLE", "credit"),
      cashControlEffect: sum("CASH_CONTROL", "credit"),
      canonical: true as const,
    };
  }).sort((left, right) => right.postedAt.localeCompare(left.postedAt) || right.id.localeCompare(left.id));

  const partnerPositions = scopeAccounts.filter((account) => account.accountType === "partner").map((account) => {
    const ledger = accountEntries.filter((entry) => entry.accountId === account.id);
    return {
      accountId: account.id,
      accountName: account.name,
      farmOwesPartner: amount(ledger.reduce((sum, entry) => sum + entry.balanceEffect, 0)),
      ledgerBalance: amount(ledger.reduce((sum, entry) => sum + entry.balanceEffect, 0)),
      entryCount: ledger.length,
    };
  });
  const expenses = journalEvents.filter((event) => !event.legacy && event.expenseEffect !== 0).map((event) => ({
    id: event.id, dueId: event.dueId, dueNumber: event.dueNumber, date: event.date,
    recipientScope: event.recipientScope, labourerId: event.labourerId, labourGroupId: event.labourGroupId,
    recipientName: event.recipientName, description: event.description, status: event.status,
    amount: event.expenseEffect, canonical: true as const,
  }));
  const labourLedger = journalEvents.filter((event) => !event.legacy && (event.labourDueEffect !== 0 || event.labourAdvanceEffect !== 0 || event.expenseEffect !== 0));
  const activity = journalEvents.filter((event) => !event.legacy).map((event) => ({
    id: `labour:${event.id}`, date: event.postedAt, module: "labour" as const,
    title: event.eventType === "REVERSAL" ? `Reversed ${event.originalEventType?.toLowerCase().replaceAll("_", " ") ?? "labour event"}` : event.eventType.toLowerCase().replaceAll("_", " "),
    detail: `${event.dueNumber ?? event.voucherNumber ?? event.recipientName} · ${event.description}`,
    status: event.status, sourceId: event.voucherId ?? event.dueId ?? event.advanceApplicationId,
    canonical: true as const,
  }));
  const canonicalJournalEvents = journalEvents.filter((event) => !event.legacy);
  const currentLedger = {
    LABOUR_EXPENSE: amount(canonicalJournalEvents.reduce((sum, event) => sum + event.expenseEffect, 0)),
    LABOUR_PAYABLE: amount(canonicalJournalEvents.reduce((sum, event) => sum - event.labourDueEffect, 0)),
    LABOUR_ADVANCE: amount(canonicalJournalEvents.reduce((sum, event) => sum + event.labourAdvanceEffect, 0)),
    CASH_CONTROL: amount(canonicalJournalEvents.reduce((sum, event) => sum - event.cashControlEffect, 0)),
    PARTNER_PAYABLE: amount(canonicalJournalEvents.reduce((sum, event) => sum - event.partnerEffect, 0)),
  };
  const advancePositions = vouchers.filter((row) => row.nature === "ADVANCE").map((advance) => {
    const applied = scopedApplications.filter((row) => row.advanceVoucherId === advance.id && row.status === "ACTIVE").reduce((sum, row) => sum + amount(row.amount), 0);
    const recovered = vouchers.filter((row) => row.relatedAdvanceVoucherId === advance.id && row.nature === "REFUND_RECOVERY" && row.status === "POSTED").reduce((sum, row) => sum + amount(row.paymentAmount), 0);
    return { voucherId: advance.id, voucherNumber: advance.voucherNumber, accountId: advance.paymentAccountId, sourceId: advance.sourceId, legacySourceRecordId: advance.legacySourceRecordId, labourerId: advance.labourerId, labourGroupId: advance.labourGroupId, recipientScope: advance.recipientScope, originalAmount: amount(advance.paymentAmount), appliedAmount: amount(applied), recoveredAmount: amount(recovered), outstandingAmount: advance.status === "VOIDED" ? 0 : amount(Math.max(amount(advance.paymentAmount) - applied - recovered, 0)), status: advance.status };
  });

  return {
    scope: input,
    accountEntries,
    partnerPositions,
    partnerLedger: accountEntries.filter((entry) => entry.accountType === "partner"),
    labourLedger,
    expenses,
    activity,
    currentLedger,
    advancePositions,
    replacedLegacySourceIds: [...new Set(vouchers.flatMap((voucher) => [voucher.sourceId, voucher.legacySourceRecordId]).filter((id): id is string => Boolean(id)))],
    summary: {
      labourDue: amount(canonicalJournalEvents.reduce((sum, event) => sum + event.labourDueEffect, 0)),
      outstandingAdvance: amount(advancePositions.reduce((sum, position) => sum + position.outstandingAmount, 0)),
      wageExpense: amount(canonicalJournalEvents.reduce((sum, event) => sum + event.expenseEffect, 0)),
      farmOwesPartner: amount(partnerPositions.reduce((sum, position) => sum + position.farmOwesPartner, 0)),
      accountMovement: amount(accountEntries.reduce((sum, entry) => sum + entry.balanceEffect, 0)),
      activePaymentAmount: amount(scopedAllocations.filter((row) => row.status === "ACTIVE").reduce((sum, row) => sum + amount(row.amount), 0)),
      activeAdvanceApplied: amount(scopedApplications.filter((row) => row.status === "ACTIVE").reduce((sum, row) => sum + amount(row.amount), 0)),
    },
  };
}
