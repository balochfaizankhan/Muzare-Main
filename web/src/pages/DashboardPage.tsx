import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  BanknoteArrowDown,
  BookOpenText,
  CalendarRange,
  CircleDollarSign,
  CloudUpload,
  Leaf,
  LogOut,
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
import { Brand } from "../components/Brand";
import { LanguageSwitch } from "../components/LanguageSwitch";
import { fetchBootstrap } from "../lib/api";
import { ensureLocalAccounts, offlineDb } from "../lib/offline-db";

type DashboardTotals = {
  presentToday: number;
  cartonsToday: number;
  totalSales: number;
  totalExpenses: number;
  netPosition: number;
  partnerBalance: number;
  pendingSync: number;
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
  { key: "workforce", path: "/workforce", icon: UsersRound, detail: "Attendance and labour register" },
  { key: "expenses", path: "/expenses", icon: BanknoteArrowDown, detail: "Vouchers and farm costs" },
  { key: "sales", path: "/sales", icon: ShoppingBasket, detail: "Revenue and buyers" },
  { key: "dispatch", path: "/dispatch", icon: PackageOpen, detail: "Vehicles and cartons" },
  { key: "accounts", path: "/accounts", icon: BookOpenText, detail: "Cash and bank balances" },
  { key: "partnerLedger", path: "/partner-ledger", icon: Leaf, detail: "Capital and settlements" },
];

const quickActions = [
  { label: "Mark attendance", path: "/workforce", icon: UsersRound },
  { label: "New expense", path: "/expenses", icon: BanknoteArrowDown },
  { label: "Record dispatch", path: "/dispatch", icon: PackageOpen },
  { label: "Record sale", path: "/sales", icon: ShoppingBasket },
] as const;

const today = () => new Date().toISOString().slice(0, 10);
const money = (amount: number) => new Intl.NumberFormat("en", { style: "currency", currency: "SAR", maximumFractionDigits: 0 }).format(amount);
const formatDate = () => new Intl.DateTimeFormat("en", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date());

export function DashboardPage() {
  const { t } = useTranslation();
  const { user, token, logout } = useAuth();
  const [totals, setTotals] = useState<DashboardTotals>({
    presentToday: 0,
    cartonsToday: 0,
    totalSales: 0,
    totalExpenses: 0,
    netPosition: 0,
    partnerBalance: 0,
    pendingSync: 0,
  });
  const [activities, setActivities] = useState<Activity[]>([]);
  const query = useQuery({
    queryKey: ["bootstrap", user?.id],
    queryFn: () => fetchBootstrap(token!),
    enabled: Boolean(user && token),
    retry: false,
  });

  const loadLocalDashboard = useCallback(async () => {
    await ensureLocalAccounts();
    const [attendance, dispatches, sales, vouchers, entries, pending] = await Promise.all([
      offlineDb.attendance.toArray(),
      offlineDb.dispatches.toArray(),
      offlineDb.sales.toArray(),
      offlineDb.vouchers.toArray(),
      offlineDb.partnerEntries.toArray(),
      offlineDb.pendingMutations.toArray(),
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
      pendingSync: pending.length,
    });

    const recent: Activity[] = [
      ...sales.map((item) => ({
        id: item.id,
        path: "/sales",
        title: "Sale recorded",
        detail: item.buyerName,
        value: money(item.amount),
        createdAt: item.createdAt,
      })),
      ...vouchers.map((item) => ({
        id: item.id,
        path: "/expenses",
        title: "Expense voucher",
        detail: item.category,
        value: `-${money(item.amount)}`,
        createdAt: item.createdAt,
      })),
      ...dispatches.map((item) => ({
        id: item.id,
        path: "/dispatch",
        title: "Dispatch recorded",
        detail: item.vehicleNumber,
        value: `${item.cartons} cartons`,
        createdAt: item.createdAt,
      })),
      ...entries.map((item) => ({
        id: item.id,
        path: "/partner-ledger",
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
  }, [loadLocalDashboard]);

  const farm = query.data?.farms[0];
  const season = farm ? query.data?.seasons.find((item) => item.farmId === farm.id) : query.data?.seasons[0];
  const StatusIcon = query.data ? Wifi : WifiOff;
  const displayName = user?.displayName || user?.email || "Administrator";

  const summaryCards = [
    { label: "Present today", value: String(totals.presentToday), icon: UsersRound, path: "/workforce", tone: "green" },
    { label: "Cartons today", value: String(totals.cartonsToday), icon: PackageOpen, path: "/dispatch", tone: "navy" },
    { label: "Total sales", value: money(totals.totalSales), icon: TrendingUp, path: "/sales", tone: "green" },
    { label: "Total expenses", value: money(totals.totalExpenses), icon: BanknoteArrowDown, path: "/expenses", tone: "red" },
    { label: "Available balance", value: money(totals.netPosition), icon: Wallet, path: "/accounts", tone: "navy" },
    { label: "Partner balance", value: money(totals.partnerBalance), icon: CircleDollarSign, path: "/partner-ledger", tone: "blue" },
  ];

  return (
    <div className="dashboard-page professional-dashboard">
      <header className="toolbar dashboard-toolbar">
        <Brand compact />
        <div className="toolbar__actions">
          <LanguageSwitch />
          <button className="ghost-icon" onClick={() => void logout()} title={t("logout")} aria-label={t("logout")}>
            <LogOut size={19} />
          </button>
        </div>
      </header>

      <main className="dashboard dashboard--wide">
        <section className="dashboard-hero">
          <div className="dashboard-hero__intro">
            <span className="eyebrow">Operations overview</span>
            <h1>Welcome, {displayName}</h1>
            <p>{formatDate()}</p>
          </div>
          <div className="context-actions">
            <Link className="context-chip" to="/farms">
              <Leaf size={18} />
              <span>{t("currentFarm")}</span>
              <strong>{farm?.name ?? t("noFarm")}</strong>
            </Link>
            <Link className="context-chip" to="/seasons">
              <CalendarRange size={18} />
              <span>{t("currentSeason")}</span>
              <strong>{season?.name ?? t("noSeason")}</strong>
            </Link>
          </div>
        </section>

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
                  <strong>{query.isLoading ? "Connecting..." : query.data ? "API connected" : "Connection unavailable"}</strong>
                  <p>{query.isLoading ? "Loading farm context." : query.isError ? query.error.message : query.data ? "Farm context loaded from Render." : t("connectionPending")}</p>
                </div>
              </div>
              <div className="sync-line">
                <CloudUpload size={18} />
                <div>
                  <strong>{totals.pendingSync} local changes pending sync</strong>
                  <p>Operational entries remain securely on this device until sync endpoints are enabled.</p>
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
