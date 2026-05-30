import { useEffect, type PropsWithChildren } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./auth/AuthProvider";
import { AdminLayout } from "./layouts/AdminLayout";
import { WorkspaceLayout } from "./layouts/WorkspaceLayout";
import { getHomePath, isPlatformUser } from "./lib/permissions";
import { AdminApprovalsPage } from "./pages/AdminApprovalsPage";
import { ContextPage } from "./pages/ContextPage";
import { LoginPage } from "./pages/LoginPage";
import { ModulePage } from "./pages/ModulePage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { SignupPage } from "./pages/SignupPage";
import { AdminDashboard } from "./pages/admin/AdminDashboard";
import { AdminSection } from "./pages/admin/AdminSection";
import { AuditLogs } from "./pages/admin/AuditLogs";
import { Billing } from "./pages/admin/Billing";
import { Settings } from "./pages/admin/Settings";
import { Users } from "./pages/admin/Users";
import { Workspaces } from "./pages/admin/Workspaces";
import { Attendance } from "./pages/workspace/Attendance";
import { Dispatch } from "./pages/workspace/Dispatch";
import { Expenses } from "./pages/workspace/Expenses";
import { Inventory } from "./pages/workspace/Inventory";
import { Reports } from "./pages/workspace/Reports";
import { Sales } from "./pages/workspace/Sales";
import { WorkspaceDashboard } from "./pages/workspace/WorkspaceDashboard";

function RequireAuth({ children }: PropsWithChildren) {
  const { user, loading } = useAuth();
  if (loading) return <div className="page-loader" aria-label="Loading" />;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

function RequirePlatform({ children }: PropsWithChildren) {
  const { user, loading } = useAuth();
  if (loading) return <div className="page-loader" aria-label="Loading" />;
  if (!user) return <Navigate to="/login" replace />;
  if (!isPlatformUser(user)) return <Navigate to="/workspace/dashboard" replace />;
  return children;
}

function RequireWorkspace({ children }: PropsWithChildren) {
  const { user, loading } = useAuth();
  if (loading) return <div className="page-loader" aria-label="Loading" />;
  if (!user) return <Navigate to="/login" replace />;
  if (isPlatformUser(user) || !user.workspaceId) return <Navigate to="/admin/dashboard" replace />;
  return children;
}

function HomeRedirect() {
  const { user } = useAuth();
  return <Navigate to={user ? getHomePath(user) : "/login"} replace />;
}

export default function App() {
  const { i18n } = useTranslation();
  useEffect(() => {
    const language = i18n.resolvedLanguage?.slice(0, 2) ?? "en";
    document.documentElement.lang = language;
    document.documentElement.dir = language === "ar" || language === "ur" ? "rtl" : "ltr";
  }, [i18n.resolvedLanguage]);

  return <Routes>
    <Route path="/login" element={<LoginPage />} />
    <Route path="/signup" element={<SignupPage />} />
    <Route path="/" element={<RequireAuth><HomeRedirect /></RequireAuth>} />
    <Route path="/admin" element={<RequirePlatform><AdminLayout /></RequirePlatform>}>
      <Route path="dashboard" element={<AdminDashboard />} />
      <Route path="workspaces" element={<Workspaces />} />
      <Route path="users" element={<Users />} />
      <Route path="subscriptions" element={<AdminSection title="Subscriptions" description="Manage plans, renewals, and upcoming expirations." />} />
      <Route path="billing" element={<Billing />} />
      <Route path="audit-logs" element={<AuditLogs />} />
      <Route path="reports" element={<AdminSection title="Reports" description="Review platform analytics across workspaces." />} />
      <Route path="settings" element={<Settings />} />
      <Route path="approvals" element={<AdminApprovalsPage />} />
    </Route>
    <Route path="/workspace" element={<RequireWorkspace><WorkspaceLayout /></RequireWorkspace>}>
      <Route path="dashboard" element={<WorkspaceDashboard />} />
      <Route path="attendance" element={<Attendance />} />
      <Route path="sales" element={<Sales />} />
      <Route path="expenses" element={<Expenses />} />
      <Route path="dispatch" element={<Dispatch />} />
      <Route path="inventory" element={<Inventory />} />
      <Route path="reports" element={<Reports />} />
      <Route path="team" element={<ModulePage module="workforce" />} />
      <Route path="settings" element={<ContextPage kind="farms" />} />
      <Route path="farms" element={<ContextPage kind="farms" />} />
      <Route path="seasons" element={<ContextPage kind="seasons" />} />
      <Route path="accounts" element={<ModulePage module="accounts" />} />
      <Route path="partner-ledger" element={<ModulePage module="partnerLedger" />} />
    </Route>
    {["workforce", "expenses", "sales", "dispatch", "accounts", "partner-ledger", "farms", "seasons"].map((path) =>
      <Route key={path} path={`/${path}`} element={<Navigate to={`/workspace/${path === "workforce" ? "attendance" : path}`} replace />} />,
    )}
    <Route path="*" element={<RequireAuth><NotFoundPage /></RequireAuth>} />
  </Routes>;
}
