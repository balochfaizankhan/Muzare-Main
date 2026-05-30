import { Activity, Building2, CircleDollarSign, Clock3, HeartPulse, Plus, Settings, ShieldCheck, UserRoundPlus, Users } from "lucide-react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../../auth/AuthProvider";
import { fetchAdminDashboard } from "../../lib/api";

const actions = [
  ["/admin/workspaces", "Create Workspace", Plus], ["/admin/workspaces", "Manage Workspaces", Building2],
  ["/admin/users", "Manage Users", Users], ["/admin/billing", "Billing", CircleDollarSign],
  ["/admin/settings", "Platform Settings", Settings], ["/admin/audit-logs", "Audit Logs", Activity],
] as const;

export function AdminDashboard() {
  const { token } = useAuth();
  const query = useQuery({ queryKey: ["admin-dashboard"], queryFn: () => fetchAdminDashboard(token!), enabled: Boolean(token) });
  const data = query.data;
  const metrics = [
    ["Total Workspaces", data?.totalWorkspaces ?? "-", Building2], ["Active Workspaces", data?.activeWorkspaces ?? "-", ShieldCheck],
    ["Suspended Workspaces", data?.suspendedWorkspaces ?? "-", Clock3], ["Pending Workspace Requests", data?.pendingWorkspaceRequests ?? "-", UserRoundPlus],
    ["Total Users", data?.totalUsers ?? "-", Users], ["Total Active Users", data?.totalActiveUsers ?? "-", Users],
    ["Subscription Revenue", data ? `SAR ${data.subscriptionRevenue}` : "-", CircleDollarSign],
    ["Expiring Subscriptions", data?.expiringSubscriptions ?? "-", Clock3], ["System Health", data?.systemHealth ?? "-", HeartPulse],
  ] as const;
  return <main className="shell-page">
    <section className="shell-page__intro"><span className="eyebrow">Platform overview</span><h1>Administration dashboard</h1><p>Manage Muzare customers, subscriptions, and system health.</p></section>
    {query.isError && <p className="error">{query.error.message}</p>}
    <section className="admin-metric-grid">{metrics.map(([label, value, Icon]) => <article key={label}><Icon size={19} /><span>{label}</span><strong>{value}</strong></article>)}</section>
    <section className="shell-grid">
      <div className="panel"><h2>Quick actions</h2><div className="shell-actions">{actions.map(([to, label, Icon]) => <Link to={to} key={label}><Icon size={17} />{label}</Link>)}</div></div>
      <div className="panel"><h2>Recent platform activity</h2><p className="activity-empty">Workspace creation, suspensions, invitations, and renewals will appear here.</p></div>
    </section>
  </main>;
}
