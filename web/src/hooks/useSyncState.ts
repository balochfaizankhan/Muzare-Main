import { useEffect, useState } from "react";
import { getLastSyncTime, subscribeSyncState, type SyncState } from "../services/syncService";

export function useSyncState() {
  const [state, setState] = useState<SyncState>({ status: navigator.onLine ? "online" : "offline", pendingCount: 0, lastSyncTime: getLastSyncTime() });
  useEffect(() => subscribeSyncState(setState), []);
  return state;
}
