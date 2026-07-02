import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { ArrowRight, CalendarCheck, CircleDollarSign, ClipboardList, HandCoins, ReceiptText, WalletCards } from "lucide-react";
import { useTranslation } from "react-i18next";
import { NavLink, Outlet, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../../auth/AuthProvider";
import { LabourSelectCombobox } from "../../components/LabourSelectCombobox";
import { SearchInput } from "../../components/SearchInput";
import { SubpageHeader } from "../../components/SubpageHeader";
import { formatMoney } from "../../lib/format";
import { canCreate, hasModulePermission } from "../../lib/permissions";
import { compareLabourers, getActiveFarmId, getActiveSeasonId, makeLocalRecord, offlineDb, workspaceRecords, type LabourEarning, type LabourPayment, type LabourWageSettlement, type Labourer, type WageRate } from "../../lib/offline-db";
import { isActiveOperationalRecord } from "../../lib/operationalRecords";
import { compareWageRates, getWageRateStatus } from "../../lib/wageRates";
import { persistOperationalRecord } from "../../services/syncService";

const money = formatMoney;
const today = () => new Date().toISOString().slice(0, 10);
const monthStart = () => `${today().slice(0, 8)}01`;

function workforceQuery(searchParams: URLSearchParams) {
  const labourId = searchParams.get("labourId");
  return labourId ? `?labourId=${encodeURIComponent(labourId)}` : "";
}

function WorkforceShell({
  title,
  description,
  tabs,
  children,
}: {
  title: string;
  description: string;
  tabs: Array<{ to: string; label: string }>;
  children: ReactNode;
}) {
  return (
    <div className="dashboard-page">
      <SubpageHeader title={title} />
      <main className="subpage module-workspace">
        <section className="workspace-intro workforce-shell-intro">
          <div>
            <h2>{title}</h2>
            <p>{description}</p>
          </div>
        </section>
        <section className="record-panel workforce-shell-panel">
          <nav className="workforce-shell-tabs" aria-label={`${title} navigation`}>
            {tabs.map((tab) => (
              <NavLink
                key={tab.to}
                to={tab.to}
                className={({ isActive }) => `workforce-shell-tab${isActive ? " is-active" : ""}`}
              >
                {tab.label}
              </NavLink>
            ))}
          </nav>
        </section>
        {children}
      </main>
    </div>
  );
}

export function WorkforceSectionLayout() {
  const { t } = useTranslation();
  const tabs = [
    { to: "/workspace/workforce/labour", label: "Labour" },
    { to: "/workspace/workforce/attendance", label: t("layout.attendance") },
    { to: "/workspace/workforce/reports", label: "Workforce Reports" },
  ];
  return (
    <WorkforceShell
      title="Workforce"
      description="Manage labour, attendance, and workforce reporting from one operational workspace."
      tabs={tabs}
    >
      <Outlet />
    </WorkforceShell>
  );
}

export function LabourPaymentsSectionLayout() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const workspaceId = user?.workspaceId ?? "";
  const [searchParams] = useSearchParams();
  const query = workforceQuery(searchParams);
  const tabs = useMemo(() => {
    const allTabs = [
      { to: `/workspace/labour-payments/overview${query}`, label: "Overview", module: "workforce" as const },
      { to: `/workspace/labour-payments/advances${query}`, label: t("layout.advances"), module: "advances" as const },
      { to: `/workspace/labour-payments/wage-rates${query}`, label: "Wage Rates", module: "wages" as const },
      { to: `/workspace/labour-payments/earnings${query}`, label: "Labour Work / Earnings", module: "wages" as const },
      { to: `/workspace/labour-payments/settlements${query}`, label: "Wage Settlement", module: "wages" as const },
      { to: `/workspace/labour-payments/direct-payments${query}`, label: "Direct Payments", module: "workforce" as const },
      { to: `/workspace/labour-payments/reports${query}`, label: "Reports", module: "reports" as const },
    ];
    return allTabs.filter((tab) => !user || hasModulePermission(user, tab.module, "view", workspaceId));
  }, [query, t, user, workspaceId]);
  return (
    <WorkforceShell
      title="Labour Payments"
      description="Keep advances, wage rates, labour work, direct payments, settlements, and payment reports together in one professional labour-payment center."
      tabs={tabs}
    >
      <Outlet />
    </WorkforceShell>
  );
}

