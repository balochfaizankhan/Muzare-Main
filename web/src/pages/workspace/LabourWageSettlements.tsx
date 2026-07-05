import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Search, Printer, Download, X, ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../../auth/AuthProvider";
import { createLabourWageSettlement, deleteLabourWageSettlement, fetchLabourWageSettlements, previewLabourWageSettlement, repairLabourWageSettlementAccounting, type LabourWageSettlementPreview } from "../../lib/api";
import { formatMoney } from "../../lib/format";
import { getActiveFarmId, getActiveSeasonId, offlineDb, workspaceRecords, type Account, type LabourWageSettlement, type Voucher } from "../../lib/offline-db";
import { canCreate } from "../../lib/permissions";
import { getVoucherDisplayNumber } from "../../lib/vouchers";

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
  const [settlements, setSettlements] = useState<LabourWageSettlement[]>([]);
  const [vouchers, setVouchers] = useState<Voucher[]>([]);
  const [settlementDate, setSettlementDate] = useState(today());
  const [fromDate, setFromDate] = useState(`${today().slice(0, 8)}01`);
  const [toDate, setToDate] = useState(today());
  const [accountId, setAccountId] = useState("");
  const [notes, setNotes] = useState("");
  const [preview, setPreview] = useState<PreviewState>({ status: "idle", data: null });
  const [historyLoading, setHistoryLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [registerSearch, setRegisterSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "posted" | "voided" | "accounting_missing">("all");
  const [paymentAccountFilter, setPaymentAccountFilter] = useState("all");
  const [selectedSettlement, setSelectedSettlement] = useState<LabourWageSettlement | null>(null);
  const [repairingSettlementId, setRepairingSettlementId] = useState<string | null>(null);
  const [deletingSettlement, setDeletingSettlement] = useState<LabourWageSettlement | null>(null);
  const [deletingSettlementId, setDeletingSettlementId] = useState<string | null>(null);

  const onlineRequired = !navigator.onLine;
  const linkedVoucherById = useMemo(() => new Map(vouchers.map((voucher) => [voucher.id, voucher])), [vouchers]);

  const refresh = useCallback(async () => {
    const [cachedAccounts, cachedSettlements, cachedVouchers] = await Promise.all([
      workspaceRecords(offlineDb.accounts),
      workspaceRecords(offlineDb.labourWageSettlements),
      workspaceRecords(offlineDb.vouchers),
    ]);
    setAccounts(cachedAccounts.filter((account) => account.type === "cash" || account.type === "bank" || account.type === "partner"));
    setSettlements(cachedSettlements.sort((left, right) => right.settlementDate.localeCompare(left.settlementDate) || right.updatedAt.localeCompare(left.updatedAt)));
    setVouchers(cachedVouchers);
  }, []);

  const syncFromServer = useCallback(async () => {
    if (!token || !workspaceId || !activeFarmId || !activeSeasonId || !navigator.onLine) return;
    setHistoryLoading(true);
    try {
      const response = await fetchLabourWageSettlements(token, workspaceId, {
        farmId: activeFarmId,
        seasonId: activeSeasonId,
      });
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
        pendingLabourEarnings: settlement.pendingLabourEarnings,
        totalEarned: settlement.totalEarned,
        advancesPaid: settlement.advancesPaid,
        settledAdvanceAmount: settlement.settledAdvanceAmount,
        expenseAmount: settlement.expenseAmount,
        carryForwardAdvance: settlement.carryForwardAdvance,
        payableBalance: settlement.payableBalance,
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
    if (!accountId && accounts.length) {
      setAccountId(accounts.find((account) => account.type === "cash" || account.type === "bank")?.id ?? accounts[0]?.id ?? "");
    }
  }, [accountId, accounts]);

  useEffect(() => {
    const recordId = searchParams.get("recordId");
    if (!recordId || !settlements.length) return;
    const match = settlements.find((settlement) => settlement.id === recordId);
    if (!match) return;
    setSelectedSettlement(match);
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
    if (!token || !workspaceId || !activeFarmId || !activeSeasonId || !accountId) {
      setError("Select an active farm, season, and payment account before creating a settlement.");
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
        accountId,
        notes: notes.trim() || undefined,
      });
      await offlineDb.vouchers.put({
        id: response.voucher.id,
        workspaceId,
        farmId: activeFarmId,
        seasonId: activeSeasonId,
        voucherNumber: response.voucher.voucherNumber,
        originalVoucherNumber: response.voucher.originalVoucherNumber,
        legacyVoucherNumber: response.voucher.legacyVoucherNumber,
        voucherNumberEdited: response.voucher.voucherNumberEdited,
        allowVoucherNumberEdit: response.voucher.allowVoucherNumberEdit,
        settlementId: response.voucher.settlementId,
        settlementNumber: response.voucher.settlementNumber,
        voucherPurpose: response.voucher.voucherPurpose,
        nonCashSettlement: response.voucher.nonCashSettlement,
        date: response.voucher.date,
        category: response.voucher.category,
        categoryId: response.voucher.categoryId,
        subcategory: response.voucher.subcategory,
        subcategoryId: response.voucher.subcategoryId,
        description: response.voucher.description,
        amount: response.voucher.amount,
        accountId: response.voucher.accountId,
        notes: response.voucher.notes,
        items: response.voucher.items,
        createdBy: response.voucher.createdBy,
        updatedBy: response.voucher.updatedBy,
        createdAt: response.voucher.createdAt,
        updatedAt: response.voucher.updatedAt,
        pendingSync: false,
      });
      await offlineDb.labourWageSettlements.put({
        id: response.settlement.id,
        workspaceId,
        farmId: activeFarmId,
        seasonId: activeSeasonId,
        settlementNumber: response.settlement.settlementNumber,
        linkedVoucherId: response.settlement.linkedVoucherId,
        linkedVoucherNumber: response.settlement.linkedVoucherNumber,
        linkedAccountId: response.settlement.linkedAccountId,
        fromDate: response.settlement.fromDate,
        toDate: response.settlement.toDate,
        settlementDate: response.settlement.settlementDate,
        attendanceWages: response.settlement.attendanceWages,
        pendingLabourEarnings: response.settlement.pendingLabourEarnings,
        totalEarned: response.settlement.totalEarned,
        advancesPaid: response.settlement.advancesPaid,
        settledAdvanceAmount: response.settlement.settledAdvanceAmount,
        expenseAmount: response.settlement.expenseAmount,
        carryForwardAdvance: response.settlement.carryForwardAdvance,
        payableBalance: response.settlement.payableBalance,
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
      setSuccess(`Settlement ${response.settlement.settlementNumber} posted. The linked accounting record now uses ${response.settlement.settlementNumber} as its reference.`);
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
  const settlementStatus = useCallback((settlement: LabourWageSettlement) => settlement.accountingStatus ?? settlement.status, []);
  const canDeleteSettlement = useCallback((settlement: LabourWageSettlement) => settlementStatus(settlement) === "accounting_missing", [settlementStatus]);
  const repairAccounting = useCallback(async (settlement: LabourWageSettlement) => {
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
      if (response.linkedVoucherId) {
        await offlineDb.vouchers.update(response.linkedVoucherId, {
          deletedAt,
          updatedAt: deletedAt,
        });
      }
      setDeletingSettlement(null);
      setSelectedSettlement((current) => current?.id === settlement.id ? null : current);
      setSuccess(`Settlement ${response.settlementNumber} deleted. Its advances are available for reposting.`);
      window.dispatchEvent(new Event("muzare-local-data-change"));
      await syncFromServer();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to delete this settlement.");
    } finally {
      setDeletingSettlementId(null);
    }
  }, [syncFromServer, token, user?.id, workspaceId]);
  const registerRows = useMemo(() => {
    const term = registerSearch.trim().toLowerCase();
    return settlements.filter((settlement) => {
      const linkedVoucher = linkedVoucherById.get(settlement.linkedVoucherId);
      const accountName = accountById.get(settlement.linkedAccountId)?.name ?? "";
      return (statusFilter === "all" || settlementStatus(settlement) === statusFilter)
        && (paymentAccountFilter === "all" || settlement.linkedAccountId === paymentAccountFilter)
        && (!term || [
          settlement.settlementNumber,
          settlement.settlementDate,
          settlement.fromDate,
          settlement.toDate,
          settlement.notes ?? "",
          linkedVoucher ? getVoucherDisplayNumber(linkedVoucher) || linkedVoucher.voucherNumber : settlement.linkedVoucherNumber,
          accountName,
          String(settlement.totalEarned),
          String(settlement.expenseAmount),
          String(settlement.settledAdvanceAmount),
        ].some((value) => value.toLowerCase().includes(term)));
    });
  }, [accountById, linkedVoucherById, paymentAccountFilter, registerSearch, settlementStatus, settlements, statusFilter]);
  const registerTotals = useMemo(() => registerRows.reduce((totals, settlement) => ({
    attendanceWages: totals.attendanceWages + settlement.attendanceWages,
    labourWork: totals.labourWork + settlement.pendingLabourEarnings,
    totalLabourCost: totals.totalLabourCost + settlement.expenseAmount,
    appliedAdvances: totals.appliedAdvances + settlement.settledAdvanceAmount,
    carryForward: totals.carryForward + settlement.carryForwardAdvance,
    cashPaid: totals.cashPaid + settlement.payableBalance,
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
      "Attendance Wages",
      "Labour Work",
      "Total Labour Cost",
      "Applied Advances",
      "Carry-forward Advance",
      "Cash Paid",
      "Payment Account",
      "Generated Voucher Number",
      "Status",
    ];
    const rows = registerRows.map((settlement) => {
      const linkedVoucher = linkedVoucherById.get(settlement.linkedVoucherId);
      const linkedVoucherNumber = linkedVoucher ? getVoucherDisplayNumber(linkedVoucher) || linkedVoucher.voucherNumber : settlement.linkedVoucherNumber;
      return [
        settlement.settlementNumber,
        settlement.settlementDate,
        `${settlement.fromDate} to ${settlement.toDate}`,
        settlement.attendanceWages,
        settlement.pendingLabourEarnings,
        settlement.expenseAmount,
        settlement.settledAdvanceAmount,
        settlement.carryForwardAdvance,
        settlement.payableBalance,
        accountById.get(settlement.linkedAccountId)?.name ?? "",
        linkedVoucherNumber ?? "",
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
            <h2>Close Wage Period</h2>
            <p>
              Preview attendance wages, settle advances without mutating cash history, and post one linked labour wage expense voucher in a controlled accounting step.
            </p>
          </div>
          <span className="local-pill">{onlineRequired ? "Online required" : "Online and ready"}</span>
        </section>

        {(!activeFarmId || !activeSeasonId) && <section className="record-panel">
          <p className="context-message">Select an active farm and season before creating a labour wage settlement.</p>
        </section>}

        <section className="record-panel labour-settlement-form-panel">
          <div className="advances-heading">
            <h2>Create settlement</h2>
            <span>Settlement and voucher are posted together in one transaction.</span>
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
                <span>Payment / expense account</span>
                <select required value={accountId} onChange={(event) => setAccountId(event.target.value)}>
                  <option value="">Select account</option>
                  {accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
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
              <button type="submit" disabled={!canPost || submitting || preview.status !== "ready" || Boolean(summary?.unresolvedRows.length) || Boolean(summary?.overlappingSettlements.length) || onlineRequired}>
                {submitting ? "Posting settlement..." : "Create Settlement"}
              </button>
            </div>
          </form>
        </section>

        <section className="record-panel labour-settlement-preview-panel">
          <div className="advances-heading">
            <h2>Settlement preview</h2>
            <span>Advances stay immutable. Settlement offsets them for accounting and creates one wage expense voucher.</span>
          </div>
          {!summary ? <p className="context-message">Run a preview to calculate period wages, settled advances, carry-forward, and payable balance.</p> : <>
            <div className="reports-kpis">
              <article><span>Attendance wages</span><strong>{money(summary.attendanceWages)}</strong></article>
              <article><span>Labour work</span><strong>{money(summary.pendingLabourEarnings)}</strong></article>
              <article><span>Total labour cost</span><strong>{money(summary.totalEarned)}</strong></article>
              <article><span>Advances available up to settlement date</span><strong>{money(summary.advancesAvailableUpToSettlementDate)}</strong></article>
              <article><span>Settlement voucher amount</span><strong>{money(summary.expenseAmount)}</strong></article>
              <article><span>Applied advances</span><strong>{money(summary.settledAdvanceAmount)}</strong></article>
              <article><span>Carry-forward advance</span><strong>{money(summary.carryForwardAdvance)}</strong></article>
              <article><span>Remaining cash payable</span><strong>{money(summary.payableBalance)}</strong></article>
            </div>
            <div className="reports-summary-list">
              <article><span>Wage period</span><strong>{fromDate} to {toDate}</strong></article>
              <article><span>Advances considered until</span><strong>{summary.settlementDate}</strong></article>
              <article><span>Total advances up to settlement date</span><strong>{money(summary.rawAdvancesUpToSettlementDate)}</strong></article>
              <article><span>Previously settled advances</span><strong>{money(summary.previouslySettledAdvances)}</strong></article>
            </div>
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
                <article><span>Labour work</span><strong>{money(registerTotals.labourWork)}</strong></article>
                <article><span>Total labour cost</span><strong>{money(registerTotals.totalLabourCost)}</strong></article>
                <article><span>Applied advances</span><strong>{money(registerTotals.appliedAdvances)}</strong></article>
                <article><span>Carry-forward advance</span><strong>{money(registerTotals.carryForward)}</strong></article>
                <article><span>Cash paid</span><strong>{money(registerTotals.cashPaid)}</strong></article>
              </div>
              <div className="report-toolbar labour-settlement-register-toolbar">
                <label className="search-input labour-settlement-register-search">
                  <Search size={16} />
                  <input
                    type="search"
                    placeholder="Search settlement number, voucher, notes, or account"
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
                    {accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
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
                    <th>Attendance wages</th>
                    <th>Labour work</th>
                    <th>Total labour cost</th>
                    <th>Applied advances</th>
                    <th>Carry-forward advance</th>
                    <th>Cash paid</th>
                    <th>Payment account</th>
                    <th>Generated voucher</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {registerRows.map((settlement) => {
                    const linkedVoucher = linkedVoucherById.get(settlement.linkedVoucherId);
                    const linkedVoucherNumber = linkedVoucher
                      ? getVoucherDisplayNumber(linkedVoucher) || linkedVoucher.voucherNumber
                      : settlement.linkedVoucherNumber;
                    return (
                      <tr key={settlement.id}>
                        <td><button type="button" className="worker-dialog__link" onClick={() => setSelectedSettlement(settlement)}>{settlement.settlementNumber}</button></td>
                        <td>{settlement.settlementDate}</td>
                        <td>{settlement.fromDate} to {settlement.toDate}</td>
                        <td>{money(settlement.attendanceWages)}</td>
                        <td>{money(settlement.pendingLabourEarnings)}</td>
                        <td>{money(settlement.expenseAmount)}</td>
                        <td>{money(settlement.settledAdvanceAmount)}</td>
                        <td>{money(settlement.carryForwardAdvance)}</td>
                        <td>{money(settlement.payableBalance)}</td>
                        <td>{accountById.get(settlement.linkedAccountId)?.name ?? "-"}</td>
                        <td>{linkedVoucherNumber || settlement.settlementNumber}</td>
                        <td>{settlementStatus(settlement).replaceAll("_", " ")}</td>
                        <td>
                          <div className="stacked-inline-actions">
                            <button type="button" className="secondary-action" onClick={() => setSelectedSettlement(settlement)}>View</button>
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
                            {canDeleteSettlement(settlement) ? (
                              <button
                                type="button"
                                className="danger-button"
                                disabled={deletingSettlementId === settlement.id}
                                onClick={() => setDeletingSettlement(settlement)}
                              >
                                {deletingSettlementId === settlement.id ? "Deleting..." : "Delete settlement"}
                              </button>
                            ) : settlement.status === "posted" ? (
                              <button
                                type="button"
                                className="secondary-action"
                                onClick={() => setError("This settlement has accounting entries. Use Void/Reverse instead.")}
                              >
                                Void / Reverse
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
          const linkedVoucher = linkedVoucherById.get(selectedSettlement.linkedVoucherId);
          return (
            <div className="worker-dialog-backdrop worker-action-backdrop" role="presentation" onClick={() => setSelectedSettlement(null)}>
              <section className="worker-action-dialog account-ledger-dialog" role="dialog" aria-modal="true" aria-label="Labour settlement details" onClick={(event) => event.stopPropagation()}>
                <header>
                  <div>
                    <h2>{selectedSettlement.settlementNumber}</h2>
                    <p>{selectedSettlement.fromDate} to {selectedSettlement.toDate}</p>
                  </div>
                  <button aria-label={t("common.close")} type="button" onClick={() => setSelectedSettlement(null)}><X size={18} /></button>
                </header>
                <div className="worker-action-form">
                  <div className="reports-kpis">
                    <article><span>Settlement date</span><strong>{selectedSettlement.settlementDate}</strong></article>
                    <article><span>Attendance wages</span><strong>{money(selectedSettlement.attendanceWages)}</strong></article>
                    <article><span>Labour work</span><strong>{money(selectedSettlement.pendingLabourEarnings)}</strong></article>
                    <article><span>Total labour cost</span><strong>{money(selectedSettlement.expenseAmount)}</strong></article>
                    <article><span>Advances applied</span><strong>{money(selectedSettlement.settledAdvanceAmount)}</strong></article>
                    <article><span>Carry-forward advance</span><strong>{money(selectedSettlement.carryForwardAdvance)}</strong></article>
                    <article><span>Cash paid</span><strong>{money(selectedSettlement.payableBalance)}</strong></article>
                    <article><span>Payment account</span><strong>{accountById.get(selectedSettlement.linkedAccountId)?.name ?? "-"}</strong></article>
                  </div>
                  {selectedSettlement.notes ? <p className="context-message">{selectedSettlement.notes}</p> : null}
                  {settlementStatus(selectedSettlement) === "accounting_missing" ? (
                    <div className="worker-action-warning">
                      <strong>Accounting entries missing.</strong>
                      <p>{selectedSettlement.accountingMessage ?? "Repost accounting to restore this settlement in the accounts ledger."}</p>
                    </div>
                  ) : null}
                  <footer className="worker-action-footer">
                    <button type="button" onClick={() => setSelectedSettlement(null)}>Close</button>
                    {settlementStatus(selectedSettlement) === "accounting_missing" ? (
                      <button
                        type="button"
                        className="secondary-action"
                        disabled={repairingSettlementId === selectedSettlement.id}
                        onClick={() => void repairAccounting(selectedSettlement)}
                      >
                        {repairingSettlementId === selectedSettlement.id ? "Repairing..." : "Repair accounting"}
                      </button>
                    ) : null}
                    {canDeleteSettlement(selectedSettlement) ? (
                      <button
                        type="button"
                        className="danger-button"
                        disabled={deletingSettlementId === selectedSettlement.id}
                        onClick={() => setDeletingSettlement(selectedSettlement)}
                      >
                        {deletingSettlementId === selectedSettlement.id ? "Deleting..." : "Delete settlement"}
                      </button>
                    ) : null}
                    {linkedVoucher ? <button type="button" onClick={() => navigate(`/workspace/expenses?recordId=${linkedVoucher.id}&showSettlementVouchers=true`)}>View Generated Voucher <ExternalLink size={16} /></button> : null}
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
    </>
  );
}
