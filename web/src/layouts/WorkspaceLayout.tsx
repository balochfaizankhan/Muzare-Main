import { BarChart3, Boxes, CalendarCheck, CloudUpload, LayoutDashboard, LogOut, PackageOpen, ReceiptText, RefreshCw, Settings, ShoppingBasket, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { Brand } from "../components/Brand";
import { LanguageSwitch } from "../components/LanguageSwitch";
import { useSyncState } from "../hooks/useSyncState";
import { refreshOperationalData, startSyncService, stopSyncService, syncNow } from "../services/syncService";
import { setActiveWorkspaceId } from "../lib/offline-db";

const nav = [
  ["/workspace/dashboard", "Dashboard", LayoutDashboard],
  ["/workspace/attendance", "Attendance", CalendarCheck],
  ["/workspace/sales", "Sales", ShoppingBasket],
  ["/workspace/expenses", "Expenses", ReceiptText],
  ["/workspace/dispatch", "Dispatch", PackageOpen],
  ["/workspace/inventory", "Inventory", Boxes],
  ["/workspace/reports", "Reports", BarChart3],
  ["/workspace/team", "Team", Users],
  ["/workspace/settings", "Settings", Settings],
] as const;

export function WorkspaceLayout() {
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
  const statusText = sync.status === "offline" ? "Working Offline" : sync.status === "syncing" ? "Syncing..." : sync.status === "error" ? "Sync Failed" : sync.pendingCount ? `${sync.pendingCount} Changes Waiting` : "Synced";
  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <Brand compact />
        <span className="shell-label">{user?.workspaceName ?? "Workspace"}</span>
        <nav>{nav.map(([to, label, Icon]) => <NavLink to={to} key={to}><Icon size={17} />{label}</NavLink>)}</nav>
      </aside>
      <div className="app-shell__body">
        <header className="shell-header">
          <strong>Farm Operations</strong>
          <div className="toolbar__actions">
            {user && user.memberships.length > 1 && (
              <select className="workspace-switcher" aria-label="Current workspace" value={user.workspaceId ?? ""} onChange={(event) => void switchWorkspace(event.target.value)}>
                {user.memberships.filter((membership) => membership.active).map((membership) => (
                  <option key={membership.workspaceId} value={membership.workspaceId}>{membership.workspaceName}</option>
                ))}
              </select>
            )}
            <span className={`sync-badge sync-badge--${sync.status}`}>{statusText}</span>
            <button className="shell-action" type="button" onClick={() => void refreshOperationalData()}><RefreshCw size={16} />Refresh</button>
            <button className="shell-action" type="button" onClick={() => void syncNow()}><CloudUpload size={16} />Sync Now</button>
            <LanguageSwitch /><button className="ghost-icon" onClick={() => void logout()}><LogOut size={18} /></button>
          </div>
        </header>
        <Outlet />
        {toast && <div className="saas-toast" role="status">{toast}</div>}
      </div>
    </div>
  );
}
