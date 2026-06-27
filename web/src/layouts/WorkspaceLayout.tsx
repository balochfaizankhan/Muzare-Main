import { BarChart3, BookOpenText, Boxes, CalendarCheck, CloudUpload, HandCoins, LayoutDashboard, LogOut, PackageOpen, ReceiptText, RefreshCw, Satellite, Settings, ShoppingBasket, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { Brand } from "../components/Brand";
import { LanguageSwitch } from "../components/LanguageSwitch";
import { config } from "../config";
import type { PendingMutation } from "../lib/offline-db";
import { useSyncState } from "../hooks/useSyncState";
import { discardSyncQueueItem, getSyncQueueItems, refreshOperationalData, resolveSyncQueueItem, retrySyncQueueItem, startSyncService, stopSyncService, syncNow } from "../services/syncService";
import { setActiveWorkspaceId } from "../lib/offline-db";
import { hasModulePermission } from "../lib/permissions";

const nav = [
  ["/workspace/dashboard", "layout.dashboard", LayoutDashboard, "dashboard"],
  ["/workspace/attendance", "layout.attendance", CalendarCheck, "attendance"],
  ["/workspace/sales", "layout.sales", ShoppingBasket, "sales"],
  ["/workspace/expenses", "layout.expenses", ReceiptText, "expenses"],
  ["/workspace/advances", "layout.advances", HandCoins, "advances"],
  ["/workspace/dispatch", "layout.dispatch", PackageOpen, "dispatch"],
  ["/workspace/inventory", "layout.inventory", Boxes, "inventory"],
  ["/workspace/operations-map", "operationsMap", Satellite, "dashboard"],
  ["/workspace/reports", "layout.reports", BarChart3, "reports"],
  ["/workspace/team", "layout.workforce", Users, "workforce"],
  ["/workspace/accounts", "layout.accounts", BookOpenText, "accounts"],
  ["/workspace/settings", "layout.settings", Settings, "settings"],
] as const;

export function WorkspaceLayout() {
  const { t } = useTranslation();
  const { user, token, logout, switchWorkspace } = useAuth();
  const sync = useSyncState();
  const [toast, setToast] = useState<string | null>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  const [queueItems, setQueueItems] = useState<PendingMutation[]>([]);
  useEffect(() => {
    setActiveWorkspaceId(user?.workspaceId ?? null);
  }, [user?.workspaceId]);
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
  useEffect(() => {
    const refreshQueue = () => { void getSyncQueueItems().then(setQueueItems); };
    void refreshQueue();
    window.addEventListener("muzare-local-data-change", refreshQueue);
    window.addEventListener("muzare-data-refresh", refreshQueue);
    return () => {
      window.removeEventListener("muzare-local-data-change", refreshQueue);
      window.removeEventListener("muzare-data-refresh", refreshQueue);
    };
  }, []);
  const statusText = sync.status === "offline"
    ? t("layout.workingOffline")
    : sync.status === "syncing"
      ? t("layout.syncing")
      : sync.status === "error"
        ? t("layout.syncFailed")
        : sync.pendingCount
          ? t("layout.changesWaiting", { count: sync.pendingCount })
          : t("layout.synced");
  const startupVisible = sync.startupInProgress || Boolean(sync.message && sync.startupStage && sync.startupStage !== "ready");
  const queueNeedsAttention = (sync.pendingCount ?? 0) > 0 || (sync.failedCount ?? 0) > 0;
  const queueStatusLabel = (status?: PendingMutation["status"]) => {
    switch (status ?? "pending") {
      case "syncing": return t("sync.statusSyncing");
      case "failed": return t("sync.statusFailed");
      case "permission_denied": return t("sync.statusPermissionDenied");
      case "resolved": return t("sync.statusResolved");
      case "discarded": return t("sync.statusDiscarded");
      default: return t("sync.statusPending");
    }
  };
  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <Brand compact />
        <span className="shell-label">{user?.workspaceName ?? t("layout.workspace")}</span>
        <nav>{nav
          .filter(([to]) => config.featureFarmMap || to !== "/workspace/operations-map")
          .filter(([to]) => config.featureInventory || to !== "/workspace/inventory")
          .filter(([, , , module]) => !user || hasModulePermission(user, module, "view"))
          .map(([to, label, Icon]) => <NavLink to={to} key={to}><Icon size={17} />{t(label)}</NavLink>)}</nav>
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
              <button className={`sync-badge sync-badge--${sync.status}`} type="button" onClick={() => setQueueOpen((current) => !current)} aria-expanded={queueOpen} aria-label={t("sync.queueInspector")}>{statusText}</button>
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
            {queueItems.map((item) => (
              <article key={item.id} className={`sync-queue-item sync-queue-item--${item.status ?? "pending"}`}>
                <div className="sync-queue-item__meta">
                  <strong>{item.entity} · {item.operation}</strong>
                  <span>{queueStatusLabel(item.status)}</span>
                </div>
                <p>{t("sync.queueItemId")}: {item.id}</p>
                <p>Client record: {typeof (item.payload as { id?: unknown })?.id === "string" ? (item.payload as { id: string }).id : "-"}</p>
                <p>Workspace: {item.workspaceId}</p>
                <p>Farm: {item.farmId ?? "-"}</p>
                <p>Season: {item.seasonId ?? "-"}</p>
                <p>{t("sync.createdAt")}: {new Date(item.createdAt).toLocaleString()}</p>
                <p>{t("sync.retryCount")}: {item.attempts}</p>
                {item.lastAttemptedAt ? <p>{t("sync.lastAttemptedAt")}: {new Date(item.lastAttemptedAt).toLocaleString()}</p> : null}
                {item.status === "permission_denied" ? <p className="sync-queue-item__error">{t("sync.permissionDeniedHint")}</p> : null}
                {item.lastError ? <p className="sync-queue-item__error">{t("sync.lastError")}: {item.lastError}</p> : null}
                <div className="sync-queue-item__actions">
                  {item.status !== "permission_denied" && <button type="button" onClick={() => void retrySyncQueueItem(item.id).then(() => getSyncQueueItems().then(setQueueItems))}>{t("sync.retryItem")}</button>}
                  <button type="button" onClick={() => void resolveSyncQueueItem(item.id).then(() => getSyncQueueItems().then(setQueueItems))}>{t("sync.markResolved")}</button>
                  <button type="button" onClick={() => void discardSyncQueueItem(item.id).then(() => getSyncQueueItems().then(setQueueItems))}>{item.status === "permission_denied" ? t("sync.discardUnauthorizedChange") : t("sync.discardStaleItem")}</button>
                </div>
              </article>
            ))}
          </div>}
        </section>}
        <Outlet />
        {toast && <div className="saas-toast" role="status">{toast}</div>}
      </div>
    </div>
  );
}
