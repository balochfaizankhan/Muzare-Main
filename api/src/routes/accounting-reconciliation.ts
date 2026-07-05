import type { FastifyInstance } from "fastify";
import { and, eq, ilike, or, sql } from "drizzle-orm";
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
  accountName: z.string().trim().optional(),
  accountId: z.string().uuid().optional(),
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
  farmId: string | null;
  seasonId: string | null;
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
  farmId: string | null;
  seasonId: string | null;
  farmName: string | null;
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
  farmId: string | null;
  seasonId: string | null;
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
  farmFilterApplied: boolean;
  seasonFilterApplied: boolean;
  farmMatches: boolean;
  seasonMatches: boolean;
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
  if (!input.farmMatches && input.farmFilterApplied) return "Settlement is excluded by the selected farm filter.";
  if (!input.seasonMatches && input.seasonFilterApplied) return "Settlement is excluded by the selected season filter.";
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
    farmId: string | null;
    seasonId: string | null;
  }>;
  sales: Array<{ accountId: string | null; amount: number; farmId: string | null; seasonId: string | null }>;
  useTransactionFallback: boolean;
  farmId?: string | null;
  seasonId?: string | null;
}) {
  const { selectedAccountId, advances, settlements, vouchers, partnerEntries, sales, useTransactionFallback, farmId, seasonId } = args;
  const farmMatches = (rowFarmId: string | null) => !farmId || rowFarmId === farmId;
  const seasonMatches = (rowSeasonId: string | null) => !seasonId || rowSeasonId === seasonId;
  const purchaseVouchersPaid = vouchers
    .filter((voucher) => voucher.accountId === selectedAccountId && !voucher.isLabourWageSettlementVoucher)
    .reduce((sum, voucher) => sum + voucher.amount, 0);
  const businessFundsGiven = partnerEntries
    .filter((entry) => entry.type === "settlement" && entry.fromAccountId === selectedAccountId && farmMatches(entry.farmId) && seasonMatches(entry.seasonId))
    .reduce((sum, entry) => sum + entry.amount, 0);
  const businessFundsReceived = partnerEntries
    .filter((entry) => entry.type === "settlement" && entry.toAccountId === selectedAccountId && farmMatches(entry.farmId) && seasonMatches(entry.seasonId))
    .reduce((sum, entry) => sum + entry.amount, 0);
  const moneyReturned = partnerEntries
    .filter((entry) => entry.type === "withdrawal")
    .filter((entry) => (entry.partnerAccountId === selectedAccountId || entry.accountId === selectedAccountId) && farmMatches(entry.farmId) && seasonMatches(entry.seasonId))
    .reduce((sum, entry) => sum + entry.amount, 0);
  const capitalInjected = partnerEntries
    .filter((entry) => entry.type === "contribution")
    .filter((entry) => (entry.partnerAccountId === selectedAccountId || entry.accountId === selectedAccountId) && farmMatches(entry.farmId) && seasonMatches(entry.seasonId))
    .reduce((sum, entry) => sum + entry.amount, 0);
  const adjustments = partnerEntries
    .filter((entry) => entry.type === "adjustment")
    .filter((entry) => (entry.partnerAccountId === selectedAccountId || entry.accountId === selectedAccountId) && farmMatches(entry.farmId) && seasonMatches(entry.seasonId))
    .reduce((sum, entry) => sum + entry.amount, 0)
    - sales.filter((sale) => sale.accountId === selectedAccountId && farmMatches(sale.farmId) && seasonMatches(sale.seasonId)).reduce((sum, sale) => sum + sale.amount, 0);
  const totalLabourAdvancesPaid = advances
    .filter((advance) => advance.accountId === selectedAccountId && !advance.deleted && farmMatches(advance.farmId) && seasonMatches(advance.seasonId))
    .reduce((sum, advance) => sum + advance.amount, 0);
  const settlementSnapshot = includedSettlementSnapshot(
    settlements.filter((row) => farmMatches(row.farmId) && seasonMatches(row.seasonId)),
    selectedAccountId,
    useTransactionFallback,
  );
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

export async function buildAccountingReconciliationTrace(input: {
  workspaceId: string;
  accountName?: string;
  accountId?: string;
  farmId?: string | null;
  seasonId?: string | null;
}) {
  const {
    workspaceId,
    accountName = "",
    accountId,
    farmId = null,
    seasonId = null,
  } = input;
  return db.transaction(async (tx) => {
    const accountSearch = accountName.trim().toLowerCase();
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
      accountId
        ? eq(accounts.id, accountId)
        : accountSearch
          ? or(
            ilike(accounts.name, `%${accountSearch}%`),
            ilike(sql`${accounts.id}::text`, `%${accountSearch}%`),
            ilike(sql`COALESCE(${accounts.oldAndroidId}::text, '')`, `%${accountSearch}%`),
          )
          : undefined,
    )).orderBy(accounts.name);

    const selectedAccount = (accountId ? matchingAccounts.find((row) => row.id === accountId) : matchingAccounts.find((row) => row.farmId === farmId)) ?? matchingAccounts[0] ?? null;
    if (!selectedAccount) {
      return {
        buildInfo,
        workspaceId,
        farmId,
        seasonId,
        accountName,
        accountId: accountId ?? null,
        account: null,
        matchingAccounts,
        message: "No account matched the requested name in this workspace.",
      };
    }

    const advanceRecords = await tx.select({
      id: operationalRecords.clientRecordId,
      farmId: operationalRecords.farmId,
      seasonId: operationalRecords.seasonId,
      createdAt: operationalRecords.createdAt,
      updatedAt: operationalRecords.updatedAt,
      payload: operationalRecords.payload,
    }).from(operationalRecords).where(and(
      eq(operationalRecords.workspaceId, workspaceId),
      eq(operationalRecords.entityType, "advance"),
    ));
    const voucherRecords = await tx.select({
      farmId: operationalRecords.farmId,
      seasonId: operationalRecords.seasonId,
      payload: operationalRecords.payload,
    }).from(operationalRecords).where(and(
      eq(operationalRecords.workspaceId, workspaceId),
      eq(operationalRecords.entityType, "voucher"),
    ));
    const partnerEntryRecords = await tx.select({
      id: operationalRecords.clientRecordId,
      farmId: operationalRecords.farmId,
      seasonId: operationalRecords.seasonId,
      payload: operationalRecords.payload,
    }).from(operationalRecords).where(and(
      eq(operationalRecords.workspaceId, workspaceId),
      eq(operationalRecords.entityType, "partnerEntry"),
    ));
    const saleRecords = await tx.select({
      id: operationalRecords.clientRecordId,
      farmId: operationalRecords.farmId,
      seasonId: operationalRecords.seasonId,
      payload: operationalRecords.payload,
    }).from(operationalRecords).where(and(
      eq(operationalRecords.workspaceId, workspaceId),
      eq(operationalRecords.entityType, "sale"),
    ));
    const settlementRecords = await tx.select({
      id: operationalRecords.clientRecordId,
      farmId: operationalRecords.farmId,
      seasonId: operationalRecords.seasonId,
      farmName: farms.name,
      createdAt: operationalRecords.createdAt,
      updatedAt: operationalRecords.updatedAt,
      payload: operationalRecords.payload,
    }).from(operationalRecords).innerJoin(farms, eq(farms.id, operationalRecords.farmId)).where(and(
      eq(operationalRecords.workspaceId, workspaceId),
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
      farmId: accountTransactions.farmId,
      seasonId: accountTransactions.seasonId,
      remarks: accountTransactions.remarks,
    }).from(accountTransactions).where(and(
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
          farmId: row.farmId,
          seasonId: row.seasonId,
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
        farmId: row.farmId,
        seasonId: row.seasonId,
      };
    });

    const sales = saleRecords.map((row) => {
      const payload = row.payload as Record<string, unknown>;
      return {
        accountId: firstString(payload.accountId),
        amount: numberValue(payload.amount),
        farmId: row.farmId,
        seasonId: row.seasonId,
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
          farmId: row.farmId,
          seasonId: row.seasonId,
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
        const farmMatches = !farmId || row.farmId === farmId;
        const seasonMatches = !seasonId || row.seasonId === seasonId;
        const currentHelperIncluded = accountingStatus === "posted" && accountId === selectedAccount.id && farmMatches && seasonMatches;
        const sourceOfTruthIncluded = accountingStatus === "posted" && (accountId === selectedAccount.id || transactionAccountIds.includes(selectedAccount.id)) && farmMatches && seasonMatches;
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
          farmFilterApplied: Boolean(farmId),
          seasonFilterApplied: Boolean(seasonId),
          farmMatches,
          seasonMatches,
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
          farmId: row.farmId,
          seasonId: row.seasonId,
          farmName: row.farmName,
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
        farmId,
        seasonId,
      });
      const sourceOfTruthSnapshot = buildPartnerSnapshot({
        selectedAccountId: selectedAccount.id,
        advances,
        settlements: settlementRows,
        vouchers,
        partnerEntries,
        sales,
        useTransactionFallback: true,
        farmId,
        seasonId,
      });

      return {
        buildInfo,
        workspaceId,
        farmId,
        seasonId,
        selectedContext: {
          workspaceId,
          farmId,
          seasonId,
        },
        filtersApplied: {
          farmId: Boolean(farmId),
          seasonId: Boolean(seasonId),
        },
        accountName,
        accountId: accountId ?? null,
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
          rowsBeforeFilters: settlementRows.length,
          rowsAfterFilters: settlementRows.filter((row) => (!farmId || row.farmId === farmId) && (!seasonId || row.seasonId === seasonId)).length,
          rows: settlementRows,
          filteredRows: settlementRows.filter((row) => (!farmId || row.farmId === farmId) && (!seasonId || row.seasonId === seasonId)),
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
    if (!parsed.data.accountName && !parsed.data.accountId) {
      return reply.code(400).send({ message: "Select an account name or account id." });
    }
    const permissionMode = isPlatformAdmin ? "platform_admin_override" : "workspace_report_permission";
    let permissionPassed = false;
    let permissionFailureReason: string | null = null;
    if (isPlatformAdmin) {
      permissionPassed = true;
    } else if (currentWorkspaceId && requestWorkspaceId !== currentWorkspaceId) {
      permissionFailureReason = "Workspace selection does not match the authenticated session.";
    } else if (!hasPermission(appUser, "VIEW_REPORTS", requestWorkspaceId)) {
      permissionFailureReason = "Workspace report permission is required.";
    } else {
      permissionPassed = true;
    }
    if (!permissionPassed) {
      return reply.code(403).send({
        message: permissionFailureReason ?? "Workspace report permission is required.",
        debugContext: {
          authType: appUser.platformRole ?? "workspace_user",
          isPlatformAdmin,
          workspaceId: requestWorkspaceId,
          permissionMode,
          permissionPassed,
          reason: permissionFailureReason ?? "Workspace report permission is required.",
        },
      });
    }
    if (parsed.data.workspaceId && !isPlatformAdmin && parsed.data.workspaceId !== appUser.workspaceId) {
      return reply.code(403).send({
        message: "Only platform admins can override the workspace for this trace.",
        debugContext: {
          authType: appUser.platformRole ?? "workspace_user",
          isPlatformAdmin,
          workspaceId: requestWorkspaceId,
          permissionMode,
          permissionPassed: false,
          reason: "Only platform admins can override the workspace for this trace.",
        },
      });
    }

    const session = !isPlatformAdmin && request.sessionId
      ? await db.select({
        activeFarmId: userSessions.activeFarmId,
        activeSeasonId: userSessions.activeSeasonId,
      }).from(userSessions).where(eq(userSessions.id, request.sessionId)).limit(1).then(([row]) => row ?? null)
      : null;
    const selectedFarmId = parsed.data.farmId ?? (isPlatformAdmin ? null : session?.activeFarmId ?? null);
    const selectedSeasonId = parsed.data.seasonId ?? (isPlatformAdmin ? null : session?.activeSeasonId ?? null);
    const sessionBacked = Boolean(request.sessionId && !isPlatformAdmin);
    if (!selectedFarmId && !selectedSeasonId && !requestWorkspaceId) {
      return reply.code(400).send({ message: "Select a workspace/farm/season first, or provide workspaceId as platform admin." });
    }
    if (selectedFarmId || selectedSeasonId) {
      const ownershipError = await validateTenantReferences(requestWorkspaceId, {
        farmId: selectedFarmId ?? undefined,
        seasonId: selectedSeasonId ?? undefined,
      });
      if (ownershipError) return reply.code(403).send({ message: ownershipError });
    }

    const trace = await buildAccountingReconciliationTrace({
      workspaceId: requestWorkspaceId,
      accountName: parsed.data.accountName ?? "",
      accountId: parsed.data.accountId,
      farmId: selectedFarmId ?? undefined,
      seasonId: selectedSeasonId ?? undefined,
    });
    return {
      ...trace,
      debugContext: {
        currentUserId: appUser.id,
        authType: appUser.platformRole ?? "workspace_user",
        currentAuthType: appUser.platformRole ?? "workspace_user",
        isPlatformAdmin,
        currentWorkspaceId,
        currentFarmId: session?.activeFarmId ?? null,
        currentSeasonId: session?.activeSeasonId ?? null,
        sessionBacked,
        workspaceContextBacked: Boolean(currentWorkspaceId && selectedFarmId && selectedSeasonId),
        permissionMode,
        permissionPassed,
        requestedWorkspaceId: parsed.data.workspaceId ?? null,
        requestedFarmId: parsed.data.farmId ?? null,
        requestedSeasonId: parsed.data.seasonId ?? null,
        resolvedWorkspaceId: requestWorkspaceId,
        resolvedFarmId: selectedFarmId,
        resolvedSeasonId: selectedSeasonId,
        canOverrideWorkspace: isPlatformAdmin,
        permissionFailureReason,
      },
    };
  });
}
