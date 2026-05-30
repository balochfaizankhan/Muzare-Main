import { BarChart3, CreditCard, FileClock, LayoutDashboard, ReceiptText, Settings, Users, Warehouse, LogOut } from "lucide-react";
import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { Brand } from "../components/Brand";
import { LanguageSwitch } from "../components/LanguageSwitch";

const nav = [
  ["/admin/dashboard", "Dashboard", LayoutDashboard],
  ["/admin/workspaces", "Workspaces", Warehouse],
  ["/admin/users", "Users", Users],
  ["/admin/subscriptions", "Subscriptions", ReceiptText],
  ["/admin/billing", "Billing", CreditCard],
  ["/admin/audit-logs", "Audit Logs", FileClock],
  ["/admin/reports", "Reports", BarChart3],
  ["/admin/settings", "Settings", Settings],
] as const;

export function AdminLayout() {
  const { logout } = useAuth();
  return (
    <div className="app-shell app-shell--admin">
      <aside className="app-sidebar">
        <Brand compact />
        <span className="shell-label">Platform Console</span>
        <nav>{nav.map(([to, label, Icon]) => <NavLink to={to} key={to}><Icon size={17} />{label}</NavLink>)}</nav>
      </aside>
      <div className="app-shell__body">
        <header className="shell-header">
          <strong>Muzare Platform Administration</strong>
          <div className="toolbar__actions"><LanguageSwitch /><button className="ghost-icon" onClick={() => void logout()}><LogOut size={18} /></button></div>
        </header>
        <Outlet />
      </div>
    </div>
  );
}
