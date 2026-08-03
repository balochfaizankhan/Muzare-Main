import { useQuery } from "@tanstack/react-query";
import {
  Bell,
  BanknoteArrowDown,
  BookOpenText,
  CalendarRange,
  CircleUserRound,
  ClipboardList,
  ChevronRight,
  ClockAlert,
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
import { HarvestDashboardSection } from "../components/HarvestDashboardSection";
import { calculateScopedCashAccountBalance } from "../lib/accounting";
import { fetchBootstrap } from "../lib/api";
import { dashboardFinancialSnapshotStorageKey, isDashboardFinancialScope, settleDashboardFinancialSnapshot, type DashboardFinancialSnapshot } from "../lib/dashboardFinancialSnapshot";
import { formatDate, formatMoney } from "../lib/format";
import { getActiveLabourWageSettlements } from "../lib/labourWageSettlements";
import { buildReplacedSourceIdSet, selectActiveDedupedAdvances, selectDedupedExpenseVouchers } from "../lib/financialInputs";
import { buildPartnerLiabilityPositions, mergePartnerPositionWithCanonical } from "../lib/partnerAccounting";
import { ensureLocalAccounts, offlineDb, workspaceRecords } from "../lib/offline-db";
import { isActiveOperationalRecord } from "../lib/operationalRecords";
import { hasPermission } from "../lib/permissions";
import { loadWorkspaceVouchers } from "../lib/voucherCollections";
import { useSyncState } from "../hooks/useSyncState";
import { useCanonicalLabourFinancials } from "../hooks/useCanonicalLabourFinancials";
import { formatWorkspaceActivityDateTime, loadWorkspaceActivity, type WorkspaceActivityItem } from "../lib/workspaceActivity";
import { deriveWorkspaceDisplayStatus } from "../lib/workspaceStatus";
import { workspaceBootstrapQueryKey } from "../lib/workspaceBootstrap";
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
  outstandingLabourPayments: number;
  outstandingLabourPaymentsCount: number;
  overdueLabourPaymentsCount: number;
};
type DashboardScope = {
  workspaceId: string;
  farmId: string;
  seasonId: string;
};

const today = () => new Date().toISOString().slice(0, 10);
const moneyWhole = formatMoney;
const dashboardRetryDelay = (attempt: number) => new Promise<void>((resolve) => {
  window.setTimeout(resolve, 400 * 2 ** attempt);
});

