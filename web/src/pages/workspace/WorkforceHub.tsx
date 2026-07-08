import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Activity, ArrowLeft, ArrowRight, CalendarCheck, CircleDollarSign, ClipboardList, HandCoins, ReceiptText, WalletCards } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link, NavLink, Outlet, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../../auth/AuthProvider";
import { LabourSelectCombobox } from "../../components/LabourSelectCombobox";
import { SearchInput } from "../../components/SearchInput";
import { SubpageHeader } from "../../components/SubpageHeader";
import { useSyncState } from "../../hooks/useSyncState";
import { formatMoney } from "../../lib/format";
import { getActiveLabourWageSettlements, outstandingLabourAdvances } from "../../lib/labourWageSettlements";
import { canCreate, hasModulePermission } from "../../lib/permissions";
import { getActiveFarmId, getActiveSeasonId, makeLocalRecord, offlineDb, workspaceRecords, type LabourEarning, type LabourPayment, type LabourWageSettlement, type Labourer, type WageRate } from "../../lib/offline-db";
import { isActiveOperationalRecord } from "../../lib/operationalRecords";
import { compareWageRates, getWageRateStatus } from "../../lib/wageRates";
import { sortWorkersForDisplay } from "../../lib/workerEligibility";
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
  subtitle,
  tabs,
  compactMobileHeader = false,
  children,
}: {
  title: string;
  description: string;
  subtitle?: string;
  tabs: Array<{ to: string; label: string }>;
  compactMobileHeader?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const sync = useSyncState();
  const statusText = sync.status === "offline"
    ? t("layout.workingOffline")
    : sync.status === "syncing"
      ? t("layout.syncing")
      : sync.status === "error"
        ? t("layout.syncFailed")
        : sync.pendingCount
          ? t("layout.changesWaiting", { count: sync.pendingCount })
          : t("layout.synced");
  return (
    <div className="dashboard-page">
      {!compactMobileHeader ? <SubpageHeader title={title} /> : null}
      <main className={`subpage module-workspace workforce-shell-main${compactMobileHeader ? " workforce-shell-main--labour-payments" : ""}`}>
        {compactMobileHeader ? (
          <section className="labour-payments-mobile-header" aria-label={`${title} overview`}>
            <Link className="labour-payments-mobile-header__back" to="/workspace/workforce/labour" aria-label="Back to workforce">
              <ArrowLeft size={18} />
            </Link>
            <div className="labour-payments-mobile-header__copy">
              <strong>{title}</strong>
              <p>{subtitle ?? description}</p>
            </div>
            <span className={`labour-payments-mobile-header__status sync-badge sync-badge--${sync.status}`}>{statusText}</span>
          </section>
        ) : (
          <section className="workspace-intro workforce-shell-intro">
            <div>
              <h2>{title}</h2>
              <p>{description}</p>
            </div>
          </section>
        )}
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
        <div className="workforce-shell-content">
          {children}
        </div>
      </main>
    </div>
  );
}