export function LabourPaymentsOverview() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const labourId = searchParams.get("labourId") ?? "";
  const [labourers, setLabourers] = useState<Labourer[]>([]);
  const [earnings, setEarnings] = useState<LabourEarning[]>([]);
  const [payments, setPayments] = useState<LabourPayment[]>([]);
  const [rates, setRates] = useState<WageRate[]>([]);
  const [settlements, setSettlements] = useState<LabourWageSettlement[]>([]);
  const [advancesTotal, setAdvancesTotal] = useState(0);

  const refresh = useCallback(async () => {
    const [nextLabourers, nextEarnings, nextPayments, nextRates, nextSettlements, nextAdvances] = await Promise.all([
      workspaceRecords(offlineDb.labourers),
      workspaceRecords(offlineDb.labourEarnings, { includeDeleted: true }),
      workspaceRecords(offlineDb.labourPayments, { includeDeleted: true }),
      workspaceRecords(offlineDb.wageRates, { includeDeleted: true }),
      workspaceRecords(offlineDb.labourWageSettlements, { includeDeleted: true }),
      workspaceRecords(offlineDb.advances),
    ]);
    setLabourers(nextLabourers.sort(compareLabourers));
    setEarnings(nextEarnings);
    setPayments(nextPayments);
    setRates(nextRates.sort(compareWageRates));
    setSettlements(nextSettlements);
    setAdvancesTotal(nextAdvances.filter((record) => isActiveOperationalRecord(record)).reduce((sum, record) => sum + record.amount, 0));
  }, []);

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

  const selectedLabourer = labourId ? labourers.find((labourer) => labourer.id === labourId) ?? null : null;
  const pendingEarnings = earnings.filter((earning) => earning.status === "pending_settlement" && isActiveOperationalRecord(earning));
  const activeRates = rates.filter((rate) => isActiveOperationalRecord(rate) && getWageRateStatus(rate, today()) === "active");
  const recentPayments = payments.filter((payment) => isActiveOperationalRecord(payment)).slice().sort((left, right) => right.date.localeCompare(left.date)).slice(0, 5);
  const recentSettlements = settlements.filter((settlement) => settlement.status === "posted" && isActiveOperationalRecord(settlement)).slice().sort((left, right) => right.settlementDate.localeCompare(left.settlementDate)).slice(0, 5);
  const query = labourId ? `?labourId=${encodeURIComponent(labourId)}` : "";

  return (
    <>
      {selectedLabourer ? (
        <section className="record-panel">
          <div className="labour-selected-card">
            <div>
              <span className="labour-selected-card__eyebrow">Selected labour</span>
              <strong>{selectedLabourer.name}</strong>
              <small>{selectedLabourer.group || "General"}</small>
            </div>
            <button type="button" className="secondary-button" onClick={() => navigate("/workspace/labour-payments/overview")}>Clear selection</button>
          </div>
        </section>
      ) : null}
      <section className="reports-kpis labour-payments-overview-grid">
        <article><span>Outstanding Advances</span><strong>{money(advancesTotal)}</strong></article>
        <article><span>Pending Labour Work</span><strong>{money(pendingEarnings.reduce((sum, earning) => sum + earning.amount, 0))}</strong></article>
        <article><span>Current Wage Rates</span><strong>{activeRates.length}</strong></article>
        <article><span>Upcoming Settlements</span><strong>{recentSettlements.length}</strong></article>
        <article><span>Recent Payments</span><strong>{recentPayments.length}</strong></article>
        <article><span>Recent Settlements</span><strong>{recentSettlements.length}</strong></article>
      </section>
      <section className="record-panel">
        <div className="advances-heading">
          <h2>Quick Actions</h2>
          <span>Open the exact labour-payment workflow you need without leaving Workforce.</span>
        </div>
        <div className="labour-payments-quick-grid">
          {[
            { to: `/workspace/labour-payments/advances${query}`, icon: HandCoins, title: "Record Advance", detail: "Capture labour cash advances and review history." },
            { to: `/workspace/labour-payments/earnings${query}`, icon: ClipboardList, title: "Record Labour Work", detail: "Capture lump sum, task work, bonuses, and adjustments." },
            { to: `/workspace/labour-payments/direct-payments${query}`, icon: CircleDollarSign, title: "Record Payment", detail: "Post direct labour payments and keep their history together." },
            { to: `/workspace/labour-payments/settlements${query}`, icon: ReceiptText, title: "Create Settlement", detail: "Preview and close a wage period with one settlement record." },
          ].map((item) => (
            <button key={item.to} type="button" className="labour-payments-quick-card" onClick={() => navigate(item.to)}>
              <item.icon size={18} />
              <strong>{item.title}</strong>
              <span>{item.detail}</span>
              <small>Open <ArrowRight size={14} /></small>
            </button>
          ))}
        </div>
      </section>
      <section className="record-panel">
        <div className="advances-heading">
          <h2>Recent Activity</h2>
          <span>Keep the latest labour-payment events visible without opening separate modules.</span>
        </div>
        <div className="labour-payments-overview-columns">
          <article>
            <h3>Recent Payments</h3>
            {!recentPayments.length ? <p className="empty-records">No direct labour payments recorded yet.</p> : (
              <div className="record-list">
                {recentPayments.map((payment) => (
                  <article key={payment.id}>
                    <strong>{labourers.find((labourer) => labourer.id === payment.labourerId)?.name ?? payment.labourerId}</strong>
                    <span>{payment.date}</span>
                    <span>{money(payment.amount)}</span>
                  </article>
                ))}
              </div>
            )}
          </article>
          <article>
            <h3>Recent Settlements</h3>
            {!recentSettlements.length ? <p className="empty-records">No wage settlements posted yet.</p> : (
              <div className="record-list">
                {recentSettlements.map((settlement) => (
                  <article key={settlement.id}>
                    <strong>{settlement.settlementNumber}</strong>
                    <span>{settlement.fromDate} - {settlement.toDate}</span>
                    <span>{money(settlement.expenseAmount)}</span>
                  </article>
                ))}
              </div>
            )}
          </article>
        </div>
      </section>
    </>
  );
}

