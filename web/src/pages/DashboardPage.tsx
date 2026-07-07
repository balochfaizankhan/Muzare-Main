import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
  ShoppingBasket,
  UsersRound,
  Wallet,
  Wifi,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { calculateAvailableBalance } from "../lib/accounting";
import { fetchBootstrap, repairWorkspaceContextRequest } from "../lib/api";
import { getCanonicalExpenseCategory } from "../lib/expenseCategories";
import { formatDate, formatMoney } from "../lib/format";
import { getActiveLabourWageSettlements, getCashAffectingVouchers, outstandingLabourAdvances } from "../lib/labourWageSettlements";
import { buildPartnerLiabilityPositions } from "../lib/partnerAccounting";
import { ensureLocalAccounts, offlineDb, workspaceRecords } from "../lib/offline-db";
import { isActiveOperationalRecord } from "../lib/operationalRecords";
import { hasPermission } from "../lib/permissions";
import { getVisibleVouchers, loadWorkspaceVouchers } from "../lib/voucherCollections";
import { getVoucherDisplayNumber } from "../lib/vouchers";
import { useSyncState } from "../hooks/useSyncState";

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

type Activity = {
  id: string;
  path: string;
  title: string;
  detail: string;
  value: string;
  createdAt: string;
  icon: LucideIcon;
  tone?: "green" | "orange" | "blue" | "purple" | "slate";
};

const today = () => new Date().toISOString().slice(0, 10);
const money = formatMoney;
const moneyWhole = (amount: number) => new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "SAR",
  maximumFractionDigits: 0,
}).format(amount);
const capitalize = (value: string) => value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
const formatActivityDate = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
};
const formatShortRange = (start: string, end: string) => {
  const startDate = new Date(start);
  const endDate = new Date(end);
  const sameYear = startDate.getFullYear() === endDate.getFullYear();
  const shortFormatter = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
  const longFormatter = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
  return sameYear ? `${shortFormatter.format(startDate)} – ${longFormatter.format(endDate)}` : `${longFormatter.format(startDate)} – ${longFormatter.format(endDate)}`;
};

