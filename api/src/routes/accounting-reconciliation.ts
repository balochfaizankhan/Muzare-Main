import type { FastifyInstance } from "fastify";
import { and, eq, or, sql } from "drizzle-orm";
import { z } from "zod";
import { buildInfo } from "../build-info.js";
import { requireUser } from "../auth.js";
import { hasPermission } from "../permissions.js";
import { db } from "../db/client.js";
import { accountTransactions, accounts, farms, operationalRecords, userSessions } from "../db/schema.js";
import { isDeletedOperationalPayload } from "../operational-record-state.js";
import { normalizeSettlementPayload } from "../lib/labour-wage-settlements.js";
import { validateTenantReferences } from "../tenant-ownership.js";

const querySchema = z.object({
  accountName: z.string().trim().min(1),
  workspaceId: z.string().uuid().optional(),
  farmId: z.string().uuid().optional(),
  seasonId: z.string().uuid().optional(),
});

type AccountRow = {
  id: string;
  farmId: string;
  farmName: string;
  name: string;
  accountType: string;
  active: boolean;
  oldAndroidId: string | null;
  sourceType: string | null;
};

type AdvanceRow = {
  id: string;
  date: string;
  amount: number;
  accountId: string | null;
  sourceAccountName: string | null;
  deleted: boolean;
};

type SettlementRow = {
  id: string;
  settlementNumber: string;
  status: string;
  linkedAccountId: string | null;
  paymentAccountId: string | null;
  accountId: string | null;
  partnerAccountId: string | null;
  labourAccountId: string | null;
  totalLabourCost: number;
  advancesApplied: number;
  settledAdvanceAmount: number;
  cashPaid: number;
  carryForwardAdvance: number;
  createdAt: string;
  updatedAt: string;
  postedAt: string | null;
  voidedAt: string | null;
  reversedAt: string | null;
  deletedAt: string | null;
  linkedVoucherNumber: string | null;
  linkedVoucherId: string | null;
  accountingEntries: number;
  transactionAccountIds: string[];
  transactionRemarks: string[];
};

type TransactionRow = {
  referenceId: string | null;
  accountId: string;
  source: string;
  sourceType: string | null;
  type: string;
  amount: number;
  transactionDate: string;
  remarks: string | null;
};

type PartnerSnapshot = {
  purchaseVouchersPaid: number;
  businessFundsGiven: number;
  businessFundsReceived: number;
  labourAdvancesPaid: number;
  labourAdvancesSettledThroughWageSettlements: number;
  outstandingLabourAdvances: number;
  labourSettlementCashPaid: number;
  labourSettlementNonCashApplied: number;
  moneyReturned: number;
  adjustments: number;
  farmOwesPartner: number;
};

function lowerTrim(value: string) {
  return value.trim().toLowerCase();
}

