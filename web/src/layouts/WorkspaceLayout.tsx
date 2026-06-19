import { BarChart3, BookOpenText, Boxes, CalendarCheck, CloudUpload, HandCoins, LayoutDashboard, LogOut, PackageOpen, ReceiptText, RefreshCw, Satellite, Settings, ShoppingBasket, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { Brand } from "../components/Brand";
import { LanguageSwitch } from "../components/LanguageSwitch";
import { config } from "../config";
import { useSyncState } from "../hooks/useSyncState";
import { refreshOperationalData, startSyncService, stopSyncService, syncNow } from "../services/syncService";
import { setActiveWorkspaceId } from "../lib/offline-db";
import { hasModulePermission } from "../lib/permissions";

const nav = [
  ["/workspace/dashboard", "layout.dashboard", LayoutDashboard, "dashboard"],
  ["/workspace/attendance", "layout.attendance", CalendarCheck, "attendance"],
  ["/workspace/sales", "layout.sales", ShoppingBasket, "sales"],
  ["/workspace/expenses", "layout.expenses", ReceiptText, "expenses"],
  ["/workspace/advances", "layout.advances", HandCoins, "advances"],
  ["/workspace/dispatch", "layout.dispatch", PackageOpen, "dispatch"],
  ["/workspace/inventory", "layout.inventory", Boxes, "inventory"],
  ["/workspace/operations-map", "operationsMap", Satellite, "dashboard"],
  ["/workspace/reports", "layout.reports", BarChart3, "reports"],
  ["/workspace/team", "layout.workforce", Users, "workforce"],
  ["/workspace/accounts", "layout.accounts", BookOpenText, "accounts"],
  ["/workspace/settings", "layout.settings", Settings, "settings"],
] as const;

export function WorkspaceLayout() {
  const { t } = useTranslation();
  const { user, token, logout, switchWorkspace } = useAuth();
  const sync = useSyncState();
  const [toast, setToast] = useState<string | null>(null);
  setActiveWorkspaceId(user?.workspaceId ?? null);
  useEffect(() => {
    if (token && user?.workspaceId) void startSyncService(token, user.workspaceId);
    return stopSyncService;
  }, [token, user?.workspaceId]);
  useEffect(() => {
    const reloadSeason = () => {
      if (token && user?.workspaceId) void startSyncService(token, user.workspaceId);
    };
    window.addEventListener("muzare-season-changed", reloadSeason);
    return () => window.removeEventListener("muzare-season-changed", reloadSeason);
  }, [token, user?.workspaceId]);
  useEffect(() => {
    const reloadFarm = () => {
      if (token && user?.workspaceId) void startSyncService(token, user.workspaceId);
    };
    window.addEventListener("muzare-farm-changed", reloadFarm);
    return () => window.removeEventListener("muzare-farm-changed", reloadFarm);
  }, [token, user?.workspaceId]);
  useEffect(() => {
    const showToast = (event: Event) => {
      setToast((event as CustomEvent<string>).detail);
      window.setTimeout(() => setToast(null), 4200);
    };
    window.addEventListener("muzare-toast", showToast);
    return () => window.removeEventListener("muzare-toast", showToast);
  }, []);
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
    <div className="app-shell">
      <aside className="app-sidebar">
        <Brand compact />
        <span className="shell-label">{user?.workspaceName ?? t("layout.workspace")}</span>
        <nav>{nav
          .filter(([to]) => config.featureFarmMap || to !== "/workspace/operations-map")
          .filter(([to]) => config.featureInventory || to !== "/workspace/inventory")
          .filter(([, , , module]) => !user || hasModulePermission(user, module, "view"))
          .map(([to, label, Icon]) => <NavLink to={to} key={to}><Icon size={17} />{t(label)}</NavLink>)}</nav>
      </aside>
      <div className="app-shell__body">
        <header className="shell-header">
          <div className="shell-header__top">
            <strong className="shell-header__title">{t("layout.farmOperations")}</strong>
            <div className="shell-header__meta">
              {user && user.memberships.length > 1 && (
                <select className="workspace-switcher" aria-label={t("layout.currentWorkspace")} value={user.workspaceId ?? ""} onChange={(event) => void switchWorkspace(event.target.value)}>
                  {user.memberships.filter((membership) => membership.active).map((membership) => (
                    <option key={membership.workspaceId} value={membership.workspaceId}>{membership.workspaceName}</option>
                  ))}
                </select>
              )}
              <span className={`sync-badge sync-badge--${sync.status}`}>{statusText}</span>
            </div>
          </div>
          <div className="toolbar__actions shell-header__controls">
            <button className="shell-action shell-action--refresh" type="button" aria-label={t("layout.refresh")} onClick={() => void refreshOperationalData()}><RefreshCw size={16} /><span className="shell-action__desktop">{t("layout.refresh")}</span></button>
            <button className="shell-action shell-action--sync" type="button" aria-label={t("layout.syncNow")} onClick={() => void syncNow()}><CloudUpload size={16} /><span className="shell-action__desktop">{t("layout.syncNow")}</span><span className="shell-action__mobile">{t("layout.sync")}</span></button>
            <LanguageSwitch />
            <button className="ghost-icon shell-logout" aria-label={t("common.logout")} onClick={() => void logout()}><LogOut size={18} /></button>
          </div>
        </header>
        <Outlet />
        {toast && <div className="saas-toast" role="status">{toast}</div>}
      </div>
    </div>
  );
}
