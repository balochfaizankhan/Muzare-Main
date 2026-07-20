import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { AlertCircle, ArrowRight, Banknote, HandCoins, PauseCircle, Plus, ReceiptText, Search, ShieldCheck, WalletCards, X } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../../auth/AuthProvider";
import {
  createDirectLabourDue,
  fetchLabourPaymentAdvances,
  fetchLabourPaymentDues,
  fetchLabourPaymentVouchers,
  postLabourAdvanceVoucher,
  refundLabourAdvance,
  setLabourDueHold,
  settleLabourPaymentDue,
  voidLabourPaymentVoucher,
  voidLabourDue,
  type LabourAdvancePosition,
  type LabourAdvanceListResponse,
  type LabourDueRecord,
  type LabourPaymentVoucherRecord,
  type LabourRecipientScope,
} from "../../lib/api";
import { formatMoney } from "../../lib/format";
import { canCreate, canDelete, canEdit } from "../../lib/permissions";
import { getActiveFarmId, getActiveSeasonId, offlineDb, workspaceRecords, type Account, type LabourGroup, type Labourer } from "../../lib/offline-db";

const today = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};
const money = formatMoney;
const uuid = () => crypto.randomUUID();

const scopeOptions: Array<{ value: LabourRecipientScope; label: string }> = [
  { value: "INDIVIDUAL", label: "Individual labourer" },
  { value: "LABOUR_GROUP", label: "Labour group" },
  { value: "CONTRACTOR_FOREMAN", label: "Contractor / foreman" },
  { value: "TEMPORARY_CREW", label: "Temporary crew" },
  { value: "UNREGISTERED_LABOUR", label: "Unregistered labour" },
  { value: "NO_SPECIFIC_RECIPIENT", label: "No specific recipient" },
];

function scopeLabel(scope: LabourRecipientScope) {
  return scopeOptions.find((option) => option.value === scope)?.label ?? scope;
}

function statusLabel(value: string) {
  return value.toLowerCase().replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}

function recipientLabel(record: Pick<LabourDueRecord | LabourPaymentVoucherRecord, "recipientScope" | "recipientSnapshot" | "labourerId" | "labourGroupId">, labourById: Map<string, Labourer>, groupById: Map<string, LabourGroup>) {
  if (record.labourerId) return labourById.get(record.labourerId)?.name ?? String(record.recipientSnapshot.labourerName ?? "Individual labourer");
  if (record.labourGroupId) return groupById.get(record.labourGroupId)?.name ?? String(record.recipientSnapshot.labourGroupName ?? "Labour group");
  return String(record.recipientSnapshot.manualRecipientName ?? record.recipientSnapshot.crewReference ?? record.recipientSnapshot.contractorReference ?? record.recipientSnapshot.batchIdentity ?? scopeLabel(record.recipientScope));
}

type View = "dues" | "direct" | "vouchers" | "advances";