export function DashboardPage() {
  const { t } = useTranslation();
  const { user, token } = useAuth();
  const sync = useSyncState();
  const canonicalFinancials = useCanonicalLabourFinancials();
  const [totals, setTotals] = useState<DashboardTotals | null>(null);
  const [financialSnapshot, setFinancialSnapshot] = useState<DashboardFinancialSnapshot | null>(null);
  const [activities, setActivities] = useState<WorkspaceActivityItem[]>([]);
  const [dashboardError, setDashboardError] = useState<string | null>(null);
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
    outstandingLabourPayments: 0,
    outstandingLabourPaymentsCount: 0,
    overdueLabourPaymentsCount: 0,
  };
  const query = useQuery({
    queryKey: workspaceBootstrapQueryKey(user?.workspaceId),
    queryFn: ({ signal }) => fetchBootstrap(token!, signal),
    enabled: Boolean(user && token && user.workspaceId),
    retry: (failureCount) => navigator.onLine && failureCount < 2,
    retryDelay: (attemptIndex) => Math.min(1_000 * 2 ** attemptIndex, 4_000),
    refetchOnReconnect: true,
  });
  const workspaceId = user?.workspaceId ?? "";
  const bootstrapFarmId = query.data?.activeFarmId ?? "";
  const bootstrapSeasonId = query.data?.activeSeasonId ?? "";
  const syncFarmId = sync.farmId ?? "";
  const syncSeasonId = sync.seasonId ?? "";
  const bootstrapContextReady = Boolean(bootstrapFarmId && bootstrapSeasonId);
  const contextReady = Boolean(
    workspaceId
    && syncFarmId
    && syncSeasonId
    && (!bootstrapContextReady || (syncFarmId === bootstrapFarmId && syncSeasonId === bootstrapSeasonId)),
  );
  const [resolvedContext, setResolvedContext] = useState<DashboardScope | null>(null);
  const resolvedContextKeyRef = useRef("");
  useEffect(() => {
    if (!workspaceId) {
      setResolvedContext(null);
      return;
    }
    if (!contextReady) return;
    const nextContext = {
      workspaceId,
      farmId: syncFarmId,
      seasonId: syncSeasonId,
    };
    setResolvedContext((current) => (
      current
      && current.workspaceId === nextContext.workspaceId
      && current.farmId === nextContext.farmId
      && current.seasonId === nextContext.seasonId
    ) ? current : nextContext);
  }, [contextReady, syncFarmId, syncSeasonId, workspaceId]);
  const financialScope = resolvedContext ?? {
    workspaceId: "",
    farmId: "",
    seasonId: "",
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
  useEffect(() => {
    dashboardSnapshotSequence.current += 1;
    setDashboardError(null);
    if (!workspaceId) {
      resolvedContextKeyRef.current = "";
      financialSnapshotRef.current = null;
      setFinancialSnapshot(null);
      setTotals(null);
      setActivities([]);
      setDashboardLoading(false);
      return;
    }
    if (!financialScope.workspaceId || !financialScope.farmId || !financialScope.seasonId) {
      if (!financialSnapshotRef.current && !totals) setDashboardLoading(true);
      return;
    }
    const previousScopeKey = resolvedContextKeyRef.current;
    resolvedContextKeyRef.current = financialScopeKey;
    if (previousScopeKey && previousScopeKey !== financialScopeKey) {
      financialSnapshotRef.current = null;
      setFinancialSnapshot(null);
      setTotals(null);
      setActivities([]);
      setDashboardLoading(true);
    }
  }, [financialScope.farmId, financialScope.seasonId, financialScope.workspaceId, financialScopeKey, totals, workspaceId]);
  const loadLocalDashboard = useCallback(async () => {
    const scope = financialScope;
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
      loadWorkspaceActivity(t, canonicalFinancials.data),
    ]);
    if (requestId !== dashboardSnapshotSequence.current || financialScopeKeyRef.current !== scopeKey) return;
    const activeAttendance = attendance.filter(isActiveOperationalRecord);
    const activeDispatches = dispatches.filter(isActiveOperationalRecord);
    const activeSales = sales.filter(isActiveOperationalRecord);
    const activeVouchers = vouchers;
    const replaced = buildReplacedSourceIdSet(canonicalFinancials.data?.replacedLegacySourceIds);
    const { generalExpenseVouchers, cashAffectingVouchers } = selectDedupedExpenseVouchers(activeVouchers, settlements, replaced);
    const activeEntries = entries.filter(isActiveOperationalRecord);
    const activeAdvances = selectActiveDedupedAdvances(advances, replaced);
    const activeSettlements = getActiveLabourWageSettlements(settlements);
    const activeAccounts = accounts.filter(isActiveOperationalRecord);
    const farmId = scope.farmId || null;
    const seasonId = scope.seasonId || null;
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
        // Falls back to the last reconciled value (not 0) when the canonical read model hasn't
        // loaded yet — e.g. a fresh offline app open — so the Labour Payments Due card never
        // flashes a zero it hasn't actually verified. See settleDashboardFinancialSnapshot.
        outstandingLabourPayments: canonicalFinancials.data?.labourPaymentsDue?.totalOutstanding ?? financialSnapshotRef.current?.outstandingLabourPayments ?? 0,
        outstandingLabourPaymentsCount: canonicalFinancials.data?.labourPaymentsDue?.outstandingCount ?? financialSnapshotRef.current?.outstandingLabourPaymentsCount ?? 0,
        overdueLabourPaymentsCount: canonicalFinancials.data?.labourPaymentsDue?.overdueCount ?? financialSnapshotRef.current?.overdueLabourPaymentsCount ?? 0,
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
      outstandingLabourPayments: settledFinancialSnapshot?.outstandingLabourPayments ?? 0,
      outstandingLabourPaymentsCount: settledFinancialSnapshot?.outstandingLabourPaymentsCount ?? 0,
      overdueLabourPaymentsCount: settledFinancialSnapshot?.overdueLabourPaymentsCount ?? 0,
    });

    setActivities(recentActivities.slice(0, 5));
  }, [canonicalFinancials.data, canonicalFinancials.dataUpdatedAt, financialScope, syncSnapshotLocked, t, totals?.partnerBalance]);
  const retryDashboardLoad = useCallback(() => {
    setDashboardError(null);
    setDashboardLoading(true);
    void query.refetch();
    void canonicalFinancials.refetch();
  }, [canonicalFinancials, query]);
  const scheduleDashboardRefresh = useCallback(() => {
    if (refreshInFlight.current) return;
    if (!workspaceId) {
      setDashboardLoading(false);
      return;
    }
    if (query.isError && !contextReady) {
      setDashboardLoading(false);
      return;
    }
    if (!financialScope.workspaceId || !financialScope.farmId || !financialScope.seasonId) {
      if (!financialSnapshotRef.current && !totals) setDashboardLoading(Boolean(workspaceId));
      return;
    }
    if (contextReady && navigator.onLine && !canonicalFinancials.data && !financialSnapshotRef.current) {
      setDashboardLoading(true);
      return;
    }
    refreshInFlight.current = true;
    if (!financialSnapshotRef.current) setDashboardLoading(true);
    setDashboardError(null);
    markStartup("dashboard-refresh-scheduled", { workspaceId: user?.workspaceId, farmId: sync.farmId, seasonId: sync.seasonId });
    void scheduleBackgroundTask(async () => {
      try {
        let lastError: unknown = null;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            await loadLocalDashboard();
            lastError = null;
            break;
          } catch (error) {
            lastError = error;
            if (attempt === 2 || !navigator.onLine) {
              throw error;
            }
            await dashboardRetryDelay(attempt);
          }
        }
        if (lastError) throw lastError;
        markStartup("dashboard-data-ready", { workspaceId: user?.workspaceId, farmId: sync.farmId, seasonId: sync.seasonId });
      } catch (error) {
        setDashboardError(error instanceof Error ? error.message : t("dashboardPage.dashboardDataLoadFailedForContext"));
        markStartup("dashboard-data-error", { message: error instanceof Error ? error.message : "Unknown dashboard load failure" });
      } finally {
        refreshInFlight.current = false;
        setDashboardLoading(false);
      }
    }, { timeoutMs: 500 });
  }, [canonicalFinancials.data, contextReady, financialScope.farmId, financialScope.seasonId, financialScope.workspaceId, loadLocalDashboard, query, sync.farmId, sync.seasonId, t, totals, user?.workspaceId, workspaceId]);

  useEffect(() => {
    scheduleDashboardRefresh();
    window.addEventListener("muzare-data-refresh", scheduleDashboardRefresh);
    window.addEventListener("online", scheduleDashboardRefresh);
    return () => {
      window.removeEventListener("muzare-data-refresh", scheduleDashboardRefresh);
      window.removeEventListener("online", scheduleDashboardRefresh);
    };
  }, [scheduleDashboardRefresh]);
  useEffect(() => {
    if (!financialScope.workspaceId || !financialScope.farmId || !financialScope.seasonId || sync.startupStage !== "ready") return;
    void canonicalFinancials.refetch();
    scheduleDashboardRefresh();
  }, [canonicalFinancials, financialScope.farmId, financialScope.seasonId, financialScope.workspaceId, scheduleDashboardRefresh, sync.lastSyncTime, sync.startupStage]);

  const workspaceStatus = deriveWorkspaceDisplayStatus({
    t,
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
  const dashboardLoadError = dashboardError ?? (contextReady && canonicalFinancials.isError ? canonicalFinancials.error.message : null);
  const metricsReady = !hydrationPending && !dashboardLoading && Boolean(totals) && Boolean(financialSnapshot || !financialScope.farmId || !financialScope.seasonId);
  const attendanceTodayLabel = hydrationPending || dashboardLoading ? "--" : t("dashboardPage.labourTodayCount", { count: totalsValue.attendanceMarkedToday });
  const dispatchTodayLabel = hydrationPending || dashboardLoading ? "--" : t("dashboardPage.dispatchesTodayCount", { count: totalsValue.dispatchesToday });

  // Labour Payments Due card: has its own snapshot-aware states (skeleton/error/offline) below,
  // rendered separately from the generic summaryCards map so it can show a retry action and an
  // overdue badge without special-casing the shared card loop.
  const labourPaymentsDueHasSnapshot = Boolean(financialSnapshot);
  const labourPaymentsDueSkeleton = !metricsReady && !labourPaymentsDueHasSnapshot;
  const labourPaymentsDueLoadFailed = Boolean(dashboardLoadError) && !labourPaymentsDueHasSnapshot;
  const outstandingLabourPaymentsCount = totalsValue.outstandingLabourPaymentsCount;
  const overdueLabourPaymentsCount = totalsValue.overdueLabourPaymentsCount;
  const labourPaymentsDueSupportingText = outstandingLabourPaymentsCount <= 0
    ? t("dashboard.noOutstandingPayments")
    : overdueLabourPaymentsCount > 0
      ? `${t("dashboard.paymentDue", { count: outstandingLabourPaymentsCount })} · ${t("dashboard.overdue", { count: overdueLabourPaymentsCount })}`
      : t("dashboard.paymentDue", { count: outstandingLabourPaymentsCount });

  const summaryCards = [
    {
      label: t("dashboard.totalExpenses"),
      value: metricsReady ? moneyWhole(totalsValue.totalExpenses) : "—",
      icon: BanknoteArrowDown,
      path: "/workspace/reports?report=expenditures",
      tone: "orange",
      detail: t("dashboardPage.thisSeason"),
      isMoney: true,
    },
    {
      label: t("dashboard.labourAdvances"),
      value: metricsReady ? moneyWhole(totalsValue.labourAdvances) : "—",
      icon: HandCoins,
      path: "/workspace/labour-payments/advances",
      tone: "purple",
      detail: t("dashboardPage.outstandingBalance"),
      isMoney: true,
    },
    {
      label: t("dashboard.dispatchesLabel"),
      value: metricsReady ? String(totalsValue.dispatchesToday) : "—",
      icon: PackageOpen,
      path: "/workspace/dispatch",
      tone: "blue",
      detail: metricsReady ? t("dashboardPage.cartonsTodayCount", { count: totalsValue.cartonsToday }) : (dashboardLoadError ? t("dashboardPage.dispatchLoadFailedRetry") : t("dashboardPage.loadingDispatches")),
      isMoney: false,
    },
  ];

  const quickActions = [
    { to: "/workspace/workforce/labour", icon: UsersRound, title: t("layout.workforce") },
    { to: "/workspace/expenses", icon: ReceiptText, title: t("layout.expenses") },
    { to: "/workspace/dispatch", icon: PackageOpen, title: t("layout.dispatch") },
    { to: "/workspace/partner-ledger", icon: BookOpenText, title: t("partnerLedger") },
    { to: "/workspace/accounts", icon: Wallet, title: t("layout.accounts") },
    { to: "/workspace/reports", icon: ClipboardList, title: t("layout.reports") },
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
              <Link className="dashboard-mobile-header__icon" to="/workspace/reports" aria-label={t("dashboardPage.notificationsAria")}>
                <Bell size={18} />
                {sync.pendingCount > 0 && <span className="dashboard-mobile-header__badge">{sync.pendingCount}</span>}
              </Link>
              <Link className="dashboard-mobile-header__icon" to="/workspace/settings" aria-label={t("dashboardPage.profileAria")}>
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

        {query.isError && user?.workspaceId && !hasOperationalContext && (
          <section className="dashboard-alert-card">
            <div>
              <strong>{t("common.dashboard")}</strong>
              <p>{t("dashboardPage.workspaceContextRefreshFailed")}</p>
            </div>
            <p className="error">{query.error.message}</p>
          </section>
        )}
        {!query.isError && dashboardLoadError && hasOperationalContext && (
          <section className="dashboard-alert-card" role="alert">
            <div>
              <strong>{t("common.dashboard")}</strong>
              <p>{t("dashboardPage.dashboardDataLoadFailedForContext")}</p>
            </div>
            <div className="farm-actions">
              <p className="error">{dashboardLoadError}</p>
              <button className="secondary-button" type="button" onClick={retryDashboardLoad} disabled={dashboardLoading}>
                {t("dashboard.retry")}
              </button>
            </div>
          </section>
        )}
        {!query.isError && !hydrationPending && query.data?.contextWarning && (
          <section className="dashboard-alert-card">
            <p className="context-message">{query.isFetching ? t("dashboardPage.loadingWorkspaceEllipsis") : query.data.contextWarning}</p>
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

        <section className="dashboard-context-grid" aria-label={t("dashboardPage.currentWorkspaceContextAria")}>
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
              <span className="dashboard-hero-card__eyebrow">{t("dashboardPage.todayFarmPulse")}</span>
              <h2>{t("dashboardPage.farmOverview")}</h2>
              <p className="dashboard-hero-card__status-label">{t("dashboardPage.operationsHealth", { status: heroStatus })}</p>
              <span>{heroStatusCopy}</span>
            </div>
            <div className="dashboard-hero-card__stats">
              <article className="dashboard-hero-card__stat">
                <UsersRound size={18} />
                <div>
                  <span>{t("dashboard.attendanceLabel")}</span>
                  <strong>{attendanceTodayLabel}</strong>
                </div>
              </article>
              <article className="dashboard-hero-card__stat">
                <PackageOpen size={18} />
                <div>
                  <span>{t("dashboard.dispatchesLabel")}</span>
                  <strong>{dispatchTodayLabel}</strong>
                </div>
              </article>
            </div>
          </div>
        </section>

        <section className="dashboard-kpi-grid" aria-label={t("dashboardPage.kpiGridAria")}>
          {!hasOperationalContext ? (
            <div className="dashboard-kpi-card dashboard-kpi-card--amber dashboard-kpi-card--disabled" aria-disabled="true">
              <div className="dashboard-kpi-card__icon"><ClockAlert size={18} /></div>
              <span>{t("dashboard.labourPaymentsDue")}</span>
              <strong>{hydrationPending ? "..." : "--"}</strong>
              <small>{hydrationPending ? t("dashboardPage.preparingWorkspaceDataShort") : t("dashboardPage.requiresFarmAndSeason")}</small>
            </div>
          ) : labourPaymentsDueLoadFailed ? (
            <div className="dashboard-kpi-card dashboard-kpi-card--amber dashboard-kpi-card--error" role="alert">
              <div className="dashboard-kpi-card__icon"><ClockAlert size={18} /></div>
              <span>{t("dashboard.labourPaymentsDue")}</span>
              <strong className="dashboard-kpi-card__error-text">{t("dashboard.unableToLoad")}</strong>
              <button type="button" className="dashboard-kpi-card__retry" onClick={retryDashboardLoad} disabled={dashboardLoading}>
                {t("dashboard.retry")}
              </button>
            </div>
          ) : (
            <Link
              className={`dashboard-kpi-card dashboard-kpi-card--amber${overdueLabourPaymentsCount > 0 ? " dashboard-kpi-card--has-overdue" : ""}`}
              to="/workspace/labour-payments/overview"
            >
              <div className="dashboard-kpi-card__header">
                <div className="dashboard-kpi-card__icon"><ClockAlert size={18} /></div>
                {!labourPaymentsDueSkeleton && overdueLabourPaymentsCount > 0 && (
                  <span className="dashboard-kpi-card__overdue-badge">{t("dashboard.overdueBadge")}</span>
                )}
              </div>
              <span>{t("dashboard.labourPaymentsDue")}</span>
              {labourPaymentsDueSkeleton ? (
                <>
                  <span className="dashboard-kpi-card__skeleton dashboard-kpi-card__skeleton--amount" aria-hidden="true" />
                  <span className="dashboard-kpi-card__skeleton dashboard-kpi-card__skeleton--detail" aria-hidden="true" />
                </>
              ) : (
                <>
                  <strong className="bidi-isolate">{moneyWhole(totalsValue.outstandingLabourPayments)}</strong>
                  <small>
                    {labourPaymentsDueSupportingText}
                    {sync.status === "offline" && <span className="dashboard-kpi-card__stale-hint"> · {t("dashboard.offlineLastSynced")}</span>}
                  </small>
                </>
              )}
            </Link>
          )}
          {summaryCards.map(({ label, value, path, icon: Icon, tone, detail, isMoney }) => hasOperationalContext ? (
            <Link className={`dashboard-kpi-card dashboard-kpi-card--${tone}`} to={path} key={label}>
              <div className="dashboard-kpi-card__icon"><Icon size={18} /></div>
              <span>{label}</span>
              <strong className={isMoney ? "bidi-isolate" : undefined}>{value}</strong>
              <small>{detail}</small>
            </Link>
          ) : (
            <div className={`dashboard-kpi-card dashboard-kpi-card--${tone} dashboard-kpi-card--disabled`} key={label} aria-disabled="true">
              <div className="dashboard-kpi-card__icon"><Icon size={18} /></div>
              <span>{label}</span>
              <strong>{hydrationPending ? "..." : "--"}</strong>
              <small>{hydrationPending ? t("dashboardPage.preparingWorkspaceDataShort") : detail}</small>
            </div>
          ))}
        </section>

        <section className="dashboard-quick-section">
          <div className="dashboard-section-heading">
            <h2>{t("dashboardPage.quickActions")}</h2>
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

        <HarvestDashboardSection />

        <section className="dashboard-home__grid">
          <div className="dashboard-home__main">
            <section className="dashboard-activity-card" id="recent-activity">
              <div className="dashboard-section-heading dashboard-section-heading--split">
                <div>
                  <h2>{t("dashboard.recentActivity")}</h2>
                  <p>{dashboardLoading ? t("dashboardPage.loadingActivity") : (activities.length ? t("dashboardPage.recentActivityDescription") : t("dashboardPage.activityWillAppear"))}</p>
                </div>
            <Link className="dashboard-section-link" to="/workspace/activity"><span>{t("dashboardPage.viewAll")}</span><ChevronRight size={14} /></Link>
              </div>
              {dashboardLoading ? (
                <p className="activity-empty">{t("dashboardPage.loadingActivity")}</p>
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
                          <strong className="bidi-isolate">{activity.value}</strong>
                          <small className="bidi-isolate">{formatWorkspaceActivityDateTime(t, activity.createdAt)}</small>
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
