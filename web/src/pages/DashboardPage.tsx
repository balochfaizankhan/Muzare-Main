import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  BanknoteArrowDown,
  BookOpenText,
  CalendarRange,
  CircleDollarSign,
  CloudUpload,
  Leaf,
  PackageOpen,
  ShoppingBasket,
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
import { ImportVisibilityAuditPanel } from "../components/ImportVisibilityAuditPanel";
import { config } from "../config";
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

const modules: Array<{
  key: string;
  path: string;
  icon: LucideIcon;
  detailKey: string;
}> = [
  { key: "workforce", path: "/workspace/team", icon: UsersRound, detailKey: "dashboard.workforceDetail" },
  { key: "expenses", path: "/workspace/expenses", icon: BanknoteArrowDown, detailKey: "dashboard.expensesDetail" },
  { key: "sales", path: "/workspace/sales", icon: ShoppingBasket, detailKey: "dashboard.salesDetail" },
  { key: "dispatch", path: "/workspace/dispatch", icon: PackageOpen, detailKey: "dashboard.dispatchDetail" },
  { key: "accounts", path: "/workspace/accounts", icon: BookOpenText, detailKey: "dashboard.accountsDetail" },
  { key: "partnerLedger", path: "/workspace/partner-ledger", icon: Leaf, detailKey: "dashboard.partnerLedgerDetail" },
];

