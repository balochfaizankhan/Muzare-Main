import { useQuery } from "@tanstack/react-query";
import {
  Bell,
  BanknoteArrowDown,
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
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { calculateAvailableBalance } from "../lib/accounting";
import { fetchBootstrap } from "../lib/api";
import { formatDate } from "../lib/format";
import { getActiveLabourWageSettlements, getCashAffectingVouchers, outstandingLabourAdvances } from "../lib/labourWageSettlements";
import { buildPartnerLiabilityPositions } from "../lib/partnerAccounting";
import { ensureLocalAccounts, offlineDb, workspaceRecords } from "../lib/offline-db";
import { isActiveOperationalRecord } from "../lib/operationalRecords";
import { hasPermission } from "../lib/permissions";
import { getVisibleVouchers, loadWorkspaceVouchers } from "../lib/voucherCollections";
import { useSyncState } from "../hooks/useSyncState";
import { formatWorkspaceActivityDateTime, loadWorkspaceActivity, type WorkspaceActivityItem } from "../lib/workspaceActivity";
import { deriveWorkspaceDisplayStatus } from "../lib/workspaceStatus";

type DashboardTotals = {
  presentToday: number;
  attendanceMarkedToday: number;
  dispatchesToday: number;
  cartonsToday: number;
  totalSales: number;
  labourAdvances: number;
  totalExpenses: number;
  netPosition: number;
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
  const [totals, setTotals] = useState<DashboardTotals>({
    presentToday: 0,
    attendanceMarkedToday: 0,
    dispatchesToday: 0,
    cartonsToday: 0,
    totalSales: 0,
    labourAdvances: 0,
    totalExpenses: 0,
    netPosition: 0,
    partnerBalance: 0,
  });
  const [activities, setActivities] = useState<WorkspaceActivityItem[]>([]);
  const query = useQuery({
    queryKey: ["bootstrap", user?.workspaceId, sync.farmId, sync.seasonId],
    queryFn: () => fetchBootstrap(token!),
    enabled: Boolean(user && token),
    retry: false,
  });
  const loadLocalDashboard = useCallback(async () => {
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
      loadWorkspaceActivity(),
    ]);
    const activeAttendance = attendance.filter(isActiveOperationalRecord);
    const activeDispatches = dispatches.filter(isActiveOperationalRecord);
    const activeSales = sales.filter(isActiveOperationalRecord);
    const activeVouchers = vouchers;
    const generalExpenseVouchers = getVisibleVouchers(activeVouchers, { visibility: "general-expenses" });
    const cashAffectingVouchers = getCashAffectingVouchers(activeVouchers);
    const activeEntries = entries.filter(isActiveOperationalRecord);
    const activeAdvances = advances.filter(isActiveOperationalRecord);
    const activeSettlements = getActiveLabourWageSettlements(settlements);
    const activeAccounts = accounts.filter(isActiveOperationalRecord);
    const farmId = sync.farmId ?? null;
    const seasonId = sync.seasonId ?? null;
    const date = today();
    const totalSales = activeSales.reduce((sum, item) => sum + item.amount, 0);
    const labourAdvances = outstandingLabourAdvances(activeAdvances, activeSettlements, { farmId, seasonId });
    const totalExpenses = generalExpenseVouchers.reduce((sum, item) => sum + item.amount, 0);
    const partnerBalance = buildPartnerLiabilityPositions(activeAccounts, cashAffectingVouchers, activeAdvances, activeEntries, activeSales, activeSettlements, { farmId, seasonId })
      .reduce((sum, item) => sum + item.currentPartnerBalance, 0);
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
      labourAdvances,
      totalExpenses,
      netPosition: calculateAvailableBalance(activeAccounts, activeSales, cashAffectingVouchers, activeAdvances, activeEntries, activeSettlements),
      partnerBalance,
    });

    setActivities(recentActivities.slice(0, 5));
  }, [sync.farmId, sync.seasonId, t]);

  useEffect(() => {
    void loadLocalDashboard();
    window.addEventListener("muzare-data-refresh", loadLocalDashboard);
    window.addEventListener("muzare-local-data-change", loadLocalDashboard);
    return () => {
      window.removeEventListener("muzare-data-refresh", loadLocalDashboard);
      window.removeEventListener("muzare-local-data-change", loadLocalDashboard);
    };
  }, [loadLocalDashboard]);

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
  const attendanceTodayLabel = hydrationPending ? "--" : `${totals.attendanceMarkedToday} labour today`;
  const dispatchTodayLabel = hydrationPending ? "--" : `${totals.dispatchesToday} today`;

  const summaryCards = [
    {
      label: "Cash Balance",
      value: moneyWhole(totals.netPosition),
      icon: Wallet,
      path: "/workspace/accounts",
      tone: totals.netPosition >= 0 ? "green" : "orange",
      detail: hasOperationalContext ? "Available cash position" : "Requires a farm and season",
    },
    {
      label: "Total Expenses",
      value: moneyWhole(totals.totalExpenses),
      icon: BanknoteArrowDown,
      path: "/workspace/reports?report=expenditures",
      tone: "orange",
      detail: "This season",
    },
    {
      label: "Labour Advances",
      value: moneyWhole(totals.labourAdvances),
      icon: HandCoins,
      path: "/workspace/labour-payments/advances",
      tone: "purple",
      detail: "Outstanding balance",
    },
    {
      label: "Dispatches",
      value: String(totals.dispatchesToday),
      icon: PackageOpen,
      path: "/workspace/dispatch",
      tone: "blue",
      detail: `${totals.cartonsToday} cartons today`,
    },
  ];

  const quickActions = [
    { to: "/workspace/workforce/labour", icon: UsersRound, title: "Workforce" },
    { to: "/workspace/labour-payments/advances", icon: HandCoins, title: "Advances" },
    { to: "/workspace/expenses", icon: ReceiptText, title: "Expenses" },
    { to: "/workspace/dispatch", icon: PackageOpen, title: "Dispatch" },
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
                  <p>{activities.length ? "Recent operational records from the current workspace." : "Activity will appear here as soon as records are saved."}</p>
                </div>
            <Link className="dashboard-section-link" to="/workspace/activity"><span>View all</span><ChevronRight size={14} /></Link>
              </div>
              {activities.length === 0 ? (
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
