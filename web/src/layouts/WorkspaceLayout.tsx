import { BarChart3, Boxes, CalendarCheck, LayoutDashboard, LogOut, PackageOpen, ReceiptText, Settings, ShoppingBasket, Users } from "lucide-react";
import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { Brand } from "../components/Brand";
import { LanguageSwitch } from "../components/LanguageSwitch";

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
  const { user, logout } = useAuth();
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
          <div className="toolbar__actions"><LanguageSwitch /><button className="ghost-icon" onClick={() => void logout()}><LogOut size={18} /></button></div>
        </header>
        <Outlet />
      </div>
    </div>
  );
}
