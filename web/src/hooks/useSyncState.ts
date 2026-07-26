import { useEffect, useState } from "react";
import { getLastSyncTime, subscribeSyncState, type SyncState } from "../services/syncService";

function presentSyncState(next: SyncState): SyncState {
  const cachedContextReady = Boolean(next.farmId && next.seasonId);
  if (!cachedContextReady || !next.startupInProgress) return next;
  return { ...next, startupStage: "ready", startupInProgress: false };
}

export function useSyncState() {
  const [state, setState] = useState<SyncState>({ status: navigator.onLine ? "online" : "offline", pendingCount: 0, lastSyncTime: getLastSyncTime() });
  useEffect(() => subscribeSyncState((next) => setState(presentSyncState(next))), []);
  return state;
}
