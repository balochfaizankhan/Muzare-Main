import { useQuery } from "@tanstack/react-query";
import {
  Bell,
  BanknoteArrowDown,
  BookOpenText,
  CalendarRange,
  CircleUserRound,
  ClipboardList,
  ChevronRight,
  HandCoins,
  Leaf,
  ReceiptText,
  PackageOpen,
  UsersRound,
  Wallet,
  Wifi,
  WifiOff,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { calculateScopedCashAccountBalance } from "../lib/accounting";
import { fetchBootstrap } from "../lib/api";
import { dashboardFinancialSnapshotStorageKey, isDashboardFinancialScope, settleDashboardFinancialSnapshot, type DashboardFinancialSnapshot } from "../lib/dashboardFinancialSnapshot";
import { formatDate } from "../lib/format";
import { getActiveLabourWageSettlements, getCashAffectingVouchers, getGeneralExpenseVouchers } from "../lib/labourWageSettlements";
import { buildPartnerLiabilityPositions, mergePartnerPositionWithCanonical } from "../lib/partnerAccounting";
import { ensureLocalAccounts, offlineDb, workspaceRecords } from "../lib/offline-db";
import { isActiveOperationalRecord } from "../lib/operationalRecords";
import { hasPermission } from "../lib/permissions";
import { loadWorkspaceVouchers } from "../lib/voucherCollections";
import { useSyncState } from "../hooks/useSyncState";
import { useCanonicalLabourFinancials } from "../hooks/useCanonicalLabourFinancials";
import { formatWorkspaceActivityDateTime, loadWorkspaceActivity, type WorkspaceActivityItem } from "../lib/workspaceActivity";
import { deriveWorkspaceDisplayStatus } from "../lib/workspaceStatus";
import { markStartup, scheduleBackgroundTask } from "../lib/startupPerf";

type DashboardTotals = {
  presentToday: number;
  attendanceMarkedToday: number;
  dispatchesToday: number;
  cartonsToday: number;
  totalSales: number;
  labourAdvances: number;
  totalExpenses: number;
  cashBalance: number;
  partnerBalance: number;
};

const today = () => new Date().toISOString().slice(0, 10);
const moneyWhole = (amount: number) => new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "SAR",
  maximumFractionDigits: 0,
}).format(amount);

