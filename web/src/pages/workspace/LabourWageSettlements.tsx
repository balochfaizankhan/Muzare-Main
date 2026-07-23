import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Search, Printer, Download, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../../auth/AuthProvider";
import { eligiblePaymentAccounts, PaymentAccountSelect } from "../../components/PaymentAccountSelect";
import { ApiError, createLabourWageSettlement, deleteLabourWageSettlement, fetchLabourWageSettlement, fetchLabourWageSettlementCreateStatus, fetchLabourWageSettlementPaymentAccounts, fetchLabourWageSettlements, previewLabourWageSettlement, repairLabourWageSettlementAccounting, updateLabourWageSettlement, voidLabourWageSettlement, type LabourWageSettlementDetail, type LabourWageSettlementPaymentAccount, type LabourWageSettlementPreview, type LabourWageSettlementRecord } from "../../lib/api";
import { formatMoney } from "../../lib/format";
import { getActiveFarmId, getActiveSeasonId, offlineDb, workspaceRecords, type Account, type LabourGroup, type LabourWageSettlement, type Labourer } from "../../lib/offline-db";
import { canCreate } from "../../lib/permissions";
import { translateStatus } from "../../lib/statusLabels";
import { isLabourAvailableForEntry } from "../../lib/workerEligibility";

const today = () => new Date().toISOString().slice(0, 10);
const money = formatMoney;

type PreviewState =
  | { status: "idle"; data: null }
  | { status: "loading"; data: null }
  | { status: "ready"; data: LabourWageSettlementPreview }
  | { status: "error"; data: null };

type PreviewDiagnostics = {
  submittedPayload: Record<string, unknown> | null;
  missingRequiredFields: string[];
  apiStatus: number | null;
  apiResponseBody: unknown | null;
  storedPreview: LabourWageSettlementPreview | null;
  createDisabledReason: string;
};

