import { useEffect, type PropsWithChildren } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./auth/AuthProvider";
import { config } from "./config";
import { AdminLayout } from "./layouts/AdminLayout";
import { WorkspaceLayout } from "./layouts/WorkspaceLayout";
import { getHomePath, isPlatformUser } from "./lib/permissions";
import { AdminApprovalsPage } from "./pages/AdminApprovalsPage";
import { LoginPage } from "./pages/LoginPage";
import { ModulePage } from "./pages/ModulePage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { SignupPage } from "./pages/SignupPage";
import { AcceptInvitationPage } from "./pages/AcceptInvitationPage";
import { AdminDashboard } from "./pages/admin/AdminDashboard";
import { AdminSection } from "./pages/admin/AdminSection";
import { AuditLogs } from "./pages/admin/AuditLogs";
import { Billing } from "./pages/admin/Billing";
import { AdminFarms } from "./pages/admin/Farms";
import { Settings } from "./pages/admin/Settings";
import { Users } from "./pages/admin/Users";
import { Workspaces } from "./pages/admin/Workspaces";
import { MigrationImport } from "./pages/admin/MigrationImport";
import { Attendance } from "./pages/workspace/Attendance";
import { Dispatch } from "./pages/workspace/Dispatch";
import { Expenses } from "./pages/workspace/Expenses";
import { Inventory } from "./pages/workspace/Inventory";
import { LabourAdvances } from "./pages/workspace/LabourAdvances";
import { Reports } from "./pages/workspace/Reports";
import { Sales } from "./pages/workspace/Sales";
import { WorkspaceDashboard } from "./pages/workspace/WorkspaceDashboard";
import { Farms } from "./pages/workspace/Farms";
import { FarmOperationsMap } from "./pages/workspace/FarmOperationsMap";
import { Seasons } from "./pages/workspace/Seasons";
import { WorkspaceApprovals } from "./pages/workspace/WorkspaceApprovals";
import { WorkspaceTeam } from "./pages/workspace/WorkspaceTeam";

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

function FarmMapDisabledRedirect() {
  const { t } = useTranslation();
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("muzare-toast", { detail: t("farmMap.disabled") }));
  }, [t]);
  return <Navigate to="/workspace/dashboard" replace />;
}

export default function App() {
  const { i18n, t } = useTranslation();
  useEffect(() => {
    const language = i18n.resolvedLanguage?.slice(0, 2) ?? "en";
    document.documentElement.lang = language;
    document.documentElement.dir = language === "ar" || language === "ur" ? "rtl" : "ltr";
  }, [i18n.resolvedLanguage]);

  return <Routes>
    <Route path="/login" element={<LoginPage />} />
    <Route path="/signup" element={<SignupPage />} />
    <Route path="/accept-invitation" element={<AcceptInvitationPage />} />
    <Route path="/" element={<RequireAuth><HomeRedirect /></RequireAuth>} />
    <Route path="/admin" element={<RequirePlatform><AdminLayout /></RequirePlatform>}>
      <Route path="dashboard" element={<AdminDashboard />} />
      <Route path="workspaces" element={<Workspaces />} />
      <Route path="farms" element={<AdminFarms />} />
      <Route path="suspended" element={<Workspaces defaultStatusFilter="suspended" />} />
      <Route path="users" element={<Users />} />
      <Route path="subscriptions" element={<AdminSection title={t("layout.subscriptions")} description={t("adminSections.subscriptionsDescription")} emptyDescription={t("adminSections.subscriptionsDescription")} />} />
      <Route path="billing" element={<Billing />} />
      <Route path="audit-logs" element={<AuditLogs />} />
      <Route path="migration-import" element={<MigrationImport />} />
      <Route path="reports" element={<AdminSection title={t("layout.reports")} description={t("adminSections.reportsDescription")} emptyDescription={t("adminSections.reportsDescription")} />} />
      <Route path="settings" element={<Settings />} />
      <Route path="approvals" element={<AdminApprovalsPage />} />
    </Route>
    <Route path="/workspace" element={<RequireWorkspace><WorkspaceLayout /></RequireWorkspace>}>
      <Route path="dashboard" element={<WorkspaceDashboard />} />
      <Route path="attendance" element={<Attendance />} />
      <Route path="advances" element={<LabourAdvances />} />
      <Route path="sales" element={<Sales />} />
      <Route path="expenses" element={<Expenses />} />
      <Route path="dispatch" element={<Dispatch />} />
      <Route path="inventory" element={<Inventory />} />
      <Route path="labour-advances" element={<LabourAdvances />} />
      <Route path="reports" element={<Reports />} />
      <Route path="operations-map" element={config.featureFarmMap ? <FarmOperationsMap mode="live" /> : <FarmMapDisabledRedirect />} />
      <Route path="map-builder" element={config.featureFarmMap ? <FarmOperationsMap mode="builder" /> : <FarmMapDisabledRedirect />} />
      <Route path="team" element={<ModulePage module="workforce" />} />
      <Route path="settings" element={<Farms />} />
      <Route path="settings/team" element={<WorkspaceTeam />} />
      <Route path="settings/approvals" element={<WorkspaceApprovals />} />
      <Route path="farms" element={<Farms />} />
      <Route path=":workspaceId/farms/:farmId/map-builder" element={config.featureFarmMap ? <FarmOperationsMap mode="builder" /> : <FarmMapDisabledRedirect />} />
      <Route path=":workspaceId/farms/:farmId/operations-map" element={config.featureFarmMap ? <FarmOperationsMap mode="live" /> : <FarmMapDisabledRedirect />} />
      <Route path="seasons" element={<Seasons />} />
      <Route path="accounts" element={<ModulePage module="accounts" />} />
      <Route path="partner-ledger" element={<ModulePage module="partnerLedger" />} />
    </Route>
    {["workforce", "advances", "expenses", "sales", "dispatch", "inventory", "accounts", "partner-ledger", "farms", "seasons"].map((path) =>
      <Route key={path} path={`/${path}`} element={<Navigate to={`/workspace/${path === "workforce" ? "attendance" : path}`} replace />} />,
    )}
    <Route path="*" element={<RequireAuth><NotFoundPage /></RequireAuth>} />
  </Routes>;
}
