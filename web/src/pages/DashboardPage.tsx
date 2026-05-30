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
import { fetchBootstrap } from "../lib/api";
import { ensureLocalAccounts, offlineDb, workspaceRecords } from "../lib/offline-db";
import { useSyncState } from "../hooks/useSyncState";
import { refreshOperationalData, syncNow } from "../services/syncService";

type DashboardTotals = {
  presentToday: number;
  cartonsToday: number;
  totalSales: number;
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
  detail: string;
}> = [
  { key: "workforce", path: "/workspace/attendance", icon: UsersRound, detail: "Attendance and labour register" },
  { key: "expenses", path: "/workspace/expenses", icon: BanknoteArrowDown, detail: "Vouchers and farm costs" },
  { key: "sales", path: "/workspace/sales", icon: ShoppingBasket, detail: "Revenue and buyers" },
  { key: "dispatch", path: "/workspace/dispatch", icon: PackageOpen, detail: "Vehicles and cartons" },
  { key: "accounts", path: "/workspace/accounts", icon: BookOpenText, detail: "Cash and bank balances" },
  { key: "partnerLedger", path: "/workspace/partner-ledger", icon: Leaf, detail: "Capital and settlements" },
];

const quickActions = [
  { label: "Mark attendance", path: "/workspace/attendance", icon: UsersRound },
  { label: "New expense", path: "/workspace/expenses", icon: BanknoteArrowDown },
  { label: "Record dispatch", path: "/workspace/dispatch", icon: PackageOpen },
  { label: "Record sale", path: "/workspace/sales", icon: ShoppingBasket },
] as const;

const today = () => new Date().toISOString().slice(0, 10);
const money = (amount: number) => new Intl.NumberFormat("en", { style: "currency", currency: "SAR", maximumFractionDigits: 0 }).format(amount);
const formatDate = () => new Intl.DateTimeFormat("en", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date());

