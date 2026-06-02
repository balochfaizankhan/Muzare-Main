import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  BanknoteArrowDown,
  BookOpenText,
  CalendarRange,
  CircleDollarSign,
  CloudUpload,
  Leaf,
  PackageOpen,
  TrendingUp,
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
import { fetchBootstrap } from "../lib/api";
import { formatDate, formatMoney } from "../lib/format";
import { ensureLocalAccounts, offlineDb, workspaceRecords } from "../lib/offline-db";
import { useSyncState } from "../hooks/useSyncState";
import { refreshOperationalData, syncNow } from "../services/syncService";

type DashboardTotals = {
  presentToday: number;
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
};

const manageOperations: Array<{
  labelKey: string;
  path: string;
  icon: LucideIcon;
  detailKey: string;
}> = [
  { labelKey: "layout.attendance", path: "/workspace/attendance", icon: CalendarRange, detailKey: "dashboard.attendanceDetail" },
  { labelKey: "layout.expenses", path: "/workspace/expenses", icon: BanknoteArrowDown, detailKey: "dashboard.expensesDetail" },
  { labelKey: "dashboard.labourAdvances", path: "/workspace/labour-advances", icon: UsersRound, detailKey: "dashboard.advancesDetail" },
  { labelKey: "layout.reports", path: "/workspace/reports", icon: BookOpenText, detailKey: "dashboard.reportsDetail" },
  { labelKey: "dashboard.operationalRecords", path: "/workspace/dispatch", icon: PackageOpen, detailKey: "dashboard.operationalRecordsDetail" },
];

const quickActions = [
  { labelKey: "dashboard.markAttendance", path: "/workspace/attendance", icon: UsersRound },
  { labelKey: "dashboard.newExpense", path: "/workspace/expenses", icon: BanknoteArrowDown },
  { labelKey: "dashboard.giveAdvance", path: "/workspace/labour-advances", icon: Wallet },
  { labelKey: "dashboard.addLabour", path: "/workspace/team", icon: UsersRound },
  { labelKey: "dashboard.viewReports", path: "/workspace/reports", icon: BookOpenText },
] as const;

