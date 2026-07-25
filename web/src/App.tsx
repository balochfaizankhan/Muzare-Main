import { lazy, Suspense, useEffect, type PropsWithChildren, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./auth/AuthProvider";
import { config } from "./config";
import type { AppUser } from "./lib/api";
import { getAccountStatusPath, getHomePath, isPlatformUser } from "./lib/permissions";
import { AccountRejectedPage } from "./pages/AccountRejectedPage";
import { AccountSuspendedPage } from "./pages/AccountSuspendedPage";
import { LoginPage } from "./pages/LoginPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { OnboardingPage } from "./pages/OnboardingPage";
import { PendingApprovalPage } from "./pages/PendingApprovalPage";
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
const AccountingReconciliationDebug = lazy(async () => ({ default: (await import("./pages/admin/AccountingReconciliationDebug")).AccountingReconciliationDebug }));
const WorkspaceAccountingReconciliationDebug = lazy(async () => ({ default: (await import("./pages/workspace/AccountingReconciliationDebug")).AccountingReconciliationDebug }));
const Attendance = lazy(async () => ({ default: (await import("./pages/workspace/Attendance")).Attendance }));
const Dispatch = lazy(async () => ({ default: (await import("./pages/workspace/Dispatch")).Dispatch }));
const Expenses = lazy(async () => ({ default: (await import("./pages/workspace/Expenses")).Expenses }));
const Inventory = lazy(async () => ({ default: (await import("./pages/workspace/Inventory")).Inventory }));
const LabourPaymentsReportsHub = lazy(async () => ({ default: (await import("./pages/workspace/WorkforceHub")).LabourPaymentsReportsHub }));
const LabourPaymentsSectionLayout = lazy(async () => ({ default: (await import("./pages/workspace/WorkforceHub")).LabourPaymentsSectionLayout }));
const WorkforcePaymentsPage = lazy(async () => ({ default: (await import("./pages/workspace/WorkforcePayments")).WorkforcePaymentsPage }));
const WageRates = lazy(async () => ({ default: (await import("./pages/workspace/WageRates")).WageRates }));
const WorkforceReportsHub = lazy(async () => ({ default: (await import("./pages/workspace/WorkforceHub")).WorkforceReportsHub }));
const WorkforceSectionLayout = lazy(async () => ({ default: (await import("./pages/workspace/WorkforceHub")).WorkforceSectionLayout }));
const LabourGroupsPage = lazy(async () => ({ default: (await import("./pages/workspace/LabourGroups")).LabourGroupsPage }));
const Reports = lazy(async () => ({ default: (await import("./pages/workspace/Reports")).Reports }));
const ActivityLog = lazy(async () => ({ default: (await import("./pages/workspace/ActivityLog")).ActivityLog }));
const Sales = lazy(async () => ({ default: (await import("./pages/workspace/Sales")).Sales }));
const WorkspaceDashboard = lazy(async () => ({ default: (await import("./pages/workspace/WorkspaceDashboard")).WorkspaceDashboard }));
const Farms = lazy(async () => ({ default: (await import("./pages/workspace/Farms")).Farms }));
const FarmOperationsMap = lazy(async () => ({ default: (await import("./pages/workspace/FarmOperationsMap")).FarmOperationsMap }));
const Seasons = lazy(async () => ({ default: (await import("./pages/workspace/Seasons")).Seasons }));
const HarvestSectionLayout = lazy(async () => ({ default: (await import("./pages/workspace/HarvestPerformance")).HarvestSectionLayout }));
const HarvestDashboardPage = lazy(async () => ({ default: (await import("./pages/workspace/HarvestPerformance")).HarvestDashboardPage }));
const HarvestEntryPage = lazy(async () => ({ default: (await import("./pages/workspace/HarvestPerformance")).HarvestEntryPage }));
const HarvestGroupsPage = lazy(async () => ({ default: (await import("./pages/workspace/HarvestPerformance")).HarvestGroupsPage }));
const HarvestReportsPage = lazy(async () => ({ default: (await import("./pages/workspace/HarvestPerformance")).HarvestReportsPage }));
const WorkspaceApprovals = lazy(async () => ({ default: (await import("./pages/workspace/WorkspaceApprovals")).WorkspaceApprovals }));
const WorkspaceTeam = lazy(async () => ({ default: (await import("./pages/workspace/WorkspaceTeam")).WorkspaceTeam }));

function StartupScreen({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="app-startup-screen" role="status" aria-live="polite">
      <div className="app-startup-shell">
        <aside className="app-startup-shell__sidebar" aria-hidden="true">
          <div className="app-startup-shell__brand app-skeleton" />
          <div className="app-startup-shell__nav">
            <span className="app-skeleton app-startup-shell__nav-item" />
            <span className="app-skeleton app-startup-shell__nav-item" />
            <span className="app-skeleton app-startup-shell__nav-item" />
            <span className="app-skeleton app-startup-shell__nav-item" />
          </div>
        </aside>
        <section className="app-startup-shell__body">
          <header className="app-startup-shell__header">
            <div>
              <div className="app-skeleton app-startup-shell__eyebrow" />
              <div className="app-skeleton app-startup-shell__title" />
            </div>
            <div className="app-skeleton app-startup-shell__status" />
          </header>
          <div className="app-startup-shell__hero app-skeleton" />
          <div className="app-startup-shell__cards">
            <div className="app-skeleton app-startup-shell__card" />
            <div className="app-skeleton app-startup-shell__card" />
            <div className="app-skeleton app-startup-shell__card" />
            <div className="app-skeleton app-startup-shell__card" />
          </div>
          <div className="app-startup-screen__copy">
            <strong>{title}</strong>
            <p>{detail}</p>
          </div>
        </section>
      </div>
    </div>
  );
}

function RouteFallback({ detailKey }: { detailKey: string }) {
  const { t } = useTranslation();
  return <StartupScreen title="Muzare" detail={detailKey ? t(detailKey) : t("common.loading")} />;
}

// `detailKey` is a translation key (routeLoading.*) rather than display text: this module renders
// route elements once at module scope, so the fallback component resolves the key with
// useTranslation at render time and stays in sync with language switches.
function routeElement(element: ReactNode, detailKey: string) {
  return <Suspense fallback={<RouteFallback detailKey={detailKey} />}>{element}</Suspense>;
}

function blockedRedirect(user: AppUser) {
  const blockedPath = getAccountStatusPath(user);
  return blockedPath ? <Navigate to={blockedPath} replace /> : null;
}

function RequireAuth({ children }: PropsWithChildren) {
  const { t } = useTranslation();
  const { user, loading } = useAuth();
  if (loading) return <StartupScreen title="Muzare" detail={t("sync.checkingSession")} />;
  if (!user) return <Navigate to="/login" replace />;
  return blockedRedirect(user) ?? children;
}

function RequirePlatform({ children }: PropsWithChildren) {
  const { t } = useTranslation();
  const { user, loading } = useAuth();
  if (loading) return <StartupScreen title="Muzare" detail={t("sync.checkingSession")} />;
  if (!user) return <Navigate to="/login" replace />;
  const blocked = blockedRedirect(user);
  if (blocked) return blocked;
  if (!isPlatformUser(user)) return <Navigate to="/workspace/dashboard" replace />;
  return children;
}

function RequireWorkspace({ children }: PropsWithChildren) {
  const { t } = useTranslation();
  const { user, loading } = useAuth();
  if (loading) return <StartupScreen title="Muzare" detail={t("sync.loadingWorkspace")} />;
  if (!user) return <Navigate to="/login" replace />;
  const blocked = blockedRedirect(user);
  if (blocked) return blocked;
  if (isPlatformUser(user)) return <Navigate to="/admin/dashboard" replace />;
  if (!user.workspaceId) return <Navigate to="/onboarding" replace />;
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
    <Route path="/pending-approval" element={<PendingApprovalPage />} />
    <Route path="/account-rejected" element={<AccountRejectedPage />} />
    <Route path="/account-suspended" element={<AccountSuspendedPage />} />
    <Route path="/onboarding" element={<RequireAuth><OnboardingPage /></RequireAuth>} />
    <Route path="/accept-invitation" element={<AcceptInvitationPage />} />
    <Route path="/" element={<RequireAuth><HomeRedirect /></RequireAuth>} />
    <Route path="/admin" element={<RequirePlatform>{routeElement(<AdminLayout />, "routeLoading.adminWorkspace")}</RequirePlatform>}>
      <Route path="dashboard" element={routeElement(<AdminDashboard />, "routeLoading.adminDashboard")} />
      <Route path="workspaces" element={routeElement(<Workspaces />, "routeLoading.workspaces")} />
      <Route path="farms" element={routeElement(<AdminFarms />, "routeLoading.farms")} />
      <Route path="suspended" element={routeElement(<Workspaces defaultStatusFilter="suspended" />, "routeLoading.workspaces")} />
      <Route path="users" element={routeElement(<Users />, "routeLoading.users")} />
      <Route path="subscriptions" element={routeElement(<AdminSection title={t("layout.subscriptions")} description={t("adminSections.subscriptionsDescription")} emptyDescription={t("adminSections.subscriptionsDescription")} />, "routeLoading.subscriptions")} />
      <Route path="billing" element={routeElement(<Billing />, "routeLoading.billing")} />
      <Route path="audit-logs" element={routeElement(<AuditLogs />, "routeLoading.auditLogs")} />
      <Route path="migration-import" element={routeElement(<MigrationImport />, "routeLoading.migrationImport")} />
      <Route path="accounting-diagnostics" element={routeElement(<AccountingDiagnostics />, "routeLoading.accountingDiagnostics")} />
      <Route path="accounting-reconciliation-debug" element={routeElement(<AccountingReconciliationDebug />, "routeLoading.accountingReconciliationTrace")} />
      <Route path="imports/:jobId" element={routeElement(<MigrationImport />, "routeLoading.importHistory")} />
      <Route path="reports" element={routeElement(<AdminSection title={t("layout.reports")} description={t("adminSections.reportsDescription")} emptyDescription={t("adminSections.reportsDescription")} />, "routeLoading.reports")} />
      <Route path="settings" element={routeElement(<Settings />, "routeLoading.settings")} />
      <Route path="approvals" element={routeElement(<AdminApprovalsPage />, "routeLoading.approvals")} />
    </Route>
    <Route path="/workspace" element={<RequireWorkspace>{routeElement(<WorkspaceLayout />, "routeLoading.workspaceShell")}</RequireWorkspace>}>
      <Route path="dashboard" element={routeElement(<WorkspaceDashboard />, "routeLoading.dashboard")} />
      <Route path="workforce" element={routeElement(<WorkforceSectionLayout />, "routeLoading.workforce")}>
        <Route index element={<Navigate to="labour" replace />} />
        <Route path="labour" element={routeElement(<ModulePage module="workforce" />, "routeLoading.labour")} />
        <Route path="labour-groups" element={routeElement(<LabourGroupsPage />, "routeLoading.labourGroups")} />
        <Route path="labour-groups/:groupId" element={routeElement(<LabourGroupsPage />, "routeLoading.labourGroup")} />
        <Route path="labour-groups/:groupId/members" element={routeElement(<LabourGroupsPage />, "routeLoading.labourGroupMembers")} />
        <Route path="attendance" element={routeElement(<Attendance />, "routeLoading.attendance")} />
        <Route path="reports" element={routeElement(<WorkforceReportsHub />, "routeLoading.workforceReports")} />
        <Route path="labour-payments" element={<Navigate to="/workspace/labour-payments/overview" replace />} />
      </Route>
      <Route path="labour-payments" element={routeElement(<LabourPaymentsSectionLayout />, "routeLoading.labourPayments")}>
        <Route index element={<Navigate to="overview" replace />} />
        <Route path="overview" element={routeElement(<WorkforcePaymentsPage />, "routeLoading.paymentsDue")} />
        <Route path="payments-due" element={<Navigate to="/workspace/labour-payments/overview" replace />} />
        <Route path="direct-due" element={routeElement(<WorkforcePaymentsPage />, "routeLoading.directLabourDue")} />
        <Route path="wage-rates" element={routeElement(<WageRates />, "routeLoading.wageRates")} />
        <Route path="vouchers" element={routeElement(<WorkforcePaymentsPage />, "routeLoading.labourPaymentVouchers")} />
        <Route path="advances" element={routeElement(<WorkforcePaymentsPage />, "routeLoading.outstandingAdvances")} />
        <Route path="legacy-earnings" element={<Navigate to="/workspace/labour-payments/direct-due" replace />} />
        <Route path="settlement-history" element={<Navigate to="/workspace/labour-payments/vouchers" replace />} />
        <Route path="legacy-advances" element={<Navigate to="/workspace/labour-payments/advances" replace />} />
        <Route path="earnings" element={<Navigate to="/workspace/labour-payments/direct-due" replace />} />
        <Route path="labour-work" element={<Navigate to="/workspace/labour-payments/direct-due" replace />} />
        <Route path="direct-payments" element={<Navigate to="/workspace/labour-payments/overview" replace />} />
        <Route path="settlements" element={<Navigate to="/workspace/labour-payments/direct-due?scope=group" replace />} />
        <Route path="settlement" element={<Navigate to="/workspace/labour-payments/direct-due?scope=group" replace />} />
        <Route path="reports" element={routeElement(<LabourPaymentsReportsHub />, "routeLoading.labourPaymentReports")} />
      </Route>
      <Route path="sales" element={routeElement(<Sales />, "routeLoading.sales")} />
      <Route path="expenses" element={routeElement(<Expenses />, "routeLoading.expenses")} />
      <Route path="expenses/new" element={routeElement(<Expenses />, "routeLoading.newExpenseVoucher")} />
      <Route path="expenses/vouchers" element={routeElement(<Expenses />, "routeLoading.expenseVouchers")} />
      <Route path="expenses/summary" element={routeElement(<Expenses />, "routeLoading.expenseSummary")} />
      <Route path="dispatch" element={routeElement(<Dispatch />, "routeLoading.dispatch")} />
      <Route path="inventory" element={routeElement(<Inventory />, "routeLoading.inventory")} />
      <Route path="harvest" element={routeElement(<HarvestSectionLayout />, "routeLoading.harvest")}>
        <Route index element={<Navigate to="dashboard" replace />} />
        <Route path="dashboard" element={routeElement(<HarvestDashboardPage />, "routeLoading.harvestDashboard")} />
        <Route path="entry" element={routeElement(<HarvestEntryPage />, "routeLoading.harvestEntry")} />
        <Route path="groups" element={routeElement(<HarvestGroupsPage />, "routeLoading.harvestGroups")} />
        <Route path="reports" element={routeElement(<HarvestReportsPage />, "routeLoading.harvestReports")} />
      </Route>
      <Route path="attendance" element={<Navigate to="/workspace/workforce/attendance" replace />} />
      <Route path="advances" element={<Navigate to="/workspace/labour-payments/advances" replace />} />
      <Route path="labour-advances" element={<Navigate to="/workspace/labour-payments/advances" replace />} />
      <Route path="labour-earnings" element={<Navigate to="/workspace/labour-payments/direct-due" replace />} />
      <Route path="wage-rates" element={<Navigate to="/workspace/labour-payments/wage-rates" replace />} />
      <Route path="wage-settlements" element={<Navigate to="/workspace/labour-payments/direct-due?scope=group" replace />} />
      <Route path="activity" element={routeElement(<ActivityLog />, "routeLoading.activityLog")} />
      <Route path="reports" element={routeElement(<Reports />, "routeLoading.reports")} />
      <Route path="operations-map" element={config.featureFarmMap ? routeElement(<FarmOperationsMap mode="live" />, "routeLoading.operationsMap") : <FarmMapDisabledRedirect />} />
      <Route path="map-builder" element={config.featureFarmMap ? routeElement(<FarmOperationsMap mode="builder" />, "routeLoading.mapBuilder") : <FarmMapDisabledRedirect />} />
      <Route path="team" element={<Navigate to="/workspace/workforce/labour" replace />} />
      <Route path="settings" element={routeElement(<Farms />, "routeLoading.workspaceSettings")} />
      <Route path="settings/team" element={routeElement(<WorkspaceTeam />, "routeLoading.workspaceTeam")} />
      <Route path="settings/approvals" element={routeElement(<WorkspaceApprovals />, "routeLoading.approvals")} />
      <Route path="farms" element={routeElement(<Farms />, "routeLoading.farms")} />
      <Route path=":workspaceId/farms/:farmId/map-builder" element={config.featureFarmMap ? routeElement(<FarmOperationsMap mode="builder" />, "routeLoading.mapBuilder") : <FarmMapDisabledRedirect />} />
      <Route path=":workspaceId/farms/:farmId/operations-map" element={config.featureFarmMap ? routeElement(<FarmOperationsMap mode="live" />, "routeLoading.operationsMap") : <FarmMapDisabledRedirect />} />
      <Route path="seasons" element={routeElement(<Seasons />, "routeLoading.seasons")} />
      <Route path="accounts" element={routeElement(<ModulePage module="accounts" />, "routeLoading.accounts")} />
      <Route path="partner-ledger" element={routeElement(<ModulePage module="partnerLedger" />, "routeLoading.partnerLedger")} />
    </Route>
    <Route path="/debug/accounting-reconciliation" element={<RequireAuth>{routeElement(<WorkspaceAccountingReconciliationDebug />, "routeLoading.accountingReconciliationTrace")}</RequireAuth>} />
    {["workforce", "advances", "wage-rates", "wage-settlements", "expenses", "sales", "dispatch", "inventory", "accounts", "partner-ledger", "farms", "seasons"].map((path) =>
      <Route key={path} path={`/${path}`} element={<Navigate to={`/workspace/${path === "workforce" ? "workforce/labour" : path}`} replace />} />,
    )}
    <Route path="*" element={<RequireAuth><NotFoundPage /></RequireAuth>} />
  </Routes>;
}
