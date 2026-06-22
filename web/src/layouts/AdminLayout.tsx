import { DatabaseBackup, FileClock, LayoutDashboard, LogOut, Settings, ShieldAlert, UserRoundPlus, Users, Warehouse } from "lucide-react";
import { useTranslation } from "react-i18next";
import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { Brand } from "../components/Brand";
import { LanguageSwitch } from "../components/LanguageSwitch";

const nav = [
  ["/admin/dashboard", "layout.dashboard", LayoutDashboard],
  ["/admin/users", "layout.users", Users],
  ["/admin/workspaces", "layout.workspaces", Warehouse],
  ["/admin/approvals", "adminApprovals.title", UserRoundPlus],
  ["/admin/suspended", "common.suspended", ShieldAlert],
  ["/admin/migration-import", "adminMigration.title", DatabaseBackup],
  ["/admin/audit-logs", "layout.auditLogs", FileClock],
  ["/admin/settings", "layout.settings", Settings],
] as const;

export function AdminLayout() {
  const { t } = useTranslation();
  const { logout } = useAuth();
  return (
    <div className="app-shell app-shell--admin">
      <aside className="app-sidebar">
        <Brand compact />
        <span className="shell-label">{t("layout.platformConsole")}</span>
        <nav>{nav.map(([to, label, Icon]) => <NavLink to={to} key={to}><Icon size={17} />{t(label)}</NavLink>)}</nav>
      </aside>
      <div className="app-shell__body">
        <header className="shell-header">
          <strong>{t("layout.platformAdministration")}</strong>
          <div className="toolbar__actions"><LanguageSwitch /><button className="ghost-icon shell-logout" aria-label={t("common.logout")} onClick={() => void logout()}><LogOut size={18} /></button></div>
        </header>
        <Outlet />
      </div>
    </div>
  );
}