export function DashboardPage() {
  const { t } = useTranslation();
  const { user, token } = useAuth();
  const sync = useSyncState();
  const [totals, setTotals] = useState<DashboardTotals>({
    presentToday: 0,
    cartonsToday: 0,
    totalSales: 0,
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
    const [attendance, dispatches, sales, vouchers, entries] = await Promise.all([
      workspaceRecords(offlineDb.attendance),
      workspaceRecords(offlineDb.dispatches),
      workspaceRecords(offlineDb.sales),
      workspaceRecords(offlineDb.vouchers),
      workspaceRecords(offlineDb.partnerEntries),
    ]);
    const date = today();
    const totalSales = sales.reduce((sum, item) => sum + item.amount, 0);
    const totalExpenses = vouchers.reduce((sum, item) => sum + item.amount, 0);
    const partnerBalance = entries.reduce(
      (sum, item) => sum + (item.type === "contribution" ? item.amount : -item.amount),
      0,
    );
    setTotals({
      presentToday: attendance.filter((item) => item.date === date && item.status === "present").length,
      cartonsToday: dispatches.filter((item) => item.date === date).reduce((sum, item) => sum + item.cartons, 0),
      totalSales,
      totalExpenses,
      netPosition: totalSales - totalExpenses + partnerBalance,
      partnerBalance,
    });

    const recent: Activity[] = [
      ...sales.map((item) => ({
        id: item.id,
        path: "/workspace/sales",
        title: "Sale recorded",
        detail: item.buyerName,
        value: money(item.amount),
        createdAt: item.createdAt,
      })),
      ...vouchers.map((item) => ({
        id: item.id,
        path: "/workspace/expenses",
        title: "Expense voucher",
        detail: item.category,
        value: `-${money(item.amount)}`,
        createdAt: item.createdAt,
      })),
      ...dispatches.map((item) => ({
        id: item.id,
        path: "/workspace/dispatch",
        title: "Dispatch recorded",
        detail: item.vehicleNumber,
        value: `${item.cartons} cartons`,
        createdAt: item.createdAt,
      })),
      ...entries.map((item) => ({
        id: item.id,
        path: "/workspace/partner-ledger",
        title: item.type === "contribution" ? "Partner contribution" : "Partner withdrawal",
        detail: item.partnerName,
        value: `${item.type === "withdrawal" ? "-" : ""}${money(item.amount)}`,
        createdAt: item.createdAt,
      })),
    ];
    recent.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    setActivities(recent.slice(0, 5));
  }, []);

  useEffect(() => {
    void loadLocalDashboard();
    window.addEventListener("muzare-data-refresh", loadLocalDashboard);
    return () => window.removeEventListener("muzare-data-refresh", loadLocalDashboard);
  }, [loadLocalDashboard]);

  const farm = query.data?.farms.find((item) => item.id === query.data.activeFarmId);
  const season = query.data?.seasons.find((item) => item.id === query.data.activeSeasonId);
  const StatusIcon = sync.status === "offline" ? WifiOff : Wifi;
  const displayName = user?.displayName || user?.email || "Administrator";

  const summaryCards = [
    { label: "Present today", value: String(totals.presentToday), icon: UsersRound, path: "/workspace/attendance", tone: "green" },
    { label: "Cartons today", value: String(totals.cartonsToday), icon: PackageOpen, path: "/workspace/dispatch", tone: "navy" },
    { label: "Total sales", value: money(totals.totalSales), icon: TrendingUp, path: "/workspace/sales", tone: "green" },
    { label: "Total expenses", value: money(totals.totalExpenses), icon: BanknoteArrowDown, path: "/workspace/expenses", tone: "red" },
    { label: "Available balance", value: money(totals.netPosition), icon: Wallet, path: "/workspace/accounts", tone: "navy" },
    { label: "Partner balance", value: money(totals.partnerBalance), icon: CircleDollarSign, path: "/workspace/partner-ledger", tone: "blue" },
  ];

  return (
    <div className="dashboard-page professional-dashboard">
      <main className="dashboard dashboard--wide">
        <section className="dashboard-hero">
          <div className="dashboard-hero__intro">
            <span className="eyebrow">Operations overview</span>
            <h1>Welcome, {displayName}</h1>
            <p>{formatDate()}</p>
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
        {!season && <p className="context-message">No active season. Create or select a season to begin operations.</p>}

        <div className="section-title-row">
          <div>
            <h2>Today at a glance</h2>
            <p>Live local figures from this device</p>
          </div>
        </div>
        <section className="summary-grid" aria-label="Operational summary">
          {summaryCards.map(({ label, value, path, icon: Icon, tone }) => (
            <Link className={`metric-card metric-card--${tone}`} to={path} key={label}>
              <div className="metric-card__icon"><Icon size={20} /></div>
              <span>{label}</span>
              <strong>{value}</strong>
            </Link>
          ))}
        </section>

        <section className="dashboard-columns">
          <div className="dashboard-main">
            <section className="panel quick-panel">
              <div className="panel-heading">
                <div>
                  <h2>Quick actions</h2>
                  <p>Common daily entries</p>
                </div>
              </div>
              <div className="quick-grid">
                {quickActions.map(({ label, path, icon: Icon }) => (
                  <Link className="quick-action" to={path} key={label}>
                    <Icon size={19} />
                    <span>{label}</span>
                    <ArrowRight size={16} />
                  </Link>
                ))}
              </div>
            </section>

            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>{t("operations")}</h2>
                  <p>Open a management module</p>
                </div>
              </div>
              <div className="operation-grid">
                {modules.map(({ key, path, detail, icon: Icon }) => (
                  <Link className="operation-card" key={key} to={path}>
                    <Icon size={22} />
                    <div>
                      <strong>{t(key)}</strong>
                      <span>{detail}</span>
                    </div>
                    <ArrowRight size={16} />
                  </Link>
                ))}
              </div>
            </section>
          </div>

          <aside className="dashboard-side">
            <section className="panel status-panel">
              <div className="status-line">
                <StatusIcon size={19} />
                <div>
                  <strong>{sync.status === "offline" ? "Working Offline" : sync.status === "syncing" ? "Syncing..." : sync.status === "error" ? "Sync Failed" : "API Connected"}</strong>
                  <p>{sync.status === "offline" ? "Changes will be saved locally until connectivity returns." : "PostgreSQL is the primary workspace database."}</p>
                </div>
              </div>
              <div className="sync-line">
                <CloudUpload size={18} />
                <div>
                  <strong>Database {sync.pendingCount ? "Sync Pending" : "Synced"}</strong>
                  <p>Pending Changes: {sync.pendingCount}</p>
                  <p>Last Successful Sync: {sync.lastSyncTime ? new Date(sync.lastSyncTime).toLocaleString() : "Not yet synchronized"}</p>
                  <div className="sync-buttons"><button type="button" onClick={() => void refreshOperationalData()}>Refresh Data</button><button type="button" onClick={() => void syncNow()}>Sync Now</button></div>
                </div>
              </div>
            </section>

            <section className="panel activity-panel">
              <div className="panel-heading">
                <div>
                  <h2>Recent activity</h2>
                  <p>Entries made on this device</p>
                </div>
              </div>
              {activities.length === 0 ? (
                <p className="activity-empty">No activity yet. Use a quick action to enter your first operational record.</p>
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