const today = () => new Date().toISOString().slice(0, 10);
const money = formatMoney;
export function DashboardPage() {
  const { t } = useTranslation();
  const { user, token } = useAuth();
  const sync = useSyncState();
  const [totals, setTotals] = useState<DashboardTotals>({
    presentToday: 0,
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

  const loadLocalDashboard = useCallback(async () => {
    await ensureLocalAccounts();
    const [attendance, dispatches, sales, vouchers, entries, advances, accounts] = await Promise.all([
      workspaceRecords(offlineDb.attendance),
      workspaceRecords(offlineDb.dispatches),
      workspaceRecords(offlineDb.sales),
      workspaceRecords(offlineDb.vouchers, { includeGeneralFarmRecords: true }),
      workspaceRecords(offlineDb.partnerEntries),
      workspaceRecords(offlineDb.advances),
      workspaceRecords(offlineDb.accounts),
    ]);
    const date = today();
    const totalSales = sales.reduce((sum, item) => sum + item.amount, 0);
    const labourAdvances = advances.reduce((sum, item) => sum + item.amount, 0);
    const totalExpenses = vouchers.reduce((sum, item) => sum + item.amount, 0) + labourAdvances;
    const partnerBalance = entries.reduce(
      (sum, item) => sum + (item.type === "contribution" ? item.amount : item.type === "withdrawal" ? -item.amount : 0),
      0,
    );
    setTotals({
      presentToday: attendance.filter((item) => item.date === date && item.status === "present").length,
      cartonsToday: dispatches.filter((item) => item.date === date).reduce((sum, item) => sum + (item.items?.reduce((itemSum, entry) => itemSum + entry.cartons, 0) ?? item.cartons ?? 0), 0),
      totalSales,
      labourAdvances,
      totalExpenses,
      netPosition: calculateAvailableBalance(accounts, sales, vouchers, advances, entries),
      partnerBalance,
    });

    const recent: Activity[] = [
      ...sales.map((item) => ({
        id: item.id,
        path: "/workspace/sales",
        title: t("dashboard.saleRecorded"),
        detail: item.buyerName,
        value: money(item.amount),
        createdAt: item.createdAt,
      })),
      ...vouchers.map((item) => ({
        id: item.id,
        path: "/workspace/expenses",
        title: t("dashboard.expenseVoucher"),
        detail: item.category,
        value: `-${money(item.amount)}`,
        createdAt: item.createdAt,
      })),
      ...dispatches.map((item) => ({
        id: item.id,
        path: "/workspace/dispatch",
        title: t("dashboard.dispatchRecorded"),
        detail: item.vehicleNumber ?? t("dashboard.savedVehicle"),
        value: `${item.items?.reduce((sum, entry) => sum + entry.cartons, 0) ?? item.cartons ?? 0} cartons`,
        createdAt: item.createdAt,
      })),
      ...entries.map((item) => ({
        id: item.id,
        path: "/workspace/partner-ledger",
        title: item.type === "contribution" ? t("dashboard.partnerContribution") : item.type === "withdrawal" ? t("dashboard.partnerWithdrawal") : t("dashboard.partnerSettlement"),
        detail: item.type === "settlement" ? `${item.fromPartner} to ${item.toPartner}` : item.partnerName ?? "-",
        value: `${item.type === "withdrawal" ? "-" : ""}${money(item.amount)}`,
        createdAt: item.createdAt,
      })),
      ...advances.map((item) => ({
        id: item.id,
        path: "/workspace/labour-advances",
        title: t("dashboard.labourAdvancePaid"),
        detail: t("dashboard.cashOutflow"),
        value: `-${money(item.amount)}`,
        createdAt: item.createdAt,
      })),
    ];
    recent.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    setActivities(recent.slice(0, 5));
  }, []);

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
  const StatusIcon = sync.status === "offline" ? WifiOff : Wifi;
  const displayName = user?.displayName || user?.email || t("common.dashboard");

  const summaryCards = [
    { label: t("dashboard.presentToday"), value: String(totals.presentToday), icon: UsersRound, path: "/workspace/attendance", tone: "green" },
    { label: t("dashboard.cartonsToday"), value: String(totals.cartonsToday), icon: PackageOpen, path: "/workspace/dispatch", tone: "navy" },
    { label: t("dashboard.totalSales"), value: money(totals.totalSales), icon: TrendingUp, path: "/workspace/sales", tone: "green" },
    { label: t("dashboard.totalExpenses"), value: money(totals.totalExpenses), icon: BanknoteArrowDown, path: "/workspace/reports?report=combined-expenses", tone: "red" },
    { label: t("dashboard.labourAdvances"), value: money(totals.labourAdvances), icon: UsersRound, path: "/workspace/labour-advances", tone: "red" },
    { label: t("dashboard.availableBalance"), value: money(totals.netPosition), icon: Wallet, path: "/workspace/accounts", tone: "navy" },
    { label: t("dashboard.partnerBalance"), value: money(totals.partnerBalance), icon: CircleDollarSign, path: "/workspace/partner-ledger", tone: "blue" },
  ];

  return (
    <div className="dashboard-page professional-dashboard">
      <main className="dashboard dashboard--wide">
        <section className="dashboard-hero">
          <div className="dashboard-hero__intro">
            <span className="eyebrow">{t("dashboardPage.operationsOverview")}</span>
            <h1>{t("dashboardPage.welcome", { name: displayName })}</h1>
            <p>{formatDate(new Date(), { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</p>
            {user?.workspaceName && <p className="workspace-label">{user.workspaceName}</p>}
          </div>
          <div className="context-actions">
            <Link className="context-chip" to="/workspace/farms">
              <Leaf size={18} />
              <span>{t("currentFarm")}</span>
              <strong>{farm?.name ?? t("noFarm")}</strong>
            </Link>
            <Link className="context-chip" to="/workspace/seasons">
              <CalendarRange size={18} />
              <span>{t("currentSeason")}</span>
              <strong>{season?.name ?? t("noSeason")}</strong>
            </Link>
          </div>
        </section>
        {!season && <p className="context-message">{t("dashboardPage.noActiveSeason")}</p>}

        <section className="panel dashboard-priority-panel">
          <div className="panel-heading">
            <div>
              <h2>{t("dashboardPage.manageOperations")}</h2>
              <p>{t("dashboardPage.coreWorkflows")}</p>
            </div>
          </div>
          <div className="operation-grid">
            {manageOperations.map(({ labelKey, path, detailKey, icon: Icon }) => (
              <Link className="operation-card" key={labelKey} to={path}>
                <Icon size={22} />
                <div>
                  <strong>{t(labelKey)}</strong>
                  <span>{t(detailKey)}</span>
                </div>
                <ArrowRight size={16} />
              </Link>
            ))}
          </div>
        </section>

        <section className="panel quick-panel dashboard-priority-panel">
          <div className="panel-heading">
            <div>
              <h2>{t("dashboardPage.quickActions")}</h2>
              <p>{t("dashboardPage.dailyEntries")}</p>
            </div>
          </div>
          <div className="quick-grid">
            {quickActions.map(({ labelKey, path, icon: Icon }) => (
              <Link className="quick-action" to={path} key={labelKey}>
                <Icon size={19} />
                <span>{t(labelKey)}</span>
                <ArrowRight size={16} />
              </Link>
            ))}
          </div>
        </section>

        <div className="section-title-row">
          <div>
            <h2>{t("dashboardPage.todayAtGlance")}</h2>
            <p>{t("dashboardPage.localFigures")}</p>
          </div>
        </div>
        <section className="summary-grid" aria-label={t("dashboard.operationalSummary")}>
          {summaryCards.map(({ label, value, path, icon: Icon, tone }) => (
            <Link className={`metric-card metric-card--${tone}`} to={path} key={label}>
              <div className="metric-card__icon"><Icon size={20} /></div>
              <span>{label}</span>
              <strong>{value}</strong>
            </Link>
          ))}
        </section>

        <aside className="dashboard-side dashboard-side--wide">
            <section className="panel status-panel">
              <div className="status-line">
                <StatusIcon size={19} />
                <div>
                  <strong>{sync.status === "offline" ? t("layout.workingOffline") : sync.status === "syncing" ? t("layout.syncing") : sync.status === "error" ? t("layout.syncFailed") : t("layout.apiConnected")}</strong>
                  <p>{sync.status === "offline" ? t("layout.offlineNotice") : t("layout.postgresPrimary")}</p>
                </div>
              </div>
              <div className="sync-line">
                <CloudUpload size={18} />
                <div>
                  <strong>{sync.pendingCount ? t("layout.databaseSyncPending") : t("layout.databaseSynced")}</strong>
                  <p>{t("layout.pendingChanges", { count: sync.pendingCount })}</p>
                  <p>{t("layout.lastSuccessfulSync", { value: sync.lastSyncTime ? new Date(sync.lastSyncTime).toLocaleString() : t("layout.notYetSynchronized") })}</p>
                  <div className="sync-buttons"><button type="button" onClick={() => void refreshOperationalData()}>{t("layout.refreshData")}</button><button type="button" onClick={() => void syncNow()}>{t("layout.syncNow")}</button></div>
                </div>
              </div>
            </section>

            <section className="panel activity-panel">
              <div className="panel-heading">
                <div>
                  <h2>{t("dashboard.recentActivity")}</h2>
                  <p>{t("dashboard.entriesMade")}</p>
                </div>
              </div>
              {activities.length === 0 ? (
                <p className="activity-empty">{t("dashboard.noActivity")}</p>
              ) : (
                <div className="activity-list">
                  {activities.map((activity) => (
                    <Link to={activity.path} className="activity-item" key={`${activity.path}-${activity.id}`}>
                      <div>
                        <strong>{activity.title}</strong>
                        <span>{activity.detail}</span>
                      </div>
                      <b>{activity.value}</b>
                    </Link>
                  ))}
                </div>
              )}
            </section>
        </aside>
      </main>
    </div>
  );
}