export function DashboardPage() {
  const { t } = useTranslation();
  const { user, token } = useAuth();
  const sync = useSyncState();
  const canonicalFinancials = useCanonicalLabourFinancials();
  const [totals, setTotals] = useState<DashboardTotals | null>(null);
  const [financialSnapshot, setFinancialSnapshot] = useState<DashboardFinancialSnapshot | null>(null);
  const [activities, setActivities] = useState<WorkspaceActivityItem[]>([]);
  const refreshInFlight = useRef(false);
  const financialSnapshotRef = useRef<DashboardFinancialSnapshot | null>(null);
  const financialScopeKeyRef = useRef("");
  const dashboardSnapshotSequence = useRef(0);
  const [dashboardLoading, setDashboardLoading] = useState(true);
  const fallbackTotals: DashboardTotals = {
    presentToday: 0,
    attendanceMarkedToday: 0,
    dispatchesToday: 0,
    cartonsToday: 0,
    totalSales: 0,
    labourAdvances: 0,
    totalExpenses: 0,
    cashBalance: 0,
    partnerBalance: 0,
  };
  const query = useQuery({
    queryKey: ["bootstrap", user?.workspaceId, sync.farmId, sync.seasonId],
    queryFn: () => fetchBootstrap(token!),
    enabled: Boolean(user && token),
    retry: false,
  });
  const financialScope = {
    workspaceId: user?.workspaceId ?? "",
    farmId: sync.farmId ?? "",
    seasonId: sync.seasonId ?? "",
  };
  const financialScopeKey = `${financialScope.workspaceId}:${financialScope.farmId}:${financialScope.seasonId}`;
  const syncSnapshotLocked = ["syncing", "pending", "stale_context"].includes(sync.status);
  useEffect(() => {
    financialScopeKeyRef.current = financialScopeKey;
    if (!financialScope.workspaceId || !financialScope.farmId || !financialScope.seasonId) {
      financialSnapshotRef.current = null;
      setFinancialSnapshot(null);
      return;
    }
    const cached = localStorage.getItem(dashboardFinancialSnapshotStorageKey(financialScope));
    if (!cached) {
      financialSnapshotRef.current = null;
      setFinancialSnapshot(null);
      return;
    }
    try {
      const parsed = JSON.parse(cached) as DashboardFinancialSnapshot;
      if (!isDashboardFinancialScope(parsed, financialScope)) {
        financialSnapshotRef.current = null;
        setFinancialSnapshot(null);
        return;
      }
      financialSnapshotRef.current = parsed;
      setFinancialSnapshot(parsed);
    } catch {
      localStorage.removeItem(dashboardFinancialSnapshotStorageKey(financialScope));
      financialSnapshotRef.current = null;
      setFinancialSnapshot(null);
    }
  }, [financialScope.farmId, financialScope.seasonId, financialScope.workspaceId, financialScopeKey]);
  const loadLocalDashboard = useCallback(async () => {
    const scope = {
      workspaceId: user?.workspaceId ?? "",
      farmId: sync.farmId ?? "",
      seasonId: sync.seasonId ?? "",
    };
    const scopeKey = `${scope.workspaceId}:${scope.farmId}:${scope.seasonId}`;
    const requestId = ++dashboardSnapshotSequence.current;
    const hasScope = Boolean(scope.workspaceId && scope.farmId && scope.seasonId);
    const canonicalReady = !hasScope || !navigator.onLine || Boolean(canonicalFinancials.data);
    await ensureLocalAccounts();
    const [attendance, dispatches, sales, vouchers, entries, advances, accounts, settlements, recentActivities] = await Promise.all([
      workspaceRecords(offlineDb.attendance),
      workspaceRecords(offlineDb.dispatches),
      workspaceRecords(offlineDb.sales),
      loadWorkspaceVouchers({ includeGeneralFarmRecords: true, includeImportedAcrossSeasons: true }),
      workspaceRecords(offlineDb.partnerEntries),
      workspaceRecords(offlineDb.advances),
      workspaceRecords(offlineDb.accounts, { includeImportedAcrossSeasons: true }),
      workspaceRecords(offlineDb.labourWageSettlements),
      loadWorkspaceActivity(canonicalFinancials.data),
    ]);
    if (requestId !== dashboardSnapshotSequence.current || financialScopeKeyRef.current !== scopeKey) return;
    const activeAttendance = attendance.filter(isActiveOperationalRecord);
    const activeDispatches = dispatches.filter(isActiveOperationalRecord);
    const activeSales = sales.filter(isActiveOperationalRecord);
    const activeVouchers = vouchers;
    const replaced = new Set(canonicalFinancials.data?.replacedLegacySourceIds ?? []);
    const legacyOnlyVouchers = activeVouchers.filter((item) => !replaced.has(item.id));
    const generalExpenseVouchers = getGeneralExpenseVouchers(legacyOnlyVouchers, settlements);
    const cashAffectingVouchers = getCashAffectingVouchers(legacyOnlyVouchers, settlements);
    const activeEntries = entries.filter(isActiveOperationalRecord);
    const activeAdvances = advances.filter((item) => isActiveOperationalRecord(item) && !replaced.has(item.id));
    const activeSettlements = getActiveLabourWageSettlements(settlements);
    const activeAccounts = accounts.filter(isActiveOperationalRecord);
    const farmId = sync.farmId ?? null;
    const seasonId = sync.seasonId ?? null;
    const date = today();
    const totalSales = activeSales.reduce((sum, item) => sum + item.amount, 0);
    const nextFinancialSnapshot = syncSnapshotLocked
      ? financialSnapshotRef.current
      : settleDashboardFinancialSnapshot({
      scope,
      previousSnapshot: financialSnapshotRef.current,
      canonicalReady,
      generatedAt: new Date().toISOString(),
      canonicalVersion: String(canonicalFinancials.dataUpdatedAt ?? "offline"),
      financials: {
        cashBalance: calculateScopedCashAccountBalance(
          activeAccounts,
          activeSales,
          cashAffectingVouchers,
          activeAdvances,
          activeEntries,
          activeSettlements,
          canonicalFinancials.data?.accountEntries ?? [],
          { farmId, seasonId },
        ),
        totalExpenses: generalExpenseVouchers.reduce((sum, item) => sum + item.amount, 0) + (canonicalFinancials.data?.summary.wageExpense ?? 0),
        outstandingLabourAdvances: canonicalFinancials.data?.summary.outstandingAdvance ?? 0,
        inputVersion: `${activeAccounts.length}:${activeSales.length}:${generalExpenseVouchers.length}:${activeAdvances.length}:${activeEntries.length}:${activeSettlements.length}`,
      },
    });
    if (nextFinancialSnapshot && canonicalReady && isDashboardFinancialScope(nextFinancialSnapshot, scope)) {
      financialSnapshotRef.current = nextFinancialSnapshot;
      setFinancialSnapshot(nextFinancialSnapshot);
      localStorage.setItem(dashboardFinancialSnapshotStorageKey(scope), JSON.stringify(nextFinancialSnapshot));
    }
    const settledFinancialSnapshot = nextFinancialSnapshot ?? financialSnapshotRef.current;
    const partnerBalance = canonicalReady
      ? buildPartnerLiabilityPositions(activeAccounts, cashAffectingVouchers, activeAdvances, activeEntries, activeSales, activeSettlements, { farmId, seasonId })
        .map((item) => mergePartnerPositionWithCanonical(
          item,
          item.account?.id
            ? canonicalFinancials.data?.partnerPositions.find((position) => position.accountId === item.account!.id)
            : undefined,
        ))
        .reduce((sum, item) => sum + item.currentPartnerBalance, 0)
        + (canonicalFinancials.data?.partnerPositions ?? [])
          .filter((position) => !activeAccounts.some((account) => account.id === position.accountId))
          .reduce((sum, item) => sum + item.farmOwesPartner, 0)
      : (totals?.partnerBalance ?? 0);
    const attendanceMarkedToday = activeAttendance.filter((item) => item.date === date).length;
    const presentToday = activeAttendance.filter((item) => item.date === date && item.status === "present").length;
    const dispatchesToday = activeDispatches.filter((item) => item.date === date).length;
    const cartonsToday = activeDispatches.filter((item) => item.date === date).reduce((sum, item) => sum + (item.items?.reduce((itemSum, entry) => itemSum + entry.cartons, 0) ?? item.cartons ?? 0), 0);
    setTotals({
      presentToday,
      attendanceMarkedToday,
      dispatchesToday,
      cartonsToday,
      totalSales,
      labourAdvances: settledFinancialSnapshot?.outstandingLabourAdvances ?? 0,
      totalExpenses: settledFinancialSnapshot?.totalExpenses ?? 0,
      cashBalance: settledFinancialSnapshot?.cashBalance ?? 0,
      partnerBalance,
    });

    setActivities(recentActivities.slice(0, 5));
  }, [canonicalFinancials.data, canonicalFinancials.dataUpdatedAt, sync.farmId, sync.seasonId, syncSnapshotLocked, t, totals?.partnerBalance, user?.workspaceId]);
  const scheduleDashboardRefresh = useCallback(() => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    if (!financialSnapshotRef.current) setDashboardLoading(true);
    markStartup("dashboard-refresh-scheduled", { workspaceId: user?.workspaceId, farmId: sync.farmId, seasonId: sync.seasonId });
    void scheduleBackgroundTask(async () => {
      try {
        await loadLocalDashboard();
        markStartup("dashboard-data-ready", { workspaceId: user?.workspaceId, farmId: sync.farmId, seasonId: sync.seasonId });
      } catch (error) {
        markStartup("dashboard-data-error", { message: error instanceof Error ? error.message : "Unknown dashboard load failure" });
      } finally {
        refreshInFlight.current = false;
        setDashboardLoading(false);
      }
    }, { timeoutMs: 500 });
  }, [loadLocalDashboard, sync.farmId, sync.seasonId, user?.workspaceId]);

  useEffect(() => {
    scheduleDashboardRefresh();
    window.addEventListener("muzare-data-refresh", scheduleDashboardRefresh);
    return () => {
      window.removeEventListener("muzare-data-refresh", scheduleDashboardRefresh);
    };
  }, [scheduleDashboardRefresh]);

  const workspaceStatus = deriveWorkspaceDisplayStatus({
    sync,
    bootstrap: query.data,
    bootstrapLoading: query.isLoading || (!query.data && query.isFetching),
    bootstrapLoaded: query.isSuccess,
    bootstrapErrored: query.isError,
  });
  const hasFarm = workspaceStatus.hasFarm;
  const hasSeason = workspaceStatus.hasSeason;
  const hasOperationalContext = workspaceStatus.hasOperationalContext;
  const hydrationPending = workspaceStatus.hydrationPending;
  const canManageFarms = Boolean(user?.workspaceId && user && hasPermission(user, "MANAGE_FARMS", user.workspaceId));
  const totalsValue = totals ?? fallbackTotals;
  const workspaceFarmCount = query.data?.workspaceFarmCount ?? query.data?.farms.length ?? 0;
  const accessibleFarmCount = query.data?.accessibleFarmCount ?? query.data?.farms.length ?? 0;
  const noAccessibleFarms = workspaceFarmCount > 0 && accessibleFarmCount === 0;
  const noWorkspaceFarms = workspaceFarmCount === 0;
  const hasOtherWorkspaces = (user?.memberships.filter((membership) => membership.active).length ?? 0) > 1;
  const StatusIcon = sync.status === "offline" ? WifiOff : Wifi;
  const displayName = user?.displayName || user?.email || t("common.dashboard");
  const selectedFarmLabel = workspaceStatus.selectedFarmLabel;
  const selectedSeasonLabel = workspaceStatus.selectedSeasonLabel;
  const heroStatus = workspaceStatus.heroStatus;
  const heroStatusCopy = workspaceStatus.heroCopy;
  const heroSyncLabel = workspaceStatus.label;
  const syncNote = workspaceStatus.tone === "offline" ? t("layout.workingOffline") : workspaceStatus.note;
  const metricsReady = !hydrationPending && !dashboardLoading && Boolean(totals) && Boolean(financialSnapshot || !financialScope.farmId || !financialScope.seasonId);
  const attendanceTodayLabel = hydrationPending || dashboardLoading ? "--" : `${totalsValue.attendanceMarkedToday} labour today`;
  const dispatchTodayLabel = hydrationPending || dashboardLoading ? "--" : `${totalsValue.dispatchesToday} today`;

  const summaryCards = [
    {
      label: "Cash Balance",
      value: metricsReady ? moneyWhole(totalsValue.cashBalance) : "—",
      icon: Wallet,
      path: "/workspace/accounts",
      tone: totalsValue.cashBalance >= 0 ? "green" : "orange",
      detail: hasOperationalContext ? (metricsReady ? "Current cash-account balance" : "Updating balance...") : "Requires a farm and season",
    },
    {
      label: "Total Expenses",
      value: metricsReady ? moneyWhole(totalsValue.totalExpenses) : "—",
      icon: BanknoteArrowDown,
      path: "/workspace/reports?report=expenditures",
      tone: "orange",
      detail: "This season",
    },
    {
      label: "Labour Advances",
      value: metricsReady ? moneyWhole(totalsValue.labourAdvances) : "—",
      icon: HandCoins,
      path: "/workspace/labour-payments/advances",
      tone: "purple",
      detail: "Outstanding balance",
    },
    {
      label: "Dispatches",
      value: metricsReady ? String(totalsValue.dispatchesToday) : "—",
      icon: PackageOpen,
      path: "/workspace/dispatch",
      tone: "blue",
      detail: metricsReady ? `${totalsValue.cartonsToday} cartons today` : "Loading today's dispatches",
    },
  ];

  const quickActions = [
    { to: "/workspace/workforce/labour", icon: UsersRound, title: "Workforce" },
    { to: "/workspace/expenses", icon: ReceiptText, title: "Expenses" },
    { to: "/workspace/dispatch", icon: PackageOpen, title: "Dispatch" },
    { to: "/workspace/partner-ledger", icon: BookOpenText, title: "Partner Ledger" },
    { to: "/workspace/accounts", icon: Wallet, title: "Accounts" },
    { to: "/workspace/reports", icon: ClipboardList, title: "Reports" },
  ];

  return (
    <div className="dashboard-page professional-dashboard">
      <main className="dashboard dashboard--wide dashboard-home">
        <section className="dashboard-mobile-header">
          <div className="dashboard-mobile-header__brand">
            <img className="dashboard-mobile-header__logo" src="/assets/muzare-logo.png" alt="Muzare" />
            <div className="dashboard-mobile-header__copy">
              <span>{t("dashboardPage.welcome", { name: displayName })}</span>
              <small>{user?.workspaceName ?? t("layout.workspace")}</small>
            </div>
          </div>
          <div className="dashboard-mobile-header__status">
            <span className={`dashboard-home__sync-chip dashboard-home__sync-chip--${workspaceStatus.tone}`}>
              <StatusIcon size={14} />
              {heroSyncLabel}
            </span>
            <div className="dashboard-mobile-header__actions">
              <Link className="dashboard-mobile-header__icon" to="/workspace/reports" aria-label="Notifications">
                <Bell size={18} />
                {sync.pendingCount > 0 && <span className="dashboard-mobile-header__badge">{sync.pendingCount}</span>}
              </Link>
              <Link className="dashboard-mobile-header__icon" to="/workspace/settings" aria-label="Profile">
                <CircleUserRound size={18} />
              </Link>
            </div>
          </div>
        </section>

        <section className="dashboard-home__meta">
          <div className="dashboard-home__title">
            <span className="eyebrow eyebrow--dark">{t("dashboardPage.operationsOverview")}</span>
            <h1>{t("dashboardPage.welcome", { name: displayName })}</h1>
            <p>{formatDate(new Date(), { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</p>
          </div>
          <div className="dashboard-home__sync">
            <span className={`dashboard-home__sync-chip dashboard-home__sync-chip--${workspaceStatus.tone}`}>
              <StatusIcon size={14} />
              {heroSyncLabel}
            </span>
            <span className="dashboard-home__sync-note">{syncNote}</span>
          </div>
        </section>

        {query.isError && user?.workspaceId && (
          <section className="dashboard-alert-card">
            <div>
              <strong>{t("common.dashboard")}</strong>
              <p>Workspace context could not be refreshed. Please retry.</p>
            </div>
            <p className="error">{query.error.message}</p>
          </section>
        )}
        {!query.isError && !hydrationPending && query.data?.contextWarning && (
          <section className="dashboard-alert-card">
            <p className="context-message">{query.isFetching ? "Loading workspace..." : query.data.contextWarning}</p>
            {user?.workspaceId && (
              <div className="farm-actions">
                {!hasFarm && canManageFarms && <Link className="secondary-button" to="/workspace/farms?create=1">{t("dashboardPage.createNewFarm")}</Link>}
                {!hasFarm && canManageFarms && <Link className="secondary-button" to="/workspace/farms?view=history">{t("dashboardPage.restoreSoftDeletedFarm")}</Link>}
              </div>
            )}
          </section>
        )}
        {!hydrationPending && !hasFarm && noWorkspaceFarms && <p className="context-message">{canManageFarms
          ? t("dashboardPage.noFarmAvailableMessage")
          : hasOtherWorkspaces
            ? t("dashboardPage.emptyWorkspaceSwitchHint")
            : t("dashboardPage.noFarmVisibleReadOnly")}</p>}
        {!hydrationPending && !hasFarm && noAccessibleFarms && <p className="context-message">{t("dashboardPage.noAccessibleFarmMessage")}</p>}
        {!hydrationPending && hasFarm && !hasSeason && <p className="context-message">{t("dashboardPage.noActiveSeason")}</p>}

        <section className="dashboard-context-grid" aria-label="Current workspace context">
          <Link className="dashboard-context-card" to="/workspace/farms">
            <Leaf size={18} />
            <div>
              <span>{t("currentFarm")}</span>
              <strong>{selectedFarmLabel}</strong>
            </div>
            <ChevronRight size={16} />
          </Link>
          <Link className="dashboard-context-card" to="/workspace/seasons">
            <CalendarRange size={18} />
            <div>
              <span>{t("currentSeason")}</span>
              <strong>{selectedSeasonLabel}</strong>
            </div>
            <ChevronRight size={16} />
          </Link>
        </section>

        <section className="dashboard-hero-card">
          <div className="dashboard-hero-card__content">
            <div className="dashboard-hero-card__copy">
              <span className="dashboard-hero-card__eyebrow">Today's Farm Pulse</span>
              <h2>Farm Overview</h2>
              <p className="dashboard-hero-card__status-label">Operations Health: {heroStatus}</p>
              <span>{heroStatusCopy}</span>
            </div>
            <div className="dashboard-hero-card__stats">
              <article className="dashboard-hero-card__stat">
                <UsersRound size={18} />
                <div>
                  <span>Attendance</span>
                  <strong>{attendanceTodayLabel}</strong>
                </div>
              </article>
              <article className="dashboard-hero-card__stat">
                <PackageOpen size={18} />
                <div>
                  <span>Dispatches</span>
                  <strong>{dispatchTodayLabel}</strong>
                </div>
              </article>
            </div>
          </div>
        </section>

        <section className="dashboard-kpi-grid" aria-label="Key performance indicators">
          {summaryCards.map(({ label, value, path, icon: Icon, tone, detail }) => hasOperationalContext ? (
            <Link className={`dashboard-kpi-card dashboard-kpi-card--${tone}`} to={path} key={label}>
              <div className="dashboard-kpi-card__icon"><Icon size={18} /></div>
              <span>{label}</span>
              <strong>{value}</strong>
              <small>{detail}</small>
            </Link>
          ) : (
            <div className={`dashboard-kpi-card dashboard-kpi-card--${tone} dashboard-kpi-card--disabled`} key={label} aria-disabled="true">
              <div className="dashboard-kpi-card__icon"><Icon size={18} /></div>
              <span>{label}</span>
              <strong>{hydrationPending ? "..." : "--"}</strong>
              <small>{hydrationPending ? "Preparing workspace data" : detail}</small>
            </div>
          ))}
        </section>

        <section className="dashboard-quick-section">
          <div className="dashboard-section-heading">
            <h2>Quick Actions</h2>
          </div>
          <div className="dashboard-quick-grid">
            {quickActions.map(({ to, icon: Icon, title }) => (
              <Link key={to} to={to} className="dashboard-quick-card">
                <Icon size={18} />
                <strong>{title}</strong>
              </Link>
            ))}
          </div>
        </section>

        <section className="dashboard-home__grid">
          <div className="dashboard-home__main">
            <section className="dashboard-activity-card" id="recent-activity">
              <div className="dashboard-section-heading dashboard-section-heading--split">
                <div>
                  <h2>{t("dashboard.recentActivity")}</h2>
                  <p>{dashboardLoading ? "Loading recent workspace activity..." : (activities.length ? "Recent operational records from the current workspace." : "Activity will appear here as soon as records are saved.")}</p>
                </div>
            <Link className="dashboard-section-link" to="/workspace/activity"><span>View all</span><ChevronRight size={14} /></Link>
              </div>
              {dashboardLoading ? (
                <p className="activity-empty">Loading activity...</p>
              ) : activities.length === 0 ? (
                <p className="activity-empty">{t("dashboard.noActivity")}</p>
              ) : (
                <div className="dashboard-activity-list">
                  {activities.map((activity) => {
                    const Icon = activity.icon;
                    return (
                      <Link to={activity.path ?? "/workspace/activity"} className="dashboard-activity-item" key={activity.id}>
                        <div className={`dashboard-activity-item__icon dashboard-activity-item__icon--${activity.tone ?? "slate"}`}>
                          <Icon size={16} />
                        </div>
                        <div className="dashboard-activity-item__copy">
                          <strong>{activity.title}</strong>
                          <span>{activity.detail}</span>
                        </div>
                        <div className="dashboard-activity-item__meta">
                          <strong>{activity.value}</strong>
                          <small>{formatWorkspaceActivityDateTime(activity.createdAt)}</small>
                        </div>
                      </Link>
                    );
                  })}
                </div>
              )}
            </section>
          </div>

        </section>
      </main>
    </div>
  );
}