function firstString(...values: Array<unknown>) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function numberValue(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isLabourWageSettlementVoucherPayload(payload: Record<string, unknown>) {
  return Boolean(
    payload.settlementId
    || payload.voucherPurpose === "labour_wage_settlement"
    || payload.nonCashSettlement === true,
  );
}

function resolveSettlementAccountId(payload: Record<string, unknown>) {
  return firstString(
    payload.linkedAccountId,
    payload.paymentAccountId,
    payload.accountId,
    payload.partnerAccountId,
    payload.labourAccountId,
  );
}

function settlementAccountingStatus(status: string, accountingEntries: number) {
  if (status === "deleted") return "deleted";
  if (status === "voided") return "voided";
  return accountingEntries > 0 ? "posted" : "accounting_missing";
}

function settlementExclusionReason(input: {
  status: string;
  accountingStatus: string;
  currentHelperIncluded: boolean;
  sourceOfTruthIncluded: boolean;
  settlementAccountId: string | null;
  transactionAccountIds: string[];
  selectedAccountId: string;
}) {
  const {
    status,
    accountingStatus,
    currentHelperIncluded,
    sourceOfTruthIncluded,
    settlementAccountId,
    transactionAccountIds,
    selectedAccountId,
  } = input;
  if (currentHelperIncluded || sourceOfTruthIncluded) return null;
  if (status === "deleted") return "Settlement is deleted.";
  if (status === "voided") return "Settlement is voided.";
  if (accountingStatus === "accounting_missing") return "Accounting entries are missing.";
  if (!settlementAccountId && transactionAccountIds.includes(selectedAccountId)) {
    return "Settlement row is missing a settlement account link, but the accounting row points to the selected account.";
  }
  if (settlementAccountId && settlementAccountId !== selectedAccountId && transactionAccountIds.includes(selectedAccountId)) {
    return "Settlement account on the row does not match the accounting row.";
  }
  if (!settlementAccountId && !transactionAccountIds.includes(selectedAccountId)) {
    return "Settlement row is not linked to the selected account.";
  }
  return "Settlement was excluded by reconciliation filters.";
}

function includedSettlementSnapshot(
  settlements: SettlementRow[],
  selectedAccountId: string,
  useTransactionFallback: boolean,
) {
  const active = settlements.filter((row) => row.status === "posted" && row.accountingEntries > 0);
  const included = active.filter((row) => {
    const settlementAccountId = row.linkedAccountId ?? row.paymentAccountId ?? row.accountId ?? row.partnerAccountId ?? row.labourAccountId;
    if (settlementAccountId === selectedAccountId) return true;
    return useTransactionFallback && row.transactionAccountIds.includes(selectedAccountId);
  });
  const labourSettlementNonCashApplied = included.reduce((sum, row) => sum + row.settledAdvanceAmount, 0);
  const labourSettlementCashPaid = included.reduce((sum, row) => sum + row.cashPaid, 0);
  return { included, labourSettlementNonCashApplied, labourSettlementCashPaid };
}

function buildPartnerSnapshot(args: {
  selectedAccountId: string;
  advances: AdvanceRow[];
  settlements: SettlementRow[];
  vouchers: Array<{ accountId: string; amount: number; isLabourWageSettlementVoucher: boolean }>;
  partnerEntries: Array<{
    type: string;
    amount: number;
    partnerAccountId: string | null;
    fromAccountId: string | null;
    toAccountId: string | null;
    accountId: string | null;
  }>;
  sales: Array<{ accountId: string | null; amount: number }>;
  useTransactionFallback: boolean;
}) {
  const { selectedAccountId, advances, settlements, vouchers, partnerEntries, sales, useTransactionFallback } = args;
  const purchaseVouchersPaid = vouchers
    .filter((voucher) => voucher.accountId === selectedAccountId && !voucher.isLabourWageSettlementVoucher)
    .reduce((sum, voucher) => sum + voucher.amount, 0);
  const businessFundsGiven = partnerEntries
    .filter((entry) => entry.type === "settlement" && entry.fromAccountId === selectedAccountId)
    .reduce((sum, entry) => sum + entry.amount, 0);
  const businessFundsReceived = partnerEntries
    .filter((entry) => entry.type === "settlement" && entry.toAccountId === selectedAccountId)
    .reduce((sum, entry) => sum + entry.amount, 0);
  const moneyReturned = partnerEntries
    .filter((entry) => entry.type === "withdrawal")
    .filter((entry) => entry.partnerAccountId === selectedAccountId || entry.accountId === selectedAccountId)
    .reduce((sum, entry) => sum + entry.amount, 0);
  const capitalInjected = partnerEntries
    .filter((entry) => entry.type === "contribution")
    .filter((entry) => entry.partnerAccountId === selectedAccountId || entry.accountId === selectedAccountId)
    .reduce((sum, entry) => sum + entry.amount, 0);
  const adjustments = partnerEntries
    .filter((entry) => entry.type === "adjustment")
    .filter((entry) => entry.partnerAccountId === selectedAccountId || entry.accountId === selectedAccountId)
    .reduce((sum, entry) => sum + entry.amount, 0)
    - sales.filter((sale) => sale.accountId === selectedAccountId).reduce((sum, sale) => sum + sale.amount, 0);
  const totalLabourAdvancesPaid = advances
    .filter((advance) => advance.accountId === selectedAccountId && !advance.deleted)
    .reduce((sum, advance) => sum + advance.amount, 0);
  const settlementSnapshot = includedSettlementSnapshot(settlements, selectedAccountId, useTransactionFallback);
  const labourAdvancesSettledThroughWageSettlements = settlementSnapshot.labourSettlementNonCashApplied;
  const labourSettlementNonCashApplied = settlementSnapshot.labourSettlementNonCashApplied;
  const labourSettlementCashPaid = settlementSnapshot.labourSettlementCashPaid;
  const outstandingLabourAdvances = Math.max(totalLabourAdvancesPaid - labourAdvancesSettledThroughWageSettlements, 0);
  const farmOwesPartner = capitalInjected
    + purchaseVouchersPaid
    + businessFundsGiven
    - businessFundsReceived
    - moneyReturned
    + labourSettlementNonCashApplied
    + outstandingLabourAdvances
    + adjustments;
  return {
    purchaseVouchersPaid,
    businessFundsGiven,
    businessFundsReceived,
    labourAdvancesPaid: totalLabourAdvancesPaid,
    labourAdvancesSettledThroughWageSettlements,
    outstandingLabourAdvances,
    labourSettlementCashPaid,
    labourSettlementNonCashApplied,
    moneyReturned,
    adjustments,
    farmOwesPartner,
  } satisfies PartnerSnapshot;
}

export async function buildAccountingReconciliationTrace(accountName: string, workspaceId: string, farmId: string, seasonId: string) {
  return db.transaction(async (tx) => {
    const matchingAccounts = await tx.select({
      id: accounts.id,
      farmId: accounts.farmId,
      farmName: farms.name,
      name: accounts.name,
      accountType: accounts.accountType,
      active: accounts.active,
      oldAndroidId: accounts.oldAndroidId,
      sourceType: accounts.sourceType,
    }).from(accounts).innerJoin(farms, eq(farms.id, accounts.farmId)).where(and(
      eq(farms.workspaceId, workspaceId),
      sql`lower(btrim(${accounts.name})) = lower(btrim(${accountName}))`,
    )).orderBy(accounts.name);

    const selectedAccount = matchingAccounts.find((row) => row.farmId === farmId) ?? matchingAccounts[0] ?? null;
    if (!selectedAccount) {
      return {
        buildInfo,
        workspaceId,
        farmId,
        seasonId,
        accountName,
        account: null,
        matchingAccounts,
        message: "No account matched the requested name in this workspace.",
      };
    }

    const session = {
      activeFarmId: farmId,
      activeSeasonId: seasonId,
    };

    const advanceRecords = await tx.select({
      id: operationalRecords.clientRecordId,
      createdAt: operationalRecords.createdAt,
      updatedAt: operationalRecords.updatedAt,
      payload: operationalRecords.payload,
    }).from(operationalRecords).where(and(
      eq(operationalRecords.workspaceId, workspaceId),
      eq(operationalRecords.farmId, farmId),
      eq(operationalRecords.seasonId, seasonId),
      eq(operationalRecords.entityType, "advance"),
    ));
    const voucherRecords = await tx.select({
      payload: operationalRecords.payload,
    }).from(operationalRecords).where(and(
      eq(operationalRecords.workspaceId, workspaceId),
      eq(operationalRecords.farmId, farmId),
      eq(operationalRecords.seasonId, seasonId),
      eq(operationalRecords.entityType, "voucher"),
    ));
    const partnerEntryRecords = await tx.select({
      id: operationalRecords.clientRecordId,
      payload: operationalRecords.payload,
    }).from(operationalRecords).where(and(
      eq(operationalRecords.workspaceId, workspaceId),
      eq(operationalRecords.farmId, farmId),
      eq(operationalRecords.seasonId, seasonId),
      eq(operationalRecords.entityType, "partnerEntry"),
    ));
    const saleRecords = await tx.select({
      id: operationalRecords.clientRecordId,
      payload: operationalRecords.payload,
    }).from(operationalRecords).where(and(
      eq(operationalRecords.workspaceId, workspaceId),
      eq(operationalRecords.farmId, farmId),
      eq(operationalRecords.seasonId, seasonId),
      eq(operationalRecords.entityType, "sale"),
    ));
    const settlementRecords = await tx.select({
      id: operationalRecords.clientRecordId,
      createdAt: operationalRecords.createdAt,
      updatedAt: operationalRecords.updatedAt,
      payload: operationalRecords.payload,
    }).from(operationalRecords).where(and(
      eq(operationalRecords.workspaceId, workspaceId),
      eq(operationalRecords.farmId, farmId),
      eq(operationalRecords.seasonId, seasonId),
      eq(operationalRecords.entityType, "labourWageSettlement"),
    ));
    const transactionRecords = await tx.select({
      referenceId: accountTransactions.referenceId,
      accountId: accountTransactions.accountId,
      source: accountTransactions.source,
      sourceType: accountTransactions.sourceType,
      type: accountTransactions.type,
      amount: accountTransactions.amount,
      transactionDate: accountTransactions.transactionDate,
      remarks: accountTransactions.remarks,
    }).from(accountTransactions).where(and(
      eq(accountTransactions.farmId, farmId),
      eq(accountTransactions.seasonId, seasonId),
      or(
        eq(accountTransactions.source, "settlement"),
        eq(accountTransactions.sourceType, "labour_wage_settlement"),
      ),
    ));

    const advances = advanceRecords.map((row) => {
      const payload = row.payload as Record<string, unknown>;
      const deleted = isDeletedOperationalPayload(payload);
      return {
        id: row.id,
        date: typeof payload.date === "string" ? payload.date : "",
        amount: numberValue(payload.amount),
        accountId: firstString(payload.accountId),
        sourceAccountName: firstString(payload.sourceAccountName),
        deleted,
      } satisfies AdvanceRow;
    });

    const vouchers = voucherRecords.map((row) => {
      const payload = row.payload as Record<string, unknown>;
      return {
        accountId: firstString(payload.accountId) ?? "",
        amount: numberValue(payload.totalAmount ?? payload.amount),
        isLabourWageSettlementVoucher: isLabourWageSettlementVoucherPayload(payload),
      };
    });

    const partnerEntries = partnerEntryRecords.map((row) => {
      const payload = row.payload as Record<string, unknown>;
      return {
        type: typeof payload.type === "string" ? payload.type : "settlement",
        amount: numberValue(payload.amount),
        partnerAccountId: firstString(payload.partnerAccountId),
        fromAccountId: firstString(payload.fromAccountId),
        toAccountId: firstString(payload.toAccountId),
        accountId: firstString(payload.accountId),
      };
    });

    const sales = saleRecords.map((row) => {
      const payload = row.payload as Record<string, unknown>;
      return {
        accountId: firstString(payload.accountId),
        amount: numberValue(payload.amount),
      };
    });

    const transactionBySettlementId = new Map<string, TransactionRow[]>();
    for (const row of transactionRecords) {
      if (!row.referenceId) continue;
      const current = transactionBySettlementId.get(row.referenceId) ?? [];
      current.push({
        referenceId: row.referenceId,
        accountId: row.accountId,
        source: row.source,
        sourceType: row.sourceType,
        type: row.type,
        amount: numberValue(row.amount),
        transactionDate: row.transactionDate,
        remarks: row.remarks,
      });
      transactionBySettlementId.set(row.referenceId, current);
    }

    const settlementRows = settlementRecords.map((row) => {
      const payload = row.payload as Record<string, unknown>;
      const accountId = resolveSettlementAccountId(payload);
      const transactionRows = transactionBySettlementId.get(row.id) ?? [];
      const transactionAccountIds = [...new Set(transactionRows.map((entry) => entry.accountId))];
      const transactionRemarks = transactionRows.map((entry) => entry.remarks ?? "");
      const accountingEntries = transactionRows.length;
      const normalizedPayload = normalizeSettlementPayload(payload);
      const status = normalizedPayload.status;
      const accountingStatus = settlementAccountingStatus(status, accountingEntries);
      const currentHelperIncluded = accountingStatus === "posted" && accountId === selectedAccount.id;
      const sourceOfTruthIncluded = accountingStatus === "posted" && (accountId === selectedAccount.id || transactionAccountIds.includes(selectedAccount.id));
      const totalLabourCost = numberValue(normalizedPayload.totalLabourCost ?? normalizedPayload.totalEarned);
      const advancesApplied = numberValue(normalizedPayload.advancesPaid ?? normalizedPayload.advancesAvailableUpToSettlementDate);
      const settledAdvanceAmount = numberValue(normalizedPayload.settledAdvanceAmount ?? normalizedPayload.appliedAdvances);
      const cashPaid = numberValue(payload.cashPaid ?? normalizedPayload.payableBalance ?? normalizedPayload.cashPayable);
      const carryForwardAdvance = numberValue(normalizedPayload.carryForwardAdvance);
      const excludedReason = settlementExclusionReason({
        status,
        accountingStatus,
        currentHelperIncluded,
        sourceOfTruthIncluded,
        settlementAccountId: accountId,
        transactionAccountIds,
        selectedAccountId: selectedAccount.id,
      });
      return {
        id: row.id,
        settlementNumber: normalizedPayload.settlementNumber,
        status,
        linkedAccountId: firstString(payload.linkedAccountId),
        paymentAccountId: firstString(payload.paymentAccountId),
        accountId: firstString(payload.accountId),
        partnerAccountId: firstString(payload.partnerAccountId),
        labourAccountId: firstString(payload.labourAccountId),
        totalLabourCost,
        advancesApplied,
        settledAdvanceAmount,
        cashPaid,
        carryForwardAdvance,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        postedAt: firstString(payload.postedAt, payload.accountedAt, row.updatedAt.toISOString()),
        voidedAt: firstString(payload.voidedAt),
        reversedAt: firstString(payload.reversedAt),
        deletedAt: firstString(payload.deletedAt),
        linkedVoucherNumber: firstString(payload.linkedVoucherNumber),
        linkedVoucherId: firstString(payload.linkedVoucherId),
        accountingEntries,
        transactionAccountIds,
        transactionRemarks,
        currentHelperIncluded,
        sourceOfTruthIncluded,
        excludedReason,
      };
    }).filter((row) =>
      row.currentHelperIncluded
      || row.sourceOfTruthIncluded
      || row.excludedReason !== "Settlement row is not linked to the selected account."
    );

    const helperSnapshot = buildPartnerSnapshot({
      selectedAccountId: selectedAccount.id,
      advances,
      settlements: settlementRows,
      vouchers,
      partnerEntries,
      sales,
      useTransactionFallback: false,
    });
    const sourceOfTruthSnapshot = buildPartnerSnapshot({
      selectedAccountId: selectedAccount.id,
      advances,
      settlements: settlementRows,
      vouchers,
      partnerEntries,
      sales,
      useTransactionFallback: true,
    });

    return {
      buildInfo,
      workspaceId,
      farmId,
      seasonId,
      session: {
        activeFarmId: session?.activeFarmId ?? farmId,
        activeSeasonId: session?.activeSeasonId ?? seasonId,
      },
      accountName,
      account: selectedAccount,
      matchingAccounts,
      advances: {
        rowsFound: advances.length,
        rows: advances.map((row) => ({
          ...row,
          includedById: row.accountId === selectedAccount.id && !row.deleted,
          includedByName: row.sourceAccountName ? lowerTrim(row.sourceAccountName) === lowerTrim(selectedAccount.name) : false,
        })),
      },
      labourWageSettlements: {
        rowsFound: settlementRows.length,
        rows: settlementRows,
        helperSnapshot,
        sourceOfTruthSnapshot,
        mismatch: helperSnapshot.labourAdvancesSettledThroughWageSettlements !== sourceOfTruthSnapshot.labourAdvancesSettledThroughWageSettlements
          || helperSnapshot.outstandingLabourAdvances !== sourceOfTruthSnapshot.outstandingLabourAdvances,
      },
      partnerStatusValues: sourceOfTruthSnapshot,
      currentHelperValues: helperSnapshot,
      exclusions: settlementRows.filter((row) => !row.currentHelperIncluded && !row.sourceOfTruthIncluded).map((row) => ({
        settlementId: row.id,
        settlementNumber: row.settlementNumber,
        reason: row.excludedReason,
      })),
    };
  });
}

export async function accountingReconciliationRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/debug/accounting-reconciliation", { preHandler: requireUser }, async (request, reply) => {
    if (process.env.NODE_ENV === "production" && process.env.RENDER_GIT_BRANCH !== "dev") {
      return reply.code(404).send({ message: "Not found." });
    }
    const appUser = request.appUser;
    if (!appUser) {
      return reply.code(401).send({ message: "Authentication token is required." });
    }
    if (!hasPermission(appUser, "VIEW_REPORTS", appUser.workspaceId ?? undefined)) {
      return reply.code(403).send({ message: "Workspace report permission is required." });
    }
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ message: "accountName is required." });
    }
    const isPlatformAdmin = appUser.platformRole === "platform_admin";
    const currentWorkspaceId = appUser.workspaceId ?? null;
    const requestWorkspaceId = parsed.data.workspaceId ?? currentWorkspaceId;
    if (!requestWorkspaceId) {
      return reply.code(400).send({ message: "Select a workspace/farm/season first, or provide workspaceId as platform admin." });
    }
    if (appUser.workspaceId && requestWorkspaceId !== appUser.workspaceId) {
      return reply.code(403).send({ message: "Workspace selection does not match the authenticated session." });
    }
    if (parsed.data.workspaceId && !isPlatformAdmin && parsed.data.workspaceId !== appUser.workspaceId) {
      return reply.code(403).send({ message: "Only platform admins can override the workspace for this trace." });
    }

    const session = request.sessionId
      ? await db.select({
        activeFarmId: userSessions.activeFarmId,
        activeSeasonId: userSessions.activeSeasonId,
      }).from(userSessions).where(eq(userSessions.id, request.sessionId)).limit(1).then(([row]) => row ?? null)
      : null;
    const selectedFarmId = parsed.data.farmId ?? session?.activeFarmId ?? null;
    const selectedSeasonId = parsed.data.seasonId ?? session?.activeSeasonId ?? null;
    const sessionBacked = Boolean(request.sessionId);
    if (!selectedFarmId || !selectedSeasonId) {
      return reply.code(400).send({ message: "Select a workspace/farm/season first, or provide workspaceId as platform admin." });
    }
    const ownershipError = await validateTenantReferences(requestWorkspaceId, {
      farmId: selectedFarmId,
      seasonId: selectedSeasonId,
    });
    if (ownershipError) return reply.code(403).send({ message: ownershipError });

    const trace = await buildAccountingReconciliationTrace(
      parsed.data.accountName,
      requestWorkspaceId,
      selectedFarmId,
      selectedSeasonId,
    );
    return {
      ...trace,
      debugContext: {
        currentUserId: appUser.id,
        currentAuthType: appUser.platformRole ?? "workspace_user",
        currentWorkspaceId,
        currentFarmId: session?.activeFarmId ?? null,
        currentSeasonId: session?.activeSeasonId ?? null,
        sessionBacked,
        workspaceContextBacked: Boolean(session?.activeFarmId && session?.activeSeasonId),
        requestedWorkspaceId: parsed.data.workspaceId ?? null,
        requestedFarmId: parsed.data.farmId ?? null,
        requestedSeasonId: parsed.data.seasonId ?? null,
        resolvedWorkspaceId: requestWorkspaceId,
        resolvedFarmId: selectedFarmId,
        resolvedSeasonId: selectedSeasonId,
        canOverrideWorkspace: isPlatformAdmin,
      },
    };
  });
}
