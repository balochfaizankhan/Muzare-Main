import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Search, Printer, Download, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../../auth/AuthProvider";
import { createLabourWageSettlement, deleteLabourWageSettlement, fetchAttendanceReport, fetchLabourWageSettlement, fetchLabourWageSettlementPaymentAccounts, fetchLabourWageSettlements, previewLabourWageSettlement, repairLabourWageSettlementAccounting, updateLabourWageSettlement, voidLabourWageSettlement, type AttendanceReportData, type LabourWageSettlementDetail, type LabourWageSettlementPaymentAccount, type LabourWageSettlementPreview } from "../../lib/api";
import { formatMoney } from "../../lib/format";
import { getActiveFarmId, getActiveSeasonId, offlineDb, workspaceRecords, type Account, type LabourGroup, type LabourWageSettlement, type Labourer } from "../../lib/offline-db";
import { canCreate } from "../../lib/permissions";

const today = () => new Date().toISOString().slice(0, 10);
const money = formatMoney;

type PreviewState =
  | { status: "idle"; data: null }
  | { status: "loading"; data: null }
  | { status: "ready"; data: LabourWageSettlementPreview }
  | { status: "error"; data: null };

export function LabourWageSettlements() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { token, user } = useAuth();
  const workspaceId = user?.workspaceId ?? "";
  const activeFarmId = getActiveFarmId();
  const activeSeasonId = getActiveSeasonId();
  const canPost = Boolean(user && workspaceId && canCreate(user, "wages", workspaceId));

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [labourers, setLabourers] = useState<Labourer[]>([]);
  const [labourGroups, setLabourGroups] = useState<LabourGroup[]>([]);
  const [paymentAccounts, setPaymentAccounts] = useState<LabourWageSettlementPaymentAccount[]>([]);
  const [settlements, setSettlements] = useState<LabourWageSettlement[]>([]);
  const [settlementDate, setSettlementDate] = useState(today());
  const [fromDate, setFromDate] = useState(`${today().slice(0, 8)}01`);
  const [toDate, setToDate] = useState(today());
  const [settlementMode, setSettlementMode] = useState<"individual" | "group">("individual");
  const [labourerId, setLabourerId] = useState("");
  const [foremanId, setForemanId] = useState("");
  const [groupId, setGroupId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [paidAmount, setPaidAmount] = useState("0");
  const [manualAdjustment, setManualAdjustment] = useState("0");
  const [manualAdjustmentNote, setManualAdjustmentNote] = useState("");
  const [notes, setNotes] = useState("");
  const [preview, setPreview] = useState<PreviewState>({ status: "idle", data: null });
  const [attendanceComparison, setAttendanceComparison] = useState<{
    status: "idle" | "loading" | "ready" | "error";
    data: AttendanceReportData | null;
    error: string;
  }>({ status: "idle", data: null, error: "" });
  const [historyLoading, setHistoryLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [savingSettlementId, setSavingSettlementId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [registerSearch, setRegisterSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "posted" | "voided" | "accounting_missing">("all");
  const [paymentAccountFilter, setPaymentAccountFilter] = useState("all");
  const [selectedSettlement, setSelectedSettlement] = useState<LabourWageSettlementDetail | null>(null);
  const [selectedSettlementMode, setSelectedSettlementMode] = useState<"view" | "edit">("view");
  const [selectedSettlementLoading, setSelectedSettlementLoading] = useState(false);
  const [editForm, setEditForm] = useState({ fromDate: "", toDate: "", settlementDate: "", accountId: "", notes: "" });
  const [repairingSettlementId, setRepairingSettlementId] = useState<string | null>(null);
  const [deletingSettlement, setDeletingSettlement] = useState<LabourWageSettlement | null>(null);
  const [deletingSettlementId, setDeletingSettlementId] = useState<string | null>(null);
  const [voidingSettlement, setVoidingSettlement] = useState<LabourWageSettlementDetail | null>(null);
  const [voidingSettlementId, setVoidingSettlementId] = useState<string | null>(null);
  const [voidReason, setVoidReason] = useState("");

  const onlineRequired = !navigator.onLine;

  const refresh = useCallback(async () => {
    const [cachedAccounts, cachedSettlements] = await Promise.all([
      workspaceRecords(offlineDb.accounts),
      workspaceRecords(offlineDb.labourWageSettlements),
    ]);
    setAccounts(cachedAccounts.filter((account) => account.type === "cash" || account.type === "bank" || account.type === "partner"));
    setLabourers(await workspaceRecords(offlineDb.labourers));
    setLabourGroups(await workspaceRecords(offlineDb.labourGroups));
    setSettlements(cachedSettlements.sort((left, right) => right.settlementDate.localeCompare(left.settlementDate) || right.updatedAt.localeCompare(left.updatedAt)));
  }, []);

  const syncFromServer = useCallback(async () => {
    if (!token || !workspaceId || !activeFarmId || !activeSeasonId || !navigator.onLine) return;
    setHistoryLoading(true);
    try {
      const [response, paymentAccountResponse] = await Promise.all([
        fetchLabourWageSettlements(token, workspaceId, {
          farmId: activeFarmId,
          seasonId: activeSeasonId,
        }),
        fetchLabourWageSettlementPaymentAccounts(token, workspaceId, activeFarmId),
      ]);
      setPaymentAccounts(paymentAccountResponse.accounts);
      await offlineDb.labourWageSettlements.bulkPut(response.settlements.map((settlement) => ({
        id: settlement.id,
        workspaceId,
        farmId: activeFarmId,
        seasonId: activeSeasonId,
        settlementNumber: settlement.settlementNumber,
        linkedVoucherId: settlement.linkedVoucherId,
        linkedVoucherNumber: settlement.linkedVoucherNumber,
        linkedAccountId: settlement.linkedAccountId,
        fromDate: settlement.fromDate,
        toDate: settlement.toDate,
        settlementDate: settlement.settlementDate,
        attendanceWages: settlement.attendanceWages,
        labourWorkWages: settlement.labourWorkWages,
        pendingLabourEarnings: settlement.pendingLabourEarnings,
        grossWages: settlement.grossWages ?? settlement.totalEarned,
        totalEarned: settlement.totalEarned,
        availableAdvanceBalanceBeforeSettlement: settlement.availableAdvanceBalanceBeforeSettlement,
        advancesPaid: settlement.advancesPaid,
        advanceAdjustedNow: settlement.advanceAdjustedNow ?? settlement.settledAdvanceAmount,
        settledAdvanceAmount: settlement.settledAdvanceAmount,
        expenseAmount: settlement.expenseAmount,
        remainingAdvanceCarryForward: settlement.remainingAdvanceCarryForward ?? settlement.carryForwardAdvance,
        carryForwardAdvance: settlement.carryForwardAdvance,
        manualAdjustment: settlement.manualAdjustment,
        manualAdjustmentNote: settlement.manualAdjustmentNote ?? null,
        netPayableBeforePayment: settlement.netPayableBeforePayment,
        paidAmount: settlement.paidAmount ?? settlement.payableBalance,
        payableBalance: settlement.payableBalance,
        balanceAfterPayment: settlement.balanceAfterPayment ?? settlement.payableBalance,
        paymentAccountId: settlement.paymentAccountId ?? settlement.linkedAccountId,
        settlementMode: settlement.settlementMode,
        foremanId: settlement.foremanId ?? null,
        groupId: settlement.groupId ?? null,
        groupName: settlement.groupName ?? null,
        includedLabourIds: settlement.includedLabourIds ?? [],
        includedInactiveLabourIds: settlement.includedInactiveLabourIds ?? [],
        includedActiveLabourIds: settlement.includedActiveLabourIds ?? [],
        includedLabourRows: settlement.includedLabourRows ?? [],
        excludedLabourers: settlement.excludedLabourers ?? [],
        attendanceTotals: settlement.attendanceTotals ?? undefined,
        sourceAttendanceIds: settlement.sourceAttendanceIds ?? [],
        sourceLabourWorkIds: settlement.sourceLabourWorkIds ?? [],
        advanceAdjustmentAllocations: settlement.advanceAdjustmentAllocations ?? [],
        settlementScopeSnapshot: settlement.settlementScopeSnapshot ?? undefined,
        notes: settlement.notes,
        status: settlement.status,
        accountingStatus: settlement.accountingStatus,
        accountingMessage: settlement.accountingMessage ?? null,
        createdBy: settlement.createdBy,
        createdAt: settlement.createdAt,
        updatedAt: settlement.updatedAt,
        deletedAt: settlement.deletedAt ?? null,
        deletedBy: settlement.deletedBy ?? null,
        voidedAt: settlement.voidedAt ?? null,
        voidedBy: settlement.voidedBy ?? null,
        voidReason: settlement.voidReason ?? null,
        pendingSync: false,
      })));
      window.dispatchEvent(new Event("muzare-local-data-change"));
    } catch {
      // keep cached settlement history when the network is unavailable or the refresh fails
    } finally {
      setHistoryLoading(false);
      await refresh();
    }
  }, [activeFarmId, activeSeasonId, refresh, token, workspaceId]);

  useEffect(() => {
    void refresh();
    const handle = () => void refresh();
    window.addEventListener("muzare-data-refresh", handle);
    window.addEventListener("muzare-local-data-change", handle);
    return () => {
      window.removeEventListener("muzare-data-refresh", handle);
      window.removeEventListener("muzare-local-data-change", handle);
    };
  }, [refresh]);

  useEffect(() => {
    void syncFromServer();
  }, [syncFromServer]);

  useEffect(() => {
    const presetGroupId = searchParams.get("groupId");
    if (presetGroupId && !groupId) {
      setSettlementMode("group");
      setGroupId(presetGroupId);
    }
    const presetForemanId = searchParams.get("foremanId");
    if (presetForemanId && !foremanId) {
      setSettlementMode("group");
      setForemanId(presetForemanId);
    }
  }, [foremanId, groupId, searchParams]);

  useEffect(() => {
    if (!token || !workspaceId || !selectedSettlement?.id || !navigator.onLine) return;
    let cancelled = false;
    setSelectedSettlementLoading(true);
    void fetchLabourWageSettlement(token, workspaceId, selectedSettlement.id)
      .then((response) => {
        if (!cancelled) setSelectedSettlement(response.settlement);
      })
      .catch(() => {
        // keep cached details if the network refresh fails
      })
      .finally(() => {
        if (!cancelled) setSelectedSettlementLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedSettlement?.id, token, workspaceId]);

  useEffect(() => {
    if (!accountId && paymentAccounts.length) {
      setAccountId(paymentAccounts.find((account) => account.accountType === "cash" || account.accountType === "bank")?.id
        ?? paymentAccounts[0]?.id
        ?? "");
    }
  }, [accountId, paymentAccounts]);

  useEffect(() => {
    const recordId = searchParams.get("recordId");
    if (!recordId || !settlements.length) return;
    const match = settlements.find((settlement) => settlement.id === recordId);
    if (!match) return;
    setSelectedSettlement(match);
    setSelectedSettlementMode("view");
    const next = new URLSearchParams(searchParams);
    next.delete("recordId");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, settlements]);

  const previewSettlement = async () => {
    if (!token || !workspaceId || !activeFarmId || !activeSeasonId) {
      setError(t("farmsPage.noActiveSeason"));
      return;
    }
    if (fromDate > toDate) {
      setError("From date must be on or before the to date.");
      return;
    }
    setPreview({ status: "loading", data: null });
    setError("");
    setSuccess("");
    try {
      const response = await previewLabourWageSettlement(token, workspaceId, {
        farmId: activeFarmId,
        seasonId: activeSeasonId,
        fromDate,
        toDate,
        settlementDate,
        settlementMode,
        labourerId: settlementMode === "individual" ? labourerId || undefined : undefined,
        foremanId: settlementMode === "group" ? foremanId || undefined : undefined,
        groupId: settlementMode === "group" ? groupId || undefined : undefined,
        paidAmount: Number(paidAmount || 0),
        manualAdjustment: Number(manualAdjustment || 0),
      });
      setPreview({ status: "ready", data: response.preview });
    } catch (caught) {
      setPreview({ status: "error", data: null });
      setError(caught instanceof Error ? caught.message : "Unable to preview this wage settlement.");
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canPost) {
      setError(t("common.viewOnlyAccess"));
      return;
    }
    if (onlineRequired) {
      setError("Wage settlement requires online connection.");
      return;
    }
    if (!token || !workspaceId || !activeFarmId || !activeSeasonId) {
      setError("Select an active farm and season before creating a settlement.");
      return;
    }
    if (Number(paidAmount || 0) > 0 && !accountId) {
      setError("Select a payment account when paid now is greater than zero.");
      return;
    }
    if (settlementMode === "individual" && !labourerId) {
      setError("Select a labourer for an individual settlement.");
      return;
    }
    if (settlementMode === "group" && !groupId && !foremanId) {
      setError("Select a foreman or group for a group settlement.");
      return;
    }
    if (Number(manualAdjustment || 0) !== 0 && !manualAdjustmentNote.trim()) {
      setError("Manual adjustment note is required when manual adjustment is non-zero.");
      return;
    }
    if (preview.status !== "ready") {
      setError("Preview the settlement before posting it.");
      return;
    }
    if (preview.data.unresolvedRows.length || preview.data.overlappingSettlements.length) {
      setError("This wage settlement still has unresolved wage rates or overlapping settlements.");
      return;
    }
    setSubmitting(true);
    setError("");
    setSuccess("");
    try {
      const response = await createLabourWageSettlement(token, workspaceId, {
        farmId: activeFarmId,
        seasonId: activeSeasonId,
        fromDate,
        toDate,
        settlementDate,
        settlementMode,
        labourerId: settlementMode === "individual" ? labourerId || undefined : undefined,
        foremanId: settlementMode === "group" ? foremanId || undefined : undefined,
        groupId: settlementMode === "group" ? groupId || undefined : undefined,
        paymentAccountId: Number(paidAmount || 0) > 0 ? accountId : undefined,
        paidAmount: Number(paidAmount || 0),
        manualAdjustment: Number(manualAdjustment || 0),
        manualAdjustmentNote: Number(manualAdjustment || 0) !== 0 ? manualAdjustmentNote.trim() : undefined,
        notes: notes.trim() || undefined,
      });
      await offlineDb.labourWageSettlements.put({
        id: response.settlement.id,
        workspaceId,
        farmId: activeFarmId,
        seasonId: activeSeasonId,
        settlementNumber: response.settlement.settlementNumber,
        linkedVoucherId: response.settlement.linkedVoucherId || "",
        linkedVoucherNumber: response.settlement.linkedVoucherNumber || response.settlement.settlementNumber,
        linkedAccountId: response.settlement.linkedAccountId,
        settlementMode: response.settlement.settlementMode,
        foremanId: response.settlement.foremanId ?? null,
        groupId: response.settlement.groupId ?? null,
        groupName: response.settlement.groupName ?? null,
        includedLabourIds: response.settlement.includedLabourIds ?? [],
        includedInactiveLabourIds: response.settlement.includedInactiveLabourIds ?? [],
        includedActiveLabourIds: response.settlement.includedActiveLabourIds ?? [],
        includedLabourRows: response.settlement.includedLabourRows ?? [],
        excludedLabourers: response.settlement.excludedLabourers ?? [],
        attendanceTotals: response.settlement.attendanceTotals ?? undefined,
        fromDate: response.settlement.fromDate,
        toDate: response.settlement.toDate,
        settlementDate: response.settlement.settlementDate,
        attendanceWages: response.settlement.attendanceWages,
        labourWorkWages: response.settlement.labourWorkWages,
        pendingLabourEarnings: response.settlement.pendingLabourEarnings,
        grossWages: response.settlement.grossWages ?? response.settlement.totalEarned,
        totalEarned: response.settlement.totalEarned,
        availableAdvanceBalanceBeforeSettlement: response.settlement.availableAdvanceBalanceBeforeSettlement,
        advancesPaid: response.settlement.advancesPaid,
        advanceAdjustedNow: response.settlement.advanceAdjustedNow ?? response.settlement.settledAdvanceAmount,
        settledAdvanceAmount: response.settlement.settledAdvanceAmount,
        expenseAmount: response.settlement.expenseAmount,
        remainingAdvanceCarryForward: response.settlement.remainingAdvanceCarryForward ?? response.settlement.carryForwardAdvance,
        carryForwardAdvance: response.settlement.carryForwardAdvance,
        manualAdjustment: response.settlement.manualAdjustment,
        manualAdjustmentNote: response.settlement.manualAdjustmentNote ?? null,
        netPayableBeforePayment: response.settlement.netPayableBeforePayment,
        paidAmount: response.settlement.paidAmount ?? response.settlement.payableBalance,
        payableBalance: response.settlement.payableBalance,
        balanceAfterPayment: response.settlement.balanceAfterPayment ?? response.settlement.payableBalance,
        paymentAccountId: response.settlement.paymentAccountId ?? response.settlement.linkedAccountId,
        sourceAttendanceIds: response.settlement.sourceAttendanceIds ?? [],
        sourceLabourWorkIds: response.settlement.sourceLabourWorkIds ?? [],
        advanceAdjustmentAllocations: response.settlement.advanceAdjustmentAllocations ?? [],
        settlementScopeSnapshot: response.settlement.settlementScopeSnapshot ?? undefined,
        notes: response.settlement.notes,
        status: response.settlement.status,
        accountingStatus: response.settlement.accountingStatus,
        accountingMessage: response.settlement.accountingMessage ?? null,
        createdBy: response.settlement.createdBy,
        createdAt: response.settlement.createdAt,
        updatedAt: response.settlement.updatedAt,
        deletedAt: response.settlement.deletedAt ?? null,
        deletedBy: response.settlement.deletedBy ?? null,
        voidedAt: response.settlement.voidedAt ?? null,
        voidedBy: response.settlement.voidedBy ?? null,
        voidReason: response.settlement.voidReason ?? null,
        pendingSync: false,
      });
      setPreview({ status: "idle", data: null });
      setNotes("");
      setManualAdjustment("0");
      setManualAdjustmentNote("");
      setPaidAmount("0");
      setSuccess(`Settlement ${response.settlement.settlementNumber} posted. Accounting reference: ${response.settlement.settlementNumber}.`);
      window.dispatchEvent(new Event("muzare-local-data-change"));
      await syncFromServer();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to create the labour wage settlement.");
    } finally {
      setSubmitting(false);
    }
  };

  const summary = preview.status === "ready" ? preview.data : null;
  const accountById = useMemo(() => new Map(accounts.map((account) => [account.id, account])), [accounts]);
  const settlementPaymentAccountById = useMemo(() => new Map(paymentAccounts.map((account) => [account.id, account])), [paymentAccounts]);
  const includedLabourRows = summary?.includedLabourRows ?? [];
  const summaryTotals = useMemo(() => includedLabourRows.reduce((totals, row) => ({
    includedLabourers: totals.includedLabourers + 1,
    activeNowIncluded: totals.activeNowIncluded + (row.currentStatus === "active" ? 1 : 0),
    inactiveNowIncluded: totals.inactiveNowIncluded + (row.currentStatus === "inactive" ? 1 : 0),
    presentDays: totals.presentDays + row.presentDays,
    halfDayDays: totals.halfDayDays + row.halfDayDays,
    absentDays: totals.absentDays + row.absentDays,
    payableDays: totals.payableDays + row.payableDays,
    attendanceWages: totals.attendanceWages + row.attendanceWage,
    labourWorkWages: totals.labourWorkWages + row.labourWorkWage,
    grossWagesEarned: totals.grossWagesEarned + row.grossWage,
    availableAdvanceBalance: totals.availableAdvanceBalance + row.advanceAvailable,
    advanceAdjustedNow: totals.advanceAdjustedNow + row.advanceAdjustedNow,
    advanceCarriedForward: totals.advanceCarriedForward + row.advanceCarriedForward,
    netPayableBeforePayment: totals.netPayableBeforePayment + row.netPayableBeforePayment,
    paidNow: totals.paidNow + row.paidNow,
    balanceAfterSettlement: totals.balanceAfterSettlement + row.balanceAfterSettlement,
  }), {
    includedLabourers: 0,
    activeNowIncluded: 0,
    inactiveNowIncluded: 0,
    presentDays: 0,
    halfDayDays: 0,
    absentDays: 0,
    payableDays: 0,
    attendanceWages: 0,
    labourWorkWages: 0,
    grossWagesEarned: 0,
    availableAdvanceBalance: 0,
    advanceAdjustedNow: 0,
    advanceCarriedForward: 0,
    netPayableBeforePayment: 0,
    paidNow: 0,
    balanceAfterSettlement: 0,
  }), [includedLabourRows]);
  const summaryConsistent = Boolean(summary)
    && includedLabourRows.length > 0
    && summaryTotals.includedLabourers === includedLabourRows.length
    && summaryTotals.activeNowIncluded + summaryTotals.inactiveNowIncluded === summaryTotals.includedLabourers
    && !(summaryTotals.attendanceWages > 0 && summaryTotals.payableDays <= 0)
    && !(summaryTotals.payableDays === 0 && summaryTotals.attendanceWages > 0)
    && summaryTotals.presentDays >= 0
    && summaryTotals.halfDayDays >= 0
    && summaryTotals.grossWagesEarned >= 0;
  const selectedGroupName = summary?.groupName
    ?? labourGroups.find((group) => group.id === groupId || group.id === foremanId)?.name
    ?? "";
  const settlementScopeLabel = summary?.settlementMode === "group"
    ? `Group ${selectedGroupName || summary?.groupId || "-"}`
    : summary?.settlementMode === "individual"
      ? "Individual labour settlement"
      : "Settlement scope";
  const openMatchingAttendanceReport = useCallback(() => {
    if (!summary) return;
    const query = new URLSearchParams({
      report: "attendance",
      from: fromDate,
      to: toDate,
    });
    if (selectedGroupName) query.set("group", selectedGroupName);
    if (summary.settlementMode === "individual" && summary.includedLabourIds?.length) query.set("labourIds", summary.includedLabourIds.join(","));
    navigate(`/workspace/reports?${query.toString()}`);
  }, [fromDate, navigate, selectedGroupName, summary, toDate]);
  const settlementStatus = useCallback((settlement: Pick<LabourWageSettlement, "status" | "accountingStatus">) => settlement.accountingStatus ?? settlement.status, []);
  const canEditSettlement = useCallback((settlement: Pick<LabourWageSettlementDetail, "status" | "accountingStatus">) => settlement.status !== "deleted" && settlement.status !== "voided" && settlement.accountingStatus !== "posted", []);
  const canDeleteSettlement = useCallback((settlement: Pick<LabourWageSettlementDetail, "status" | "accountingStatus">) => settlement.status !== "deleted" && settlement.status !== "voided" && settlement.accountingStatus !== "posted", []);
  const canVoidSettlement = useCallback((settlement: Pick<LabourWageSettlementDetail, "status" | "accountingStatus">) => settlement.status === "posted" && settlement.accountingStatus === "posted", []);
  const activeLabourers = useMemo(() => labourers.filter((labourer) => labourer.active !== false).sort((left, right) => left.name.localeCompare(right.name)), [labourers]);
  const activeLabourGroups = useMemo(() => labourGroups.filter((group) => group.active !== false).sort((left, right) => left.name.localeCompare(right.name)), [labourGroups]);
  useEffect(() => {
    if (process.env.NODE_ENV === "production" || preview.status !== "ready" || !token || !workspaceId || !activeFarmId || !activeSeasonId) {
      setAttendanceComparison({ status: "idle", data: null, error: "" });
      return;
    }
    let cancelled = false;
    setAttendanceComparison({ status: "loading", data: null, error: "" });
    void fetchAttendanceReport(token, workspaceId, {
      farmId: activeFarmId,
      seasonId: activeSeasonId,
      from: fromDate,
      to: toDate,
      labourIds: preview.data.includedLabourIds ?? [],
    }).then((data) => {
      if (cancelled) return;
      setAttendanceComparison({ status: "ready", data: data as AttendanceReportData, error: "" });
    }).catch((caught) => {
      if (cancelled) return;
      setAttendanceComparison({ status: "error", data: null, error: caught instanceof Error ? caught.message : "Unable to load attendance comparison." });
    });
    return () => {
      cancelled = true;
    };
  }, [activeFarmId, activeSeasonId, fromDate, preview.data, preview.status, token, workspaceId, toDate]);
  const openSettlement = useCallback((settlement: LabourWageSettlement | LabourWageSettlementDetail, mode: "view" | "edit" = "view") => {
    setSelectedSettlement(settlement);
    setSelectedSettlementMode(mode);
    setVoidReason("");
    if (mode === "edit") {
      setEditForm({
        fromDate: settlement.fromDate,
        toDate: settlement.toDate,
        settlementDate: settlement.settlementDate,
        accountId: settlement.paymentAccountId ?? settlement.linkedAccountId,
        notes: settlement.notes ?? "",
      });
    }
  }, []);
  const closeSettlement = useCallback(() => {
    setSelectedSettlement(null);
    setSelectedSettlementMode("view");
    setSelectedSettlementLoading(false);
    setVoidReason("");
    setEditForm({ fromDate: "", toDate: "", settlementDate: "", accountId: "", notes: "" });
  }, []);
  const repairAccounting = useCallback(async (settlement: Pick<LabourWageSettlementDetail, "id" | "settlementNumber">) => {
    if (!token || !workspaceId) return;
    setRepairingSettlementId(settlement.id);
    setError("");
    setSuccess("");
    try {
      const response = await repairLabourWageSettlementAccounting(token, workspaceId, settlement.id);
      await offlineDb.labourWageSettlements.update(settlement.id, {
        accountingStatus: response.accountingStatus,
        accountingMessage: response.accountingStatus === "posted" ? null : "Accounting entries missing. Repost accounting.",
        updatedAt: new Date().toISOString(),
      });
      setSuccess(`Accounting repaired for ${response.settlementNumber}.`);
      window.dispatchEvent(new Event("muzare-local-data-change"));
      await syncFromServer();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to repair settlement accounting.");
    } finally {
      setRepairingSettlementId(null);
    }
  }, [syncFromServer, token, workspaceId]);
  const saveSettlement = useCallback(async () => {
    if (!token || !workspaceId || !selectedSettlement) return;
    setSavingSettlementId(selectedSettlement.id);
    setError("");
    setSuccess("");
    try {
      const response = await updateLabourWageSettlement(token, workspaceId, selectedSettlement.id, {
        fromDate: editForm.fromDate,
        toDate: editForm.toDate,
        settlementDate: editForm.settlementDate,
        paymentAccountId: editForm.accountId,
        notes: editForm.notes.trim() || null,
      });
      await offlineDb.labourWageSettlements.update(selectedSettlement.id, {
        settlementNumber: response.settlement.settlementNumber,
        linkedVoucherId: response.settlement.linkedVoucherId,
        linkedVoucherNumber: response.settlement.linkedVoucherNumber,
        linkedAccountId: response.settlement.linkedAccountId,
        settlementMode: response.settlement.settlementMode,
        foremanId: response.settlement.foremanId ?? null,
        groupId: response.settlement.groupId ?? null,
        groupName: response.settlement.groupName ?? null,
        includedLabourIds: response.settlement.includedLabourIds ?? [],
        includedInactiveLabourIds: response.settlement.includedInactiveLabourIds ?? [],
        includedActiveLabourIds: response.settlement.includedActiveLabourIds ?? [],
        includedLabourRows: response.settlement.includedLabourRows ?? [],
        excludedLabourers: response.settlement.excludedLabourers ?? [],
        attendanceTotals: response.settlement.attendanceTotals ?? undefined,
        fromDate: response.settlement.fromDate,
        toDate: response.settlement.toDate,
        settlementDate: response.settlement.settlementDate,
        attendanceWages: response.settlement.attendanceWages,
        labourWorkWages: response.settlement.labourWorkWages,
        pendingLabourEarnings: response.settlement.pendingLabourEarnings,
        grossWages: response.settlement.grossWages ?? response.settlement.totalEarned,
        totalEarned: response.settlement.totalEarned,
        availableAdvanceBalanceBeforeSettlement: response.settlement.availableAdvanceBalanceBeforeSettlement,
        advancesPaid: response.settlement.advancesPaid,
        advanceAdjustedNow: response.settlement.advanceAdjustedNow ?? response.settlement.settledAdvanceAmount,
        settledAdvanceAmount: response.settlement.settledAdvanceAmount,
        expenseAmount: response.settlement.expenseAmount,
        remainingAdvanceCarryForward: response.settlement.remainingAdvanceCarryForward ?? response.settlement.carryForwardAdvance,
        carryForwardAdvance: response.settlement.carryForwardAdvance,
        manualAdjustment: response.settlement.manualAdjustment,
        manualAdjustmentNote: response.settlement.manualAdjustmentNote ?? null,
        netPayableBeforePayment: response.settlement.netPayableBeforePayment,
        paidAmount: response.settlement.paidAmount ?? response.settlement.payableBalance,
        payableBalance: response.settlement.payableBalance,
        balanceAfterPayment: response.settlement.balanceAfterPayment ?? response.settlement.payableBalance,
        paymentAccountId: response.settlement.paymentAccountId ?? response.settlement.linkedAccountId,
        sourceAttendanceIds: response.settlement.sourceAttendanceIds ?? [],
        sourceLabourWorkIds: response.settlement.sourceLabourWorkIds ?? [],
        advanceAdjustmentAllocations: response.settlement.advanceAdjustmentAllocations ?? [],
        settlementScopeSnapshot: response.settlement.settlementScopeSnapshot ?? undefined,
        notes: response.settlement.notes,
        status: response.settlement.status,
        accountingStatus: response.settlement.accountingStatus,
        accountingMessage: response.settlement.accountingMessage ?? null,
        createdBy: response.settlement.createdBy,
        createdAt: response.settlement.createdAt,
        updatedAt: response.settlement.updatedAt,
        deletedAt: response.settlement.deletedAt ?? null,
        deletedBy: response.settlement.deletedBy ?? null,
        voidedAt: response.settlement.voidedAt ?? null,
        voidedBy: response.settlement.voidedBy ?? null,
        voidReason: response.settlement.voidReason ?? null,
        pendingSync: false,
      });
      setSelectedSettlement(response.settlement);
      setSelectedSettlementMode("view");
      setSuccess(`Settlement ${response.settlement.settlementNumber} updated.`);
      window.dispatchEvent(new Event("muzare-local-data-change"));
      await syncFromServer();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to update this settlement.");
    } finally {
      setSavingSettlementId(null);
    }
  }, [editForm.accountId, editForm.fromDate, editForm.notes, editForm.settlementDate, editForm.toDate, selectedSettlement, syncFromServer, token, workspaceId]);
  const voidSettlement = useCallback(async () => {
    if (!token || !workspaceId || !voidingSettlement) return;
    setVoidingSettlementId(voidingSettlement.id);
    setError("");
    setSuccess("");
    try {
      const response = await voidLabourWageSettlement(token, workspaceId, voidingSettlement.id, {
        voidReason: voidReason.trim() || undefined,
      });
      await offlineDb.labourWageSettlements.update(voidingSettlement.id, {
        status: "voided",
        accountingStatus: "voided",
        accountingMessage: "Settlement has been voided.",
        voidedAt: response.voidedAt,
        voidedBy: response.voidedBy,
        voidReason: response.voidReason,
        updatedAt: response.voidedAt,
      });
      setVoidingSettlement(null);
      closeSettlement();
      setSuccess(`Settlement ${response.settlementNumber} voided and reversed.`);
      window.dispatchEvent(new Event("muzare-local-data-change"));
      await syncFromServer();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to void this settlement.");
    } finally {
      setVoidingSettlementId(null);
    }
  }, [closeSettlement, syncFromServer, token, voidReason, voidingSettlement, workspaceId]);
  const deleteSettlement = useCallback(async (settlement: LabourWageSettlement) => {
    if (!token || !workspaceId) return;
    setDeletingSettlementId(settlement.id);
    setError("");
    setSuccess("");
    try {
      const response = await deleteLabourWageSettlement(token, workspaceId, settlement.id);
      const deletedAt = new Date().toISOString();
      await offlineDb.labourWageSettlements.update(settlement.id, {
        status: "deleted",
        accountingStatus: "deleted",
        accountingMessage: "Settlement deleted before accounting was posted.",
        deletedAt,
        deletedBy: user?.id ?? null,
        updatedAt: deletedAt,
      });
      setDeletingSettlement(null);
      if (selectedSettlement?.id === settlement.id) closeSettlement();
      setSuccess(`Settlement ${response.settlementNumber} deleted. Its advances are available for reposting.`);
      window.dispatchEvent(new Event("muzare-local-data-change"));
      await syncFromServer();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to delete this settlement.");
    } finally {
      setDeletingSettlementId(null);
    }
  }, [closeSettlement, selectedSettlement?.id, syncFromServer, token, user?.id, workspaceId]);
  const registerRows = useMemo(() => {
    const term = registerSearch.trim().toLowerCase();
    return settlements.filter((settlement) => {
      const settlementAccountId = settlement.paymentAccountId ?? settlement.linkedAccountId;
      const accountName = settlementPaymentAccountById.get(settlementAccountId)?.name ?? accountById.get(settlementAccountId)?.name ?? "";
      return (statusFilter === "all" || settlementStatus(settlement) === statusFilter)
        && (paymentAccountFilter === "all" || settlementAccountId === paymentAccountFilter)
        && (!term || [
          settlement.settlementNumber,
          settlement.settlementDate,
          settlement.fromDate,
          settlement.toDate,
          settlement.notes ?? "",
          settlement.settlementNumber,
          accountName,
          String(settlement.totalEarned),
          String(settlement.expenseAmount),
          String(settlement.settledAdvanceAmount),
        ].some((value) => value.toLowerCase().includes(term)));
    });
  }, [accountById, paymentAccountFilter, registerSearch, settlementPaymentAccountById, settlementStatus, settlements, statusFilter]);
  const registerTotals = useMemo(() => registerRows.reduce((totals, settlement) => ({
    attendanceWages: totals.attendanceWages + settlement.attendanceWages,
    labourWork: totals.labourWork + (settlement.labourWorkWages ?? settlement.pendingLabourEarnings),
    totalLabourCost: totals.totalLabourCost + (settlement.grossWages ?? settlement.expenseAmount),
    appliedAdvances: totals.appliedAdvances + (settlement.advanceAdjustedNow ?? settlement.settledAdvanceAmount),
    carryForward: totals.carryForward + (settlement.remainingAdvanceCarryForward ?? settlement.carryForwardAdvance),
    cashPaid: totals.cashPaid + (settlement.paidAmount ?? settlement.payableBalance),
  }), {
    attendanceWages: 0,
    labourWork: 0,
    totalLabourCost: 0,
    appliedAdvances: 0,
    carryForward: 0,
    cashPaid: 0,
  }), [registerRows]);
  const exportRegister = () => {
    const header = [
      "Settlement No.",
      "Settlement Date",
      "Period",
      "Settlement Mode",
      "Foreman / Group",
      "Included Labourers",
      "Attendance Wages",
      "Labour Work",
      "Gross Wages Earned",
      "Advance Adjusted Now",
      "Advance Carried Forward",
      "Paid Now",
      "Payment Account",
      "Accounting Reference",
      "Status",
    ];
    const rows = registerRows.map((settlement) => {
      return [
        settlement.settlementNumber,
        settlement.settlementDate,
        `${settlement.fromDate} to ${settlement.toDate}`,
        settlement.settlementMode ?? "individual",
        settlement.foremanId ?? settlement.groupId ?? "-",
        settlement.includedLabourIds?.length ?? "-",
        settlement.attendanceWages,
        settlement.labourWorkWages ?? settlement.pendingLabourEarnings,
        settlement.grossWages ?? settlement.expenseAmount,
        settlement.advanceAdjustedNow ?? settlement.settledAdvanceAmount,
        settlement.remainingAdvanceCarryForward ?? settlement.carryForwardAdvance,
        settlement.paidAmount ?? settlement.payableBalance,
        settlementPaymentAccountById.get(settlement.paymentAccountId ?? settlement.linkedAccountId)?.name ?? accountById.get(settlement.paymentAccountId ?? settlement.linkedAccountId)?.name ?? "",
        settlement.settlementNumber,
        settlement.status,
      ];
    });
    const csv = [header, ...rows]
      .map((row) => row.map((value) => `"${String(value ?? "").replaceAll("\"", "\"\"")}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `labour-wage-settlements-${activeFarmId ?? "farm"}-${activeSeasonId ?? "season"}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <>
        <section className="record-panel workforce-shell-intro workforce-shell-intro--nested">
          <div>
            <h2>{settlementMode === "group" ? "Foreman / Group Period Settlement" : "Labour Period Settlement"}</h2>
            <p>
              Preview period wages, apply advances, and post a labour settlement voucher.
            </p>
          </div>
          <span className="local-pill">{onlineRequired ? "Online required" : "Online and ready"}</span>
        </section>

        {(!activeFarmId || !activeSeasonId) && <section className="record-panel">
          <p className="context-message">Select an active farm and season before creating a labour wage settlement.</p>
        </section>}

        <section className="record-panel labour-settlement-form-panel">
          <div className="advances-heading">
            <h2>{settlementMode === "group" ? "Foreman / group period settlement" : "Labour period settlement"}</h2>
            <span>Settlement accounting is posted under the LW settlement number.</span>
          </div>
          <form className="module-form wage-settlement-form" onSubmit={(event) => void submit(event)}>
            <div className="advances-filter-row">
              <label className="advances-filter-field">
                <span>From date</span>
                <input required type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} />
              </label>
              <label className="advances-filter-field">
                <span>To date</span>
                <input required type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} />
              </label>
              <label className="advances-filter-field">
                <span>Settlement date</span>
                <input required type="date" value={settlementDate} onChange={(event) => setSettlementDate(event.target.value)} />
              </label>
            </div>
            <div className="advances-filter-row">
              <label className="advances-filter-field">
                <span>Settlement mode</span>
                <select value={settlementMode} onChange={(event) => setSettlementMode(event.target.value as "individual" | "group")}>
                  <option value="individual">Individual labour settlement</option>
                  <option value="group">Foreman / group period settlement</option>
                </select>
              </label>
              {settlementMode === "individual" ? (
                <label className="advances-filter-field">
                  <span>Labourer</span>
                  <select required value={labourerId} onChange={(event) => setLabourerId(event.target.value)}>
                    <option value="">Select labourer</option>
                    {activeLabourers.map((labourer) => <option key={labourer.id} value={labourer.id}>{labourer.name}</option>)}
                  </select>
                </label>
              ) : (
                <>
                  <label className="advances-filter-field">
                    <span>Foreman / group leader</span>
                    <select value={foremanId} onChange={(event) => setForemanId(event.target.value)}>
                      <option value="">Select foreman</option>
                      {activeLabourers.map((labourer) => <option key={labourer.id} value={labourer.id}>{labourer.name}</option>)}
                    </select>
                  </label>
                  <label className="advances-filter-field">
                    <span>Group</span>
                    <select value={groupId} onChange={(event) => setGroupId(event.target.value)}>
                      <option value="">Select group</option>
                      {activeLabourGroups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
                    </select>
                  </label>
                </>
              )}
            </div>
            <div className="advances-filter-row">
              <label className="advances-filter-field">
                <span>Paid now</span>
                <input type="number" min="0" step="0.01" value={paidAmount} onChange={(event) => setPaidAmount(event.target.value)} />
              </label>
              <label className="advances-filter-field">
                <span>Manual adjustment</span>
                <input type="number" step="0.01" value={manualAdjustment} onChange={(event) => setManualAdjustment(event.target.value)} />
              </label>
              <label className="advances-filter-field advances-filter-field--full">
                <span>Manual adjustment note</span>
                <input value={manualAdjustmentNote} onChange={(event) => setManualAdjustmentNote(event.target.value)} placeholder="Required when manual adjustment is non-zero" />
              </label>
            </div>
            <div className="advances-filter-row">
              <label className="advances-filter-field">
                <span>Payment account</span>
                <select required={Number(paidAmount || 0) > 0} value={accountId} onChange={(event) => setAccountId(event.target.value)}>
                  <option value="">Select payment account</option>
                  {paymentAccounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
                </select>
              </label>
              <label className="advances-filter-field advances-filter-field--full">
                <span>Notes</span>
                <input value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Optional settlement notes or reference" />
              </label>
            </div>
            {onlineRequired ? <p className="worker-action-warning">Wage settlement requires online connection.</p> : null}
            {error ? <p className="form-error">{error}</p> : null}
            {success ? <p className="context-message">{success}</p> : null}
            <div className="wage-settlement-actions">
              <button type="button" className="secondary-action" onClick={() => void previewSettlement()} disabled={!token || !workspaceId || !activeFarmId || !activeSeasonId || preview.status === "loading"}>
                {preview.status === "loading" ? "Previewing..." : "Preview Settlement"}
              </button>
              <button type="submit" disabled={!canPost || submitting || preview.status !== "ready" || !summaryConsistent || Boolean(summary?.unresolvedRows.length) || Boolean(summary?.overlappingSettlements.length) || onlineRequired}>
                {submitting ? "Posting settlement..." : "Create Settlement"}
              </button>
            </div>
          </form>
        </section>

        <section className="record-panel labour-settlement-preview-panel">
          <div className="advances-heading">
            <h2>Settlement preview</h2>
            <span>Advances stay immutable. Settlement accounting is posted under the LW settlement number.</span>
          </div>
          {!summary ? <p className="context-message">Run a preview to calculate period wages, advance use, and settlement balance.</p> : <>
            <div className="record-panel">
              <h3>Settlement scope</h3>
              <div className="reports-summary-list">
                <article><span>Settlement scope</span><strong>{settlementScopeLabel}</strong></article>
                <article><span>Labour status rule</span><strong>All labourers with wages in period</strong></article>
                <article><span>Date range</span><strong>{fromDate} to {toDate}</strong></article>
                <article><span>Farm / season</span><strong>{activeFarmId || "-"} / {activeSeasonId || "-"}</strong></article>
                <article><span>Included labourers</span><strong>{summaryTotals.includedLabourers}</strong></article>
                <article><span>Excluded group members</span><strong>{summary.excludedLabourers?.length ?? 0}</strong></article>
                <article><span>Active now included</span><strong>{summaryTotals.activeNowIncluded}</strong></article>
                <article><span>Inactive now included</span><strong>{summaryTotals.inactiveNowIncluded}</strong></article>
              </div>
              <p className="context-message">Settlement preview uses the same attendance wage engine as the attendance report.</p>
            </div>

            <div className="reports-kpis">
              <article><span>Included labourers</span><strong>{summaryTotals.includedLabourers}</strong></article>
              <article><span>Active now included</span><strong>{summaryTotals.activeNowIncluded}</strong></article>
              <article><span>Inactive now included</span><strong>{summaryTotals.inactiveNowIncluded}</strong></article>
              <article><span>Present days</span><strong>{summaryTotals.presentDays}</strong></article>
              <article><span>Half-day days</span><strong>{summaryTotals.halfDayDays}</strong></article>
              <article><span>Payable days</span><strong>{summaryTotals.payableDays}</strong></article>
              <article><span>Attendance wages</span><strong>{money(summaryTotals.attendanceWages)}</strong></article>
              <article><span>Labour work wages</span><strong>{money(summaryTotals.labourWorkWages)}</strong></article>
              <article><span>Gross wages earned</span><strong>{money(summaryTotals.grossWagesEarned)}</strong></article>
              <article><span>Available advance balance</span><strong>{money(summaryTotals.availableAdvanceBalance)}</strong></article>
              <article><span>Advance adjusted now</span><strong>{money(summaryTotals.advanceAdjustedNow)}</strong></article>
              <article><span>Advance carried forward</span><strong>{money(summaryTotals.advanceCarriedForward)}</strong></article>
              <article><span>Manual adjustment</span><strong>{money(summary?.manualAdjustment ?? 0)}</strong></article>
              <article><span>Net payable before payment</span><strong>{money(summaryTotals.netPayableBeforePayment)}</strong></article>
              <article><span>Paid now</span><strong>{money(summary?.paidAmount ?? 0)}</strong></article>
              <article><span>Balance after settlement</span><strong>{money(summaryTotals.balanceAfterSettlement)}</strong></article>
            </div>

            <div className="reports-summary-list">
              <article><span>Advances considered until</span><strong>{summary.settlementDate}</strong></article>
              <article><span>Total advances up to settlement date</span><strong>{money(summary.rawAdvancesUpToSettlementDate)}</strong></article>
              <article><span>Previously settled advances</span><strong>{money(summary.previouslySettledAdvances)}</strong></article>
              <article><span>Preview status</span><strong>{summaryConsistent ? "Consistent" : "Needs review"}</strong></article>
            </div>

            {includedLabourRows.length > 0 ? (
              <>
                <div className="attendance-import-table-wrap report-wide-table">
                  <table className="report-data-table">
                    <thead>
                      <tr>
                        <th>Labourer</th>
                        <th>Status</th>
                        <th>Group</th>
                        <th>Present</th>
                        <th>Half-day</th>
                        <th>Payable</th>
                        <th>Wage rate</th>
                        <th>Attendance wage</th>
                        <th>Labour work wage</th>
                        <th>Gross wage</th>
                        <th>Advance available</th>
                        <th>Advance adjusted</th>
                        <th>Carry forward</th>
                        <th>Net payable</th>
                        <th>Paid now</th>
                        <th>Balance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {includedLabourRows.map((row) => (
                        <tr key={row.labourerId}>
                          <td>{row.labourName}</td>
                          <td>{row.currentStatus === "active" ? "Active now" : "Inactive now"}</td>
                          <td>{row.groupName ?? summary.groupName ?? "-"}</td>
                          <td>{row.presentDays}</td>
                          <td>{row.halfDayDays}</td>
                          <td>{row.payableDays}</td>
                          <td>{row.wageRateLabel ?? "-"}</td>
                          <td>{money(row.attendanceWage)}</td>
                          <td>{money(row.labourWorkWage)}</td>
                          <td>{money(row.grossWage)}</td>
                          <td>{money(row.advanceAvailable)}</td>
                          <td>{money(row.advanceAdjustedNow)}</td>
                          <td>{money(row.advanceCarriedForward)}</td>
                          <td>{money(row.netPayableBeforePayment)}</td>
                          <td>{money(row.paidNow)}</td>
                          <td>{money(row.balanceAfterSettlement)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="report-mobile-cards">
                  {includedLabourRows.map((row) => (
                    <article className="report-mobile-card" key={`preview:${row.labourerId}`}>
                      <header>
                        <strong>{row.labourName}</strong>
                        <b>{money(row.grossWage)}</b>
                      </header>
                      <span>{row.currentStatus === "active" ? "Active now" : "Inactive now"}</span>
                      <details>
                        <summary>View labour breakdown</summary>
                        <dl>
                          <div><dt>Payable days</dt><dd>{row.payableDays}</dd></div>
                          <div><dt>Gross wage</dt><dd>{money(row.grossWage)}</dd></div>
                          <div><dt>Advance adjusted</dt><dd>{money(row.advanceAdjustedNow)}</dd></div>
                          <div><dt>Net payable</dt><dd>{money(row.netPayableBeforePayment)}</dd></div>
                          <div><dt>Present days</dt><dd>{row.presentDays}</dd></div>
                          <div><dt>Half-day days</dt><dd>{row.halfDayDays}</dd></div>
                          <div><dt>Wage rate</dt><dd>{row.wageRateLabel ?? "-"}</dd></div>
                          <div><dt>Attendance wage</dt><dd>{money(row.attendanceWage)}</dd></div>
                          <div><dt>Labour work wage</dt><dd>{money(row.labourWorkWage)}</dd></div>
                          <div><dt>Advance available</dt><dd>{money(row.advanceAvailable)}</dd></div>
                          <div><dt>Carry forward</dt><dd>{money(row.advanceCarriedForward)}</dd></div>
                        </dl>
                      </details>
                    </article>
                  ))}
                </div>
              </>
            ) : null}

            <div className="module-inline-actions">
              <button type="button" className="secondary-action" onClick={openMatchingAttendanceReport}>View matching attendance report</button>
              {!summaryConsistent ? <span className="worker-action-warning">Preview is inconsistent. Create Settlement is disabled until the labour rows reconcile.</span> : null}
            </div>

            {process.env.NODE_ENV !== "production" ? (
              <div className="record-panel">
                <h3>Development reconciliation</h3>
                {attendanceComparison.status === "loading" ? <p className="context-message">Loading attendance register comparison...</p> : attendanceComparison.status === "error" ? <p className="worker-action-warning">{attendanceComparison.error}</p> : attendanceComparison.status === "ready" && attendanceComparison.data ? (() => {
                  const reportTotals = attendanceComparison.data.summaries.reduce((totals, row) => ({
                    labourers: totals.labourers + 1,
                    present: totals.present + row.presentDays,
                    halfDay: totals.halfDay + row.halfDays,
                    payableDays: totals.payableDays + row.payableDays,
                    wages: totals.wages + row.totalWage,
                  }), { labourers: 0, present: 0, halfDay: 0, payableDays: 0, wages: 0 });
                  return (
                    <>
                      <div className="reports-summary-list">
                        <article><span>Preview labour count</span><strong>{summaryTotals.includedLabourers}</strong></article>
                        <article><span>Report labour count</span><strong>{reportTotals.labourers}</strong></article>
                        <article><span>Preview present days</span><strong>{summaryTotals.presentDays}</strong></article>
                        <article><span>Report present days</span><strong>{reportTotals.present}</strong></article>
                        <article><span>Preview half-day days</span><strong>{summaryTotals.halfDayDays}</strong></article>
                        <article><span>Report half-day days</span><strong>{reportTotals.halfDay}</strong></article>
                        <article><span>Preview payable days</span><strong>{summaryTotals.payableDays}</strong></article>
                        <article><span>Report payable days</span><strong>{reportTotals.payableDays}</strong></article>
                        <article><span>Preview attendance wages</span><strong>{money(summaryTotals.attendanceWages)}</strong></article>
                        <article><span>Report attendance wages</span><strong>{money(reportTotals.wages)}</strong></article>
                        <article><span>Preview labour row total</span><strong>{money(summaryTotals.grossWagesEarned)}</strong></article>
                        <article><span>Included inactive labourers</span><strong>{summaryTotals.inactiveNowIncluded}</strong></article>
                      </div>
                      {summary.excludedLabourers?.length ? (
                        <details>
                          <summary>Excluded labourers with reasons</summary>
                          <ul>
                            {summary.excludedLabourers.map((row) => <li key={`dev-excluded:${row.labourerId}`}>{row.labourName}: {row.reason}</li>)}
                          </ul>
                        </details>
                      ) : null}
                    </>
                  );
                })() : null}
              </div>
            ) : null}

            {summary.excludedLabourers?.length ? <details className="worker-action-warning">
              <summary>Excluded labourers</summary>
              <ul>
                {summary.excludedLabourers.map((row) => <li key={row.labourerId}>{row.labourName}: {row.reason}</li>)}
              </ul>
            </details> : null}
            {summary.unresolvedRows.length > 0 && <div className="worker-action-warning">
              <strong>Missing wage rates</strong>
              <ul>
                {summary.unresolvedRows.slice(0, 8).map((row) => <li key={`${row.labourerId}:${row.date}`}>{row.labourName} on {row.date} ({row.status}) has no active wage rate.</li>)}
              </ul>
            </div>}
            {summary.overlappingSettlements.length > 0 && <div className="worker-action-warning">
              <strong>Overlapping settlements found</strong>
              <ul>
                {summary.overlappingSettlements.map((row) => <li key={row.id}>{row.settlementNumber} covers {row.fromDate} to {row.toDate} and is still {row.status}.</li>)}
              </ul>
            </div>}
            {summary.includedEarnings.length > 0 && <div className="reports-summary-list">
              <article><span>Included labour work rows</span><strong>{summary.includedEarnings.length}</strong></article>
              <article><span>Ledger total</span><strong>{money(summary.includedEarnings.reduce((sum, item) => sum + item.amount, 0))}</strong></article>
            </div>}
          </>}
        </section>

        <section className="record-panel labour-settlement-register-panel">
          <div className="advances-heading labour-settlement-register-header">
            <div>
              <h2>Labour settlement register</h2>
              <span>{historyLoading ? "Refreshing register..." : `${settlements.length} settlements in this farm and season`}</span>
            </div>
            <div className="module-inline-actions">
              <button type="button" className="secondary-action" onClick={() => window.print()}><Printer size={16} /> Print</button>
              <button type="button" className="secondary-action" onClick={exportRegister}><Download size={16} /> Export CSV</button>
            </div>
          </div>
          {!settlements.length ? <p className="context-message">No wage settlements have been posted for this farm and season yet.</p> : (
            <>
              <div className="reports-kpis">
                <article><span>Attendance wages</span><strong>{money(registerTotals.attendanceWages)}</strong></article>
                <article><span>Labour work wages</span><strong>{money(registerTotals.labourWork)}</strong></article>
                <article><span>Gross wages earned</span><strong>{money(registerTotals.totalLabourCost)}</strong></article>
                <article><span>Advance adjusted now</span><strong>{money(registerTotals.appliedAdvances)}</strong></article>
                <article><span>Advance carried forward</span><strong>{money(registerTotals.carryForward)}</strong></article>
                <article><span>Paid now</span><strong>{money(registerTotals.cashPaid)}</strong></article>
              </div>
              <div className="report-toolbar labour-settlement-register-toolbar">
                <label className="search-input labour-settlement-register-search">
                  <Search size={16} />
                  <input
                    type="search"
                    placeholder="Search settlement number, notes, or account"
                    value={registerSearch}
                    onChange={(event) => setRegisterSearch(event.target.value)}
                  />
                </label>
                <label className="advances-filter-field labour-settlement-filter-field">
                  <span>Status</span>
                  <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}>
                    <option value="all">All</option>
                    <option value="posted">Posted</option>
                    <option value="accounting_missing">Accounting missing</option>
                    <option value="voided">Voided</option>
                  </select>
                </label>
                <label className="advances-filter-field labour-settlement-filter-field">
                  <span>Payment account</span>
                  <select value={paymentAccountFilter} onChange={(event) => setPaymentAccountFilter(event.target.value)}>
                    <option value="all">All accounts</option>
                    {paymentAccounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
                  </select>
                </label>
              </div>
            <div className="attendance-import-table-wrap report-wide-table labour-settlement-table-wrap">
              <table className="report-data-table">
                <thead>
                  <tr>
                    <th>Settlement No.</th>
                    <th>Settlement date</th>
                    <th>Settlement period</th>
                    <th>Mode</th>
                    <th>Foreman / group</th>
                    <th>Labourers</th>
                    <th>Attendance wages</th>
                    <th>Labour work</th>
                    <th>Gross wages earned</th>
                    <th>Advance adjusted now</th>
                    <th>Advance carried forward</th>
                    <th>Paid now</th>
                    <th>Payment account</th>
                    <th>Accounting reference</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {registerRows.map((settlement) => {
                    return (
                      <tr key={settlement.id}>
                        <td><button type="button" className="worker-dialog__link" onClick={() => openSettlement(settlement)}>{settlement.settlementNumber}</button></td>
                        <td>{settlement.settlementDate}</td>
                        <td>{settlement.fromDate} to {settlement.toDate}</td>
                        <td>{settlement.settlementMode ?? "individual"}</td>
                        <td>{settlement.foremanId ?? settlement.groupId ?? "-"}</td>
                        <td>{settlement.includedLabourIds?.length ?? "-"}</td>
                        <td>{money(settlement.attendanceWages)}</td>
                        <td>{money(settlement.labourWorkWages ?? settlement.pendingLabourEarnings)}</td>
                        <td>{money(settlement.grossWages ?? settlement.expenseAmount)}</td>
                        <td>{money(settlement.advanceAdjustedNow ?? settlement.settledAdvanceAmount)}</td>
                        <td>{money(settlement.remainingAdvanceCarryForward ?? settlement.carryForwardAdvance)}</td>
                        <td>{money(settlement.paidAmount ?? settlement.payableBalance)}</td>
                        <td>{settlementPaymentAccountById.get(settlement.paymentAccountId ?? settlement.linkedAccountId)?.name ?? accountById.get(settlement.paymentAccountId ?? settlement.linkedAccountId)?.name ?? "-"}</td>
                        <td>{settlement.settlementNumber}</td>
                        <td>{settlementStatus(settlement).replaceAll("_", " ")}</td>
                        <td>
                          <div className="stacked-inline-actions">
                            <button type="button" className="secondary-action" onClick={() => openSettlement(settlement)}>View</button>
                            {canEditSettlement(settlement) ? (
                              <button type="button" className="secondary-action" onClick={() => openSettlement(settlement, "edit")}>Edit / Update</button>
                            ) : null}
                            {canDeleteSettlement(settlement) ? (
                              <button
                                type="button"
                                className="danger-button"
                                disabled={deletingSettlementId === settlement.id}
                                onClick={() => setDeletingSettlement(settlement)}
                              >
                                {deletingSettlementId === settlement.id ? "Deleting..." : "Delete settlement"}
                              </button>
                            ) : null}
                            {canVoidSettlement(settlement) ? (
                              <button
                                type="button"
                                className="secondary-action"
                                disabled={voidingSettlementId === settlement.id}
                                onClick={() => {
                                  setVoidingSettlement(settlement);
                                  setVoidReason("");
                                }}
                              >
                                {voidingSettlementId === settlement.id ? "Voiding..." : "Void / Reverse settlement"}
                              </button>
                            ) : null}
                            {settlementStatus(settlement) === "accounting_missing" ? (
                              <button
                                type="button"
                                className="secondary-action"
                                disabled={repairingSettlementId === settlement.id}
                                onClick={() => void repairAccounting(settlement)}
                              >
                                {repairingSettlementId === settlement.id ? "Repairing..." : "Repair accounting"}
                              </button>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            </>
          )}
        </section>
        {selectedSettlement ? (() => {
          return (
            <div className="worker-dialog-backdrop worker-action-backdrop" role="presentation" onClick={closeSettlement}>
              <section className="worker-action-dialog account-ledger-dialog" role="dialog" aria-modal="true" aria-label="Labour settlement details" onClick={(event) => event.stopPropagation()}>
                <header>
                  <div>
                    <h2>{selectedSettlement.settlementNumber}</h2>
                    <p>{selectedSettlement.fromDate} to {selectedSettlement.toDate}</p>
                  </div>
                  <button aria-label={t("common.close")} type="button" onClick={closeSettlement}><X size={18} /></button>
                </header>
                <div className="worker-action-form">
                  {settlementStatus(selectedSettlement) === "voided" ? <p className="worker-action-warning">This settlement was voided and no longer affects balances.</p> : null}
                  {selectedSettlementMode === "edit" ? (
                    <>
                      <div className="advances-filter-row">
                        <label className="advances-filter-field">
                          <span>From date</span>
                          <input required type="date" value={editForm.fromDate} onChange={(event) => setEditForm((current) => ({ ...current, fromDate: event.target.value }))} />
                        </label>
                        <label className="advances-filter-field">
                          <span>To date</span>
                          <input required type="date" value={editForm.toDate} onChange={(event) => setEditForm((current) => ({ ...current, toDate: event.target.value }))} />
                        </label>
                        <label className="advances-filter-field">
                          <span>Settlement date</span>
                          <input required type="date" value={editForm.settlementDate} onChange={(event) => setEditForm((current) => ({ ...current, settlementDate: event.target.value }))} />
                        </label>
                      </div>
                      <div className="advances-filter-row">
                        <label className="advances-filter-field">
                          <span>Payment account</span>
                          <select required value={editForm.accountId} onChange={(event) => setEditForm((current) => ({ ...current, accountId: event.target.value }))}>
                            <option value="">Select payment account</option>
                            {paymentAccounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
                          </select>
                        </label>
                        <label className="advances-filter-field advances-filter-field--full">
                          <span>Notes</span>
                          <input value={editForm.notes} onChange={(event) => setEditForm((current) => ({ ...current, notes: event.target.value }))} placeholder="Optional settlement notes or reference" />
                        </label>
                      </div>
                      <p className="context-message">Editing is only allowed before posted accounting is healthy, or for notes-only changes.</p>
                    </>
                  ) : (
                    <>
                      <div className="reports-kpis">
                        <article><span>Settlement date</span><strong>{selectedSettlement.settlementDate}</strong></article>
                        <article><span>Attendance wages</span><strong>{money(selectedSettlement.attendanceWages)}</strong></article>
                        <article><span>Labour work wages</span><strong>{money(selectedSettlement.labourWorkWages ?? selectedSettlement.pendingLabourEarnings)}</strong></article>
                        <article><span>Gross wages earned</span><strong>{money(selectedSettlement.grossWages ?? selectedSettlement.expenseAmount)}</strong></article>
                        <article><span>Advance adjusted now</span><strong>{money(selectedSettlement.advanceAdjustedNow ?? selectedSettlement.settledAdvanceAmount)}</strong></article>
                        <article><span>Advance carried forward</span><strong>{money(selectedSettlement.remainingAdvanceCarryForward ?? selectedSettlement.carryForwardAdvance)}</strong></article>
                        <article><span>Paid now</span><strong>{money(selectedSettlement.paidAmount ?? selectedSettlement.payableBalance)}</strong></article>
                        <article><span>Payment account</span><strong>{settlementPaymentAccountById.get(selectedSettlement.paymentAccountId ?? selectedSettlement.linkedAccountId)?.name ?? accountById.get(selectedSettlement.paymentAccountId ?? selectedSettlement.linkedAccountId)?.name ?? "-"}</strong></article>
                        <article><span>Accounting reference</span><strong>{selectedSettlement.settlementNumber}</strong></article>
                      </div>
                      {selectedSettlement.notes ? <p className="context-message">{selectedSettlement.notes}</p> : null}
                      {selectedSettlement.accountingStatus === "accounting_missing" ? (
                        <div className="worker-action-warning">
                          <strong>Accounting entries missing.</strong>
                          <p>{selectedSettlement.accountingMessage ?? "Repost accounting to restore this settlement in the accounts ledger."}</p>
                        </div>
                      ) : null}
                      {selectedSettlement.accountingStatus === "posted" ? (
                        <div className="worker-action-warning">
                          <strong>Accounting is posted.</strong>
                          <p>This settlement can be viewed or voided, but not edited directly.</p>
                        </div>
                      ) : null}
                    </>
                  )}
                  {selectedSettlementLoading ? <p className="context-message">Refreshing settlement details...</p> : null}
                  <footer className="worker-action-footer">
                    {selectedSettlementMode === "edit" ? (
                      <>
                        <button type="button" onClick={() => { setSelectedSettlementMode("view"); }}>
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="secondary-action"
                          disabled={savingSettlementId === selectedSettlement.id}
                          onClick={() => void saveSettlement()}
                        >
                          {savingSettlementId === selectedSettlement.id ? "Updating..." : "Update settlement"}
                        </button>
                      </>
                    ) : (
                      <>
                        <button type="button" onClick={closeSettlement}>Close</button>
                        {selectedSettlement.accountingStatus === "accounting_missing" ? (
                          <button
                            type="button"
                            className="secondary-action"
                            disabled={repairingSettlementId === selectedSettlement.id}
                            onClick={() => void repairAccounting(selectedSettlement)}
                          >
                            {repairingSettlementId === selectedSettlement.id ? "Repairing..." : "Repair accounting"}
                          </button>
                        ) : null}
                        {canEditSettlement(selectedSettlement) ? (
                          <button type="button" className="secondary-action" onClick={() => {
                            setSelectedSettlementMode("edit");
                            setEditForm({
                              fromDate: selectedSettlement.fromDate,
                              toDate: selectedSettlement.toDate,
                              settlementDate: selectedSettlement.settlementDate,
                              accountId: selectedSettlement.linkedAccountId,
                              notes: selectedSettlement.notes ?? "",
                            });
                          }}>
                            Edit / Update
                          </button>
                        ) : null}
                        {canDeleteSettlement(selectedSettlement) ? (
                          <button
                            type="button"
                            className="danger-button"
                            disabled={deletingSettlementId === selectedSettlement.id}
                            onClick={() => setDeletingSettlement(selectedSettlement as unknown as LabourWageSettlement)}
                          >
                            {deletingSettlementId === selectedSettlement.id ? "Deleting..." : "Delete settlement"}
                          </button>
                        ) : null}
                        {canVoidSettlement(selectedSettlement) ? (
                          <button
                            type="button"
                            className="secondary-action"
                            disabled={voidingSettlementId === selectedSettlement.id}
                            onClick={() => setVoidingSettlement(selectedSettlement)}
                          >
                            {voidingSettlementId === selectedSettlement.id ? "Voiding..." : "Void / Reverse settlement"}
                          </button>
                        ) : null}
                      </>
                    )}
                  </footer>
                </div>
              </section>
            </div>
          );
        })() : null}
        {deletingSettlement ? (
          <div className="worker-dialog-backdrop worker-action-backdrop" role="presentation" onClick={() => deletingSettlementId ? undefined : setDeletingSettlement(null)}>
            <section className="worker-action-dialog account-ledger-dialog" role="dialog" aria-modal="true" aria-label="Delete settlement confirmation" onClick={(event) => event.stopPropagation()}>
              <header>
                <div>
                  <h2>Delete settlement</h2>
                  <p>{deletingSettlement.settlementNumber}</p>
                </div>
                <button aria-label={t("common.close")} type="button" onClick={() => deletingSettlementId ? undefined : setDeletingSettlement(null)}><X size={18} /></button>
              </header>
              <div className="worker-action-form">
                <div className="worker-action-warning">
                  <strong>Delete settlement {deletingSettlement.settlementNumber}?</strong>
                  <p>This will remove the settlement record and release its advances for reposting. No accounting entries were found.</p>
                </div>
                <footer className="worker-action-footer">
                  <button type="button" onClick={() => setDeletingSettlement(null)} disabled={Boolean(deletingSettlementId)}>Cancel</button>
                  <button type="button" className="danger-button" onClick={() => void deleteSettlement(deletingSettlement)} disabled={Boolean(deletingSettlementId)}>
                    {deletingSettlementId ? "Deleting..." : "Delete settlement"}
                  </button>
                </footer>
              </div>
            </section>
          </div>
        ) : null}
        {voidingSettlement ? (
          <div className="worker-dialog-backdrop worker-action-backdrop" role="presentation" onClick={() => voidingSettlementId ? undefined : setVoidingSettlement(null)}>
            <section className="worker-action-dialog account-ledger-dialog" role="dialog" aria-modal="true" aria-label="Void settlement confirmation" onClick={(event) => event.stopPropagation()}>
              <header>
                <div>
                  <h2>Void settlement</h2>
                  <p>{voidingSettlement.settlementNumber}</p>
                </div>
                <button aria-label={t("common.close")} type="button" onClick={() => voidingSettlementId ? undefined : setVoidingSettlement(null)}><X size={18} /></button>
              </header>
              <div className="worker-action-form">
                <div className="worker-action-warning">
                  <strong>Void settlement {voidingSettlement.settlementNumber}?</strong>
                  <p>This will reverse accounting entries and preserve the audit trail.</p>
                </div>
                <label className="advances-filter-field advances-filter-field--full">
                  <span>Void reason</span>
                  <input value={voidReason} onChange={(event) => setVoidReason(event.target.value)} placeholder="Optional void reason" />
                </label>
                <footer className="worker-action-footer">
                  <button type="button" onClick={() => setVoidingSettlement(null)} disabled={Boolean(voidingSettlementId)}>Cancel</button>
                  <button type="button" className="secondary-action" onClick={() => void voidSettlement()} disabled={Boolean(voidingSettlementId)}>
                    {voidingSettlementId ? "Voiding..." : "Void / Reverse settlement"}
                  </button>
                </footer>
              </div>
            </section>
          </div>
        ) : null}
    </>
  );
}