export function WorkforceSectionLayout() {
  return <Outlet />;
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
      { to: `/workspace/labour-payments/earnings${query}`, label: "Work", module: "wages" as const },
      { to: `/workspace/labour-payments/direct-payments${query}`, label: "Payments", module: "workforce" as const },
      { to: `/workspace/labour-payments/settlements${query}`, label: "Settlements", module: "wages" as const },
      { to: `/workspace/labour-payments/reports${query}`, label: "Reports", module: "reports" as const },
    ];
    return allTabs.filter((tab) => !user || hasModulePermission(user, tab.module, "view", workspaceId));
  }, [query, t, user, workspaceId]);
  return (
    <WorkforceShell
      title="Labour Payments"
      description="Keep advances, wage rates, labour work, direct payments, settlements, and payment reports together in one professional labour-payment center."
      subtitle="Advances • Work • Payments • Settlements"
      tabs={tabs}
      compactMobileHeader
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
  const [advancesOutstanding, setAdvancesOutstanding] = useState(0);

  const refresh = useCallback(async () => {
    const [nextLabourers, nextEarnings, nextPayments, nextRates, nextSettlements, nextAdvances] = await Promise.all([
      workspaceRecords(offlineDb.labourers),
      workspaceRecords(offlineDb.labourEarnings, { includeDeleted: true }),
      workspaceRecords(offlineDb.labourPayments, { includeDeleted: true }),
      workspaceRecords(offlineDb.wageRates, { includeDeleted: true }),
      workspaceRecords(offlineDb.labourWageSettlements, { includeDeleted: true }),
      workspaceRecords(offlineDb.advances),
    ]);
    setLabourers(sortWorkersForDisplay(nextLabourers, { includeArchived: false }));
    setEarnings(nextEarnings);
    setPayments(nextPayments);
    setRates(nextRates.sort(compareWageRates));
    setSettlements(nextSettlements);
    setAdvancesOutstanding(
      outstandingLabourAdvances(
        nextAdvances.filter((record) => isActiveOperationalRecord(record)),
        getActiveLabourWageSettlements(nextSettlements),
      ),
    );
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
  const latestSettlement = recentSettlements[0] ?? null;
  const recentActivity = useMemo(() => [
    ...recentSettlements.map((settlement) => ({
      id: `settlement:${settlement.id}`,
      type: "settlement" as const,
      title: `Wage Settlement ${settlement.settlementNumber}`,
      detail: `${settlement.fromDate} - ${settlement.toDate}`,
      amount: settlement.expenseAmount,
      date: settlement.settlementDate,
    })),
    ...recentPayments.map((payment) => ({
      id: `payment:${payment.id}`,
      type: "payment" as const,
      title: labourers.find((labourer) => labourer.id === payment.labourerId)?.name ?? "Direct Labour Payment",
      detail: payment.paymentMethod ?? "Payment",
      amount: payment.amount,
      date: payment.date,
    })),
  ].sort((left, right) => right.date.localeCompare(left.date)).slice(0, 6), [labourers, recentPayments, recentSettlements]);

  return (
    <>
      {selectedLabourer ? (
        <section className="record-panel labour-payments-selected-panel">
          <div className="labour-selected-card labour-payments-selected-card">
            <div>
              <span className="labour-selected-card__eyebrow">Selected labour</span>
              <strong>{selectedLabourer.name}</strong>
              <small>{selectedLabourer.group || "General"}</small>
            </div>
            <button type="button" className="secondary-button" onClick={() => navigate("/workspace/labour-payments/overview")}>Clear selection</button>
          </div>
        </section>
      ) : null}
      <section className="labour-payments-hero-card">
        <div className="labour-payments-hero-card__header">
          <div>
            <span>Labour Balance</span>
            <strong>{money(advancesOutstanding)}</strong>
            <small>Outstanding Advances</small>
          </div>
          <div className="labour-payments-hero-card__icon">
            <WalletCards size={22} />
          </div>
        </div>
        <div className="labour-payments-hero-card__metrics">
          <article>
            <Activity size={15} />
            <span>Pending Labour Work</span>
            <strong>{money(pendingEarnings.reduce((sum, earning) => sum + earning.amount, 0))}</strong>
          </article>
          <article>
            <ReceiptText size={15} />
            <span>Upcoming Settlements</span>
            <strong>{recentSettlements.length}</strong>
          </article>
          <article>
            <CalendarCheck size={15} />
            <span>Last Settlement</span>
            <strong>{latestSettlement ? money(latestSettlement.expenseAmount) : "-"}</strong>
          </article>
          <article>
            <ClipboardList size={15} />
            <span>Current Wage Rates</span>
            <strong>{activeRates.length}</strong>
          </article>
        </div>
        <button type="button" className="labour-payments-hero-card__link" onClick={() => navigate(`/workspace/labour-payments/wage-rates${query}`)}>
          Manage wage rates <ArrowRight size={14} />
        </button>
      </section>
      <section className="record-panel labour-payments-section-card">
        <div className="advances-heading labour-payments-section-heading">
          <h2>Quick Actions</h2>
          <span>Start a labour-payment workflow fast.</span>
        </div>
        <div className="labour-payments-quick-grid">
          {[
            { to: `/workspace/labour-payments/advances${query}`, icon: HandCoins, title: "Record Advance", detail: "Cash advance" },
            { to: `/workspace/labour-payments/earnings${query}`, icon: ClipboardList, title: "Record Labour Work", detail: "Task, bonus, or adjustment" },
            { to: `/workspace/labour-payments/direct-payments${query}`, icon: CircleDollarSign, title: "Record Payment", detail: "Direct labour payout" },
            { to: `/workspace/labour-payments/settlements${query}`, icon: ReceiptText, title: "Create Settlement", detail: "Close a wage period" },
          ].map((item) => (
            <button key={item.to} type="button" className="labour-payments-quick-card" onClick={() => navigate(item.to)}>
              <item.icon size={18} />
              <strong>{item.title}</strong>
              <span>{item.detail}</span>
            </button>
          ))}
        </div>
      </section>
      <section className="reports-kpis labour-payments-kpis-grid">
        <article><Activity size={16} /><span>Total Direct Payments</span><strong>{money(recentPayments.reduce((sum, payment) => sum + payment.amount, 0))}</strong><small>{recentPayments.length} recent records</small></article>
        <article><HandCoins size={16} /><span>Selected Labour</span><strong>{selectedLabourer ? selectedLabourer.name : "All labour"}</strong><small>{selectedLabourer?.group || "Workspace view"}</small></article>
        <article><WalletCards size={16} /><span>Rate Coverage</span><strong>{activeRates.length}</strong><small>Active rate records</small></article>
        <article><ReceiptText size={16} /><span>Settlement Register</span><strong>{recentSettlements.length}</strong><small>Latest posted periods</small></article>
      </section>
      <section className="record-panel labour-payments-section-card">
        <div className="advances-heading labour-payments-section-heading">
          <h2>Recent Activity</h2>
          <span>{recentActivity.length ? "Payments and settlements in one feed." : "Activity will appear here as soon as you post records."}</span>
        </div>
        {!recentActivity.length ? <p className="labour-payments-inline-empty">No activity yet.</p> : (
          <div className="labour-payments-activity-list">
            {recentActivity.map((item) => (
              <article key={item.id} className="labour-payments-activity-item">
                <div className={`labour-payments-activity-item__icon labour-payments-activity-item__icon--${item.type}`}>
                  {item.type === "settlement" ? <ReceiptText size={15} /> : <CircleDollarSign size={15} />}
                </div>
                <div className="labour-payments-activity-item__copy">
                  <strong>{item.title}</strong>
                  <span>{item.detail}</span>
                </div>
                <div className="labour-payments-activity-item__meta">
                  <small>{item.date}</small>
                  <strong>{money(item.amount)}</strong>
                </div>
              </article>
            ))}
          </div>
        )}
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
    setLabourers(sortWorkersForDisplay(nextLabourers, { includeArchived: false }));
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
