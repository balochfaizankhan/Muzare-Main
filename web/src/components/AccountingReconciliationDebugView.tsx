import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { BuildDiagnostics } from "./BuildDiagnostics";
import { useAuth } from "../auth/AuthProvider";
import { config } from "../config";
import { fetchAccountingReconciliationTrace } from "../lib/api";
import { getReconciliationDebugRuntime } from "../lib/reconciliationDebug";
import { useSyncState } from "../hooks/useSyncState";

const defaultAccountName = "Younis Khan";

type DebugMode = "admin" | "workspace";

export function AccountingReconciliationDebugView({ mode }: { mode: DebugMode }) {
  const { token, user } = useAuth();
  const sync = useSyncState();
  const [accountName, setAccountName] = useState(defaultAccountName);
  const [workspaceId, setWorkspaceId] = useState("");
  const [farmId, setFarmId] = useState("");
  const [seasonId, setSeasonId] = useState("");
  const runtime = useMemo(() => getReconciliationDebugRuntime(), []);
  const isAdmin = user?.platformRole === "platform_admin";
  const dbBackedSession = Boolean(token && (user?.workspaceId || isAdmin));
  const resolvedWorkspaceId = mode === "admin" ? workspaceId.trim() : (user?.workspaceId ?? "").trim();
  const resolvedFarmId = mode === "admin" ? farmId.trim() : (sync.farmId ?? "").trim();
  const resolvedSeasonId = mode === "admin" ? seasonId.trim() : (sync.seasonId ?? "").trim();
  const canRunTrace = runtime.isDebugEnabled && Boolean(token) && (mode === "workspace" ? Boolean(resolvedWorkspaceId && resolvedFarmId && resolvedSeasonId) : Boolean(isAdmin && resolvedWorkspaceId && resolvedFarmId && resolvedSeasonId));
  const trace = useQuery({
    queryKey: ["accounting-reconciliation-trace", mode, accountName, resolvedWorkspaceId, resolvedFarmId, resolvedSeasonId],
    enabled: false,
    queryFn: () => fetchAccountingReconciliationTrace(token!, {
      accountName,
      workspaceId: resolvedWorkspaceId || undefined,
      farmId: resolvedFarmId || undefined,
      seasonId: resolvedSeasonId || undefined,
    }),
  });

  useEffect(() => {
    if (!runtime.isDebugEnabled && !isAdmin) return;
    console.info("[accounting-reconciliation-debug]", {
      appEnv: runtime.appEnv,
      enableFlag: runtime.enableFlag,
      hostname: runtime.hostname,
      hostnameEnabled: runtime.hostnameEnabled,
      envEnabled: runtime.envEnabled,
      flagEnabled: runtime.flagEnabled,
      isAdmin,
      isDebugEnabled: runtime.isDebugEnabled,
      apiBaseUrl: config.apiUrl,
      userId: user?.id ?? null,
      userRole: user?.platformRole ?? null,
      workspaceId: resolvedWorkspaceId || null,
      farmId: resolvedFarmId || null,
      seasonId: resolvedSeasonId || null,
      dbBackedSession,
    });
  }, [dbBackedSession, isAdmin, resolvedFarmId, resolvedSeasonId, resolvedWorkspaceId, runtime, user?.id, user?.platformRole]);

  const tracePayload = trace.data as Record<string, unknown> | undefined;
  const debugContext = tracePayload?.debugContext as Record<string, unknown> | undefined;

  return (
    <main className="shell-page">
      <BuildDiagnostics />
      <section className="record-panel">
        <h2>Accounting Reconciliation Trace</h2>
        <div className="build-diagnostics__grid">
          <article>
            <span>Current environment</span>
            <strong>{runtime.appEnv || "unset"}</strong>
          </article>
          <article>
            <span>Hostname</span>
            <strong>{runtime.hostname || "unknown"}</strong>
          </article>
          <article>
            <span>Debug enabled</span>
            <strong>{runtime.isDebugEnabled ? "yes" : "no"}</strong>
          </article>
          <article>
            <span>Current user id</span>
            <strong>{user?.id ?? "unknown"}</strong>
          </article>
          <article>
            <span>Auth type</span>
            <strong>{isAdmin ? "platform_admin" : "workspace_user"}</strong>
          </article>
          <article>
            <span>Current workspaceId</span>
            <strong>{user?.workspaceId ?? "-"}</strong>
          </article>
          <article>
            <span>Current farmId</span>
            <strong>{sync.farmId ?? "-"}</strong>
          </article>
          <article>
            <span>Current seasonId</span>
            <strong>{sync.seasonId ?? "-"}</strong>
          </article>
          <article>
            <span>DB-backed session</span>
            <strong>{dbBackedSession ? "yes" : "no"}</strong>
          </article>
          <article>
            <span>API base URL</span>
            <strong>{config.apiUrl}</strong>
          </article>
          <article>
            <span>Resolved workspaceId</span>
            <strong>{resolvedWorkspaceId || "-"}</strong>
          </article>
          <article>
            <span>Resolved farmId</span>
            <strong>{resolvedFarmId || "-"}</strong>
          </article>
          <article>
            <span>Resolved seasonId</span>
            <strong>{resolvedSeasonId || "-"}</strong>
          </article>
        </div>

        {!isAdmin && mode === "admin" ? <p className="error">This panel is restricted to platform admins.</p> : null}
        {runtime.disabledReason && isAdmin ? <p className="error">{runtime.disabledReason}</p> : null}
        {(!resolvedWorkspaceId || !resolvedFarmId || !resolvedSeasonId) ? <p className="context-message">Select a workspace/farm/season first, or provide workspaceId as platform admin.</p> : null}
        {mode === "admin" && isAdmin && (
          <div className="worker-action-form">
            <label>
              <span>Workspace id</span>
              <input value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)} placeholder="workspace UUID" />
            </label>
            <label>
              <span>Farm id</span>
              <input value={farmId} onChange={(event) => setFarmId(event.target.value)} placeholder="farm UUID" />
            </label>
            <label>
              <span>Season id</span>
              <input value={seasonId} onChange={(event) => setSeasonId(event.target.value)} placeholder="season UUID" />
            </label>
          </div>
        )}
        <div className="worker-action-form">
          <label>
            <span>Account name</span>
            <input value={accountName} onChange={(event) => setAccountName(event.target.value)} />
          </label>
          <button type="button" onClick={() => void trace.refetch()} disabled={!canRunTrace || trace.isFetching}>
            {trace.isFetching ? "Loading..." : "Run Trace"}
          </button>
        </div>
        {trace.error ? <p className="error">{trace.error instanceof Error ? trace.error.message : "Unable to load reconciliation trace."}</p> : null}
        {trace.data ? (
          <div className="record-panel">
            <h3>Trace Result</h3>
            <pre>{JSON.stringify(trace.data, null, 2)}</pre>
          </div>
        ) : null}
        {debugContext ? (
          <div className="record-panel">
            <h3>Resolved Context</h3>
            <pre>{JSON.stringify(debugContext, null, 2)}</pre>
          </div>
        ) : null}
      </section>
    </main>
  );
}