export function DirectLabourPaymentsPage() {
  const { user } = useAuth();
  const workspaceId = user?.workspaceId ?? "";
  const [searchParams] = useSearchParams();
  const selectedLabourId = searchParams.get("labourId") ?? "";
  const activeFarmId = getActiveFarmId();
  const activeSeasonId = getActiveSeasonId();
  const canManage = Boolean(user && workspaceId && canCreate(user, "workforce", workspaceId));

  const [labourers, setLabourers] = useState<Labourer[]>([]);
  const [payments, setPayments] = useState<LabourPayment[]>([]);
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [entryDate, setEntryDate] = useState(today());
  const [entryLabourerId, setEntryLabourerId] = useState(selectedLabourId);
  const [amount, setAmount] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("Cash");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    const [nextLabourers, nextPayments] = await Promise.all([
      workspaceRecords(offlineDb.labourers, { includeDeleted: true }),
      workspaceRecords(offlineDb.labourPayments, { includeDeleted: true }),
    ]);
    setLabourers(nextLabourers.sort(compareLabourers));
    setPayments(nextPayments.sort((left, right) => right.date.localeCompare(left.date) || right.updatedAt.localeCompare(left.updatedAt)));
  }, []);

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
    setEntryLabourerId(selectedLabourId);
  }, [selectedLabourId]);

  const labourById = useMemo(() => new Map(labourers.map((labourer) => [labourer.id, labourer])), [labourers]);
  const filtered = useMemo(() => payments.filter((payment) => {
    const labourer = labourById.get(payment.labourerId);
    const term = search.trim().toLowerCase();
    return isActiveOperationalRecord(payment)
      && payment.date >= from
      && payment.date <= to
      && (!selectedLabourId || payment.labourerId === selectedLabourId)
      && (!term || [labourer?.name, labourer?.group, payment.paymentMethod, payment.notes].join(" ").toLowerCase().includes(term));
  }), [payments, labourById, search, from, to, selectedLabourId]);

  const total = filtered.reduce((sum, payment) => sum + payment.amount, 0);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (!canManage) {
      setError("You have view-only access.");
      return;
    }
    if (!workspaceId || !activeFarmId || !activeSeasonId) {
      setError("Select an active farm and season before recording labour payments.");
      return;
    }
    const numericAmount = Number(amount);
    if (!entryLabourerId || !Number.isFinite(numericAmount) || numericAmount <= 0) {
      setError("Select labour and enter a payment amount greater than zero.");
      return;
    }
    setSaving(true);
    try {
      await persistOperationalRecord("labourPayment", {
        ...makeLocalRecord(),
        workspaceId,
        farmId: activeFarmId,
        seasonId: activeSeasonId,
        labourerId: entryLabourerId,
        date: entryDate,
        amount: numericAmount,
        paymentMethod,
        notes: notes.trim() || undefined,
      });
      setAmount("");
      setNotes("");
      window.dispatchEvent(new CustomEvent("muzare-toast", { detail: "Labour payment recorded." }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to save labour payment.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <section className="record-panel">
        <div className="advances-heading">
          <h2>Record Direct Payment</h2>
          <span>Keep direct labour payouts under Workforce without mixing them into general operational expenses.</span>
        </div>
        <form className="module-form" onSubmit={(event) => void submit(event)}>
          <div className="advances-filter-row">
            <label className="advances-filter-field"><span>Date</span><input required type="date" value={entryDate} onChange={(event) => setEntryDate(event.target.value)} /></label>
            <label className="advances-filter-field advances-filter-field--full"><span>Labour</span><LabourSelectCombobox ariaLabel="Labour" options={labourers} value={entryLabourerId} onChange={setEntryLabourerId} placeholder="Search labour" noResultsLabel="No matching labour found" renderOption={(option) => <div className="labour-combobox__option-content"><div className="labour-combobox__option-content-top"><strong>{option.name}</strong></div><div className="labour-combobox__option-meta"><span>{option.group || "General"}</span>{option.active === false ? <span>Inactive</span> : null}</div></div>} /></label>
          </div>
          <div className="advances-filter-row">
            <label className="advances-filter-field"><span>Amount</span><input required type="number" min="0" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} /></label>
            <label className="advances-filter-field"><span>Payment method</span><select value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value)}><option>Cash</option><option>Bank Transfer</option><option>Other</option></select></label>
            <label className="advances-filter-field advances-filter-field--full"><span>Notes</span><input value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Optional notes" /></label>
          </div>
          {error ? <p className="form-error">{error}</p> : null}
          <button disabled={!canManage || saving} type="submit">{saving ? "Saving..." : "Record payment"}</button>
        </form>
      </section>
      <section className="record-panel">
        <div className="advances-heading">
          <h2>Payment History</h2>
          <span>{filtered.length} payments · {money(total)}</span>
        </div>
        <div className="advances-filter-grid">
          <SearchInput placeholder="Search labour payments" value={search} onChange={setSearch} />
          <label className="advances-filter-field"><span>From</span><input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
          <label className="advances-filter-field"><span>To</span><input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
        </div>
        <div className="reports-kpis">
          <article><span>Total Payments</span><strong>{money(total)}</strong></article>
          <article><span>Transactions</span><strong>{filtered.length}</strong></article>
          <article><span>Labour Paid</span><strong>{new Set(filtered.map((payment) => payment.labourerId)).size}</strong></article>
        </div>
        {!filtered.length ? <p className="empty-records">No direct labour payments match this filter yet.</p> : (
          <div className="attendance-import-table-wrap report-wide-table">
            <table className="report-data-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Labour</th>
                  <th>Method</th>
                  <th>Amount</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((payment) => (
                  <tr key={payment.id}>
                    <td>{payment.date}</td>
                    <td>{labourById.get(payment.labourerId)?.name ?? payment.labourerId}</td>
                    <td>{payment.paymentMethod ?? "-"}</td>
                    <td>{money(payment.amount)}</td>
                    <td>{payment.notes || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function WorkforceReportLinks({ title, description, links }: { title: string; description: string; links: Array<{ to: string; title: string; detail: string; icon: typeof CalendarCheck }> }) {
  const navigate = useNavigate();
  return (
    <section className="record-panel">
      <div className="advances-heading">
        <h2>{title}</h2>
        <span>{description}</span>
      </div>
      <div className="labour-payments-quick-grid">
        {links.map((link) => (
          <button key={link.to} type="button" className="labour-payments-quick-card" onClick={() => navigate(link.to)}>
            <link.icon size={18} />
            <strong>{link.title}</strong>
            <span>{link.detail}</span>
            <small>Open <ArrowRight size={14} /></small>
          </button>
        ))}
      </div>
    </section>
  );
}

export function WorkforceReportsHub() {
  return (
    <WorkforceReportLinks
      title="Workforce Reports"
      description="Open workforce-focused reports without leaving the Workforce module."
      links={[
        { to: "/workspace/reports?report=attendance", title: "Attendance Report", detail: "Attendance register, payable days, and totals.", icon: CalendarCheck },
        { to: "/workspace/reports?report=advances", title: "Advance Report", detail: "Advance summary and log by labour, date, and amount.", icon: HandCoins },
        { to: "/workspace/reports?report=wage-rates", title: "Wage Rate Report", detail: "Current, expired, and upcoming labour wage rates.", icon: WalletCards },
        { to: "/workspace/reports?report=labour-earnings", title: "Labour Work Report", detail: "Pending and settled non-attendance labour earnings.", icon: ClipboardList },
      ]}
    />
  );
}

export function LabourPaymentsReportsHub() {
  return (
    <WorkforceReportLinks
        title="Labour Payments Reports"
        description="Keep labour-payment reporting grouped with advances, labour work, wage rates, settlements, and direct payments."
        links={[
          { to: "/workspace/reports?report=advances", title: "Advance Report", detail: "Track advances, outstanding balances, and recent transactions.", icon: HandCoins },
          { to: "/workspace/reports?report=wage-rates", title: "Wage Rate Report", detail: "Audit active and historical wage-rate assignments.", icon: WalletCards },
          { to: "/workspace/reports?report=labour-earnings", title: "Labour Work Report", detail: "Review pending, settled, and voided labour work entries.", icon: ClipboardList },
          { to: "/workspace/labour-payments/settlements", title: "Settlement Register", detail: "Review the period-level wage settlement register and linked vouchers.", icon: ReceiptText },
        ]}
      />
    );
}