const today = () => new Date().toISOString().slice(0, 10);
const money = formatMoney;
export function DashboardPage() {
  const { t } = useTranslation();
  const { user, token } = useAuth();
  const sync = useSyncState();
  const client = useQueryClient();
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
    const [attendance, dispatches, sales, vouchers, entries, advances, accounts, settlements] = await Promise.all([
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
    const date = today();
    const totalSales = activeSales.reduce((sum, item) => sum + item.amount, 0);
    const labourAdvances = outstandingLabourAdvances(activeAdvances, activeSettlements);
    const totalExpenses = generalExpenseVouchers.reduce((sum, item) => sum + item.amount, 0);
    const partnerBalance = buildPartnerLiabilityPositions(activeAccounts, cashAffectingVouchers, activeAdvances, activeEntries, activeSales, activeSettlements)
      .reduce((sum, item) => sum + item.currentPartnerBalance, 0);
    setTotals({
      presentToday: activeAttendance.filter((item) => item.date === date && item.status === "present").length,
      cartonsToday: activeDispatches.filter((item) => item.date === date).reduce((sum, item) => sum + (item.items?.reduce((itemSum, entry) => itemSum + entry.cartons, 0) ?? item.cartons ?? 0), 0),
      totalSales,
      labourAdvances,
      totalExpenses,
      netPosition: calculateAvailableBalance(activeAccounts, activeSales, cashAffectingVouchers, activeAdvances, activeEntries, activeSettlements),
      partnerBalance,
    });

    const recent: Activity[] = [
      ...activeSales.map((item) => ({
        id: item.id,
        path: "/workspace/sales",
        title: t("dashboard.saleRecorded"),
        detail: item.buyerName ?? "-",
        value: money(item.amount),
        createdAt: item.createdAt,
      })),
      ...generalExpenseVouchers.map((item) => ({
        id: item.id,
        path: "/workspace/expenses",
        title: t("dashboard.expenseVoucher"),
        detail: `${getVoucherDisplayNumber(item) || item.voucherNumber} · ${getCanonicalExpenseCategory(item.category)}`,
        value: `-${money(item.amount)}`,
        createdAt: item.createdAt,
      })),
      ...activeDispatches.map((item) => ({
        id: item.id,
        path: "/workspace/dispatch",
        title: t("dashboard.dispatchRecorded"),
        detail: item.vehicleNumber ?? t("dashboard.savedVehicle"),
        value: `${item.items?.reduce((sum, entry) => sum + entry.cartons, 0) ?? item.cartons ?? 0} cartons`,
        createdAt: item.createdAt,
      })),
      ...activeEntries.map((item) => ({
        id: item.id,
        path: "/workspace/partner-ledger",
        title: item.type === "contribution" ? t("dashboard.partnerContribution") : item.type === "withdrawal" ? t("dashboard.partnerWithdrawal") : t("dashboard.partnerSettlement"),
        detail: item.type === "settlement" ? `${item.fromPartner} to ${item.toPartner}` : item.partnerName ?? "-",
        value: `${item.type === "withdrawal" ? "-" : ""}${money(item.amount)}`,
        createdAt: item.createdAt,
      })),
      ...activeAdvances.map((item) => ({
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

  const summaryCards = [
    { label: t("dashboard.presentToday"), value: String(totals.presentToday), icon: UsersRound, path: "/workspace/attendance", tone: "green" },
    { label: t("dashboard.cartonsToday"), value: String(totals.cartonsToday), icon: PackageOpen, path: "/workspace/dispatch", tone: "navy" },
    { label: t("dashboard.totalSales"), value: money(totals.totalSales), icon: TrendingUp, path: "/workspace/sales", tone: "green" },
    { label: t("dashboard.totalExpenses"), value: money(totals.totalExpenses), icon: BanknoteArrowDown, path: "/workspace/reports?report=expenditures", tone: "red" },
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
              <strong>{farm?.name ?? t("dashboardPage.noFarmAvailable")}</strong>
            </Link>
            <Link className="context-chip" to="/workspace/seasons">
              <CalendarRange size={18} />
              <span>{t("currentSeason")}</span>
              <strong>{season?.name ?? (hasFarm ? t("noSeason") : t("dashboardPage.noSeasonUntilFarm"))}</strong>
            </Link>
          </div>
        </section>
        {query.isError && user?.workspaceId && (
          <section className="panel">
            <div className="panel-heading">
              <div>
                <h2>{t("common.dashboard")}</h2>
                <p>Workspace context needs repair</p>
              </div>
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
          <section className="panel">
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

        <section className="dashboard-columns">
          <div className="dashboard-main">
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>{t("operations")}</h2>
                  <p>{t("dashboard.openModule")}</p>
                </div>
              </div>
              <div className="operation-grid">
                {modules
                  .filter(({ path }) => config.featureFarmMap || path !== "/workspace/operations-map")
                  .filter(({ key }) => config.featureInventory || key !== "inventory")
                  .map(({ key, path, detailKey, icon: Icon }) => hasOperationalContext ? (
                    <Link className="operation-card" key={key} to={path}>
                      <Icon size={22} />
                      <div>
                        <strong>{t(key)}</strong>
                        <span>{t(detailKey)}</span>
                      </div>
                      <ArrowRight size={16} />
                    </Link>
                  ) : (
                    <div className="operation-card operation-card--disabled" key={key} aria-disabled="true">
                      <Icon size={22} />
                      <div>
                        <strong>{t(key)}</strong>
                        <span>{t("dashboardPage.moduleLockedUntilFarmSeason")}</span>
                      </div>
                      <ArrowRight size={16} />
                    </div>
                  ))}
              </div>
            </section>

            <section>
              <div className="section-title-row">
                <div>
                  <h2>{t("dashboardPage.todayAtGlance")}</h2>
                  <p>{t("dashboardPage.localFigures")}</p>
                </div>
              </div>
              <section className="summary-grid" aria-label={t("dashboard.operationalSummary")}>
                {summaryCards.map(({ label, value, path, icon: Icon, tone }) => hasOperationalContext ? (
                  <Link className={`metric-card metric-card--${tone}`} to={path} key={label}>
                    <div className="metric-card__icon"><Icon size={20} /></div>
                    <span>{label}</span>
                    <strong>{value}</strong>
                  </Link>
                ) : (
                  <div className={`metric-card metric-card--${tone} metric-card--disabled`} key={label} aria-disabled="true">
                    <div className="metric-card__icon"><Icon size={20} /></div>
                    <span>{label}</span>
                    <strong>--</strong>
                  </div>
                ))}
              </section>
            </section>

            {user?.workspaceId ? <ImportVisibilityAuditPanel workspaceId={user.workspaceId} title="Visibility Audit" /> : null}
          </div>

          <aside className="dashboard-side">
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
        </section>
      </main>
    </div>
  );
}