export function WorkforcePaymentsPage() {
  const { token, user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const workspaceId = user?.workspaceId ?? "";
  const farmId = getActiveFarmId() ?? "";
  const seasonId = getActiveSeasonId() ?? "";
  const view: View = location.pathname.endsWith("/direct-due") ? "direct" : location.pathname.endsWith("/vouchers") ? "vouchers" : location.pathname.endsWith("/advances") ? "advances" : "dues";
  const canManage = Boolean(user && workspaceId && canCreate(user, "wages", workspaceId));
  const canHold = Boolean(user && workspaceId && canEdit(user, "wages", workspaceId));
  const canVoid = Boolean(user && workspaceId && canDelete(user, "wages", workspaceId));
  const [dues, setDues] = useState<LabourDueRecord[]>([]);
  const [vouchers, setVouchers] = useState<LabourPaymentVoucherRecord[]>([]);
  const [advances, setAdvances] = useState<LabourAdvancePosition[]>([]);
  const [labourers, setLabourers] = useState<Labourer[]>([]);
  const [groups, setGroups] = useState<LabourGroup[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"OPEN" | "ALL" | LabourDueRecord["paymentStatus"]>("OPEN");
  const [originFilter, setOriginFilter] = useState<"ALL" | "SETTLEMENT" | "DIRECT">("ALL");
  const [scopeFilter, setScopeFilter] = useState<"ALL" | LabourRecipientScope>("ALL");
  const [fromFilter, setFromFilter] = useState("");
  const [toFilter, setToFilter] = useState("");
  const [selectedDue, setSelectedDue] = useState<LabourDueRecord | null>(null);

  const refresh = useCallback(async () => {
    const [nextLabourers, nextGroups, nextAccounts] = await Promise.all([
      workspaceRecords(offlineDb.labourers, { includeDeleted: true }),
      workspaceRecords(offlineDb.labourGroups, { includeDeleted: true }),
      workspaceRecords(offlineDb.accounts, { includeDeleted: true }),
    ]);
    setLabourers(nextLabourers.filter((item) => !item.deletedAt));
    setGroups(nextGroups.filter((item) => !item.deletedAt));
    setAccounts(nextAccounts.filter((item) => !item.deletedAt && ["cash", "bank", "partner"].includes(item.type)));
    if (!token || !workspaceId || !farmId || !seasonId || !navigator.onLine) return;
    setLoading(true);
    setError("");
    try {
      if (view === "advances" || view === "direct") return;
      const [dueResponse, voucherResponse, advanceResponse] = await Promise.all([
        fetchLabourPaymentDues(token, workspaceId, { farmId, seasonId }),
        fetchLabourPaymentVouchers(token, workspaceId, { farmId, seasonId }),
        fetchLabourPaymentAdvances(token, workspaceId, farmId, seasonId, { pageSize: view === "dues" ? 100 : 20 }),
      ]);
      setDues(dueResponse.dues);
      setVouchers(voucherResponse.vouchers);
      setAdvances(advanceResponse.advances);
      setSelectedDue((current) => current ? dueResponse.dues.find((item) => item.id === current.id) ?? null : null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to load Workforce Payments.");
    } finally {
      setLoading(false);
    }
  }, [farmId, seasonId, token, view, workspaceId]);

  useEffect(() => {
    void refresh();
    const handle = () => void refresh();
    window.addEventListener("muzare-data-refresh", handle);
    return () => window.removeEventListener("muzare-data-refresh", handle);
  }, [refresh]);

  const labourById = useMemo(() => new Map(labourers.map((item) => [item.id, item])), [labourers]);
  const groupById = useMemo(() => new Map(groups.map((item) => [item.id, item])), [groups]);
  const accountById = useMemo(() => new Map(accounts.map((item) => [item.id, item])), [accounts]);
  const openDues = dues.filter((due) => ["UNPAID", "PARTIALLY_SETTLED", "ON_HOLD"].includes(due.paymentStatus));
  const totalDue = openDues.reduce((sum, due) => sum + Number(due.outstandingBalance), 0);
  const unpaidSettlements = openDues.filter((due) => due.origin === "SETTLEMENT" && due.paymentStatus === "UNPAID").length;
  const partialCount = openDues.filter((due) => due.paymentStatus === "PARTIALLY_SETTLED").length;
  const outstandingAdvances = advances.reduce((sum, advance) => sum + advance.outstandingAmount, 0);
  const filteredDues = useMemo(() => {
    const term = search.trim().toLowerCase();
    return dues.filter((due) => {
      const statusMatches = statusFilter === "ALL" || statusFilter === "OPEN" && ["UNPAID", "PARTIALLY_SETTLED", "ON_HOLD"].includes(due.paymentStatus) || due.paymentStatus === statusFilter;
      const originMatches = originFilter === "ALL" || due.origin === originFilter;
      const scopeMatches = scopeFilter === "ALL" || due.recipientScope === scopeFilter;
      const dateMatches = (!fromFilter || due.workToDate >= fromFilter) && (!toFilter || due.workFromDate <= toFilter);
      const textMatches = !term || [due.dueNumber, due.description, recipientLabel(due, labourById, groupById), due.settlementBasis].join(" ").toLowerCase().includes(term);
      return statusMatches && originMatches && scopeMatches && dateMatches && textMatches;
    });
  }, [dues, fromFilter, groupById, labourById, originFilter, scopeFilter, search, statusFilter, toFilter]);

  if (!farmId || !seasonId) return <section className="record-panel workforce-payments-context"><AlertCircle size={20} /><p>Select an active farm and season to manage labour payments.</p></section>;

  return <div className="workforce-payments-page">
    {error ? <div className="workforce-payments-notice is-error"><AlertCircle size={16} /><span>{error}</span><button type="button" onClick={() => setError("")}><X size={15} /></button></div> : null}
    {success ? <div className="workforce-payments-notice is-success"><ShieldCheck size={16} /><span>{success}</span><button type="button" onClick={() => setSuccess("")}><X size={15} /></button></div> : null}
    {view === "dues" ? <>
      <section className="workforce-payments-summary-grid">
        <button type="button" onClick={() => setStatusFilter("OPEN")}><WalletCards size={17} /><span>Total payments due</span><strong>{money(totalDue)}</strong></button>
        <button type="button" onClick={() => { setStatusFilter("UNPAID"); setOriginFilter("SETTLEMENT"); }}><ReceiptText size={17} /><span>Unpaid settlements</span><strong>{unpaidSettlements}</strong></button>
        <button type="button" onClick={() => setStatusFilter("PARTIALLY_SETTLED")}><Banknote size={17} /><span>Partially settled</span><strong>{partialCount}</strong></button>
        <button type="button" onClick={() => navigate("/workspace/labour-payments/advances")}><HandCoins size={17} /><span>Outstanding advances</span><strong>{money(outstandingAdvances)}</strong></button>
      </section>
      <section className="record-panel workforce-payments-panel">
        <header className="workforce-payments-panel__header"><div><h2>Payments Due</h2><p>Settlement and direct labour obligations waiting to be cleared.</p></div><div className="workforce-payments-panel__actions"><button className="secondary-action" type="button" onClick={() => navigate("/workspace/labour-payments/settlements")}><ReceiptText size={16} /> Attendance settlement</button><button className="secondary-action" type="button" onClick={() => navigate("/workspace/labour-payments/direct-due")}><Plus size={16} /> New due</button></div></header>
        <div className="workforce-payments-filters">
          <label className="workforce-payments-search"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search due, recipient, or description" /></label>
          <select aria-label="Payment status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}><option value="OPEN">Unpaid & partial</option><option value="UNPAID">Unpaid</option><option value="PARTIALLY_SETTLED">Partially settled</option><option value="PAID">Paid</option><option value="SETTLED_BY_ADVANCE">Settled by advance</option><option value="ON_HOLD">On hold</option><option value="VOIDED">Voided</option><option value="ALL">All statuses</option></select>
          <select aria-label="Due origin" value={originFilter} onChange={(event) => setOriginFilter(event.target.value as typeof originFilter)}><option value="ALL">All origins</option><option value="SETTLEMENT">Settlement</option><option value="DIRECT">Direct due</option></select>
          <select aria-label="Recipient scope" value={scopeFilter} onChange={(event) => setScopeFilter(event.target.value as typeof scopeFilter)}><option value="ALL">All recipients</option>{scopeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
          <label className="workforce-payments-date-filter"><span>From</span><input type="date" value={fromFilter} onChange={(event) => setFromFilter(event.target.value)} /></label>
          <label className="workforce-payments-date-filter"><span>To</span><input type="date" min={fromFilter || undefined} value={toFilter} onChange={(event) => setToFilter(event.target.value)} /></label>
        </div>
        {loading ? <p className="workforce-payments-empty">Loading payments due…</p> : !filteredDues.length ? <p className="workforce-payments-empty">No labour dues match these filters.</p> : <div className="workforce-payments-due-list">{filteredDues.map((due) => <button key={due.id} type="button" className="workforce-payment-due-card" onClick={() => setSelectedDue(due)}>
          <span className="workforce-payment-due-card__top"><strong>{due.dueNumber}</strong><em className={`workforce-payment-status status-${due.paymentStatus.toLowerCase()}`}>{statusLabel(due.paymentStatus)}</em></span>
          <span className="workforce-payment-due-card__recipient">{recipientLabel(due, labourById, groupById)}</span>
          <span className="workforce-payment-due-card__description">{due.description}</span>
          <span className="workforce-payment-due-card__meta"><i>{due.origin === "SETTLEMENT" ? `${statusLabel(due.settlementBasis ?? "Settlement")} settlement` : "Direct labour due"}</i><i>{due.workFromDate} – {due.workToDate}</i></span>
          <span className="workforce-payment-due-card__amounts"><i>Gross <b>{money(Number(due.grossAmount))}</b></i><i>Advances <b>{money(due.advancesApplied)}</b></i><i>Paid <b>{money(due.previousPayments)}</b></i><i className="is-outstanding">Outstanding <b>{money(due.outstandingBalance)}</b></i></span>
          <span className="workforce-payment-due-card__action">Review and settle <ArrowRight size={15} /></span>
        </button>)}</div>}
      </section>
    </> : null}
    {view === "direct" ? <DirectDueForm labourers={labourers} groups={groups} canManage={canManage} onSaved={async (message) => { setSuccess(message); await refresh(); navigate("/workspace/labour-payments/overview"); }} onError={setError} token={token ?? ""} workspaceId={workspaceId} farmId={farmId} seasonId={seasonId} /> : null}
    {view === "vouchers" ? <VoucherRegister vouchers={vouchers} dues={dues} advances={advances} accounts={accountById} labourById={labourById} groupById={groupById} loading={loading} canVoid={canVoid} token={token ?? ""} workspaceId={workspaceId} farmId={farmId} seasonId={seasonId} onSaved={async (message) => { setSuccess(message); await refresh(); }} onError={setError} /> : null}
    {view === "advances" ? <AdvancesView labourers={labourers} groups={groups} accounts={accounts} canManage={canManage} token={token ?? ""} workspaceId={workspaceId} farmId={farmId} seasonId={seasonId} onSaved={async (message) => { setSuccess(message); }} onError={setError} /> : null}
    {selectedDue ? <ReviewSettleDialog due={selectedDue} advances={advances.filter((advance) => advance.status === "POSTED" && advance.outstandingAmount > 0 && advance.financialScopeKey === selectedDue.financialScopeKey)} accounts={accounts} recipient={recipientLabel(selectedDue, labourById, groupById)} canManage={canManage} canHold={canHold} canVoid={canVoid} token={token ?? ""} workspaceId={workspaceId} farmId={farmId} seasonId={seasonId} onClose={() => setSelectedDue(null)} onSaved={async (message) => { setSelectedDue(null); setSuccess(message); await refresh(); }} onError={setError} /> : null}
  </div>;
}

function DirectDueForm({ labourers, groups, canManage, onSaved, onError, token, workspaceId, farmId, seasonId }: { labourers: Labourer[]; groups: LabourGroup[]; canManage: boolean; onSaved: (message: string) => Promise<void>; onError: (message: string) => void; token: string; workspaceId: string; farmId: string; seasonId: string }) {
  const idempotencyKey = useRef(uuid());
  const [scope, setScope] = useState<LabourRecipientScope>("INDIVIDUAL");
  const [labourerId, setLabourerId] = useState(""); const [groupId, setGroupId] = useState("");
  const [recipientName, setRecipientName] = useState(""); const [reference, setReference] = useState("");
  const [description, setDescription] = useState(""); const [from, setFrom] = useState(today()); const [to, setTo] = useState(today());
  const [amount, setAmount] = useState(""); const [leaderAllowance, setLeaderAllowance] = useState(""); const [deductions, setDeductions] = useState(""); const [notes, setNotes] = useState(""); const [saving, setSaving] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!canManage || saving) return;
    setSaving(true);
    try {
      if (!navigator.onLine) throw new Error("Connect to the internet before approving a labour due.");
      const response = await createDirectLabourDue(token, workspaceId, { farmId, seasonId, idempotencyKey: idempotencyKey.current, recipientScope: scope, labourerId: scope === "INDIVIDUAL" ? labourerId : null, labourGroupId: scope === "LABOUR_GROUP" ? groupId : null, contractorReference: scope === "CONTRACTOR_FOREMAN" ? reference : null, crewReference: ["TEMPORARY_CREW", "UNREGISTERED_LABOUR"].includes(scope) ? reference : null, manualRecipientName: recipientName || null, batchIdentity: scope === "NO_SPECIFIC_RECIPIENT" ? reference : null, description, workFromDate: from, workToDate: to, grossAmount: Number(amount), authorizedDeductions: Number(deductions || 0), leaderAllowance: Number(leaderAllowance || 0), notes });
      idempotencyKey.current = uuid();
      await onSaved(`Direct labour due ${response.due.dueNumber} created. No cash was moved.`);
    } catch (caught) { onError(caught instanceof Error ? caught.message : "Unable to create the labour due."); } finally { setSaving(false); }
  };
  return <section className="record-panel workforce-payments-panel workforce-direct-due-panel"><header className="workforce-payments-panel__header"><div><h2>Create Direct Labour Due</h2><p>Record the agreed labour obligation first. Payment is posted separately.</p></div></header><form className="workforce-payment-form" onSubmit={(event) => void submit(event)}>
    <label><span>Recipient scope</span><select value={scope} onChange={(event) => setScope(event.target.value as LabourRecipientScope)}>{scopeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
    {scope === "INDIVIDUAL" ? <label><span>Labourer</span><select required value={labourerId} onChange={(event) => setLabourerId(event.target.value)}><option value="">Select labourer</option>{labourers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label> : null}
    {scope === "LABOUR_GROUP" ? <label><span>Labour group</span><select required value={groupId} onChange={(event) => setGroupId(event.target.value)}><option value="">Select group</option>{groups.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label> : null}
    {!['INDIVIDUAL', 'LABOUR_GROUP'].includes(scope) ? <><label><span>Recipient name</span><input value={recipientName} onChange={(event) => setRecipientName(event.target.value)} placeholder="Optional name" /></label><label><span>{scope === "CONTRACTOR_FOREMAN" ? "Contractor / foreman reference" : scope === "NO_SPECIFIC_RECIPIENT" ? "Batch identity" : "Crew / work reference"}</span><input required value={reference} onChange={(event) => setReference(event.target.value)} placeholder="Required settlement identity" /></label></> : null}
    <label className="is-full"><span>Work description</span><input required value={description} onChange={(event) => setDescription(event.target.value)} placeholder="e.g. Temporary workers for onion loading" /></label>
    <label><span>Work from</span><input required type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label><label><span>Work to</span><input required type="date" min={from} value={to} onChange={(event) => setTo(event.target.value)} /></label>
    <label><span>Final agreed amount (SAR)</span><input required min="0.01" step="0.01" type="number" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.00" /></label>
    {scope === "LABOUR_GROUP" ? <label><span>Leader allowance (optional)</span><input min="0" step="0.01" type="number" value={leaderAllowance} onChange={(event) => setLeaderAllowance(event.target.value)} placeholder="0.00" /></label> : null}
    <label><span>Authorized deductions</span><input min="0" step="0.01" type="number" value={deductions} onChange={(event) => setDeductions(event.target.value)} placeholder="0.00" /></label>
    <label className="is-full"><span>Notes</span><input value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Optional notes" /></label>
    <footer className="workforce-payment-form__footer"><div><strong>Amount due</strong><span>{money(Number(amount || 0) + Number(leaderAllowance || 0) - Number(deductions || 0))}</span></div><button disabled={!canManage || saving} type="submit">{saving ? "Creating…" : "Create unpaid due"}</button></footer>
  </form></section>;
}

function VoucherRegister({ vouchers, dues, advances, accounts, labourById, groupById, loading, canVoid, token, workspaceId, farmId, seasonId, onSaved, onError }: { vouchers: LabourPaymentVoucherRecord[]; dues: LabourDueRecord[]; advances: LabourAdvancePosition[]; accounts: Map<string, Account>; labourById: Map<string, Labourer>; groupById: Map<string, LabourGroup>; loading: boolean; canVoid: boolean; token: string; workspaceId: string; farmId: string; seasonId: string; onSaved: (message: string) => Promise<void>; onError: (message: string) => void }) {
  const [search, setSearch] = useState(""); const [nature, setNature] = useState("ALL");
  const [voidingId, setVoidingId] = useState("");
  const voidIdempotencyKeys = useRef<Record<string, string>>({});
  const voidVoucher = async (voucher: LabourPaymentVoucherRecord) => {
    const reason = window.prompt(`Reason for reversing ${voucher.voucherNumber}:`);
    if (!reason?.trim()) return;
    setVoidingId(voucher.id);
    try {
      if (!navigator.onLine) throw new Error("Connect to the internet before reversing a financial transaction.");
      if (!voidIdempotencyKeys.current[voucher.id]) voidIdempotencyKeys.current[voucher.id] = uuid();
      const response = await voidLabourPaymentVoucher(token, workspaceId, voucher.id, farmId, seasonId, { idempotencyKey: voidIdempotencyKeys.current[voucher.id]!, reason: reason.trim() });
      delete voidIdempotencyKeys.current[voucher.id];
      await onSaved(response.result.reversal ? `${voucher.voucherNumber} voided by ${response.result.reversal.voucherNumber}.` : `${voucher.voucherNumber} is already voided.`);
    } catch (caught) { onError(caught instanceof Error ? caught.message : "Unable to void this voucher."); } finally { setVoidingId(""); }
  };
  const filtered = vouchers.filter((voucher) => (nature === "ALL" || voucher.nature === nature) && (!search.trim() || [voucher.voucherNumber, voucher.description, recipientLabel(voucher, labourById, groupById)].join(" ").toLowerCase().includes(search.trim().toLowerCase())));
  const recognizedExpense = dues.filter((due) => due.calculationStatus === "APPROVED" && due.paymentStatus !== "VOIDED").reduce((sum, due) => sum + Math.max(Number(due.grossAmount) + Number(due.adjustmentAmount) - Number(due.authorizedDeductions), 0), 0);
  const labourCashPaid = vouchers.filter((voucher) => voucher.status === "POSTED").reduce((sum, voucher) => {
    const amount = Number(voucher.paymentAmount);
    if (voucher.nature === "REFUND_RECOVERY") return sum - amount;
    if (voucher.nature !== "REVERSAL") return sum + amount;
    const original = vouchers.find((item) => item.id === voucher.reversalReference);
    return sum + (original?.nature === "REFUND_RECOVERY" ? amount : -amount);
  }, 0);
  const payableOutstanding = dues.filter((due) => !["VOIDED", "PAID", "SETTLED_BY_ADVANCE"].includes(due.paymentStatus)).reduce((sum, due) => sum + due.outstandingBalance, 0);
  const advanceOutstanding = advances.reduce((sum, advance) => sum + advance.outstandingAmount, 0);
  return <section className="record-panel workforce-payments-panel"><header className="workforce-payments-panel__header"><div><h2>Labour Payment Vouchers</h2><p>One register for advances, final payments, refunds, and reversals.</p></div></header><div className="workforce-payments-filters"><label className="workforce-payments-search"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search voucher or recipient" /></label><select value={nature} onChange={(event) => setNature(event.target.value)}><option value="ALL">All voucher natures</option><option value="ADVANCE">Advances</option><option value="SETTLEMENT_BALANCE_PAYMENT">Settlement payments</option><option value="DIRECT_LABOUR_PAYMENT">Direct due payments</option><option value="REFUND_RECOVERY">Refunds / recoveries</option><option value="REVERSAL">Reversals</option></select></div>
    <div className="workforce-payment-report-grid"><article><span>Labour expense recognized</span><strong>{money(recognizedExpense)}</strong></article><article><span>Labour cash paid</span><strong>{money(labourCashPaid)}</strong></article><article><span>Outstanding advances</span><strong>{money(advanceOutstanding)}</strong></article><article><span>Outstanding payables</span><strong>{money(payableOutstanding)}</strong></article></div>
    {loading ? <p className="workforce-payments-empty">Loading vouchers…</p> : !filtered.length ? <p className="workforce-payments-empty">No Labour Payment Vouchers match this filter.</p> : <div className="workforce-payment-voucher-list">{filtered.map((voucher) => <article key={voucher.id}><header><strong>{voucher.voucherNumber}</strong><em className={`workforce-payment-status status-${voucher.status.toLowerCase()}`}>{statusLabel(voucher.status)}</em></header><h3>{recipientLabel(voucher, labourById, groupById)}</h3><p>{voucher.description}</p><dl><div><dt>Nature</dt><dd>{statusLabel(voucher.nature)}</dd></div><div><dt>Date</dt><dd>{voucher.voucherDate}</dd></div><div><dt>Account</dt><dd>{accounts.get(voucher.paymentAccountId ?? "")?.name ?? "Legacy / reconciliation"}</dd></div><div><dt>Amount</dt><dd>{money(Number(voucher.paymentAmount))}</dd></div></dl>{voucher.legacy ? <small>Legacy mapped record · {statusLabel(voucher.reconciliationStatus)}</small> : null}{canVoid && voucher.status === "POSTED" && voucher.nature !== "REVERSAL" && !voucher.legacy ? <button className="secondary-action" disabled={voidingId === voucher.id} type="button" onClick={() => void voidVoucher(voucher)}>{voidingId === voucher.id ? "Reversing…" : "Void / reverse"}</button> : null}</article>)}</div>}
  </section>;
}

function AdvancesView({ labourers, groups, accounts, canManage, token, workspaceId, farmId, seasonId, onSaved, onError }: { labourers: Labourer[]; groups: LabourGroup[]; accounts: Account[]; canManage: boolean; token: string; workspaceId: string; farmId: string; seasonId: string; onSaved: (message: string) => Promise<void>; onError: (message: string) => void }) {
  const [rows,setRows]=useState<LabourAdvancePosition[]>([]); const [summary,setSummary]=useState<LabourAdvanceListResponse["summary"]>({totalOutstanding:0,openCount:0,partiallyAppliedCount:0}); const [pageInfo,setPageInfo]=useState<LabourAdvanceListResponse["pageInfo"]>({page:1,pageSize:20,totalCount:0,hasMore:false});
  const [initialLoading,setInitialLoading]=useState(true); const [loadingMore,setLoadingMore]=useState(false); const [loadError,setLoadError]=useState(""); const [searchInput,setSearchInput]=useState(""); const [search,setSearch]=useState(""); const [scopeFilter,setScopeFilter]=useState(""); const [statusFilter,setStatusFilter]=useState("OPEN"); const [accountFilter,setAccountFilter]=useState(""); const [fromFilter,setFromFilter]=useState(""); const [toFilter,setToFilter]=useState(""); const [showFilters,setShowFilters]=useState(false); const [groupMode,setGroupMode]=useState(false);
  const [selectedAdvance,setSelectedAdvance]=useState<LabourAdvancePosition|null>(null); const [showForm,setShowForm]=useState(false); const [scope,setScope]=useState<LabourRecipientScope>("INDIVIDUAL"); const [labourerId,setLabourerId]=useState(""); const [groupId,setGroupId]=useState(""); const [reference,setReference]=useState(""); const [recipientName,setRecipientName]=useState(""); const [date,setDate]=useState(today()); const [amount,setAmount]=useState(""); const [accountId,setAccountId]=useState(""); const [method,setMethod]=useState("Cash"); const [description,setDescription]=useState(""); const [saving,setSaving]=useState(false);
  const [refundAdvance,setRefundAdvance]=useState<LabourAdvancePosition|null>(null); const [refundAmount,setRefundAmount]=useState(""); const [refundAccountId,setRefundAccountId]=useState(""); const [refundDate,setRefundDate]=useState(today()); const [refundMethod,setRefundMethod]=useState("Recovery"); const [refundNotes,setRefundNotes]=useState(""); const [refunding,setRefunding]=useState(false);
  const idempotencyKey=useRef(uuid()); const refundIdempotencyKey=useRef(uuid()); const abortRef=useRef<AbortController|null>(null); const abortTimerRef=useRef<number|null>(null); const inFlightKeyRef=useRef(""); const requestSequence=useRef(0);
  useEffect(()=>{const handle=window.setTimeout(()=>setSearch(searchInput.trim()),320); return()=>window.clearTimeout(handle);},[searchInput]);
  const cacheKey=useMemo(()=>`muzare:advance-list:${workspaceId}:${farmId}:${seasonId}:${search}:${scopeFilter}:${statusFilter}:${accountFilter}:${fromFilter}:${toFilter}`,[accountFilter,farmId,fromFilter,scopeFilter,search,seasonId,statusFilter,toFilter,workspaceId]);
  const loadPage=useCallback(async(page:number,append=false)=>{const requestKey=`${cacheKey}:${page}`;if(inFlightKeyRef.current===requestKey)return;inFlightKeyRef.current=requestKey;const controller=new AbortController(); abortRef.current?.abort(); abortRef.current=controller; const sequence=++requestSequence.current; if(append)setLoadingMore(true); else setInitialLoading(true); setLoadError(""); try{const response=await fetchLabourPaymentAdvances(token,workspaceId,farmId,seasonId,{page,pageSize:20,search:search||undefined,recipientScope:scopeFilter||undefined,status:statusFilter,accountId:accountFilter||undefined,from:fromFilter||undefined,to:toFilter||undefined,signal:controller.signal}); if(sequence!==requestSequence.current)return; setRows((current)=>append?[...current,...response.advances.filter((next)=>!current.some((item)=>item.id===next.id))]:response.advances); setSummary(response.summary); setPageInfo(response.pageInfo); if(!append)sessionStorage.setItem(cacheKey,JSON.stringify(response));}catch(caught){if(controller.signal.aborted)return; setLoadError(caught instanceof Error?caught.message:"Unable to load outstanding advances.");}finally{if(inFlightKeyRef.current===requestKey)inFlightKeyRef.current="";if(sequence===requestSequence.current){setInitialLoading(false);setLoadingMore(false);}}},[accountFilter,cacheKey,farmId,fromFilter,scopeFilter,search,seasonId,statusFilter,toFilter,token,workspaceId]);
  useEffect(()=>{if(abortTimerRef.current!==null){window.clearTimeout(abortTimerRef.current);abortTimerRef.current=null;}const cached=sessionStorage.getItem(cacheKey); if(cached){try{const value=JSON.parse(cached) as LabourAdvanceListResponse;setRows(value.advances);setSummary(value.summary);setPageInfo(value.pageInfo);setInitialLoading(false);}catch{sessionStorage.removeItem(cacheKey);}} void loadPage(1,false); return()=>{abortTimerRef.current=window.setTimeout(()=>abortRef.current?.abort(),0);};},[cacheKey,loadPage]);
  const submit=async(event:FormEvent)=>{event.preventDefault();if(saving)return;setSaving(true);try{if(!navigator.onLine)throw new Error("Connect to the internet before posting a financial transaction.");const response=await postLabourAdvanceVoucher(token,workspaceId,{farmId,seasonId,idempotencyKey:idempotencyKey.current,voucherDate:date,recipientScope:scope,labourerId:scope==="INDIVIDUAL"?labourerId:null,labourGroupId:scope==="LABOUR_GROUP"?groupId:null,contractorReference:scope==="CONTRACTOR_FOREMAN"?reference:null,crewReference:["TEMPORARY_CREW","UNREGISTERED_LABOUR"].includes(scope)?reference:null,manualRecipientName:recipientName||null,batchIdentity:scope==="NO_SPECIFIC_RECIPIENT"?reference:null,amount:Number(amount),paymentAccountId:accountId,paymentMethod:method,description});idempotencyKey.current=uuid();setShowForm(false);setAmount("");setDescription("");await onSaved(`Advance ${response.voucher.voucherNumber} posted.`);await loadPage(1,false);}catch(caught){onError(caught instanceof Error?caught.message:"Unable to post the advance.");}finally{setSaving(false);}};
  const submitRefund=async(event:FormEvent)=>{event.preventDefault();if(!refundAdvance||refunding)return;const recovery=Number(refundAmount);if(recovery>refundAdvance.outstandingAmount+0.005){onError("Recovery cannot exceed the outstanding advance amount.");return;}setRefunding(true);try{const response=await refundLabourAdvance(token,workspaceId,refundAdvance.id,{farmId,seasonId,payment:{idempotencyKey:refundIdempotencyKey.current,voucherDate:refundDate,amount:recovery,paymentAccountId:refundAccountId,paymentMethod:refundMethod,description:refundNotes||`Advance recovery for ${refundAdvance.displayVoucherNumber}`}});refundIdempotencyKey.current=uuid();setRefundAdvance(null);setRefundAmount("");setRefundNotes("");await onSaved(`Recovery ${response.voucher.voucherNumber} posted.`);await loadPage(1,false);}catch(caught){onError(caught instanceof Error?caught.message:"Unable to post the recovery.");}finally{setRefunding(false);}};
  const formatDate=(value:string)=>new Intl.DateTimeFormat(undefined,{day:"numeric",month:"short",year:"numeric",timeZone:"UTC"}).format(new Date(`${value}T00:00:00Z`));
  const scopeCopy=(advance:LabourAdvancePosition)=>advance.recipientScope==="INDIVIDUAL"?"Individual labourer":advance.recipientScope==="LABOUR_GROUP"?"Labour group":scopeLabel(advance.recipientScope);
  const recipientGroups=useMemo(()=>Array.from(rows.reduce((map,advance)=>{const key=`${advance.recipientScope}:${advance.financialOwnerId??advance.financialOwnerName??"unavailable"}`;const current=map.get(key)??{key,name:advance.financialOwnerName??"Recipient unavailable",scope:scopeCopy(advance),count:0,outstanding:0,reviewRequired:false};current.count+=1;current.outstanding+=advance.outstandingAmount;current.reviewRequired ||= advance.reviewRequired;map.set(key,current);return map;},new Map<string,{key:string;name:string;scope:string;count:number;outstanding:number;reviewRequired:boolean}>()).values()),[rows]);
  return <><section className="record-panel workforce-payments-panel workforce-advances-panel"><header className="workforce-payments-panel__header workforce-advances-header"><div><h2>Outstanding Advances</h2><p>{pageInfo.totalCount?`${rows.length} of ${pageInfo.totalCount} advances loaded`:"Advance balances by financial owner"}</p></div>{canManage?<button className="primary-action workforce-record-advance" type="button" onClick={()=>setShowForm(true)}><Plus size={16}/> Record advance</button>:null}</header>
    <div className="workforce-advance-summary"><div><span>Total outstanding</span><strong>{money(summary.totalOutstanding)}</strong></div><div><span>Open</span><strong>{summary.openCount}</strong></div>{summary.partiallyAppliedCount?<div><span>Partial</span><strong>{summary.partiallyAppliedCount}</strong></div>:null}</div>
    <div className="workforce-advance-toolbar"><label className="workforce-payments-search"><Search size={16}/><input value={searchInput} onChange={(event)=>setSearchInput(event.target.value)} placeholder="Search recipient, voucher, or account"/></label><button className="secondary-action" type="button" aria-pressed={groupMode} onClick={()=>setGroupMode((value)=>!value)}>{groupMode?"Show vouchers":"Group recipients"}</button><button className="secondary-action" type="button" aria-expanded={showFilters} onClick={()=>setShowFilters((value)=>!value)}>Filters</button></div>
    {showFilters?<div className="workforce-advance-filters"><select aria-label="Recipient scope" value={scopeFilter} onChange={(event)=>setScopeFilter(event.target.value)}><option value="">All recipients</option>{scopeOptions.map((item)=><option key={item.value} value={item.value}>{item.label}</option>)}</select><select aria-label="Advance status" value={statusFilter} onChange={(event)=>setStatusFilter(event.target.value)}><option value="OPEN">Outstanding & partial</option><option value="OUTSTANDING">Outstanding</option><option value="PARTIALLY_APPLIED">Partially applied</option><option value="PARTIALLY_REFUNDED">Partially refunded</option><option value="ALL">All history</option></select><select aria-label="Payment account" value={accountFilter} onChange={(event)=>setAccountFilter(event.target.value)}><option value="">All accounts</option>{accounts.map((item)=><option key={item.id} value={item.id}>{item.name}</option>)}</select><input aria-label="Advance date from" type="date" value={fromFilter} onChange={(event)=>setFromFilter(event.target.value)}/><input aria-label="Advance date to" type="date" value={toFilter} onChange={(event)=>setToFilter(event.target.value)}/></div>:null}
    {initialLoading&&!rows.length?<div className="workforce-advance-skeletons" aria-label="Loading outstanding advances">{Array.from({length:4},(_,index)=><div key={index} className="workforce-advance-skeleton"/>)}</div>:loadError&&!rows.length?<div className="workforce-payments-empty"><p>{loadError}</p><button className="secondary-action" type="button" onClick={()=>void loadPage(1,false)}>Retry</button></div>:!rows.length?<p className="workforce-payments-empty">No outstanding advances match these filters.</p>:groupMode?<div className="workforce-advance-recipient-list">{recipientGroups.map((group)=><article key={group.key}><div><strong>{group.name}</strong><span>{group.scope}{group.reviewRequired?" · Review required":""}</span></div><div><b>{money(group.outstanding)}</b><span>{group.count} loaded {group.count===1?"advance":"advances"}</span></div><button className="secondary-action" type="button" disabled={group.name==="Recipient unavailable"} onClick={()=>{setGroupMode(false);setSearchInput(group.name);}}>Show advances</button></article>)}</div>:<div className="workforce-advance-position-list">{rows.map((advance)=><article key={advance.id} className="workforce-advance-card" tabIndex={0} role="button" onClick={()=>setSelectedAdvance(advance)} onKeyDown={(event)=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();setSelectedAdvance(advance);}}}><header><div><span>{advance.financialOwnerName??"Recipient unavailable"}</span><small>{scopeCopy(advance)}{advance.reviewRequired?" · Review required":""}</small></div><em className={`workforce-payment-status status-${advance.advanceStatus.toLowerCase()}`}>{statusLabel(advance.advanceStatus)}</em></header>{advance.receivedByName&&advance.receivedByName!==advance.financialOwnerName?<p><b>Received by:</b> {advance.receivedByName}</p>:null}<div className="workforce-advance-card__reference"><span>{advance.displayVoucherNumber}</span><time>{formatDate(advance.voucherDate)}</time></div><div className="workforce-advance-card__money"><div><span>Outstanding</span><strong>{money(advance.outstandingAmount)}</strong></div><small>Original {money(advance.originalAmount)}{advance.appliedAmount>0?` · Applied ${money(advance.appliedAmount)}`:""}{advance.refundedAmount>0?` · Recovered ${money(advance.refundedAmount)}`:""}</small></div><footer><span>{advance.paymentAccountName??"Account unavailable · Legacy record"}</span><div><button type="button" className="workforce-advance-link" onClick={(event)=>{event.stopPropagation();setSelectedAdvance(advance);}}>Details</button>{canManage&&!advance.readOnlyLegacy&&advance.status==="POSTED"?<button type="button" className="secondary-action workforce-advance-recover" onClick={(event)=>{event.stopPropagation();setRefundAdvance(advance);setRefundAmount(String(advance.outstandingAmount));}}>Recover</button>:null}</div></footer></article>)}</div>}
    {rows.length?<div className="workforce-advance-pagination"><span>Showing {rows.length} of {pageInfo.totalCount}</span>{pageInfo.hasMore?<button className="secondary-action" disabled={loadingMore} type="button" onClick={()=>void loadPage(pageInfo.page+1,true)}>{loadingMore?"Loading more…":"Load more"}</button>:<small>End of results</small>}</div>:null}
  </section>
  {showForm?<div className="worker-dialog-backdrop workforce-payment-review-backdrop" role="presentation" onClick={()=>setShowForm(false)}><form className="workforce-payment-review workforce-advance-entry-sheet" onSubmit={(event)=>void submit(event)} onClick={(event)=>event.stopPropagation()}><header><div><span>Labour Payment Voucher</span><h2>Record advance</h2></div><button type="button" onClick={()=>setShowForm(false)} aria-label="Close"><X size={18}/></button></header><div className="workforce-payment-review__body workforce-payment-form"><label><span>Recipient scope</span><select value={scope} onChange={(event)=>setScope(event.target.value as LabourRecipientScope)}>{scopeOptions.slice(0,5).map((item)=><option key={item.value} value={item.value}>{item.label}</option>)}</select></label>{scope==="INDIVIDUAL"?<label><span>Labourer</span><select required value={labourerId} onChange={(event)=>setLabourerId(event.target.value)}><option value="">Select labourer</option>{labourers.map((item)=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>:null}{scope==="LABOUR_GROUP"?<label><span>Labour group</span><select required value={groupId} onChange={(event)=>setGroupId(event.target.value)}><option value="">Select group</option>{groups.map((item)=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>:null}{!["INDIVIDUAL","LABOUR_GROUP"].includes(scope)?<><label><span>Recipient name</span><input value={recipientName} onChange={(event)=>setRecipientName(event.target.value)}/></label><label><span>Stable reference</span><input required value={reference} onChange={(event)=>setReference(event.target.value)}/></label></>:null}<label><span>Date</span><input required type="date" value={date} onChange={(event)=>setDate(event.target.value)}/></label><label><span>Amount (SAR)</span><input required min="0.01" step="0.01" type="number" value={amount} onChange={(event)=>setAmount(event.target.value)}/></label><label><span>Paid from account</span><select required value={accountId} onChange={(event)=>setAccountId(event.target.value)}><option value="">Select account</option>{accounts.map((item)=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label><span>Method</span><select value={method} onChange={(event)=>setMethod(event.target.value)}><option>Cash</option><option>Bank Transfer</option><option>Other</option></select></label><label className="is-full"><span>Description</span><input required value={description} onChange={(event)=>setDescription(event.target.value)}/></label></div><footer><div className="workforce-payment-review__actions"><button className="secondary-action" type="button" onClick={()=>setShowForm(false)}>Cancel</button><button className="primary-action" disabled={saving} type="submit">{saving?"Posting…":"Post advance"}</button></div></footer></form></div>:null}
  {refundAdvance?<div className="worker-dialog-backdrop workforce-payment-review-backdrop" role="presentation" onClick={()=>setRefundAdvance(null)}><form className="workforce-payment-review workforce-recovery-sheet" onSubmit={(event)=>void submitRefund(event)} onClick={(event)=>event.stopPropagation()}><header><div><span>{refundAdvance.displayVoucherNumber}</span><h2>Record recovery</h2><p>{refundAdvance.financialOwnerName??"Recipient unavailable"}</p></div><button type="button" onClick={()=>setRefundAdvance(null)} aria-label="Close"><X size={18}/></button></header><div className="workforce-payment-review__body"><div className="workforce-recovery-balance"><span>Current outstanding</span><strong>{money(refundAdvance.outstandingAmount)}</strong></div><div className="workforce-payment-review-form"><label><span>Recovery amount</span><input required type="number" min="0.01" max={refundAdvance.outstandingAmount} step="0.01" value={refundAmount} onChange={(event)=>setRefundAmount(event.target.value)}/></label><label><span>Received into account</span><select required value={refundAccountId} onChange={(event)=>setRefundAccountId(event.target.value)}><option value="">Select account</option>{accounts.map((item)=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label><span>Date</span><input required type="date" value={refundDate} onChange={(event)=>setRefundDate(event.target.value)}/></label><label><span>Method</span><select value={refundMethod} onChange={(event)=>setRefundMethod(event.target.value)}><option>Recovery</option><option>Cash</option><option>Bank Transfer</option></select></label><label className="is-full"><span>Notes</span><input value={refundNotes} onChange={(event)=>setRefundNotes(event.target.value)} placeholder="Optional notes"/></label></div><div className="workforce-recovery-preview"><span>Outstanding after recovery</span><strong>{money(Math.max(refundAdvance.outstandingAmount-Number(refundAmount||0),0))}</strong></div></div><footer><div className="workforce-payment-review__actions"><button className="secondary-action" type="button" onClick={()=>setRefundAdvance(null)}>Cancel</button><button className="primary-action" disabled={refunding||Number(refundAmount)<=0||Number(refundAmount)>refundAdvance.outstandingAmount||!refundAccountId} type="submit">{refunding?"Posting…":"Confirm recovery"}</button></div></footer></form></div>:null}
  {selectedAdvance?<div className="worker-dialog-backdrop workforce-payment-review-backdrop" role="presentation" onClick={()=>setSelectedAdvance(null)}><section className="workforce-payment-review workforce-advance-detail" role="dialog" aria-modal="true" onClick={(event)=>event.stopPropagation()}><header><div><span>{scopeCopy(selectedAdvance)}</span><h2>{selectedAdvance.displayVoucherNumber}</h2><p>{selectedAdvance.financialOwnerName??"Recipient unavailable"}</p></div><button type="button" onClick={()=>setSelectedAdvance(null)} aria-label="Close"><X size={18}/></button></header><div className="workforce-payment-review__body"><dl className="workforce-payment-position"><div><dt>Financial owner</dt><dd>{selectedAdvance.financialOwnerName??"Recipient unavailable"}</dd></div><div><dt>Received by</dt><dd>{selectedAdvance.receivedByName??"Same as financial owner"}</dd></div><div><dt>Date</dt><dd>{formatDate(selectedAdvance.voucherDate)}</dd></div><div><dt>Account</dt><dd>{selectedAdvance.paymentAccountName??"Account unavailable"}</dd></div><div><dt>Original</dt><dd>{money(selectedAdvance.originalAmount)}</dd></div><div><dt>Applied</dt><dd>{money(selectedAdvance.appliedAmount)}</dd></div><div><dt>Recovered</dt><dd>{money(selectedAdvance.refundedAmount)}</dd></div><div className="is-total"><dt>Outstanding</dt><dd>{money(selectedAdvance.outstandingAmount)}</dd></div></dl><section><h3>Description</h3><p>{selectedAdvance.description}</p></section><section><h3>Posting and audit</h3><p>{statusLabel(selectedAdvance.status)} · {selectedAdvance.createdByName??"Creator unavailable"}</p>{selectedAdvance.legacy?<p>Legacy source: {selectedAdvance.sourceType} · {selectedAdvance.reviewRequired?"Review required":"Mapped"}</p>:null}</section></div></section></div>:null}</>;
}

function ReviewSettleDialog({ due, advances, accounts, recipient, canManage, canHold, canVoid, token, workspaceId, farmId, seasonId, onClose, onSaved, onError }: { due: LabourDueRecord; advances: LabourAdvancePosition[]; accounts: Account[]; recipient: string; canManage: boolean; canHold: boolean; canVoid: boolean; token: string; workspaceId: string; farmId: string; seasonId: string; onClose: () => void; onSaved: (message: string) => Promise<void>; onError: (message: string) => void }) {
  const paymentIdempotencyKey = useRef(uuid());
  const advanceIdempotencyKeys = useRef<Record<string, string>>({});
  const [advanceValues, setAdvanceValues] = useState<Record<string, string>>({}); const [payAmount, setPayAmount] = useState(""); const [accountId, setAccountId] = useState(""); const [method, setMethod] = useState("Cash"); const [reference, setReference] = useState(""); const [saving, setSaving] = useState(false);
  const advanceTotal = advances.reduce((sum, advance) => sum + Number(advanceValues[advance.id] || 0), 0);
  const advanceInvalid = advanceTotal > due.outstandingBalance + 0.005 || advances.some((advance) => Number(advanceValues[advance.id] || 0) > advance.outstandingAmount + 0.005);
  const afterAdvances = Math.max(due.outstandingBalance - advanceTotal, 0); const cashNow = Number(payAmount || 0); const paymentInvalid = cashNow > afterAdvances + 0.005; const remaining = Math.max(afterAdvances - cashNow, 0);
  const submit = async () => { if (!canManage || saving) return; setSaving(true); try { if (!navigator.onLine) throw new Error("Connect to the internet before posting a financial transaction."); const applications = advances.flatMap((advance) => { const value = Number(advanceValues[advance.id] || 0); if (!advanceIdempotencyKeys.current[advance.id]) advanceIdempotencyKeys.current[advance.id] = uuid(); return value > 0 ? [{ advanceVoucherId: advance.id, amount: value, idempotencyKey: advanceIdempotencyKeys.current[advance.id]! }] : []; }); const response = await settleLabourPaymentDue(token, workspaceId, due.id, { farmId, seasonId, advanceApplications: applications, payment: cashNow > 0 ? { idempotencyKey: paymentIdempotencyKey.current, voucherDate: today(), amount: cashNow, paymentAccountId: accountId, paymentMethod: method, transactionReference: reference || null } : null }); paymentIdempotencyKey.current = uuid(); advanceIdempotencyKeys.current = {}; await onSaved(response.result.voucher ? `${response.result.voucher.voucherNumber} posted. Remaining due: ${money(response.result.due.outstandingBalance)}.` : `Advances applied. Remaining due: ${money(response.result.due.outstandingBalance)}.`); } catch (caught) { onError(caught instanceof Error ? caught.message : "Unable to settle this due."); } finally { setSaving(false); } };
  const toggleHold = async () => { if (!canHold) return; try { await setLabourDueHold(token, workspaceId, due.id, farmId, seasonId, { hold: due.paymentStatus !== "ON_HOLD", reason: due.paymentStatus === "ON_HOLD" ? null : "Payment placed on hold from review" }); await onSaved(due.paymentStatus === "ON_HOLD" ? "Payment hold removed." : "Payment placed on hold."); } catch (caught) { onError(caught instanceof Error ? caught.message : "Unable to update payment hold."); } };
  const voidDue = async () => { const reason = window.prompt(`Reason for voiding ${due.dueNumber}:`); if (!reason?.trim()) return; try { if (!navigator.onLine) throw new Error("Connect to the internet before voiding a labour due."); await voidLabourDue(token, workspaceId, due.id, farmId, seasonId, { idempotencyKey: uuid(), reason: reason.trim() }); await onSaved(`${due.dueNumber} voided.`); } catch (caught) { onError(caught instanceof Error ? caught.message : "Unable to void this due."); } };
  return <div className="worker-dialog-backdrop workforce-payment-review-backdrop" role="presentation" onClick={onClose}><section className="workforce-payment-review" role="dialog" aria-modal="true" aria-label={`Review ${due.dueNumber}`} onClick={(event) => event.stopPropagation()}><header><div><span>{due.origin === "SETTLEMENT" ? "Settlement due" : "Direct labour due"}</span><h2>{due.dueNumber}</h2><p>{recipient}</p></div><button type="button" onClick={onClose} aria-label="Close"><X size={18} /></button></header><div className="workforce-payment-review__body">
    <section><h3>Work or settlement summary</h3><dl className="workforce-payment-review-grid"><div><dt>Description</dt><dd>{due.description}</dd></div><div><dt>Work period</dt><dd>{due.workFromDate} – {due.workToDate}</dd></div><div><dt>Source</dt><dd>{due.origin === "SETTLEMENT" ? `${statusLabel(due.settlementBasis ?? "Settlement")} settlement` : "Direct labour due"}</dd></div><div><dt>Status</dt><dd><em className={`workforce-payment-status status-${due.paymentStatus.toLowerCase()}`}>{statusLabel(due.paymentStatus)}</em></dd></div></dl></section>
    <section><h3>Financial position</h3><dl className="workforce-payment-position"><div><dt>Original gross due</dt><dd>{money(Number(due.grossAmount))}</dd></div>{Number(due.adjustmentAmount) !== 0 ? <div><dt>Authorized adjustment / leader allowance</dt><dd>{Number(due.adjustmentAmount) > 0 ? "+ " : "− "}{money(Math.abs(Number(due.adjustmentAmount)))}</dd></div> : null}<div><dt>Authorized deductions</dt><dd>− {money(Number(due.authorizedDeductions))}</dd></div><div><dt>Advances applied</dt><dd>− {money(due.advancesApplied)}</dd></div><div><dt>Previous payments</dt><dd>− {money(due.previousPayments)}</dd></div><div className="is-total"><dt>Outstanding balance</dt><dd>{money(due.outstandingBalance)}</dd></div></dl></section>
    {due.paymentStatus !== "ON_HOLD" && due.outstandingBalance > 0 ? <section><h3>Apply advances</h3>{!advances.length ? <p className="workforce-payments-inline-note">No eligible outstanding advances for this financial scope.</p> : <div className="workforce-payment-advance-options">{advances.map((advance) => <label key={advance.id}><span><strong>{advance.voucherNumber}</strong><small>Available {money(advance.outstandingAmount)}</small></span><input type="number" min="0" max={Math.min(advance.outstandingAmount, due.outstandingBalance)} step="0.01" value={advanceValues[advance.id] ?? ""} onChange={(event) => setAdvanceValues((current) => ({ ...current, [advance.id]: event.target.value }))} placeholder="0.00" /></label>)}</div>}</section> : null}
    {due.paymentStatus !== "ON_HOLD" && afterAdvances > 0 ? <section><h3>Payment now</h3><div className="workforce-payment-review-form"><label><span>Amount (SAR)</span><input type="number" min="0" max={afterAdvances} step="0.01" value={payAmount} onChange={(event) => setPayAmount(event.target.value)} placeholder={String(afterAdvances.toFixed(2))} />{paymentInvalid ? <small className="field-error">Payment cannot exceed the balance after advances.</small> : null}</label><label><span>Payment account</span><select required={cashNow > 0} value={accountId} onChange={(event) => setAccountId(event.target.value)}><option value="">Select account</option>{accounts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label><span>Method</span><select value={method} onChange={(event) => setMethod(event.target.value)}><option>Cash</option><option>Bank Transfer</option><option>Other</option></select></label><label><span>Transaction reference</span><input value={reference} onChange={(event) => setReference(event.target.value)} placeholder="Optional" /></label></div></section> : null}
  </div><footer><div className="workforce-payment-review__preview"><span>Apply advances <b>{money(advanceTotal)}</b></span><span>Pay now <b>{money(cashNow)}</b></span><span>Remaining <b>{money(remaining)}</b></span></div><div className="workforce-payment-review__actions">{canVoid && due.origin === "DIRECT" && due.previousPayments <= 0 && due.advancesApplied <= 0 ? <button type="button" className="secondary-action" onClick={() => void voidDue()}>Void due</button> : null}{canHold ? <button type="button" className="secondary-action" onClick={() => void toggleHold()}><PauseCircle size={16} /> {due.paymentStatus === "ON_HOLD" ? "Remove hold" : "Put on hold"}</button> : null}<button type="button" className="primary-action" disabled={!canManage || saving || due.paymentStatus === "ON_HOLD" || advanceInvalid || paymentInvalid || advanceTotal <= 0 && cashNow <= 0 || cashNow > 0 && !accountId} onClick={() => void submit()}>{saving ? "Posting…" : cashNow > 0 ? "Post payment voucher" : "Apply advances"}</button></div></footer></section></div>;
}