export function DashboardPage() {
  const { t } = useTranslation();
  const { user, token } = useAuth();
  const sync = useSyncState();
  const client = useQueryClient();
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
  const [activities, setActivities] = useState<Activity[]>([]);
  const query = useQuery({
    queryKey: ["bootstrap", user?.workspaceId, sync.farmId, sync.seasonId],
    queryFn: () => fetchBootstrap(token!),
    enabled: Boolean(user && token),
    retry: false,
  });
  const repairContext = useMutation({
    mutationFn: async () => repairWorkspaceContextRequest(token!, user!.workspaceId!),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ["bootstrap", user?.workspaceId] }),
        client.invalidateQueries({ queryKey: ["workspace-farms", user?.workspaceId] }),
      ]);
      window.dispatchEvent(new Event("muzare-farm-changed"));
      window.dispatchEvent(new Event("muzare-season-changed"));
    },
  });

  const loadLocalDashboard = useCallback(async () => {
    await ensureLocalAccounts();
    const [labourers, attendance, dispatches, sales, vouchers, entries, advances, accounts, settlements] = await Promise.all([
      workspaceRecords(offlineDb.labourers),
      workspaceRecords(offlineDb.attendance),
      workspaceRecords(offlineDb.dispatches),
      workspaceRecords(offlineDb.sales),
      loadWorkspaceVouchers({ includeGeneralFarmRecords: true, includeImportedAcrossSeasons: true }),
      workspaceRecords(offlineDb.partnerEntries),
      workspaceRecords(offlineDb.advances),
      workspaceRecords(offlineDb.accounts, { includeImportedAcrossSeasons: true }),
      workspaceRecords(offlineDb.labourWageSettlements),
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
    const activeLabourers = labourers.filter(isActiveOperationalRecord);
    const farmId = sync.farmId ?? null;
    const seasonId = sync.seasonId ?? null;
    const date = today();
    const labourerById = new Map(activeLabourers.map((item) => [item.id, item]));
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

    const recent: Activity[] = [
      ...activeAttendance
        .slice()
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, 2)
          .map((item) => ({
          id: `attendance:${item.id}`,
          path: "/workspace/workforce/attendance",
          title: "Attendance marked",
          detail: `${labourerById.get(item.labourerId)?.name ?? "Labour"} · ${capitalize(item.status)}`,
          value: formatActivityDate(item.date),
          createdAt: item.createdAt,
          icon: UsersRound,
          tone: "green" as const,
        })),
      ...generalExpenseVouchers
        .slice()
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, 1)
        .map((item) => ({
          id: `expense:${item.id}`,
          path: "/workspace/expenses",
          title: "Expense recorded",
          detail: `${getVoucherDisplayNumber(item) || item.voucherNumber} · ${getCanonicalExpenseCategory(item.category)}`,
          value: `-${money(item.amount)}`,
          createdAt: item.createdAt,
          icon: ReceiptText,
          tone: "orange" as const,
        })),
      ...activeAdvances
        .slice()
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, 1)
        .map((item) => ({
          id: `advance:${item.id}`,
          path: "/workspace/labour-advances",
          title: "Labour advance paid",
          detail: `${labourerById.get(item.labourerId)?.name ?? "Labour"}${item.paymentMethod ? ` · ${item.paymentMethod}` : ""}`,
          value: `-${money(item.amount)}`,
          createdAt: item.createdAt,
          icon: HandCoins,
          tone: "purple" as const,
        })),
      ...activeSettlements
        .slice()
        .sort((left, right) => right.settlementDate.localeCompare(left.settlementDate) || right.createdAt.localeCompare(left.createdAt))
        .slice(0, 1)
        .map((item) => ({
          id: `settlement:${item.id}`,
          path: "/workspace/labour-payments/settlements",
          title: "Wage settlement posted",
          detail: formatShortRange(item.fromDate, item.toDate),
          value: money(item.expenseAmount),
          createdAt: item.createdAt,
          icon: ClipboardList,
          tone: "blue" as const,
        })),
      ...activeDispatches
        .slice()
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, 1)
        .map((item) => ({
          id: `dispatch:${item.id}`,
          path: "/workspace/dispatch",
          title: "Dispatch completed",
          detail: item.vehicleNumber ?? item.destination ?? "Dispatch",
          value: `${item.items?.reduce((sum, entry) => sum + entry.cartons, 0) ?? item.cartons ?? 0} cartons`,
          createdAt: item.createdAt,
          icon: PackageOpen,
          tone: "blue" as const,
        })),
      ...activeSales
        .slice()
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, 1)
        .map((item) => ({
          id: `sale:${item.id}`,
          path: "/workspace/sales",
          title: "Sale recorded",
          detail: item.buyerName ?? item.produceType,
          value: money(item.amount),
          createdAt: item.createdAt,
          icon: ShoppingBasket,
          tone: "green" as const,
        })),
    ];
    recent.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    setActivities(recent.slice(0, 5));
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

  const farm = query.data?.farms.find((item) => item.id === query.data.activeFarmId);
  const season = query.data?.seasons.find((item) => item.id === query.data.activeSeasonId);
  const hasFarm = Boolean(farm);
  const hasSeason = Boolean(season);
  const hasOperationalContext = hasFarm && hasSeason;
  const canManageFarms = Boolean(user?.workspaceId && user && hasPermission(user, "MANAGE_FARMS", user.workspaceId));
  const workspaceFarmCount = query.data?.workspaceFarmCount ?? query.data?.farms.length ?? 0;
  const accessibleFarmCount = query.data?.accessibleFarmCount ?? query.data?.farms.length ?? 0;
  const noAccessibleFarms = workspaceFarmCount > 0 && accessibleFarmCount === 0;
  const noWorkspaceFarms = workspaceFarmCount === 0;
  const hasOtherWorkspaces = (user?.memberships.filter((membership) => membership.active).length ?? 0) > 1;
  const StatusIcon = sync.status === "offline" ? WifiOff : Wifi;
  const displayName = user?.displayName || user?.email || t("common.dashboard");
  const selectedFarmLabel = farm?.name ?? t("dashboardPage.noFarmAvailable");
  const selectedSeasonLabel = season?.name ?? (hasFarm ? t("noSeason") : t("dashboardPage.noSeasonUntilFarm"));
  const heroStatus = sync.pendingCount
    ? "Needs attention"
    : !hasFarm || !hasSeason
      ? "Setup required"
      : "Ready";
  const heroStatusCopy = sync.pendingCount
    ? `${sync.pendingCount} record${sync.pendingCount === 1 ? "" : "s"} waiting to sync.`
    : !hasFarm || !hasSeason
      ? "Select a farm and season to unlock the full overview."
      : "Workspace is synced and ready for today.";
  const heroSyncLabel = sync.pendingCount === 0 && sync.status !== "offline"
    ? "Synced"
    : sync.lastSyncTime
      ? `Updated ${new Date(sync.lastSyncTime).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
      : "Updated today";

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
    { to: "/workspace/workforce/attendance", icon: UsersRound, title: "Attendance" },
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
            <span className={`dashboard-home__sync-chip dashboard-home__sync-chip--${sync.status}`}>
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
            <span className={`dashboard-home__sync-chip dashboard-home__sync-chip--${sync.status}`}>
              <StatusIcon size={14} />
              {heroSyncLabel}
            </span>
            <span className="dashboard-home__sync-note">{sync.status === "offline" ? t("layout.workingOffline") : t("layout.synced")}</span>
          </div>
        </section>

        {query.isError && user?.workspaceId && (
          <section className="dashboard-alert-card">
            <div>
              <strong>{t("common.dashboard")}</strong>
              <p>Workspace context needs repair</p>
            </div>
            <p className="error">{query.error.message}</p>
            <div className="farm-actions">
              <button type="button" onClick={() => repairContext.mutate()} disabled={repairContext.isPending}>
                {repairContext.isPending ? "Repairing..." : "Repair workspace context"}
              </button>
            </div>
            {repairContext.data ? <p className="positive">{repairContext.data.message}</p> : null}
            {repairContext.error ? <p className="error">{repairContext.error.message}</p> : null}
          </section>
        )}
        {!query.isError && query.data?.contextWarning && (
          <section className="dashboard-alert-card">
            <p className={query.data.needsRepair ? "error" : "context-message"}>{query.data.contextWarning}</p>
            {user?.workspaceId && (
              <div className="farm-actions">
                {query.data.needsRepair && (
                  <button type="button" onClick={() => repairContext.mutate()} disabled={repairContext.isPending}>
                    {repairContext.isPending ? "Repairing..." : "Repair workspace context"}
                  </button>
                )}
                {!hasFarm && canManageFarms && <Link className="secondary-button" to="/workspace/farms?create=1">{t("dashboardPage.createNewFarm")}</Link>}
                {!hasFarm && canManageFarms && <Link className="secondary-button" to="/workspace/farms?view=history">{t("dashboardPage.restoreSoftDeletedFarm")}</Link>}
              </div>
            )}
            {repairContext.data ? <p className="positive">{repairContext.data.message}</p> : null}
            {repairContext.error ? <p className="error">{repairContext.error.message}</p> : null}
          </section>
        )}
        {!hasFarm && noWorkspaceFarms && <p className="context-message">{canManageFarms
          ? t("dashboardPage.noFarmAvailableMessage")
          : hasOtherWorkspaces
            ? t("dashboardPage.emptyWorkspaceSwitchHint")
            : t("dashboardPage.noFarmVisibleReadOnly")}</p>}
        {!hasFarm && noAccessibleFarms && <p className="context-message">{t("dashboardPage.noAccessibleFarmMessage")}</p>}
        {hasFarm && !hasSeason && <p className="context-message">{t("dashboardPage.noActiveSeason")}</p>}

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
                  <strong>{totals.attendanceMarkedToday} labour today</strong>
                </div>
              </article>
              <article className="dashboard-hero-card__stat">
                <PackageOpen size={18} />
                <div>
                  <span>Dispatches</span>
                  <strong>{totals.dispatchesToday} today</strong>
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
              <strong>--</strong>
              <small>{detail}</small>
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
            <Link className="dashboard-section-link" to="/workspace/reports"><span>View all</span><ChevronRight size={14} /></Link>
              </div>
              {activities.length === 0 ? (
                <p className="activity-empty">{t("dashboard.noActivity")}</p>
              ) : (
                <div className="dashboard-activity-list">
                  {activities.map((activity) => {
                    const Icon = activity.icon;
                    return (
                      <Link to={activity.path} className="dashboard-activity-item" key={activity.id}>
                        <div className={`dashboard-activity-item__icon dashboard-activity-item__icon--${activity.tone ?? "slate"}`}>
                          <Icon size={16} />
                        </div>
                        <div className="dashboard-activity-item__copy">
                          <strong>{activity.title}</strong>
                          <span>{activity.detail}</span>
                        </div>
                        <div className="dashboard-activity-item__meta">
                          <strong>{activity.value}</strong>
                          <small>{activity.createdAt.includes("T") ? new Date(activity.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : formatActivityDate(activity.createdAt)}</small>
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
