import { lazy, Suspense, useEffect, type PropsWithChildren, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./auth/AuthProvider";
import { config } from "./config";
import { getHomePath, isPlatformUser } from "./lib/permissions";
import { LoginPage } from "./pages/LoginPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { SignupPage } from "./pages/SignupPage";
import { AcceptInvitationPage } from "./pages/AcceptInvitationPage";

const AdminLayout = lazy(async () => ({ default: (await import("./layouts/AdminLayout")).AdminLayout }));
const WorkspaceLayout = lazy(async () => ({ default: (await import("./layouts/WorkspaceLayout")).WorkspaceLayout }));
const AdminApprovalsPage = lazy(async () => ({ default: (await import("./pages/AdminApprovalsPage")).AdminApprovalsPage }));
const ModulePage = lazy(async () => ({ default: (await import("./pages/ModulePage")).ModulePage }));
const AdminDashboard = lazy(async () => ({ default: (await import("./pages/admin/AdminDashboard")).AdminDashboard }));
const AdminSection = lazy(async () => ({ default: (await import("./pages/admin/AdminSection")).AdminSection }));
const AuditLogs = lazy(async () => ({ default: (await import("./pages/admin/AuditLogs")).AuditLogs }));
const Billing = lazy(async () => ({ default: (await import("./pages/admin/Billing")).Billing }));
const AdminFarms = lazy(async () => ({ default: (await import("./pages/admin/Farms")).AdminFarms }));
const Settings = lazy(async () => ({ default: (await import("./pages/admin/Settings")).Settings }));
const Users = lazy(async () => ({ default: (await import("./pages/admin/Users")).Users }));
const Workspaces = lazy(async () => ({ default: (await import("./pages/admin/Workspaces")).Workspaces }));
const MigrationImport = lazy(async () => ({ default: (await import("./pages/admin/MigrationImport")).MigrationImport }));
const AccountingDiagnostics = lazy(async () => ({ default: (await import("./pages/admin/AccountingDiagnostics")).AccountingDiagnostics }));
const Attendance = lazy(async () => ({ default: (await import("./pages/workspace/Attendance")).Attendance }));
const Dispatch = lazy(async () => ({ default: (await import("./pages/workspace/Dispatch")).Dispatch }));
const Expenses = lazy(async () => ({ default: (await import("./pages/workspace/Expenses")).Expenses }));
const Inventory = lazy(async () => ({ default: (await import("./pages/workspace/Inventory")).Inventory }));
const LabourAdvances = lazy(async () => ({ default: (await import("./pages/workspace/LabourAdvances")).LabourAdvances }));
const WageRates = lazy(async () => ({ default: (await import("./pages/workspace/WageRates")).WageRates }));
const Reports = lazy(async () => ({ default: (await import("./pages/workspace/Reports")).Reports }));
const Sales = lazy(async () => ({ default: (await import("./pages/workspace/Sales")).Sales }));
const WorkspaceDashboard = lazy(async () => ({ default: (await import("./pages/workspace/WorkspaceDashboard")).WorkspaceDashboard }));
const Farms = lazy(async () => ({ default: (await import("./pages/workspace/Farms")).Farms }));
const FarmOperationsMap = lazy(async () => ({ default: (await import("./pages/workspace/FarmOperationsMap")).FarmOperationsMap }));
const Seasons = lazy(async () => ({ default: (await import("./pages/workspace/Seasons")).Seasons }));
const WorkspaceApprovals = lazy(async () => ({ default: (await import("./pages/workspace/WorkspaceApprovals")).WorkspaceApprovals }));
const WorkspaceTeam = lazy(async () => ({ default: (await import("./pages/workspace/WorkspaceTeam")).WorkspaceTeam }));

function StartupScreen({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="app-startup-screen" role="status" aria-live="polite">
      <div className="app-startup-screen__card">
        <div className="app-startup-screen__spinner" aria-hidden="true" />
        <strong>{title}</strong>
        <p>{detail}</p>
      </div>
    </div>
  );
}

function RouteFallback({ detail }: { detail: string }) {
  const { t } = useTranslation();
  return <StartupScreen title="Muzare" detail={detail || t("common.loading")} />;
}

function routeElement(element: ReactNode, detail: string) {
  return <Suspense fallback={<RouteFallback detail={detail} />}>{element}</Suspense>;
}

function RequireAuth({ children }: PropsWithChildren) {
  const { t } = useTranslation();
  const { user, loading } = useAuth();
  if (loading) return <StartupScreen title="Muzare" detail={t("sync.checkingSession")} />;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

function RequirePlatform({ children }: PropsWithChildren) {
  const { t } = useTranslation();
  const { user, loading } = useAuth();
  if (loading) return <StartupScreen title="Muzare" detail={t("sync.checkingSession")} />;
  if (!user) return <Navigate to="/login" replace />;
  if (!isPlatformUser(user)) return <Navigate to="/workspace/dashboard" replace />;
  return children;
}

function RequireWorkspace({ children }: PropsWithChildren) {
  const { t } = useTranslation();
  const { user, loading } = useAuth();
  if (loading) return <StartupScreen title="Muzare" detail={t("sync.loadingWorkspace")} />;
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
    <Route path="/admin" element={<RequirePlatform>{routeElement(<AdminLayout />, "Loading admin workspace")}</RequirePlatform>}>
      <Route path="dashboard" element={routeElement(<AdminDashboard />, "Loading admin dashboard")} />
      <Route path="workspaces" element={routeElement(<Workspaces />, "Loading workspaces")} />
      <Route path="farms" element={routeElement(<AdminFarms />, "Loading farms")} />
      <Route path="suspended" element={routeElement(<Workspaces defaultStatusFilter="suspended" />, "Loading workspaces")} />
      <Route path="users" element={routeElement(<Users />, "Loading users")} />
      <Route path="subscriptions" element={routeElement(<AdminSection title={t("layout.subscriptions")} description={t("adminSections.subscriptionsDescription")} emptyDescription={t("adminSections.subscriptionsDescription")} />, "Loading subscriptions")} />
      <Route path="billing" element={routeElement(<Billing />, "Loading billing")} />
      <Route path="audit-logs" element={routeElement(<AuditLogs />, "Loading audit logs")} />
      <Route path="migration-import" element={routeElement(<MigrationImport />, "Loading migration import")} />
      <Route path="accounting-diagnostics" element={routeElement(<AccountingDiagnostics />, "Loading accounting diagnostics")} />
      <Route path="imports/:jobId" element={routeElement(<MigrationImport />, "Loading import history")} />
      <Route path="reports" element={routeElement(<AdminSection title={t("layout.reports")} description={t("adminSections.reportsDescription")} emptyDescription={t("adminSections.reportsDescription")} />, "Loading reports")} />
      <Route path="settings" element={routeElement(<Settings />, "Loading settings")} />
      <Route path="approvals" element={routeElement(<AdminApprovalsPage />, "Loading approvals")} />
    </Route>
    <Route path="/workspace" element={<RequireWorkspace>{routeElement(<WorkspaceLayout />, "Loading workspace shell")}</RequireWorkspace>}>
      <Route path="dashboard" element={routeElement(<WorkspaceDashboard />, "Loading dashboard")} />
      <Route path="attendance" element={routeElement(<Attendance />, "Loading attendance")} />
      <Route path="advances" element={routeElement(<LabourAdvances />, "Loading advances")} />
      <Route path="wage-rates" element={routeElement(<WageRates />, "Loading wage rates")} />
      <Route path="sales" element={routeElement(<Sales />, "Loading sales")} />
      <Route path="expenses" element={routeElement(<Expenses />, "Loading expenses")} />
      <Route path="dispatch" element={routeElement(<Dispatch />, "Loading dispatch")} />
      <Route path="inventory" element={routeElement(<Inventory />, "Loading inventory")} />
      <Route path="labour-advances" element={routeElement(<LabourAdvances />, "Loading advances")} />
      <Route path="reports" element={routeElement(<Reports />, "Loading reports")} />
      <Route path="operations-map" element={config.featureFarmMap ? routeElement(<FarmOperationsMap mode="live" />, "Loading operations map") : <FarmMapDisabledRedirect />} />
      <Route path="map-builder" element={config.featureFarmMap ? routeElement(<FarmOperationsMap mode="builder" />, "Loading map builder") : <FarmMapDisabledRedirect />} />
      <Route path="team" element={routeElement(<ModulePage module="workforce" />, "Loading workforce")} />
      <Route path="settings" element={routeElement(<Farms />, "Loading workspace settings")} />
      <Route path="settings/team" element={routeElement(<WorkspaceTeam />, "Loading workspace team")} />
      <Route path="settings/approvals" element={routeElement(<WorkspaceApprovals />, "Loading approvals")} />
      <Route path="farms" element={routeElement(<Farms />, "Loading farms")} />
      <Route path=":workspaceId/farms/:farmId/map-builder" element={config.featureFarmMap ? routeElement(<FarmOperationsMap mode="builder" />, "Loading map builder") : <FarmMapDisabledRedirect />} />
      <Route path=":workspaceId/farms/:farmId/operations-map" element={config.featureFarmMap ? routeElement(<FarmOperationsMap mode="live" />, "Loading operations map") : <FarmMapDisabledRedirect />} />
      <Route path="seasons" element={routeElement(<Seasons />, "Loading seasons")} />
      <Route path="accounts" element={routeElement(<ModulePage module="accounts" />, "Loading accounts")} />
      <Route path="partner-ledger" element={routeElement(<ModulePage module="partnerLedger" />, "Loading partner ledger")} />
    </Route>
    {["workforce", "advances", "wage-rates", "expenses", "sales", "dispatch", "inventory", "accounts", "partner-ledger", "farms", "seasons"].map((path) =>
      <Route key={path} path={`/${path}`} element={<Navigate to={`/workspace/${path === "workforce" ? "attendance" : path}`} replace />} />,
    )}
    <Route path="*" element={<RequireAuth><NotFoundPage /></RequireAuth>} />
  </Routes>;
}
