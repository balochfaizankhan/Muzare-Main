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
  sync: SyncState;
  bootstrap?: BootstrapData;
  bootstrapLoading: boolean;
  bootstrapLoaded: boolean;
  bootstrapErrored?: boolean;
};

export function deriveWorkspaceDisplayStatus({
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

  if (sync.status === "error" || bootstrapErrored) {
    return {
      tone: "error",
      label: "Sync Failed",
      note: "Sync needs attention.",
      heroStatus: "Sync failed",
      heroCopy: "We could not finish syncing your latest workspace data.",
      hydrationPending,
      bootstrapLoaded,
      hasFarm,
      hasSeason,
      hasOperationalContext,
      setupRequired,
      selectedFarmLabel: hydrationPending ? "Loading farm..." : (farm?.name ?? "No farm available"),
      selectedSeasonLabel: hydrationPending ? "Loading season..." : (season?.name ?? (hasFarm ? "No active season" : "Create a farm first")),
    };
  }

  if (hydrationPending) {
    return {
      tone: "loading",
      label: "Loading...",
      note: "Preparing workspace context",
      heroStatus: "Loading workspace",
      heroCopy: "Preparing your farm overview...",
      hydrationPending,
      bootstrapLoaded,
      hasFarm,
      hasSeason,
      hasOperationalContext,
      setupRequired,
      selectedFarmLabel: "Loading farm...",
      selectedSeasonLabel: "Loading season...",
    };
  }

  if (sync.status === "offline") {
    return {
      tone: "offline",
      label: "Offline",
      note: "Working offline with local data.",
      heroStatus: "Offline",
      heroCopy: "Changes will stay local until connectivity returns.",
      hydrationPending,
      bootstrapLoaded,
      hasFarm,
      hasSeason,
      hasOperationalContext,
      setupRequired,
      selectedFarmLabel: farm?.name ?? "No farm available",
      selectedSeasonLabel: season?.name ?? (hasFarm ? "No active season" : "Create a farm first"),
    };
  }

  if (syncInProgress) {
    const pendingCount = sync.pendingCount ?? 0;
    return {
      tone: "syncing",
      label: "Syncing...",
      note: pendingCount > 0 ? `${pendingCount} change${pendingCount === 1 ? "" : "s"} waiting to sync.` : "Syncing the latest workspace records.",
      heroStatus: "Syncing",
      heroCopy: pendingCount > 0 ? `${pendingCount} change${pendingCount === 1 ? "" : "s"} still needs to sync.` : "Syncing the latest workspace records.",
      hydrationPending,
      bootstrapLoaded,
      hasFarm,
      hasSeason,
      hasOperationalContext,
      setupRequired,
      selectedFarmLabel: farm?.name ?? "No farm available",
      selectedSeasonLabel: season?.name ?? (hasFarm ? "No active season" : "Create a farm first"),
    };
  }

  if (setupRequired) {
    const missingSeason = hasFarm && !hasSeason;
    return {
      tone: "setup",
      label: "Setup required",
      note: missingSeason ? "No season selected yet." : "No farm selected yet.",
      heroStatus: "Setup required",
      heroCopy: missingSeason ? "Select or create a season to unlock the full overview." : "Select or create a farm to unlock the full overview.",
      hydrationPending,
      bootstrapLoaded,
      hasFarm,
      hasSeason,
      hasOperationalContext,
      setupRequired,
      selectedFarmLabel: farm?.name ?? "No farm available",
      selectedSeasonLabel: season?.name ?? (hasFarm ? "No active season" : "Create a farm first"),
    };
  }

  return {
    tone: "synced",
    label: "Synced",
    note: "Workspace is synced and ready for today.",
    heroStatus: "Ready",
    heroCopy: "Workspace is synced and ready for today.",
    hydrationPending,
    bootstrapLoaded,
    hasFarm,
    hasSeason,
    hasOperationalContext,
    setupRequired,
    selectedFarmLabel: farm?.name ?? "No farm available",
    selectedSeasonLabel: season?.name ?? (hasFarm ? "No active season" : "Create a farm first"),
  };
}
