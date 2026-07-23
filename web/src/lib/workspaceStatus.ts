import type { TFunction } from "i18next";
import type { BootstrapData } from "./api";
import type { SyncState } from "../services/syncService";

export type WorkspaceDisplayTone = "loading" | "syncing" | "setup" | "synced" | "error" | "offline";

export type WorkspaceDisplayStatus = {
  tone: WorkspaceDisplayTone;
  label: string;
  note: string;
  heroStatus: string;
  heroCopy: string;
  hydrationPending: boolean;
  bootstrapLoaded: boolean;
  hasFarm: boolean;
  hasSeason: boolean;
  hasOperationalContext: boolean;
  setupRequired: boolean;
  selectedFarmLabel: string;
  selectedSeasonLabel: string;
};

type WorkspaceDisplayStatusInput = {
  t: TFunction;
  sync: SyncState;
  bootstrap?: BootstrapData;
  bootstrapLoading: boolean;
  bootstrapLoaded: boolean;
  bootstrapErrored?: boolean;
};

export function deriveWorkspaceDisplayStatus({
  t,
  sync,
  bootstrap,
  bootstrapLoading,
  bootstrapLoaded,
  bootstrapErrored = false,
}: WorkspaceDisplayStatusInput): WorkspaceDisplayStatus {
  const farm = bootstrap?.farms.find((item) => item.id === bootstrap.activeFarmId) ?? null;
  const season = bootstrap?.seasons.find((item) => item.id === bootstrap.activeSeasonId) ?? null;
  const hasFarm = Boolean(farm);
  const hasSeason = Boolean(season);
  const hasOperationalContext = hasFarm && hasSeason;
  const hydrationPending = bootstrapLoading
    || !bootstrapLoaded
    || sync.startupStage === "loadingWorkspace"
    || sync.startupStage === "loadingContext";
  const setupRequired = bootstrapLoaded && !hydrationPending && (!hasFarm || !hasSeason);
  const syncInProgress = sync.status === "syncing" || (sync.pendingCount ?? 0) > 0 || sync.startupStage === "syncingLatestRecords";
  const noFarmSelectedShort = t("workspaceStatus.noFarmAvailableShort");
  const noSeasonSelectedShort = hasFarm ? t("workspaceStatus.noActiveSeasonShort") : t("workspaceStatus.createFarmFirstShort");

  if (sync.status === "error" || bootstrapErrored) {
    return {
      tone: "error",
      label: t("workspaceStatus.syncFailedLabel"),
      note: t("workspaceStatus.syncNeedsAttention"),
      heroStatus: t("workspaceStatus.heroSyncFailed"),
      heroCopy: t("workspaceStatus.heroSyncFailedCopy"),
      hydrationPending,
      bootstrapLoaded,
      hasFarm,
      hasSeason,
      hasOperationalContext,
      setupRequired,
      selectedFarmLabel: hydrationPending ? t("workspaceStatus.loadingFarmEllipsis") : (farm?.name ?? noFarmSelectedShort),
      selectedSeasonLabel: hydrationPending ? t("workspaceStatus.loadingSeasonEllipsis") : (season?.name ?? noSeasonSelectedShort),
    };
  }

  if (hydrationPending) {
    return {
      tone: "loading",
      label: t("workspaceStatus.loadingLabel"),
      note: t("workspaceStatus.preparingWorkspaceContext"),
      heroStatus: t("workspaceStatus.heroLoadingWorkspace"),
      heroCopy: t("workspaceStatus.heroPreparingOverview"),
      hydrationPending,
      bootstrapLoaded,
      hasFarm,
      hasSeason,
      hasOperationalContext,
      setupRequired,
      selectedFarmLabel: t("workspaceStatus.loadingFarmEllipsis"),
      selectedSeasonLabel: t("workspaceStatus.loadingSeasonEllipsis"),
    };
  }

  if (sync.status === "offline") {
    return {
      tone: "offline",
      label: t("workspaceStatus.offlineLabel"),
      note: t("workspaceStatus.workingOfflineLocalData"),
      heroStatus: t("workspaceStatus.offlineLabel"),
      heroCopy: t("workspaceStatus.heroOfflineCopy"),
      hydrationPending,
      bootstrapLoaded,
      hasFarm,
      hasSeason,
      hasOperationalContext,
      setupRequired,
      selectedFarmLabel: farm?.name ?? noFarmSelectedShort,
      selectedSeasonLabel: season?.name ?? noSeasonSelectedShort,
    };
  }

  if (syncInProgress) {
    const pendingCount = sync.pendingCount ?? 0;
    return {
      tone: "syncing",
      label: t("workspaceStatus.syncingLabel"),
      note: pendingCount > 0 ? t("workspaceStatus.changeWaitingToSync", { count: pendingCount }) : t("workspaceStatus.syncingLatestRecords"),
      heroStatus: t("workspaceStatus.heroSyncing"),
      heroCopy: pendingCount > 0 ? t("workspaceStatus.changeStillNeedsSync", { count: pendingCount }) : t("workspaceStatus.syncingLatestRecords"),
      hydrationPending,
      bootstrapLoaded,
      hasFarm,
      hasSeason,
      hasOperationalContext,
      setupRequired,
      selectedFarmLabel: farm?.name ?? noFarmSelectedShort,
      selectedSeasonLabel: season?.name ?? noSeasonSelectedShort,
    };
  }

  if (setupRequired) {
    const missingSeason = hasFarm && !hasSeason;
    return {
      tone: "setup",
      label: t("workspaceStatus.setupRequiredLabel"),
      note: missingSeason ? t("workspaceStatus.noSeasonSelectedYet") : t("workspaceStatus.noFarmSelectedYet"),
      heroStatus: t("workspaceStatus.setupRequiredLabel"),
      heroCopy: missingSeason ? t("workspaceStatus.selectSeasonToUnlock") : t("workspaceStatus.selectFarmToUnlock"),
      hydrationPending,
      bootstrapLoaded,
      hasFarm,
      hasSeason,
      hasOperationalContext,
      setupRequired,
      selectedFarmLabel: farm?.name ?? noFarmSelectedShort,
      selectedSeasonLabel: season?.name ?? noSeasonSelectedShort,
    };
  }

  return {
    tone: "synced",
    label: t("workspaceStatus.syncedLabel"),
    note: t("workspaceStatus.workspaceSyncedReady"),
    heroStatus: t("workspaceStatus.heroReady"),
    heroCopy: t("workspaceStatus.workspaceSyncedReady"),
    hydrationPending,
    bootstrapLoaded,
    hasFarm,
    hasSeason,
    hasOperationalContext,
    setupRequired,
    selectedFarmLabel: farm?.name ?? noFarmSelectedShort,
    selectedSeasonLabel: season?.name ?? noSeasonSelectedShort,
  };
}
