import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../auth/AuthProvider";
import { SubpageHeader } from "../../components/SubpageHeader";
import { createLabourWageSettlement, fetchLabourWageSettlements, previewLabourWageSettlement, type LabourWageSettlementPreview } from "../../lib/api";
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
        createdBy: settlement.createdBy,
        createdAt: settlement.createdAt,
        updatedAt: settlement.updatedAt,
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
        createdBy: response.settlement.createdBy,
        createdAt: response.settlement.createdAt,
        updatedAt: response.settlement.updatedAt,
        voidedAt: response.settlement.voidedAt ?? null,
        voidedBy: response.settlement.voidedBy ?? null,
        voidReason: response.settlement.voidReason ?? null,
        pendingSync: false,
      });
      setPreview({ status: "idle", data: null });
      setNotes("");
      setSuccess(`Settlement ${response.settlement.settlementNumber} posted. Voucher ${response.voucher.voucherNumber} was created for labour wages.`);
      window.dispatchEvent(new Event("muzare-local-data-change"));
      await syncFromServer();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to create the labour wage settlement.");
    } finally {
      setSubmitting(false);
    }
  };

  const summary = preview.status === "ready" ? preview.data : null;

  return (
    <div className="dashboard-page">
      <SubpageHeader title="Labour Wage Settlement" />
      <main className="subpage module-workspace">
        <section className="workspace-intro">
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

        <section className="record-panel">
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

        <section className="record-panel">
          <div className="advances-heading">
            <h2>Settlement preview</h2>
            <span>Advances stay immutable. Settlement offsets them for accounting and creates one wage expense voucher.</span>
          </div>
          {!summary ? <p className="context-message">Run a preview to calculate period wages, settled advances, carry-forward, and payable balance.</p> : <>
            <div className="reports-kpis">
              <article><span>Attendance wages</span><strong>{money(summary.attendanceWages)}</strong></article>
              <article><span>Pending labour earnings</span><strong>{money(summary.pendingLabourEarnings)}</strong></article>
              <article><span>Total earned</span><strong>{money(summary.totalEarned)}</strong></article>
              <article><span>Advances available up to settlement date</span><strong>{money(summary.advancesAvailableUpToSettlementDate)}</strong></article>
              <article><span>Expense amount</span><strong>{money(summary.expenseAmount)}</strong></article>
              <article><span>Settled advances</span><strong>{money(summary.settledAdvanceAmount)}</strong></article>
              <article><span>Carry-forward advance</span><strong>{money(summary.carryForwardAdvance)}</strong></article>
              <article><span>Payable balance</span><strong>{money(summary.payableBalance)}</strong></article>
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
              <article><span>Included labour earnings</span><strong>{summary.includedEarnings.length}</strong></article>
              <article><span>Ledger total</span><strong>{money(summary.includedEarnings.reduce((sum, item) => sum + item.amount, 0))}</strong></article>
            </div>}
          </>}
        </section>

        <section className="record-panel">
          <div className="advances-heading">
            <h2>Settlement history</h2>
            <span>{historyLoading ? "Refreshing history..." : `${settlements.length} settlements in this farm and season`}</span>
          </div>
          {!settlements.length ? <p className="context-message">No wage settlements have been posted for this farm and season yet.</p> : (
            <div className="attendance-import-table-wrap report-wide-table">
              <table className="report-data-table">
                <thead>
                  <tr>
                    <th>Settlement</th>
                    <th>Period</th>
                    <th>Total earned</th>
                    <th>Expense amount</th>
                    <th>Settled advances</th>
                    <th>Carry forward</th>
                    <th>Linked voucher</th>
                    <th>Status</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {settlements.map((settlement) => {
                    const linkedVoucher = linkedVoucherById.get(settlement.linkedVoucherId);
                    return (
                      <tr key={settlement.id}>
                        <td><strong>{settlement.settlementNumber}</strong></td>
                        <td>{settlement.fromDate} to {settlement.toDate}</td>
                        <td>{money(settlement.totalEarned)}</td>
                        <td>{money(settlement.expenseAmount)}</td>
                        <td>{money(settlement.settledAdvanceAmount)}</td>
                        <td>{money(settlement.carryForwardAdvance)}</td>
                        <td>
                          {linkedVoucher
                            ? <button type="button" className="worker-dialog__link" onClick={() => navigate(`/workspace/expenses?recordId=${linkedVoucher.id}`)}>{getVoucherDisplayNumber(linkedVoucher) || linkedVoucher.voucherNumber}</button>
                            : settlement.linkedVoucherNumber || "-"}
                        </td>
                        <td>{settlement.status}</td>
                        <td>{settlement.createdAt.slice(0, 10)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
