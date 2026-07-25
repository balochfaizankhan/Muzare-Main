import { BarChart3, BookOpenText, Boxes, ClipboardList, CloudUpload, HandCoins, LayoutDashboard, LogOut, MoreHorizontal, PackageOpen, Plus, ReceiptText, RefreshCw, Satellite, Settings, ShoppingBasket, Sprout, Users, WalletCards, X, type LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { Brand } from "../components/Brand";
import { LanguageSwitch } from "../components/LanguageSwitch";
import { config } from "../config";
import type { PendingMutation } from "../lib/offline-db";
import { useSyncState } from "../hooks/useSyncState";
import { fetchBootstrap } from "../lib/api";
import { formatDate } from "../lib/format";
import { deriveWorkspaceDisplayStatus } from "../lib/workspaceStatus";
import { discardSyncQueueItem, getSyncQueueItems, refreshOperationalData, repairStaleSyncQueueItem, resolveSyncQueueItem, retrySyncQueueItem, startSyncService, stopSyncService, syncNow } from "../services/syncService";
import { setActiveWorkspaceId } from "../lib/offline-db";
import { hasModulePermission } from "../lib/permissions";
import { markStartup } from "../lib/startupPerf";

const nav = [
  ["/workspace/dashboard", "layout.dashboard", LayoutDashboard, "dashboard"],
  ["/workspace/workforce/labour", "layout.workforce", Users, "workforce"],
  ["/workspace/labour-payments/overview", "layout.labourPayments", WalletCards, "wages"],
  ["/workspace/sales", "layout.sales", ShoppingBasket, "sales"],
  ["/workspace/expenses", "layout.expenses", ReceiptText, "expenses"],
  ["/workspace/dispatch", "layout.dispatch", PackageOpen, "dispatch"],
  ["/workspace/inventory", "layout.inventory", Boxes, "inventory"],
  ["/workspace/harvest/dashboard", "layout.harvest", Sprout, "harvest"],
  ["/workspace/operations-map", "operationsMap", Satellite, "dashboard"],
  ["/workspace/reports", "layout.reports", BarChart3, "reports"],
  ["/workspace/accounts", "layout.accounts", BookOpenText, "accounts"],
  ["/workspace/settings", "layout.settings", Settings, "settings"],
] as const;

type MobileNavLink = { to: string; label: string; icon: LucideIcon };
type MobileNavAction = { action: "add" | "more"; label: string; icon: LucideIcon };

export function WorkspaceLayout() {
  const { t } = useTranslation();
  const { user, token, logout, switchWorkspace } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const sync = useSyncState();
  const [toast, setToast] = useState<string | null>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  const [queueItems, setQueueItems] = useState<PendingMutation[]>([]);
  const [mobileSheet, setMobileSheet] = useState<null | "add" | "more">(null);
  const bootstrap = useQuery({
    queryKey: ["bootstrap", user?.workspaceId, sync.farmId, sync.seasonId],
    queryFn: () => fetchBootstrap(token!),
    enabled: Boolean(user && token),
    retry: false,
  });
  useEffect(() => {
    setActiveWorkspaceId(user?.workspaceId ?? null);
  }, [user?.workspaceId]);
  useEffect(() => {
    if (token && user?.workspaceId) void startSyncService(token, user.workspaceId, bootstrap.data ?? null);
    return stopSyncService;
  }, [bootstrap.data, token, user?.workspaceId]);
  useEffect(() => {
    const reloadSeason = () => {
      if (token && user?.workspaceId) void startSyncService(token, user.workspaceId, bootstrap.data ?? null);
    };
    window.addEventListener("muzare-season-changed", reloadSeason);
    return () => window.removeEventListener("muzare-season-changed", reloadSeason);
  }, [bootstrap.data, token, user?.workspaceId]);
  useEffect(() => {
    const reloadFarm = () => {
      if (token && user?.workspaceId) void startSyncService(token, user.workspaceId, bootstrap.data ?? null);
    };
    window.addEventListener("muzare-farm-changed", reloadFarm);
    return () => window.removeEventListener("muzare-farm-changed", reloadFarm);
  }, [bootstrap.data, token, user?.workspaceId]);
  useEffect(() => {
    const showToast = (event: Event) => {
      setToast((event as CustomEvent<string>).detail);
      window.setTimeout(() => setToast(null), 4200);
    };
    window.addEventListener("muzare-toast", showToast);
    return () => window.removeEventListener("muzare-toast", showToast);
  }, []);
  useEffect(() => {
    if (!queueOpen) {
      setQueueItems([]);
      return;
    }
    const refreshQueue = () => { void getSyncQueueItems().then(setQueueItems); };
    void refreshQueue();
    window.addEventListener("muzare-local-data-change", refreshQueue);
    window.addEventListener("muzare-data-refresh", refreshQueue);
    return () => {
      window.removeEventListener("muzare-local-data-change", refreshQueue);
      window.removeEventListener("muzare-data-refresh", refreshQueue);
    };
  }, [queueOpen]);
  useEffect(() => {
    setMobileSheet(null);
  }, [location.pathname, location.search]);
  const workspaceStatus = deriveWorkspaceDisplayStatus({
    t,
    sync,
    bootstrap: bootstrap.data,
    bootstrapLoading: bootstrap.isLoading || (!bootstrap.data && bootstrap.isFetching),
    bootstrapLoaded: bootstrap.isSuccess,
    bootstrapErrored: bootstrap.isError,
  });
  useEffect(() => {
    if (bootstrap.isSuccess) {
      markStartup("workspace-bootstrap-ready", {
        workspaceId: user?.workspaceId,
        farmId: bootstrap.data?.activeFarmId ?? null,
        seasonId: bootstrap.data?.activeSeasonId ?? null,
      });
    }
  }, [bootstrap.data?.activeFarmId, bootstrap.data?.activeSeasonId, bootstrap.isSuccess, user?.workspaceId]);
  const statusText = workspaceStatus.tone === "offline"
    ? t("workspaceStatus.offlineLabel")
    : workspaceStatus.label;
  const startupVisible = sync.startupInProgress;
  const queueNeedsAttention = (sync.pendingCount ?? 0) > 0 || (sync.failedCount ?? 0) > 0;
  const isDashboardHome = location.pathname === "/workspace/dashboard";
  const filteredNav = nav
    .filter(([to]) => config.featureFarmMap || to !== "/workspace/operations-map")
    .filter(([to]) => config.featureInventory || to !== "/workspace/inventory")
    .filter(([, , , module]) => !user || hasModulePermission(user, module, "view"));
  const mobilePrimaryNav: Array<MobileNavLink | MobileNavAction> = [
    { to: "/workspace/dashboard", label: t("layout.mobileNavHome"), icon: LayoutDashboard },
    { to: "/workspace/workforce/labour", label: t("layout.mobileNavRecords"), icon: ClipboardList },
    { action: "add" as const, label: t("common.add"), icon: Plus },
    { to: "/workspace/reports", label: t("layout.reports"), icon: BarChart3 },
    { action: "more" as const, label: t("layout.mobileNavMore"), icon: MoreHorizontal },
  ];
  const quickAddRoutes = [
    "/workspace/dashboard",
    "/workspace/workforce/labour",
    "/workspace/reports",
    "/workspace/workforce/attendance",
    "/workspace/labour-payments/advances",
    "/workspace/expenses",
    "/workspace/dispatch",
    "/workspace/sales",
    "/workspace/operations-map",
  ];
  const mobileMoreLinks = filteredNav.filter(([to]) => !quickAddRoutes.includes(to));
  const mobileAddLinks = [
    { to: "/workspace/workforce/attendance", label: t("workforcePage.markAttendance"), icon: Users, allowed: !user || hasModulePermission(user, "attendance", "create") },
    { to: "/workspace/labour-payments/advances?action=record-advance", label: t("dashboard.recordAdvance"), icon: HandCoins, allowed: !user || hasModulePermission(user, "advances", "create") },
    { to: "/workspace/expenses/new", label: t("dashboard.newExpense"), icon: ReceiptText, allowed: !user || hasModulePermission(user, "expenses", "create") },
    { to: "/workspace/dispatch", label: t("dashboard.recordDispatch"), icon: PackageOpen, allowed: !user || hasModulePermission(user, "dispatch", "create") },
    { to: "/workspace/sales", label: t("dashboard.recordSale"), icon: ShoppingBasket, allowed: !user || hasModulePermission(user, "sales", "create") },
  ].filter((item) => item.allowed);
  const queueStatusLabel = (status?: PendingMutation["status"]) => {
    switch (status ?? "pending") {
      case "syncing": return t("sync.statusSyncing");
      case "failed": return t("sync.statusFailed");
      case "permission_denied": return t("sync.statusPermissionDenied");
      case "stale_context": return t("sync.statusStaleContext");
      case "resolved": return t("sync.statusResolved");
      case "discarded": return t("sync.statusDiscarded");
      default: return t("sync.statusPending");
    }
  };
  const formatQueueDateTime = (value?: string | null) => {
    if (!value) return "-";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : formatDate(date, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  };
  // Queue entities are raw offline-db table identifiers ("labourer", "voucher", ...); render
  // them through the syncQueue.entity dictionary, falling back to the raw value for any entity
  // added to offline-db before its label exists.
  const queueEntityLabel = (entity: PendingMutation["entity"]) => t(`syncQueue.entity.${entity}`, { defaultValue: entity });
  const queueOperationLabel = (operation: PendingMutation["operation"]) =>
    operation === "update" ? t("sync.actionUpdate") : operation === "delete" ? t("sync.actionDelete") : t("sync.actionCreate");
  return (
    <div className={`app-shell${isDashboardHome ? " app-shell--dashboard-home" : ""}`}>
      <aside className="app-sidebar">
        <Brand compact />
        <span className="shell-label">{user?.workspaceName ?? t("layout.workspace")}</span>
        <nav className="app-sidebar__desktop-nav">{filteredNav.map(([to, label, Icon]) => <NavLink to={to} key={to}><Icon size={17} />{t(label)}</NavLink>)}</nav>
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
              <button className={`sync-badge sync-badge--${workspaceStatus.tone}`} type="button" onClick={() => setQueueOpen((current) => !current)} aria-expanded={queueOpen} aria-label={t("sync.queueInspector")}>{statusText}</button>
            </div>
          </div>
          <div className="toolbar__actions shell-header__controls">
            <button className="shell-action shell-action--refresh" type="button" aria-label={t("layout.refresh")} onClick={() => void refreshOperationalData()}><RefreshCw size={16} /><span className="shell-action__desktop">{t("layout.refresh")}</span></button>
            <button className="shell-action shell-action--sync" type="button" aria-label={t("layout.syncNow")} onClick={() => void syncNow()}><CloudUpload size={16} /><span className="shell-action__desktop">{t("layout.syncNow")}</span><span className="shell-action__mobile">{t("layout.sync")}</span></button>
            <LanguageSwitch />
            <button className="ghost-icon shell-logout" aria-label={t("common.logout")} onClick={() => void logout()}><LogOut size={18} /></button>
          </div>
        </header>
        {startupVisible && (
          <section className="startup-progress-banner" role="status" aria-live="polite">
            <div className="startup-progress-banner__content">
              <strong>{sync.message ?? t("sync.loadingWorkspace")}</strong>
              <span>{sync.startupStage === "ready" ? t("sync.ready") : t("sync.openingWithBackgroundSync")}</span>
            </div>
            <div className="startup-progress-banner__steps" aria-hidden="true">
              <span className={sync.startupStage === "loadingWorkspace" || sync.startupStage === "loadingContext" || sync.startupStage === "syncingLatestRecords" || sync.startupStage === "ready" ? "is-complete" : ""}>{t("sync.loadingWorkspaceShort")}</span>
              <span className={sync.startupStage === "loadingContext" || sync.startupStage === "syncingLatestRecords" || sync.startupStage === "ready" ? "is-complete" : ""}>{t("sync.loadingFarmSeasonShort")}</span>
              <span className={sync.startupStage === "syncingLatestRecords" || sync.startupStage === "ready" ? "is-complete" : ""}>{t("sync.syncingLatestRecordsShort")}</span>
              <span className={sync.startupStage === "ready" ? "is-complete" : ""}>{t("sync.ready")}</span>
            </div>
          </section>
        )}
        {queueOpen && queueNeedsAttention && <section className="sync-queue-panel">
          <div className="sync-queue-panel__header">
            <div>
              <strong>{t("sync.queueInspector")}</strong>
              <p>{t("sync.queueSummary", { pending: sync.pendingCount ?? 0, failed: sync.failedCount ?? 0 })}</p>
            </div>
            <button type="button" onClick={() => setQueueOpen(false)}>{t("common.close")}</button>
          </div>
          {!queueItems.length ? <p className="sync-queue-panel__empty">{t("sync.noQueueItems")}</p> : <div className="sync-queue-list">
            {queueItems.map((item) => {
              const isDateTypeQueueItem = item.entity === "dateType";
              return (
              <article key={item.id} className={`sync-queue-item sync-queue-item--${item.status ?? "pending"}`}>
                <div className="sync-queue-item__meta">
                  <strong>{isDateTypeQueueItem ? t("sync.dateTypeSyncFailedTitle") : `${queueEntityLabel(item.entity)} · ${queueOperationLabel(item.operation)}`}</strong>
                  <span>{isDateTypeQueueItem ? t("sync.dateTypeSyncFailedDetail") : queueStatusLabel(item.status)}</span>
                </div>
                <div className="sync-queue-item__facts">
                  <p><span>{t("sync.typeLabel")}</span><strong>{isDateTypeQueueItem ? t("sync.dateTypeLabel") : queueEntityLabel(item.entity)}</strong></p>
                  <p><span>{t("sync.actionLabel")}</span><strong>{queueOperationLabel(item.operation)}</strong></p>
                  <p><span>{t("sync.createdAt")}</span><strong className="bidi-isolate">{formatQueueDateTime(item.createdAt)}</strong></p>
                  <p><span>{t("sync.lastAttemptedAt")}</span><strong className="bidi-isolate">{formatQueueDateTime(item.lastAttemptedAt)}</strong></p>
                  <p><span>{t("sync.retryCount")}</span><strong>{item.attempts}</strong></p>
                </div>
                {item.status === "permission_denied" ? <p className="sync-queue-item__error">{t("sync.permissionDeniedHint")}</p> : null}
                {item.status === "stale_context" ? <p className="sync-queue-item__error">{t("sync.staleContextHint")}</p> : null}
                <details className="sync-queue-item__technical">
                  <summary>{t("sync.technicalDetails")}</summary>
                  <div className="sync-queue-item__technical-body">
                    <p>{t("sync.queueItemId")}: <code className="bidi-isolate">{item.id}</code></p>
                    <p>{t("sync.clientRecordLabel")}: <code className="bidi-isolate">{typeof (item.payload as { id?: unknown })?.id === "string" ? (item.payload as { id: string }).id : "-"}</code></p>
                    <p>{t("layout.workspace")}: <code className="bidi-isolate">{item.workspaceId}</code></p>
                    <p>{t("attendanceImport.farm")}: <code className="bidi-isolate">{item.farmId ?? "-"}</code></p>
                    <p>{t("attendanceImport.season")}: <code className="bidi-isolate">{item.seasonId ?? "-"}</code></p>
                    {"errorStatus" in item && item.errorStatus ? <p>{t("sync.httpStatusLabel")}: <code className="bidi-isolate">{item.errorStatus}</code></p> : null}
                    {"errorCode" in item && item.errorCode ? <p>{t("sync.errorCodeLabel")}: <code className="bidi-isolate">{item.errorCode}</code></p> : null}
                    {item.lastError ? <p>{t("sync.lastError")}: <code className="bidi-isolate">{item.lastError}</code></p> : null}
                    {"errorMessage" in item && item.errorMessage ? <p>{t("sync.backendMessageLabel")}: <code className="bidi-isolate">{item.errorMessage}</code></p> : null}
                    {"errorDetails" in item && item.errorDetails && typeof item.errorDetails === "object" ? <pre className="sync-queue-item__details">{t("sync.detailsLabel")}: {JSON.stringify(item.errorDetails, null, 2)}</pre> : null}
                  </div>
                </details>
                <div className="sync-queue-item__actions">
                  {(isDateTypeQueueItem || (item.status !== "permission_denied" && item.status !== "stale_context")) && <button type="button" onClick={() => void retrySyncQueueItem(item.id).then(() => getSyncQueueItems().then(setQueueItems))}>{t("sync.retryItem")}</button>}
                  {isDateTypeQueueItem && <button type="button" onClick={() => void repairStaleSyncQueueItem(item.id).then(() => getSyncQueueItems().then(setQueueItems))}>{t("sync.repairStaleContext")}</button>}
                  {!isDateTypeQueueItem && <button type="button" onClick={() => void resolveSyncQueueItem(item.id).then(() => getSyncQueueItems().then(setQueueItems))}>{t("sync.markResolved")}</button>}
                  <button type="button" onClick={() => void discardSyncQueueItem(item.id).then(() => getSyncQueueItems().then(setQueueItems))}>{item.status === "permission_denied" ? t("sync.discardUnauthorizedChange") : t("sync.discardStaleItem")}</button>
                </div>
              </article>
            );
            })}
          </div>}
        </section>}
        {mobileSheet && (
          <div className="worker-action-backdrop app-mobile-sheet-backdrop" role="presentation" onClick={() => setMobileSheet(null)}>
            <section className="worker-action-dialog app-mobile-sheet" role="dialog" aria-modal="true" aria-label={mobileSheet === "add" ? t("layout.mobileSheetQuickAddAria") : t("layout.mobileSheetMoreAria")} onClick={(event) => event.stopPropagation()}>
              <header>
                <div>
                  <h2>{mobileSheet === "add" ? t("layout.mobileSheetCreateNew") : t("layout.mobileNavMore")}</h2>
                  <p>{mobileSheet === "add" ? t("layout.mobileSheetChooseToRecord") : t("layout.mobileSheetOpenModules")}</p>
                </div>
                <button type="button" onClick={() => setMobileSheet(null)} aria-label={t("common.close")}><X size={18} /></button>
              </header>
              <div className={`app-mobile-sheet__content${mobileSheet === "add" ? " app-mobile-sheet__content--grid" : ""}`}>
                {(mobileSheet === "add" ? mobileAddLinks : mobileMoreLinks.map(([to, label, Icon]) => ({ to, label: t(label), icon: Icon }))).map((item) => {
                  const Icon = item.icon;
                  return (
                    <button key={item.to} type="button" className="app-mobile-sheet__link" onClick={() => { setMobileSheet(null); navigate(item.to); }}>
                      <Icon size={18} />
                      <span>{item.label}</span>
                    </button>
                  );
                })}
              </div>
            </section>
          </div>
        )}
        <Outlet />
        {toast && <div className="saas-toast" role="status">{toast}</div>}
      </div>
      <nav className="app-mobile-bottom-nav" aria-label={t("layout.primaryMobileNavAria")}>
        {mobilePrimaryNav.map((item) => {
          if ("to" in item) {
            const Icon = item.icon;
            const routeTo = item.to;
            return <NavLink to={routeTo} key={routeTo} end={routeTo === "/workspace/dashboard"}><Icon size={18} /><span>{item.label}</span></NavLink>;
          }
          const Icon = item.icon;
          const active = item.action === "more"
            ? mobileMoreLinks.some(([to]) => location.pathname.startsWith(to))
            : mobileSheet === item.action;
          return (
            <button
              key={item.action}
              type="button"
              className={`app-mobile-bottom-nav__action${item.action === "add" ? " app-mobile-bottom-nav__action--add" : ""}${active ? " active" : ""}`}
              onClick={() => setMobileSheet((current) => current === item.action ? null : item.action)}
              aria-expanded={mobileSheet === item.action}
            >
              {item.action === "add" && mobileSheet === "add" ? <X size={18} /> : <Icon size={18} />}
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