function toFiniteNumber(value: string) {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

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
  const [paidAmount] = useState("0");
  const [manualAdjustment, setManualAdjustment] = useState("0");
  const [manualAdjustmentNote, setManualAdjustmentNote] = useState("");
  const [notes, setNotes] = useState("");
  const [preview, setPreview] = useState<PreviewState>({ status: "idle", data: null });
  const [historyLoading, setHistoryLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [pendingRequestId, setPendingRequestId] = useState<string | null>(null);
  const [statusCheckInFlight, setStatusCheckInFlight] = useState(false);
  const [statusCheckNotice, setStatusCheckNotice] = useState("");
  const [savingSettlementId, setSavingSettlementId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [previewDiagnostics, setPreviewDiagnostics] = useState<PreviewDiagnostics>({
    submittedPayload: null,
    missingRequiredFields: [],
    apiStatus: null,
    apiResponseBody: null,
    storedPreview: null,
    createDisabledReason: "",
  });
  const [previewSearch, setPreviewSearch] = useState("");
  const [previewStatusFilter, setPreviewStatusFilter] = useState<"all" | "active" | "inactive">("all");
  const [registerSearch, setRegisterSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "posted" | "voided" | "deleted" | "accounting_missing">("all");
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
  const statusPollingAbortRef = useRef<AbortController | null>(null);
  const activeStatusResolverRequestIdRef = useRef<string | null>(null);
  const restoredPendingRequestIdRef = useRef<string | null>(null);
  const pendingSettlementStorageKey = useMemo(() => {
    if (!workspaceId || !activeFarmId || !activeSeasonId) return "";
    return `muzare-labour-settlement-pending:${workspaceId}:${activeFarmId}:${activeSeasonId}`;
  }, [activeFarmId, activeSeasonId, workspaceId]);

  const refresh = useCallback(async () => {
    const [cachedAccounts, cachedSettlements] = await Promise.all([
      workspaceRecords(offlineDb.accounts),
      workspaceRecords(offlineDb.labourWageSettlements, { includeDeleted: true }),
    ]);
    setAccounts(cachedAccounts.filter((account) => account.type === "cash" || account.type === "bank" || account.type === "partner"));
    setLabourers(await workspaceRecords(offlineDb.labourers));
    setLabourGroups((await workspaceRecords(offlineDb.labourGroups)).map((group) => {
      const normalizedForemanId = group.foremanLabourId ?? group.foremanId ?? null;
      return {
        ...group,
        foremanId: normalizedForemanId,
        foremanLabourId: normalizedForemanId,
      };
    }));
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
        linkedAccountName: settlement.linkedAccountName ?? settlement.paymentAccountName ?? null,
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
        paymentAccountCanonicalId: settlement.paymentAccountCanonicalId ?? settlement.paymentAccountId ?? settlement.linkedAccountId,
        paymentAccountLegacyId: settlement.paymentAccountLegacyId ?? null,
        paymentAccountName: settlement.paymentAccountName ?? settlement.linkedAccountName ?? null,
        paymentAccountType: settlement.paymentAccountType ?? null,
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

  useEffect(() => () => {
    statusPollingAbortRef.current?.abort();
  }, []);

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

  const selectedGroup = useMemo(() => labourGroups.find((group) => group.id === groupId) ?? null, [groupId, labourGroups]);
  const selectedGroupForemanId = selectedGroup?.foremanLabourId ?? selectedGroup?.foremanId ?? "";
  const effectiveGroupForemanId = settlementMode === "group" ? selectedGroupForemanId : foremanId;
  const selectedPaymentAccountId = undefined;
  const hasManualAdjustment = toFiniteNumber(manualAdjustment) !== 0;

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

  useEffect(() => {
    if (!pendingRequestId) {
      setStatusCheckInFlight(false);
      setStatusCheckNotice("");
    }
    setPreview((current) => (current.status === "idle" ? current : { status: "idle", data: null }));
    setPreviewDiagnostics((current) => ({
      ...current,
      storedPreview: null,
      createDisabledReason: t("wageSettlementsPage.previewBeforePosting"),
    }));
  }, [activeFarmId, activeSeasonId, accountId, foremanId, fromDate, groupId, labourerId, manualAdjustment, manualAdjustmentNote, notes, pendingRequestId, settlementDate, settlementMode, toDate]);

  const previewRequest = useMemo(() => ({
    farmId: activeFarmId || "",
    seasonId: activeSeasonId || "",
    fromDate,
    toDate,
    settlementDate,
    settlementMode,
    labourerId: settlementMode === "individual" ? labourerId || undefined : undefined,
    groupId: settlementMode === "group" ? groupId || undefined : undefined,
    paymentAccountId: selectedPaymentAccountId,
    accountId: selectedPaymentAccountId,
    paidAmount: toFiniteNumber(paidAmount),
    manualAdjustment: toFiniteNumber(manualAdjustment),
  }), [activeFarmId, activeSeasonId, fromDate, toDate, settlementDate, settlementMode, labourerId, groupId, selectedPaymentAccountId, paidAmount, manualAdjustment]);

  const previewRequestFingerprint = useMemo(() => JSON.stringify(previewRequest), [previewRequest]);
  const previewSubmissionFingerprint = useMemo(() => JSON.stringify(previewDiagnostics.submittedPayload), [previewDiagnostics.submittedPayload]);
  const summary = preview.status === "ready" && previewRequestFingerprint === previewSubmissionFingerprint ? preview.data : null;

  const previewMissingRequiredFields = useMemo(() => {
    const fields: string[] = [];
    if (!previewRequest.farmId) fields.push("farmId");
    if (!previewRequest.seasonId) fields.push("seasonId");
    if (!previewRequest.fromDate) fields.push("fromDate");
    if (!previewRequest.toDate) fields.push("toDate");
    if (!previewRequest.settlementDate) fields.push("settlementDate");
    if (previewRequest.settlementMode === "individual" && !previewRequest.labourerId) fields.push("labourerId");
    if (previewRequest.settlementMode === "group" && !previewRequest.groupId) fields.push("groupId");
    if (previewRequest.paidAmount > 0 && !previewRequest.paymentAccountId) fields.push("paymentAccountId");
    return fields;
  }, [previewRequest]);

  const persistSettlementRecord = useCallback(async (settlement: LabourWageSettlementRecord) => {
    if (!activeFarmId || !activeSeasonId) return;
    await offlineDb.labourWageSettlements.put({
      id: settlement.id,
      workspaceId,
      farmId: activeFarmId,
      seasonId: activeSeasonId,
      settlementNumber: settlement.settlementNumber,
      linkedVoucherId: settlement.linkedVoucherId || "",
      linkedVoucherNumber: settlement.linkedVoucherNumber || settlement.settlementNumber,
      linkedAccountId: settlement.linkedAccountId,
      linkedAccountName: settlement.linkedAccountName ?? settlement.paymentAccountName ?? null,
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
      paymentAccountCanonicalId: settlement.paymentAccountCanonicalId ?? settlement.paymentAccountId ?? settlement.linkedAccountId,
      paymentAccountLegacyId: settlement.paymentAccountLegacyId ?? null,
      paymentAccountName: settlement.paymentAccountName ?? settlement.linkedAccountName ?? null,
      paymentAccountType: settlement.paymentAccountType ?? null,
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
    });
  }, [activeFarmId, activeSeasonId, workspaceId]);

  const scrollToSettlements = useCallback(() => {
    document.getElementById("labour-settlement-register")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const clearPendingSettlementRequest = useCallback(() => {
    if (pendingSettlementStorageKey) window.sessionStorage.removeItem(pendingSettlementStorageKey);
    restoredPendingRequestIdRef.current = null;
    setPendingRequestId(null);
  }, [pendingSettlementStorageKey]);

  const storePendingSettlementRequest = useCallback((clientRequestId: string) => {
    if (!pendingSettlementStorageKey) return;
    window.sessionStorage.setItem(pendingSettlementStorageKey, JSON.stringify({
      clientRequestId,
      workspaceId,
      farmId: activeFarmId,
      seasonId: activeSeasonId,
      storedAt: new Date().toISOString(),
    }));
  }, [activeFarmId, activeSeasonId, pendingSettlementStorageKey, workspaceId]);

  const resetSettlementComposer = useCallback(() => {
    setPreview({ status: "idle", data: null });
    setNotes("");
    setManualAdjustment("0");
    setManualAdjustmentNote("");
  }, []);

  const finalizeSettlementCreateSuccess = useCallback(async (settlement: LabourWageSettlementRecord, message: string, accountingMessage?: string | null) => {
    await persistSettlementRecord(settlement);
    resetSettlementComposer();
    clearPendingSettlementRequest();
    setStatusCheckNotice(accountingMessage ?? "");
    setError("");
    setSuccess(message);
    window.dispatchEvent(new Event("muzare-local-data-change"));
    await syncFromServer();
  }, [clearPendingSettlementRequest, persistSettlementRecord, resetSettlementComposer, syncFromServer]);

  const resolveSettlementCreateStatus = useCallback(async (clientRequestId: string) => {
    if (!token || !workspaceId || !activeFarmId || !activeSeasonId) {
      setStatusCheckNotice(t("wageSettlementsPage.creationStillProcessing"));
      return;
    }
    if (activeStatusResolverRequestIdRef.current === clientRequestId && statusPollingAbortRef.current) {
      return;
    }
    statusPollingAbortRef.current?.abort();
    const abortController = new AbortController();
    statusPollingAbortRef.current = abortController;
    activeStatusResolverRequestIdRef.current = clientRequestId;
    setStatusCheckInFlight(true);
    setStatusCheckNotice(t("wageSettlementsPage.checkingStatus"));
    setError("");
    try {
      const delaysMs = [0, 1500, 3000, 5000, 8000, 10000, 15000, 15000, 15000, 15000, 15000, 15000];
      for (let attempt = 0; attempt < delaysMs.length; attempt += 1) {
        if (abortController.signal.aborted) return;
        const waitMs = delaysMs[attempt] ?? 0;
        if (waitMs > 0) {
          await new Promise((resolve) => window.setTimeout(resolve, waitMs));
        }
        if (abortController.signal.aborted) return;
        const status = await fetchLabourWageSettlementCreateStatus(token, workspaceId, {
          farmId: activeFarmId,
          seasonId: activeSeasonId,
          clientRequestId,
        });
        if ((status.state === "SUCCESS" || status.state === "ALREADY_CREATED") && status.settlement) {
          await finalizeSettlementCreateSuccess(
            status.settlement,
            status.lifecycleMessage ?? status.message ?? (status.state === "ALREADY_CREATED"
              ? t("wageSettlementsPage.alreadyCreatedAs", { number: status.settlement.settlementNumber })
              : t("wageSettlementsPage.createdSuccessfully", { number: status.settlement.settlementNumber })),
            status.accountingStatus === "REPAIR_REQUIRED" || status.accountingStatus === "MISSING" ? status.accountingMessage : null,
          );
          return;
        }
        if (status.state === "FAILED") {
          if (status.safeToRetry) clearPendingSettlementRequest();
          setStatusCheckNotice("");
          setError(status.lifecycleMessage ?? status.message ?? t("wageSettlementsPage.createFailedNoChanges"));
          return;
        }
        if (status.state === "IN_PROGRESS") {
          setStatusCheckNotice(status.lifecycleMessage ?? status.message ?? t("wageSettlementsPage.creationStillProcessing"));
          continue;
        }
      }
      setStatusCheckNotice(t("wageSettlementsPage.creationProcessingLeavePage"));
    } catch (caught) {
      if (!abortController.signal.aborted) {
        setStatusCheckNotice(t("wageSettlementsPage.creationProcessingLeavePage"));
        setError(caught instanceof Error ? caught.message : t("wageSettlementsPage.unableToVerifyStatus"));
      }
    } finally {
      if (statusPollingAbortRef.current === abortController) {
        statusPollingAbortRef.current = null;
      }
      if (activeStatusResolverRequestIdRef.current === clientRequestId) {
        activeStatusResolverRequestIdRef.current = null;
      }
      setStatusCheckInFlight(false);
    }
  }, [activeFarmId, activeSeasonId, clearPendingSettlementRequest, finalizeSettlementCreateSuccess, token, workspaceId]);

  useEffect(() => {
    if (!pendingSettlementStorageKey || pendingRequestId || !token || !workspaceId || !activeFarmId || !activeSeasonId) return;
    const raw = window.sessionStorage.getItem(pendingSettlementStorageKey);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as { clientRequestId?: string };
      const storedClientRequestId = typeof parsed.clientRequestId === "string" ? parsed.clientRequestId : "";
      if (!storedClientRequestId) {
        window.sessionStorage.removeItem(pendingSettlementStorageKey);
        return;
      }
      if (restoredPendingRequestIdRef.current === storedClientRequestId) return;
      restoredPendingRequestIdRef.current = storedClientRequestId;
      setPendingRequestId(storedClientRequestId);
      setStatusCheckNotice(t("wageSettlementsPage.checkingStatus"));
      void resolveSettlementCreateStatus(storedClientRequestId);
    } catch {
      window.sessionStorage.removeItem(pendingSettlementStorageKey);
    }
  }, [activeFarmId, activeSeasonId, pendingRequestId, pendingSettlementStorageKey, resolveSettlementCreateStatus, token, workspaceId]);

  const previewSettlement = async () => {
    if (!token || !workspaceId || !activeFarmId || !activeSeasonId) {
      setError(t("farmsPage.noActiveSeason"));
      return;
    }
    if (fromDate > toDate) {
      setError(t("wageSettlementsPage.fromDateBeforeToDate"));
      return;
    }
    setPreviewDiagnostics({
      submittedPayload: previewRequest,
      missingRequiredFields: previewMissingRequiredFields,
      apiStatus: null,
      apiResponseBody: null,
      storedPreview: null,
      createDisabledReason,
    });
    if (previewMissingRequiredFields.length > 0) {
      setPreview({ status: "error", data: null });
      setError(t("wageSettlementsPage.previewMissingFields", { fields: previewMissingRequiredFields.join(", ") }));
      return;
    }
    setPreview({ status: "loading", data: null });
    setError("");
    setSuccess("");
    try {
      if (import.meta.env.DEV) {
        console.debug("labour-settlement-preview", {
          selectedGroupId: groupId || null,
          displayedForemanName: selectedGroupForemanId ? (labourers.find((labourer) => labourer.id === selectedGroupForemanId)?.name ?? null) : null,
          groupForemanId: selectedGroupForemanId || null,
          formForemanId: foremanId || null,
          outgoingPayload: previewRequest,
        });
      }
      const response = await previewLabourWageSettlement(token, workspaceId, previewRequest);
      setPreview({ status: "ready", data: response.preview });
      setPreviewDiagnostics((current) => ({
        ...current,
        apiStatus: 200,
        apiResponseBody: response,
        storedPreview: response.preview,
        createDisabledReason: "",
      }));
    } catch (caught) {
      setPreview({ status: "error", data: null });
      if (caught instanceof ApiError) {
        setPreviewDiagnostics((current) => ({
          ...current,
          apiStatus: caught.status,
          apiResponseBody: caught.responseBody ?? caught.details ?? null,
        }));
      }
      setError(caught instanceof Error ? caught.message : t("wageSettlementsPage.unableToPreview"));
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canPost) {
      setError(t("common.viewOnlyAccess"));
      return;
    }
    if (onlineRequired) {
      setError(t("wageSettlementsPage.requiresOnlineConnection"));
      return;
    }
    if (!token || !workspaceId || !activeFarmId || !activeSeasonId) {
      setError(t("wageSettlementsPage.selectFarmSeasonBeforeSettlement"));
      return;
    }
    if (settlementMode === "individual" && !labourerId) {
      setError(t("wageSettlementsPage.selectLabourerIndividual"));
      return;
    }
    if (settlementMode === "group" && !groupId) {
      setError(t("wageSettlementsPage.selectLabourGroup"));
      return;
    }
    if (Number(manualAdjustment || 0) !== 0 && !manualAdjustmentNote.trim()) {
      setError(t("wageSettlementsPage.manualAdjustmentNoteRequired"));
      return;
    }
    if (createDisabledReason) {
      setError(createDisabledReason);
      return;
    }
    setSubmitting(true);
    setError("");
    setSuccess("");
    setStatusCheckNotice("");
    const clientRequestId = pendingRequestId ?? crypto.randomUUID();
    if (!pendingRequestId) {
      setPendingRequestId(clientRequestId);
    }
    storePendingSettlementRequest(clientRequestId);
    try {
      if (import.meta.env.DEV) {
        console.debug("labour-settlement-create", {
          selectedGroupId: groupId || null,
          displayedForemanName: selectedGroupForemanId ? (labourers.find((labourer) => labourer.id === selectedGroupForemanId)?.name ?? null) : null,
          groupForemanId: selectedGroupForemanId || null,
          formForemanId: foremanId || null,
          outgoingPayload: {
            farmId: activeFarmId,
            seasonId: activeSeasonId,
            fromDate,
            toDate,
            settlementDate,
            clientRequestId,
            settlementMode,
            labourerId: settlementMode === "individual" ? labourerId || undefined : undefined,
            groupId: settlementMode === "group" ? groupId || undefined : undefined,
            paidAmount: 0,
            manualAdjustment: Number(manualAdjustment || 0),
            manualAdjustmentNote: Number(manualAdjustment || 0) !== 0 ? manualAdjustmentNote.trim() : undefined,
            notes: notes.trim() || undefined,
          },
        });
      }
      const response = await createLabourWageSettlement(token, workspaceId, {
        farmId: activeFarmId,
        seasonId: activeSeasonId,
        fromDate,
        toDate,
        settlementDate,
        clientRequestId,
        settlementMode,
        labourerId: settlementMode === "individual" ? labourerId || undefined : undefined,
        groupId: settlementMode === "group" ? groupId || undefined : undefined,
        paidAmount: 0,
        manualAdjustment: Number(manualAdjustment || 0),
        manualAdjustmentNote: Number(manualAdjustment || 0) !== 0 ? manualAdjustmentNote.trim() : undefined,
        notes: notes.trim() || undefined,
      });
      if ((response.state === "SUCCESS" || response.state === "ALREADY_CREATED") && response.settlement) {
        await finalizeSettlementCreateSuccess(
          response.settlement,
          response.lifecycleMessage ?? response.message ?? (response.state === "ALREADY_CREATED"
            ? t("wageSettlementsPage.alreadyCreatedAs", { number: response.settlement.settlementNumber })
            : t("wageSettlementsPage.createdSuccessfully", { number: response.settlement.settlementNumber })),
          response.accountingStatus === "REPAIR_REQUIRED" || response.accountingStatus === "MISSING" ? response.accountingMessage : null,
        );
        return;
      }
      if (response.state === "FAILED") {
        if (response.safeToRetry) clearPendingSettlementRequest();
        setStatusCheckNotice("");
        setError(response.lifecycleMessage ?? response.message ?? t("wageSettlementsPage.createFailedNoChanges"));
        return;
      }
      setStatusCheckNotice(response.lifecycleMessage ?? response.message ?? t("wageSettlementsPage.creationStillProcessing"));
      await resolveSettlementCreateStatus(clientRequestId);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : t("wageSettlementsPage.unableToCreate");
      const isRecoverableTimeout = message.includes("Checking settlement status");
      if (isRecoverableTimeout) {
        setSubmitting(false);
        setStatusCheckNotice(t("wageSettlementsPage.requestTakingLonger"));
        await resolveSettlementCreateStatus(clientRequestId);
      } else if (caught instanceof ApiError) {
        clearPendingSettlementRequest();
        setStatusCheckNotice("");
        setError(message);
      } else {
        setStatusCheckNotice(t("wageSettlementsPage.requestTakingLonger"));
        await resolveSettlementCreateStatus(clientRequestId);
      }
    } finally {
      setSubmitting(false);
    }
  };

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
  const summaryAdvanceBalance = summary?.availableAdvanceBalanceBeforeSettlement ?? summary?.advancesAvailableUpToSettlementDate ?? summaryTotals.availableAdvanceBalance;
  const summaryAdvanceAdjustedNow = summary?.advanceAdjustedNow ?? summary?.settledAdvanceAmount ?? summaryTotals.advanceAdjustedNow;
  const summaryAdvanceCarryForward = summary?.remainingAdvanceCarryForward ?? summary?.carryForwardAdvance ?? summaryTotals.advanceCarriedForward;
  const summaryNetPayableBeforePayment = summary?.netPayableBeforePayment ?? summaryTotals.netPayableBeforePayment;
  const summaryBalanceAfterSettlement = summary?.balanceAfterPayment ?? summary?.payableBalance ?? summaryTotals.balanceAfterSettlement;
  const advanceBalanceLabel = t("wageSettlementsPage.availableGroupAdvances");
  const advanceAdjustedLabel = t("wageSettlementsPage.advanceAbsorbedThisSettlementTitle");
  const advanceCarryForwardLabel = t("wageSettlementsPage.outstandingGroupAdvanceTitle");
  const createDisabledReason = useMemo(() => {
    if (!canPost) return t("common.viewOnlyAccess");
    if (onlineRequired) return t("wageSettlementsPage.requiresOnlineConnection");
    if (!token || !workspaceId || !activeFarmId || !activeSeasonId) return t("wageSettlementsPage.selectFarmSeasonBeforeSettlement");
    if (settlementMode === "individual" && !labourerId) return t("wageSettlementsPage.selectLabourerIndividual");
    if (settlementMode === "group" && !groupId) return t("wageSettlementsPage.selectLabourGroup");
    if (Number(manualAdjustment || 0) !== 0 && !manualAdjustmentNote.trim()) return t("wageSettlementsPage.manualAdjustmentNoteRequired");
    if (!summary) return t("wageSettlementsPage.previewBeforePosting");
    if (summary.unresolvedRows.length || summary.overlappingSettlements.length) return t("wageSettlementsPage.unresolvedRatesOrOverlap");
    if (!summaryConsistent) return t("wageSettlementsPage.previewInconsistent");
    return "";
  }, [activeFarmId, activeSeasonId, canPost, labourerId, manualAdjustment, manualAdjustmentNote, onlineRequired, settlementMode, summary, summaryConsistent, t, token, workspaceId, groupId]);
  useEffect(() => {
    setPreviewDiagnostics((current) => ({
      ...current,
      createDisabledReason,
      storedPreview: summary,
    }));
  }, [createDisabledReason, summary]);
  const resolvedSelectedForemanId = summary?.foremanId ?? effectiveGroupForemanId ?? foremanId;
  const selectedForeman = useMemo(() => labourers.find((labourer) => labourer.id === resolvedSelectedForemanId) ?? null, [labourers, resolvedSelectedForemanId]);
  const selectedGroupName = summary?.groupName ?? selectedGroup?.name ?? "";
  const settlementForemanName = summary?.foremanId
    ? labourers.find((labourer) => labourer.id === summary.foremanId)?.name ?? null
    : selectedForeman?.name ?? null;
  const filteredPreviewLabourRows = useMemo(() => {
    const term = previewSearch.trim().toLowerCase();
    return includedLabourRows.filter((row) => {
      const status = row.currentStatus === "active" ? "active" : "inactive";
      return (previewStatusFilter === "all" || previewStatusFilter === status)
        && (!term || [row.labourName, row.groupName ?? "", row.wageRateLabel ?? "", String(row.grossWage)].some((value) => value.toLowerCase().includes(term)));
    });
  }, [includedLabourRows, previewSearch, previewStatusFilter]);
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
  const activeLabourers = useMemo(() => labourers.filter((labourer) => isLabourAvailableForEntry(labourer, settlementDate)).sort((left, right) => left.name.localeCompare(right.name)), [labourers, settlementDate]);
  const activeLabourGroups = useMemo(() => labourGroups.filter((group) => group.active !== false).sort((left, right) => left.name.localeCompare(right.name)), [labourGroups]);
  useEffect(() => {
    if (settlementMode === "individual" && labourerId && !activeLabourers.some((labourer) => labourer.id === labourerId)) setLabourerId("");
  }, [activeLabourers, labourerId, settlementMode]);
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
  const openSettlementVoucher = useCallback((settlement: LabourWageSettlement | LabourWageSettlementDetail) => {
    openSettlement(settlement);
    const next = new URLSearchParams(searchParams);
    next.set("recordId", settlement.id);
    setSearchParams(next);
  }, [openSettlement, searchParams, setSearchParams]);
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
        accountingMessage: response.accountingStatus === "posted" ? null : t("wageSettlementsPage.accountingEntriesMissingRepost"),
        updatedAt: new Date().toISOString(),
      });
      setSuccess(t("wageSettlementsPage.accountingRepairedFor", { number: response.settlementNumber }));
      window.dispatchEvent(new Event("muzare-local-data-change"));
      await syncFromServer();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("wageSettlementsPage.unableToRepairAccounting"));
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
      setSuccess(t("wageSettlementsPage.settlementUpdated", { number: response.settlement.settlementNumber }));
      window.dispatchEvent(new Event("muzare-local-data-change"));
      await syncFromServer();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("wageSettlementsPage.unableToUpdateSettlement"));
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
        accountingMessage: t("wageSettlementsPage.settlementHasBeenVoided"),
        voidedAt: response.voidedAt,
        voidedBy: response.voidedBy,
        voidReason: response.voidReason,
        updatedAt: response.voidedAt,
      });
      setVoidingSettlement(null);
      closeSettlement();
      setSuccess(t("wageSettlementsPage.settlementVoidedAndReversed", { number: response.settlementNumber }));
      window.dispatchEvent(new Event("muzare-local-data-change"));
      await syncFromServer();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("wageSettlementsPage.unableToVoidSettlement"));
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
        accountingMessage: t("wageSettlementsPage.settlementDeletedBeforeAccountingPosted"),
        deletedAt,
        deletedBy: user?.id ?? null,
        updatedAt: deletedAt,
      });
      setDeletingSettlement(null);
      if (selectedSettlement?.id === settlement.id) closeSettlement();
      setSuccess(t("wageSettlementsPage.settlementDeletedAdvancesAvailable", { number: response.settlementNumber }));
      window.dispatchEvent(new Event("muzare-local-data-change"));
      await syncFromServer();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("wageSettlementsPage.unableToDeleteSettlement"));
    } finally {
      setDeletingSettlementId(null);
    }
  }, [closeSettlement, selectedSettlement?.id, syncFromServer, token, user?.id, workspaceId]);
  const registerRows = useMemo(() => {
    const term = registerSearch.trim().toLowerCase();
    return settlements.filter((settlement) => {
      const settlementAccountId = settlement.paymentAccountId ?? settlement.linkedAccountId;
      const accountName = settlementPaymentAccountById.get(settlementAccountId)?.name ?? accountById.get(settlementAccountId)?.name ?? "";
      const foremanName = labourers.find((labourer) => labourer.id === settlement.foremanId)?.name ?? "";
      const labourNames = (settlement.includedLabourRows ?? []).map((row) => row.labourName).join(" ");
      return (statusFilter === "all" || settlementStatus(settlement) === statusFilter)
        && (paymentAccountFilter === "all" || settlementAccountId === paymentAccountFilter)
        && (!term || [
          settlement.settlementNumber,
          settlement.settlementDate,
          settlement.fromDate,
          settlement.toDate,
          settlement.notes ?? "",
          settlement.linkedVoucherNumber ?? "",
          settlement.groupName ?? "",
          foremanName,
          labourNames,
          settlement.status,
          settlement.accountingStatus ?? "",
          accountName,
          String(settlement.totalEarned),
          String(settlement.expenseAmount),
          String(settlement.settledAdvanceAmount),
        ].some((value) => value.toLowerCase().includes(term)));
    });
  }, [accountById, labourers, paymentAccountFilter, registerSearch, settlementPaymentAccountById, settlementStatus, settlements, statusFilter]);
  const clearRegisterFilters = useCallback(() => {
    setRegisterSearch("");
    setStatusFilter("all");
    setPaymentAccountFilter("all");
  }, []);
  const registerTotalRows = useMemo(() => statusFilter === "voided" || statusFilter === "deleted"
    ? registerRows
    : registerRows.filter((settlement) => !["voided", "deleted"].includes(settlementStatus(settlement))), [registerRows, settlementStatus, statusFilter]);
  const registerTotals = useMemo(() => registerTotalRows.reduce((totals, settlement) => ({
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
  }), [registerTotalRows]);
  const exportRegister = () => {
    const header = [
      t("wageSettlementsPage.settlementNoLabel"),
      t("wageSettlementsPage.settlementDate"),
      t("wageSettlementsPage.periodLabel"),
      t("wageSettlementsPage.settlementModeLabel"),
      t("wageSettlementsPage.foremanGroup"),
      t("wageSettlementsPage.includedLabourers"),
      t("wageSettlementsPage.attendanceWagesTitle"),
      t("wageSettlementsPage.labourWorkTitle"),
      t("wageSettlementsPage.grossWagesEarnedTitle"),
      t("wageSettlementsPage.advanceAdjustedNowTitle"),
      t("wageSettlementsPage.advanceCarriedForwardTitle"),
      t("wageSettlementsPage.paidNowTitle"),
      t("wageSettlementsPage.paidFromAccountTitle"),
      t("wageSettlementsPage.accountingReferenceTitle"),
      t("common.status"),
    ];
    const rows = registerRows.map((settlement) => {
      const foremanName = labourers.find((labourer) => labourer.id === settlement.foremanId)?.name ?? "";
      return [
        settlement.settlementNumber,
        settlement.settlementDate,
        `${settlement.fromDate} ${t("wageSettlementsPage.periodTo")} ${settlement.toDate}`,
        translateStatus(t, settlement.settlementMode ?? "individual"),
        foremanName || settlement.groupName || settlement.groupId || "-",
        settlement.includedLabourIds?.length ?? "-",
        settlement.attendanceWages,
        settlement.labourWorkWages ?? settlement.pendingLabourEarnings,
        settlement.grossWages ?? settlement.expenseAmount,
        settlement.advanceAdjustedNow ?? settlement.settledAdvanceAmount,
        settlement.remainingAdvanceCarryForward ?? settlement.carryForwardAdvance,
        settlement.paidAmount ?? settlement.payableBalance,
        settlementPaymentAccountById.get(settlement.paymentAccountId ?? settlement.linkedAccountId)?.name ?? accountById.get(settlement.paymentAccountId ?? settlement.linkedAccountId)?.name ?? "",
        settlement.settlementNumber,
        translateStatus(t, settlement.status),
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
    <div className="labour-wage-settlements-page">
        <section className="record-panel workforce-shell-intro workforce-shell-intro--nested">
          <div>
            <h2>{settlementMode === "group" ? t("wageSettlementsPage.foremanGroupPeriodSettlementTitle") : t("wageSettlementsPage.labourPeriodSettlementTitle")}</h2>
            <p>
              {t("wageSettlementsPage.previewApplyPostIntro")}
            </p>
          </div>
          <span className="local-pill">{onlineRequired ? t("wageSettlementsPage.onlineRequired") : t("wageSettlementsPage.onlineAndReady")}</span>
        </section>

        {(!activeFarmId || !activeSeasonId) && <section className="record-panel">
          <p className="context-message">{t("wageSettlementsPage.selectFarmSeasonBeforeCreating")}</p>
        </section>}

        <section className="record-panel labour-settlement-form-panel">
          <div className="advances-heading">
            <h2>{settlementMode === "group" ? t("wageSettlementsPage.foremanGroupPeriodSettlementSentence") : t("wageSettlementsPage.labourPeriodSettlementSentence")}</h2>
            <span>{t("wageSettlementsPage.accountingPostedUnderNumber")}</span>
          </div>
          <form className="module-form wage-settlement-form" onSubmit={(event) => void submit(event)}>
            <fieldset className="wage-settlement-form-section">
              <legend>{t("wageSettlementsPage.periodLabel")}</legend>
              <div className="wage-settlement-period-grid">
              <label className="advances-filter-field">
                <span>{t("wageSettlementsPage.fromDate")}</span>
                <input required type="date" className="bidi-isolate" value={fromDate} onChange={(event) => setFromDate(event.target.value)} />
              </label>
              <label className="advances-filter-field">
                <span>{t("wageSettlementsPage.toDate")}</span>
                <input required type="date" className="bidi-isolate" value={toDate} onChange={(event) => setToDate(event.target.value)} />
              </label>
              <label className="advances-filter-field">
                <span>{t("wageSettlementsPage.settlementDate")}</span>
                <input required type="date" className="bidi-isolate" value={settlementDate} onChange={(event) => setSettlementDate(event.target.value)} />
              </label>
              </div>
            </fieldset>
            <fieldset className="wage-settlement-form-section">
              <legend>{t("wageSettlementsPage.scopeLabel")}</legend>
              <div className="advances-filter-row wage-settlement-scope-grid">
              <label className="advances-filter-field">
                <span>{t("wageSettlementsPage.settlementModeLabel")}</span>
                <select value={settlementMode} onChange={(event) => setSettlementMode(event.target.value as "individual" | "group")}>
                  <option value="individual">{t("wageSettlementsPage.individualLabourSettlementOption")}</option>
                  <option value="group">{t("wageSettlementsPage.foremanGroupPeriodSettlementSentence")}</option>
                </select>
              </label>
              {settlementMode === "individual" ? (
                <label className="advances-filter-field">
                  <span>{t("wageSettlementsPage.labourerLabel")}</span>
                  <select required value={labourerId} onChange={(event) => setLabourerId(event.target.value)}>
                    <option value="">{t("wageSettlementsPage.selectLabourerOption")}</option>
                    {activeLabourers.map((labourer) => <option key={labourer.id} value={labourer.id}>{labourer.name}</option>)}
                  </select>
                </label>
              ) : (
                <>
                  <label className="advances-filter-field">
                    <span>{t("wageSettlementsPage.groupLabel")}</span>
                    <select value={groupId} onChange={(event) => setGroupId(event.target.value)}>
                      <option value="">{t("wageSettlementsPage.selectGroupOption")}</option>
                      {activeLabourGroups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
                    </select>
                  </label>
                  <label className="advances-filter-field">
                    <span>{t("wageSettlementsPage.assignedForeman")}</span>
                    <input
                      value={selectedGroup ? (labourers.find((labourer) => labourer.id === selectedGroupForemanId)?.name ?? t("wageSettlementsPage.noForemanAssigned")) : ""}
                      placeholder={t("wageSettlementsPage.selectGroupFirstPlaceholder")}
                      readOnly
                    />
                  </label>
                </>
              )}
              </div>
            </fieldset>
            <fieldset className="wage-settlement-form-section">
              <legend>{t("wageSettlementsPage.adjustmentsAndDueCreation")}</legend>
              <div className="advances-filter-row wage-settlement-payment-grid">
              <label className="advances-filter-field">
                <span>{t("wageSettlementsPage.manualAdjustmentLabel")}</span>
                <input type="number" step="0.01" value={manualAdjustment} onChange={(event) => setManualAdjustment(event.target.value)} />
              </label>
              {hasManualAdjustment ? <label className="advances-filter-field advances-filter-field--full">
                <span>{t("wageSettlementsPage.manualAdjustmentNoteLabel")}</span>
                <input required value={manualAdjustmentNote} onChange={(event) => setManualAdjustmentNote(event.target.value)} placeholder={t("wageSettlementsPage.explainManualAdjustmentPlaceholder")} />
                <small>{t("wageSettlementsPage.manualAdjustmentNoteHint")}</small>
              </label> : null}
              <p className="wage-settlement-account-hint">{t("wageSettlementsPage.creatingSettlementDueHint")}</p>
              <label className="advances-filter-field advances-filter-field--full">
                <span>{t("wageSettlementsPage.notesLabel")}</span>
                <input value={notes} onChange={(event) => setNotes(event.target.value)} placeholder={t("wageSettlementsPage.optionalNotesPlaceholder")} />
              </label>
              </div>
            </fieldset>
            {onlineRequired ? <p className="worker-action-warning">{t("wageSettlementsPage.requiresOnlineConnection")}</p> : null}
            {statusCheckNotice ? <p className="context-message">{statusCheckNotice}</p> : null}
            {error ? <p className="form-error">{error}</p> : null}
            {pendingRequestId ? (
              <div className="module-inline-actions">
                <button
                  type="button"
                  className="secondary-action"
                  onClick={() => pendingRequestId ? void resolveSettlementCreateStatus(pendingRequestId) : undefined}
                  disabled={statusCheckInFlight || !pendingRequestId}
                >
                  {t("wageSettlementsPage.checkStatusButton")}
                </button>
                <button type="button" className="secondary-action" onClick={scrollToSettlements} disabled={statusCheckInFlight}>
                  {t("wageSettlementsPage.viewSettlementsButton")}
                </button>
              </div>
            ) : null}
            {success ? <p className="context-message">{success}</p> : null}
            <div className="wage-settlement-actions">
              <button type="button" className="primary-action wage-settlement-preview-action" onClick={() => void previewSettlement()} disabled={!token || !workspaceId || !activeFarmId || !activeSeasonId || preview.status === "loading" || Boolean(pendingRequestId) || submitting || statusCheckInFlight}>
                {preview.status === "loading" ? t("wageSettlementsPage.previewingEllipsis") : t("wageSettlementsPage.previewSettlementButton")}
              </button>
              <button type="submit" disabled={Boolean(createDisabledReason) || submitting || statusCheckInFlight || Boolean(pendingRequestId)}>
                {submitting
                  ? t("wageSettlementsPage.creatingSettlementDueEllipsis")
                  : pendingRequestId
                    ? t("wageSettlementsPage.settlementInProgressEllipsis")
                    : t("wageSettlementsPage.createSettlementDueButton")}
              </button>
            </div>
            {createDisabledReason && !submitting ? <p className="wage-settlement-create-hint">{createDisabledReason}</p> : null}
          </form>
        </section>

        <section className="record-panel labour-settlement-preview-panel">
          <div className="advances-heading">
            <h2>{t("wageSettlementsPage.settlementPreviewTitle")}</h2>
            <span>{t("wageSettlementsPage.advancesMayReduceDueHint")}</span>
          </div>
          {!summary ? <p className="context-message">{t("wageSettlementsPage.runPreviewHint")}</p> : <>
            <div className="record-panel">
              <h3>{t("wageSettlementsPage.settlementHeaderTitle")}</h3>
              <div className="reports-summary-list">
                <article><span>{t("wageSettlementsPage.settlementNumberLabel")}</span><strong>{t("wageSettlementsPage.assignedOnPost")}</strong></article>
                <article><span>{t("wageSettlementsPage.groupNameLabel")}</span><strong>{selectedGroupName || "-"}</strong></article>
                <article><span>{t("wageSettlementsPage.foremanLabel")}</span><strong>{settlementForemanName ?? t("wageSettlementsPage.noForemanAssigned")}</strong></article>
                <article><span>{t("wageSettlementsPage.attendancePeriodLabel")}</span><strong className="bidi-isolate">{fromDate} {t("wageSettlementsPage.periodTo")} {toDate}</strong></article>
                <article><span>{t("wageSettlementsPage.advancesConsideredUntil")}</span><strong className="bidi-isolate">{summary.settlementDate}</strong></article>
                <article><span>{t("wageSettlementsPage.includedWorkers")}</span><strong>{summaryTotals.includedLabourers}</strong></article>
                <article><span>{t("wageSettlementsPage.settlementStatusLabel")}</span><strong>{summaryConsistent ? t("wageSettlementsPage.readyToCreateDue") : t("wageSettlementsPage.needsReview")}</strong></article>
              </div>
            </div>

            <div className="reports-kpis">
              <article><span>{t("wageSettlementsPage.grossWagesTitle")}</span><strong className="bidi-isolate">{money(summaryTotals.grossWagesEarned)}</strong></article>
              <article><span>{advanceBalanceLabel}</span><strong className="bidi-isolate">{money(summaryAdvanceBalance)}</strong></article>
              <article><span>{advanceAdjustedLabel}</span><strong className="bidi-isolate">{money(summaryAdvanceAdjustedNow)}</strong></article>
              <article><span>{advanceCarryForwardLabel}</span><strong className="bidi-isolate">{money(summaryAdvanceCarryForward)}</strong></article>
              <article><span>{t("wageSettlementsPage.netWagesPayableTitle")}</span><strong className="bidi-isolate">{money(summaryNetPayableBeforePayment)}</strong></article>
              <article><span>{t("wageSettlementsPage.cashPaidNowTitle")}</span><strong className="bidi-isolate">{money(0)}</strong></article>
              <article><span>{t("wageSettlementsPage.dueAfterAdvancesTitle")}</span><strong className="bidi-isolate">{money(summaryBalanceAfterSettlement)}</strong></article>
            </div>

            <details className="record-panel">
              <summary>{t("wageSettlementsPage.attendanceSummaryTitle")}</summary>
              <div className="reports-summary-list">
                <article><span>{t("wageSettlementsPage.presentDaysTitle")}</span><strong>{summaryTotals.presentDays}</strong></article>
                <article><span>{t("wageSettlementsPage.halfDayDaysTitle")}</span><strong>{summaryTotals.halfDayDays}</strong></article>
                <article><span>{t("wageSettlementsPage.payableDaysTitle")}</span><strong>{summaryTotals.payableDays}</strong></article>
                <article><span>{t("wageSettlementsPage.attendanceWagesTitle")}</span><strong className="bidi-isolate">{money(summaryTotals.attendanceWages)}</strong></article>
                <article><span>{t("wageSettlementsPage.labourWorkWagesTitle")}</span><strong className="bidi-isolate">{money(summaryTotals.labourWorkWages)}</strong></article>
              </div>
            </details>

            <div className="record-panel">
              <h3>{t("wageSettlementsPage.supportingReconciliationTitle")}</h3>
              <div className="reports-summary-list">
                <article><span>{t("wageSettlementsPage.totalAdvancesUpToCutoff")}</span><strong className="bidi-isolate">{money(summary.rawAdvancesUpToSettlementDate)}</strong></article>
                <article><span>{t("wageSettlementsPage.previouslyAbsorbedAdvances")}</span><strong className="bidi-isolate">{money(summary.previouslySettledAdvances)}</strong></article>
                <article><span>{t("wageSettlementsPage.availableAdvances")}</span><strong className="bidi-isolate">{money(summary.availableAdvanceBalanceBeforeSettlement ?? 0)}</strong></article>
                <article><span>{t("wageSettlementsPage.previewConsistencyStatus")}</span><strong>{summaryConsistent ? t("wageSettlementsPage.consistentStatus") : t("wageSettlementsPage.needsReview")}</strong></article>
              </div>
              {summary.advanceReconciliation?.length ? (
                <div className="attendance-import-table-wrap report-wide-table">
                  <table className="report-data-table">
                    <thead>
                      <tr>
                        <th>{t("wageSettlementsPage.advanceColumn")}</th>
                        <th>{t("wageSettlementsPage.dateColumn")}</th>
                        <th>{t("wageSettlementsPage.labourerColumn")}</th>
                        <th>{t("wageSettlementsPage.groupColumn")}</th>
                        <th>{t("wageSettlementsPage.accountColumn")}</th>
                        <th>{t("wageSettlementsPage.originalColumn")}</th>
                        <th>{t("wageSettlementsPage.previouslyAbsorbedColumn")}</th>
                        <th>{t("wageSettlementsPage.remainingAvailableColumn")}</th>
                        <th>{t("wageSettlementsPage.includedColumn")}</th>
                        <th>{t("wageSettlementsPage.exclusionReasonColumn")}</th>
                        <th>{t("wageSettlementsPage.sourceTypeColumn")}</th>
                        <th>{t("common.status")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {summary.advanceReconciliation.map((row) => (
                        <tr key={row.advanceId}>
                          <td className="bidi-isolate">{row.advanceId}</td>
                          <td className="bidi-isolate">{row.date}</td>
                          <td>{row.labourerName ?? row.labourerId ?? "-"}</td>
                          <td>{row.labourGroupName ?? "-"}</td>
                          <td>{row.accountName ?? "-"}</td>
                          <td className="bidi-isolate">{money(row.originalAmount)}</td>
                          <td className="bidi-isolate">{money(row.previouslyAbsorbedAmount)}</td>
                          <td className="bidi-isolate">{money(row.remainingAvailableAmount)}</td>
                          <td>{row.includedInPreview ? t("wageSettlementsPage.yes") : t("wageSettlementsPage.no")}</td>
                          <td>{row.exclusionReason ?? "-"}</td>
                          <td>{translateStatus(t, row.sourceRecordType)}</td>
                          <td>{row.voidedOrDeleted ? t("wageSettlementsPage.voidedOrDeleted") : t("common.active")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </div>

            <div className="record-panel">
              <div className="advances-heading">
                <h3>{t("wageSettlementsPage.labourWageContributionListTitle")}</h3>
                <span>{t("wageSettlementsPage.grossWageContributionHint")}</span>
              </div>
              <div className="module-inline-actions">
                <label className="advances-filter-field">
                  <span>{t("common.search")}</span>
                  <input value={previewSearch} onChange={(event) => setPreviewSearch(event.target.value)} placeholder={t("wageSettlementsPage.searchLabourerOrWagePlaceholder")} />
                </label>
                <label className="advances-filter-field">
                  <span>{t("common.status")}</span>
                  <select value={previewStatusFilter} onChange={(event) => setPreviewStatusFilter(event.target.value as "all" | "active" | "inactive")}>
                    <option value="all">{t("wageSettlementsPage.allLabourersOption")}</option>
                    <option value="active">{t("wageSettlementsPage.activeOnlyOption")}</option>
                    <option value="inactive">{t("wageSettlementsPage.inactiveOnlyOption")}</option>
                  </select>
                </label>
              </div>
              {filteredPreviewLabourRows.length > 0 ? (
                <div className="report-mobile-cards">
                  {filteredPreviewLabourRows.map((row) => (
                    <article className="report-mobile-card" key={`preview:${row.labourerId}`}>
                      <header>
                        <strong>{row.labourName}</strong>
                        <b className="bidi-isolate">{money(row.grossWage)}</b>
                      </header>
                      <span>{row.currentStatus === "active" ? t("common.active") : t("common.inactive")}</span>
                      <details>
                        <summary>{t("wageSettlementsPage.viewWageContribution")}</summary>
                        <dl>
                          <div><dt>{t("wageSettlementsPage.presentDaysLower")}</dt><dd>{row.presentDays}</dd></div>
                          <div><dt>{t("wageSettlementsPage.halfDayDaysLower")}</dt><dd>{row.halfDayDays}</dd></div>
                          <div><dt>{t("wageSettlementsPage.payableDaysLower")}</dt><dd>{row.payableDays}</dd></div>
                          <div><dt>{t("wageSettlementsPage.wageRateLower")}</dt><dd>{row.wageRateLabel ?? "-"}</dd></div>
                          <div><dt>{t("wageSettlementsPage.attendanceWageLower")}</dt><dd className="bidi-isolate">{money(row.attendanceWage)}</dd></div>
                          <div><dt>{t("wageSettlementsPage.labourWorkWageLower")}</dt><dd className="bidi-isolate">{money(row.labourWorkWage)}</dd></div>
                          <div><dt>{t("wageSettlementsPage.grossWageContributionLower")}</dt><dd className="bidi-isolate">{money(row.grossWage)}</dd></div>
                        </dl>
                      </details>
                    </article>
                  ))}
                </div>
              ) : <p className="context-message">{t("wageSettlementsPage.noContributionsMatchSearch")}</p>}
            </div>

            <div className="module-inline-actions">
              <button type="button" className="secondary-action" onClick={openMatchingAttendanceReport}>{t("wageSettlementsPage.viewMatchingAttendanceReport")}</button>
              {!summaryConsistent ? <span className="worker-action-warning">{t("wageSettlementsPage.previewInconsistent")}</span> : null}
            </div>

            {summary.excludedLabourers?.length ? <details className="worker-action-warning">
              <summary>{t("wageSettlementsPage.excludedLabourersTitle")}</summary>
              <ul>
                {summary.excludedLabourers.map((row) => <li key={row.labourerId}>{row.labourName}: {row.reason}</li>)}
              </ul>
            </details> : null}
            {summary.unresolvedRows.length > 0 && <div className="worker-action-warning">
              <strong>{t("wageSettlementsPage.missingWageRatesTitle")}</strong>
              <ul>
                {summary.unresolvedRows.slice(0, 8).map((row) => <li key={`${row.labourerId}:${row.date}`}>{t("wageSettlementsPage.noActiveWageRateLine", { name: row.labourName, date: row.date, status: translateStatus(t, row.status) })}</li>)}
              </ul>
            </div>}
            {summary.overlappingSettlements.length > 0 && <div className="worker-action-warning">
              <strong>{t("wageSettlementsPage.overlappingSettlementsFoundTitle")}</strong>
              <ul>
                {summary.overlappingSettlements.map((row) => <li key={row.id}>{t("wageSettlementsPage.overlappingSettlementLine", { number: row.settlementNumber, fromDate: row.fromDate, toDate: row.toDate, status: translateStatus(t, row.status) })}</li>)}
              </ul>
            </div>}
          </>}
          {import.meta.env.DEV ? (
            <details className="record-panel">
              <summary>{t("wageSettlementsPage.previewDiagnosticsTitle")}</summary>
              <div className="reports-summary-list">
                <article><span>{t("wageSettlementsPage.submittedPayloadLabel")}</span><strong><pre>{JSON.stringify(previewDiagnostics.submittedPayload, null, 2)}</pre></strong></article>
                <article><span>{t("wageSettlementsPage.missingRequiredFieldsLabel")}</span><strong>{previewDiagnostics.missingRequiredFields.length ? previewDiagnostics.missingRequiredFields.join(", ") : t("wageSettlementsPage.none")}</strong></article>
                <article><span>{t("wageSettlementsPage.apiStatusLabel")}</span><strong>{previewDiagnostics.apiStatus ?? "-"}</strong></article>
                <article><span>{t("wageSettlementsPage.apiResponseBodyLabel")}</span><strong><pre>{JSON.stringify(previewDiagnostics.apiResponseBody, null, 2)}</pre></strong></article>
                <article><span>{t("wageSettlementsPage.storedPreviewObjectLabel")}</span><strong><pre>{JSON.stringify(previewDiagnostics.storedPreview, null, 2)}</pre></strong></article>
                <article><span>{t("wageSettlementsPage.createSettlementDisabledBecauseLabel")}</span><strong>{previewDiagnostics.createDisabledReason || t("wageSettlementsPage.enabled")}</strong></article>
              </div>
            </details>
          ) : null}
        </section>

        <section id="labour-settlement-register" className="record-panel labour-settlement-register-panel">
          <div className="advances-heading labour-settlement-register-header">
            <div>
              <h2>{t("wageSettlementsPage.settlementRegisterTitle")}</h2>
              <span>{historyLoading ? t("wageSettlementsPage.refreshingRegister") : t("wageSettlementsPage.settlementsInFarmSeasonCount", { count: settlements.length })}</span>
            </div>
            <div className="module-inline-actions">
              <button type="button" className="secondary-action" onClick={() => window.print()}><Printer size={16} /> {t("wageSettlementsPage.printButton")}</button>
              <button type="button" className="secondary-action" onClick={exportRegister}><Download size={16} /> {t("wageSettlementsPage.exportCsvButton")}</button>
            </div>
          </div>
          {!settlements.length ? <p className="context-message">{t("wageSettlementsPage.noSettlementsFound")}</p> : (
            <>
              <div className="reports-kpis labour-settlement-register-kpis">
                <article><span>{t("wageSettlementsPage.attendanceWagesLower")}</span><strong className="bidi-isolate">{money(registerTotals.attendanceWages)}</strong></article>
                <article><span>{t("wageSettlementsPage.labourWorkWagesLower")}</span><strong className="bidi-isolate">{money(registerTotals.labourWork)}</strong></article>
        <article><span>{t("wageSettlementsPage.grossWagesEarnedLower")}</span><strong className="bidi-isolate">{money(registerTotals.totalLabourCost)}</strong></article>
        <article><span>{t("wageSettlementsPage.advanceAbsorbedThisSettlementLower")}</span><strong className="bidi-isolate">{money(registerTotals.appliedAdvances)}</strong></article>
        <article><span>{t("wageSettlementsPage.outstandingGroupAdvanceLower")}</span><strong className="bidi-isolate">{money(registerTotals.carryForward)}</strong></article>
        <article><span>{t("wageSettlementsPage.paidNowLower")}</span><strong className="bidi-isolate">{money(registerTotals.cashPaid)}</strong></article>
      </div>
              <div className="report-toolbar labour-settlement-register-toolbar">
                <label className="search-input labour-settlement-register-search">
                  <Search size={16} />
                  <input
                    type="search"
                    placeholder={t("wageSettlementsPage.registerSearchPlaceholder")}
                    value={registerSearch}
                    onChange={(event) => setRegisterSearch(event.target.value)}
                  />
                </label>
                <label className="advances-filter-field labour-settlement-filter-field">
                  <span>{t("common.status")}</span>
                  <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}>
                    <option value="all">{t("common.all")}</option>
                    <option value="posted">{t("status.posted")}</option>
                    <option value="accounting_missing">{t("wageSettlementsPage.accountingMissingStatus")}</option>
                    <option value="voided">{t("status.voided")}</option>
                    <option value="deleted">{t("status.deleted")}</option>
                  </select>
                </label>
                <label className="advances-filter-field labour-settlement-filter-field">
                  <span>{t("wageSettlementsPage.paidFromAccountLower")}</span>
                  <select value={paymentAccountFilter} onChange={(event) => setPaymentAccountFilter(event.target.value)}>
                    <option value="all">{t("wageSettlementsPage.allAccountsOption")}</option>
                    {paymentAccounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
                  </select>
                </label>
              </div>
            <div className="attendance-import-table-wrap report-wide-table labour-settlement-table-wrap">
              <table className="report-data-table">
                <thead>
                  <tr>
                    <th>{t("wageSettlementsPage.settlementNoLabel")}</th>
                    <th>{t("wageSettlementsPage.settlementDate")}</th>
                    <th>{t("wageSettlementsPage.settlementPeriodLower")}</th>
                    <th>{t("wageSettlementsPage.modeLabel")}</th>
                    <th>{t("wageSettlementsPage.foremanGroupLower")}</th>
                    <th>{t("wageSettlementsPage.labourersLabel")}</th>
                    <th>{t("wageSettlementsPage.attendanceWagesLower")}</th>
                    <th>{t("wageSettlementsPage.labourWorkLabel")}</th>
                    <th>{t("wageSettlementsPage.grossWagesEarnedLower")}</th>
                    <th>{t("wageSettlementsPage.advanceAbsorbedThisSettlementLower")}</th>
                    <th>{t("wageSettlementsPage.outstandingGroupAdvanceLower")}</th>
                    <th>{t("wageSettlementsPage.paidNowLower")}</th>
                    <th>{t("wageSettlementsPage.paidFromAccountLower")}</th>
                    <th>{t("wageSettlementsPage.accountingReferenceLower")}</th>
                    <th>{t("common.status")}</th>
                    <th>{t("wageSettlementsPage.actionsLabel")}</th>
                  </tr>
                </thead>
                <tbody>
                  {registerRows.map((settlement) => {
                    return (
                      <tr key={settlement.id}>
                        <td><button type="button" className="worker-dialog__link bidi-isolate" onClick={() => openSettlement(settlement)}>{settlement.settlementNumber}</button></td>
                        <td className="bidi-isolate">{settlement.settlementDate}</td>
                        <td className="bidi-isolate">{settlement.fromDate} {t("wageSettlementsPage.periodTo")} {settlement.toDate}</td>
                        <td>{translateStatus(t, settlement.settlementMode ?? "individual")}</td>
                        <td>{labourers.find((labourer) => labourer.id === settlement.foremanId)?.name ?? settlement.groupName ?? settlement.groupId ?? "-"}</td>
                        <td>{settlement.includedLabourIds?.length ?? "-"}</td>
                        <td className="bidi-isolate">{money(settlement.attendanceWages)}</td>
                        <td className="bidi-isolate">{money(settlement.labourWorkWages ?? settlement.pendingLabourEarnings)}</td>
                        <td className="bidi-isolate">{money(settlement.grossWages ?? settlement.expenseAmount)}</td>
                        <td className="bidi-isolate">{money(settlement.advanceAdjustedNow ?? settlement.settledAdvanceAmount)}</td>
                        <td className="bidi-isolate">{money(settlement.remainingAdvanceCarryForward ?? settlement.carryForwardAdvance)}</td>
                        <td className="bidi-isolate">{money(settlement.paidAmount ?? settlement.payableBalance)}</td>
                        <td>{settlementPaymentAccountById.get(settlement.paymentAccountId ?? settlement.linkedAccountId)?.name ?? accountById.get(settlement.paymentAccountId ?? settlement.linkedAccountId)?.name ?? "-"}</td>
                        <td className="bidi-isolate">{settlement.linkedVoucherNumber || settlement.settlementNumber || t("wageSettlementsPage.referenceUnavailable")}</td>
                        <td>{translateStatus(t, settlementStatus(settlement))}</td>
                        <td>
                          <div className="stacked-inline-actions">
                            <button type="button" className="secondary-action" onClick={() => openSettlement(settlement)}>{t("wageSettlementsPage.viewDetails")}</button>
                            <button type="button" className="secondary-action" onClick={() => openSettlementVoucher(settlement)}>{t("wageSettlementsPage.openVoucher")}</button>
                            {canEditSettlement(settlement) ? (
                              <button type="button" className="secondary-action" onClick={() => openSettlement(settlement, "edit")}>{t("wageSettlementsPage.editUpdate")}</button>
                            ) : null}
                            {canDeleteSettlement(settlement) ? (
                              <button
                                type="button"
                                className="danger-button"
                                disabled={deletingSettlementId === settlement.id}
                                onClick={() => setDeletingSettlement(settlement)}
                              >
                                {deletingSettlementId === settlement.id ? t("wageSettlementsPage.deletingEllipsis") : t("wageSettlementsPage.deleteSettlement")}
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
                                {voidingSettlementId === settlement.id ? t("wageSettlementsPage.voidingEllipsis") : t("wageSettlementsPage.voidReverseSettlement")}
                              </button>
                            ) : null}
                            {settlementStatus(settlement) === "accounting_missing" ? (
                              <button
                                type="button"
                                className="secondary-action"
                                disabled={repairingSettlementId === settlement.id}
                                onClick={() => void repairAccounting(settlement)}
                              >
                                {repairingSettlementId === settlement.id ? t("wageSettlementsPage.repairingEllipsis") : t("wageSettlementsPage.repairAccounting")}
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
            {registerRows.length ? (
              <div className="labour-settlement-mobile-list" aria-label={t("wageSettlementsPage.settlementRecordsAria")}>
                {registerRows.map((settlement) => {
                  const status = settlementStatus(settlement);
                  const voucherNumber = settlement.linkedVoucherNumber || settlement.settlementNumber;
                  return (
                    <article className="labour-settlement-card" key={`mobile:${settlement.id}`}>
                      <header className="labour-settlement-card__header">
                        <button type="button" className="bidi-isolate" onClick={() => openSettlement(settlement)}>{settlement.settlementNumber}</button>
                        <span className={`labour-settlement-status labour-settlement-status--${status}`}>{translateStatus(t, status)}</span>
                      </header>
                      <div className="labour-settlement-card__period">
                        <span className="bidi-isolate">{t("wageSettlementsPage.periodLabel")}: {settlement.fromDate} {t("wageSettlementsPage.periodTo")} {settlement.toDate}</span>
                        <span className="bidi-isolate">{t("wageSettlementsPage.settlementDate")}: {settlement.settlementDate}</span>
                      </div>
                      <dl className="labour-settlement-card__summary">
                        <div><dt>{t("wageSettlementsPage.grossWagesLower")}</dt><dd className="bidi-isolate">{money(settlement.grossWages ?? settlement.expenseAmount)}</dd></div>
                        <div><dt>{t("wageSettlementsPage.advanceAdjustedLower")}</dt><dd className="bidi-isolate">{money(settlement.advanceAdjustedNow ?? settlement.settledAdvanceAmount)}</dd></div>
                        <div><dt>{t("wageSettlementsPage.paidNowLower")}</dt><dd className="bidi-isolate">{money(settlement.paidAmount ?? settlement.payableBalance)}</dd></div>
                        <div><dt>{t("wageSettlementsPage.balanceAfterSettlementLower")}</dt><dd className="bidi-isolate">{money(settlement.balanceAfterPayment ?? settlement.payableBalance)}</dd></div>
                      </dl>
                      {voucherNumber ? (
                        <p className="labour-settlement-card__voucher"><span>{t("wageSettlementsPage.voucherLabel")}</span><strong className="bidi-isolate">{voucherNumber}</strong></p>
                      ) : (
                        <p className="worker-action-warning">{t("wageSettlementsPage.accountingVoucherReferenceUnavailable")}</p>
                      )}
                      <footer className="labour-settlement-card__actions">
                        <button type="button" className="secondary-action" onClick={() => openSettlement(settlement)}>{t("wageSettlementsPage.viewDetails")}</button>
                        <button type="button" className="secondary-action" onClick={() => openSettlementVoucher(settlement)}>{t("wageSettlementsPage.openVoucher")}</button>
                        {canEditSettlement(settlement) ? <button type="button" className="secondary-action" onClick={() => openSettlement(settlement, "edit")}>{t("common.edit")}</button> : null}
                        {canDeleteSettlement(settlement) ? (
                          <button type="button" className="danger-button" disabled={deletingSettlementId === settlement.id} onClick={() => setDeletingSettlement(settlement)}>
                            {deletingSettlementId === settlement.id ? t("wageSettlementsPage.deletingEllipsis") : t("common.delete")}
                          </button>
                        ) : null}
                        {canVoidSettlement(settlement) ? (
                          <button type="button" className="secondary-action" disabled={voidingSettlementId === settlement.id} onClick={() => { setVoidingSettlement(settlement); setVoidReason(""); }}>
                            {voidingSettlementId === settlement.id ? t("wageSettlementsPage.voidingEllipsis") : t("wageSettlementsPage.voidReverseShort")}
                          </button>
                        ) : null}
                        {status === "accounting_missing" ? (
                          <button type="button" className="secondary-action" disabled={repairingSettlementId === settlement.id} onClick={() => void repairAccounting(settlement)}>
                            {repairingSettlementId === settlement.id ? t("wageSettlementsPage.repairingEllipsis") : t("wageSettlementsPage.repairAccounting")}
                          </button>
                        ) : null}
                      </footer>
                    </article>
                  );
                })}
              </div>
            ) : (
              <div className="labour-settlement-filter-empty">
                <strong>{t("wageSettlementsPage.noSettlementsMatchFilters")}</strong>
                <span>{t("wageSettlementsPage.clearFiltersHint")}</span>
                <button type="button" className="secondary-action" onClick={clearRegisterFilters}>{t("wageSettlementsPage.clearFiltersButton")}</button>
              </div>
            )}
            </>
          )}
        </section>
        {selectedSettlement ? (() => {
          return (
            <div className="worker-dialog-backdrop worker-action-backdrop" role="presentation" onClick={closeSettlement}>
              <section className="worker-action-dialog account-ledger-dialog" role="dialog" aria-modal="true" aria-label={t("wageSettlementsPage.labourSettlementDetailsAria")} onClick={(event) => event.stopPropagation()}>
                <header>
                  <div>
                    <h2 className="bidi-isolate">{selectedSettlement.settlementNumber}</h2>
                    <p className="bidi-isolate">{selectedSettlement.fromDate} {t("wageSettlementsPage.periodTo")} {selectedSettlement.toDate}</p>
                  </div>
                  <button aria-label={t("common.close")} type="button" onClick={closeSettlement}><X size={18} /></button>
                </header>
                <div className="worker-action-form">
                  {settlementStatus(selectedSettlement) === "voided" ? <p className="worker-action-warning">{t("wageSettlementsPage.settlementWasVoided")}</p> : null}
                  {selectedSettlementMode === "edit" ? (
                    <>
                      <div className="advances-filter-row">
                        <label className="advances-filter-field">
                          <span>{t("wageSettlementsPage.fromDate")}</span>
                          <input required type="date" className="bidi-isolate" value={editForm.fromDate} onChange={(event) => setEditForm((current) => ({ ...current, fromDate: event.target.value }))} />
                        </label>
                        <label className="advances-filter-field">
                          <span>{t("wageSettlementsPage.toDate")}</span>
                          <input required type="date" className="bidi-isolate" value={editForm.toDate} onChange={(event) => setEditForm((current) => ({ ...current, toDate: event.target.value }))} />
                        </label>
                        <label className="advances-filter-field">
                          <span>{t("wageSettlementsPage.settlementDate")}</span>
                          <input required type="date" className="bidi-isolate" value={editForm.settlementDate} onChange={(event) => setEditForm((current) => ({ ...current, settlementDate: event.target.value }))} />
                        </label>
                      </div>
                      <div className="advances-filter-row">
                        <label className="advances-filter-field">
                          <span>{t("wageSettlementsPage.paidFromAccountLower")}</span>
                          <PaymentAccountSelect
                            accounts={eligiblePaymentAccounts(paymentAccounts, { alsoIncludeId: selectedSettlement?.paymentAccountId ?? selectedSettlement?.linkedAccountId ?? null })}
                            value={editForm.accountId}
                            onChange={(accountId) => setEditForm((current) => ({ ...current, accountId }))}
                            placeholder={t("wageSettlementsPage.selectPaidFromAccountPlaceholder")}
                          />
                        </label>
                        <label className="advances-filter-field advances-filter-field--full">
                          <span>{t("wageSettlementsPage.notesLabel")}</span>
                          <input value={editForm.notes} onChange={(event) => setEditForm((current) => ({ ...current, notes: event.target.value }))} placeholder={t("wageSettlementsPage.optionalNotesPlaceholder")} />
                        </label>
                      </div>
                      <p className="context-message">{t("wageSettlementsPage.editingAllowedHint")}</p>
                    </>
                  ) : (
                    <>
                      <div className="reports-kpis">
                        <article><span>{t("wageSettlementsPage.settlementDate")}</span><strong className="bidi-isolate">{selectedSettlement.settlementDate}</strong></article>
                        <article><span>{t("wageSettlementsPage.groupNameLabel")}</span><strong>{selectedSettlement.groupName ?? "-"}</strong></article>
                        <article><span>{t("wageSettlementsPage.foremanLabel")}</span><strong>{labourers.find((labourer) => labourer.id === (selectedSettlement.foremanId ?? ""))?.name ?? t("wageSettlementsPage.noForemanAssigned")}</strong></article>
                        <article><span>{t("wageSettlementsPage.attendanceWagesLower")}</span><strong className="bidi-isolate">{money(selectedSettlement.attendanceWages)}</strong></article>
                        <article><span>{t("wageSettlementsPage.labourWorkWagesLower")}</span><strong className="bidi-isolate">{money(selectedSettlement.labourWorkWages ?? selectedSettlement.pendingLabourEarnings)}</strong></article>
                        <article><span>{t("wageSettlementsPage.grossWagesEarnedLower")}</span><strong className="bidi-isolate">{money(selectedSettlement.grossWages ?? selectedSettlement.expenseAmount)}</strong></article>
                        <article><span>{t("wageSettlementsPage.advanceAbsorbedThisSettlementLower")}</span><strong className="bidi-isolate">{money(selectedSettlement.advanceAdjustedNow ?? selectedSettlement.settledAdvanceAmount)}</strong></article>
                        <article><span>{t("wageSettlementsPage.outstandingGroupAdvanceLower")}</span><strong className="bidi-isolate">{money(selectedSettlement.remainingAdvanceCarryForward ?? selectedSettlement.carryForwardAdvance)}</strong></article>
                        <article><span>{t("wageSettlementsPage.paidNowLower")}</span><strong className="bidi-isolate">{money(selectedSettlement.paidAmount ?? selectedSettlement.payableBalance)}</strong></article>
                        <article><span>{t("wageSettlementsPage.paidFromAccountLower")}</span><strong>{settlementPaymentAccountById.get(selectedSettlement.paymentAccountId ?? selectedSettlement.linkedAccountId)?.name ?? accountById.get(selectedSettlement.paymentAccountId ?? selectedSettlement.linkedAccountId)?.name ?? "-"}</strong></article>
                        <article><span>{t("wageSettlementsPage.voucherNumberLabel")}</span><strong className="bidi-isolate">{selectedSettlement.linkedVoucherNumber || selectedSettlement.settlementNumber || t("wageSettlementsPage.referenceUnavailable")}</strong></article>
                      </div>
                      {selectedSettlement.notes ? <p className="context-message">{selectedSettlement.notes}</p> : null}
                      {selectedSettlement.accountingStatus === "accounting_missing" ? (
                        <div className="worker-action-warning">
                          <strong>{t("wageSettlementsPage.accountingEntriesMissing")}</strong>
                          <p>{selectedSettlement.accountingMessage ?? t("wageSettlementsPage.repostAccountingToRestore")}</p>
                        </div>
                      ) : null}
                      {selectedSettlement.accountingStatus === "posted" ? (
                        <div className="worker-action-warning">
                          <strong>{t("wageSettlementsPage.accountingIsPosted")}</strong>
                          <p>{t("wageSettlementsPage.canBeViewedOrVoidedNotEdited")}</p>
                        </div>
                      ) : null}
                    </>
                  )}
                  {selectedSettlementLoading ? <p className="context-message">{t("wageSettlementsPage.refreshingSettlementDetails")}</p> : null}
                  <footer className="worker-action-footer">
                    {selectedSettlementMode === "edit" ? (
                      <>
                        <button type="button" onClick={() => { setSelectedSettlementMode("view"); }}>
                          {t("common.cancel")}
                        </button>
                        <button
                          type="button"
                          className="secondary-action"
                          disabled={savingSettlementId === selectedSettlement.id}
                          onClick={() => void saveSettlement()}
                        >
                          {savingSettlementId === selectedSettlement.id ? t("wageSettlementsPage.updatingEllipsis") : t("wageSettlementsPage.updateSettlementButton")}
                        </button>
                      </>
                    ) : (
                      <>
                        <button type="button" onClick={closeSettlement}>{t("common.close")}</button>
                        {selectedSettlement.accountingStatus === "accounting_missing" ? (
                          <button
                            type="button"
                            className="secondary-action"
                            disabled={repairingSettlementId === selectedSettlement.id}
                            onClick={() => void repairAccounting(selectedSettlement)}
                          >
                            {repairingSettlementId === selectedSettlement.id ? t("wageSettlementsPage.repairingEllipsis") : t("wageSettlementsPage.repairAccounting")}
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
                            {t("wageSettlementsPage.editUpdate")}
                          </button>
                        ) : null}
                        {canDeleteSettlement(selectedSettlement) ? (
                          <button
                            type="button"
                            className="danger-button"
                            disabled={deletingSettlementId === selectedSettlement.id}
                            onClick={() => setDeletingSettlement(selectedSettlement as unknown as LabourWageSettlement)}
                          >
                            {deletingSettlementId === selectedSettlement.id ? t("wageSettlementsPage.deletingEllipsis") : t("wageSettlementsPage.deleteSettlement")}
                          </button>
                        ) : null}
                        {canVoidSettlement(selectedSettlement) ? (
                          <button
                            type="button"
                            className="secondary-action"
                            disabled={voidingSettlementId === selectedSettlement.id}
                            onClick={() => setVoidingSettlement(selectedSettlement)}
                          >
                            {voidingSettlementId === selectedSettlement.id ? t("wageSettlementsPage.voidingEllipsis") : t("wageSettlementsPage.voidReverseSettlement")}
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
            <section className="worker-action-dialog account-ledger-dialog" role="dialog" aria-modal="true" aria-label={t("wageSettlementsPage.deleteSettlementConfirmationAria")} onClick={(event) => event.stopPropagation()}>
              <header>
                <div>
                  <h2>{t("wageSettlementsPage.deleteSettlement")}</h2>
                  <p className="bidi-isolate">{deletingSettlement.settlementNumber}</p>
                </div>
                <button aria-label={t("common.close")} type="button" onClick={() => deletingSettlementId ? undefined : setDeletingSettlement(null)}><X size={18} /></button>
              </header>
              <div className="worker-action-form">
                <div className="worker-action-warning">
                  <strong>{t("wageSettlementsPage.deleteSettlementConfirmQuestion", { number: deletingSettlement.settlementNumber })}</strong>
                  <p>{t("wageSettlementsPage.deleteSettlementConfirmDetail")}</p>
                </div>
                <footer className="worker-action-footer">
                  <button type="button" onClick={() => setDeletingSettlement(null)} disabled={Boolean(deletingSettlementId)}>{t("common.cancel")}</button>
                  <button type="button" className="danger-button" onClick={() => void deleteSettlement(deletingSettlement)} disabled={Boolean(deletingSettlementId)}>
                    {deletingSettlementId ? t("wageSettlementsPage.deletingEllipsis") : t("wageSettlementsPage.deleteSettlement")}
                  </button>
                </footer>
              </div>
            </section>
          </div>
        ) : null}
        {voidingSettlement ? (
          <div className="worker-dialog-backdrop worker-action-backdrop" role="presentation" onClick={() => voidingSettlementId ? undefined : setVoidingSettlement(null)}>
            <section className="worker-action-dialog account-ledger-dialog" role="dialog" aria-modal="true" aria-label={t("wageSettlementsPage.voidSettlementConfirmationAria")} onClick={(event) => event.stopPropagation()}>
              <header>
                <div>
                  <h2>{t("wageSettlementsPage.voidSettlementTitle")}</h2>
                  <p className="bidi-isolate">{voidingSettlement.settlementNumber}</p>
                </div>
                <button aria-label={t("common.close")} type="button" onClick={() => voidingSettlementId ? undefined : setVoidingSettlement(null)}><X size={18} /></button>
              </header>
              <div className="worker-action-form">
                <div className="worker-action-warning">
                  <strong>{t("wageSettlementsPage.voidSettlementConfirmQuestion", { number: voidingSettlement.settlementNumber })}</strong>
                  <p>{t("wageSettlementsPage.voidSettlementConfirmDetail")}</p>
                </div>
                <label className="advances-filter-field advances-filter-field--full">
                  <span>{t("wageSettlementsPage.voidReasonLabel")}</span>
                  <input value={voidReason} onChange={(event) => setVoidReason(event.target.value)} placeholder={t("wageSettlementsPage.optionalVoidReasonPlaceholder")} />
                </label>
                <footer className="worker-action-footer">
                  <button type="button" onClick={() => setVoidingSettlement(null)} disabled={Boolean(voidingSettlementId)}>{t("common.cancel")}</button>
                  <button type="button" className="secondary-action" onClick={() => void voidSettlement()} disabled={Boolean(voidingSettlementId)}>
                    {voidingSettlementId ? t("wageSettlementsPage.voidingEllipsis") : t("wageSettlementsPage.voidReverseSettlement")}
                  </button>
                </footer>
              </div>
            </section>
          </div>
        ) : null}
    </div>
  );
}
