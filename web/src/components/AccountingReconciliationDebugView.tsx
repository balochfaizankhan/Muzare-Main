import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import { useSyncState } from "../hooks/useSyncState";
import { config } from "../config";
import {
  fetchAccountingReconciliationTrace,
  fetchAdminWorkspace,
  fetchAdminWorkspaces,
  fetchAdminWorkspaceSeasons,
  fetchFarmSeasons,
  fetchWorkspaceAccounts,
  fetchWorkspaceFarms,
} from "../lib/api";
import { getReconciliationDebugRuntime } from "../lib/reconciliationDebug";
import { BuildDiagnostics } from "./BuildDiagnostics";

const defaultAccountSearch = "Younis Khan";
type DebugMode = "admin" | "workspace";

function labelWithId(name?: string | null, id?: string | null) {
  return `${name ?? "-"}${id ? ` (${id})` : ""}`;
}

export function AccountingReconciliationDebugView({ mode }: { mode: DebugMode }) {
  const { token, user } = useAuth();
  const sync = useSyncState();
  const runtime = useMemo(() => getReconciliationDebugRuntime(), []);
  const isAdmin = user?.platformRole === "platform_admin";
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState("");
  const [selectedFarmId, setSelectedFarmId] = useState("");
  const [selectedSeasonId, setSelectedSeasonId] = useState("");
  const [accountSearch, setAccountSearch] = useState(defaultAccountSearch);
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [farmSelectionTouched, setFarmSelectionTouched] = useState(false);
  const [seasonSelectionTouched, setSeasonSelectionTouched] = useState(false);

  const adminWorkspaces = useQuery({
    queryKey: ["admin-workspaces", "debug-selector"],
    queryFn: () => fetchAdminWorkspaces(token!),
    enabled: Boolean(token && mode === "admin"),
  });
  const selectedAdminWorkspace = useQuery({
    queryKey: ["admin-workspace", selectedWorkspaceId],
    queryFn: () => fetchAdminWorkspace(token!, selectedWorkspaceId),
    enabled: Boolean(token && mode === "admin" && selectedWorkspaceId),
  });
  const workspaceFarms = useQuery({
    queryKey: ["debug-workspace-farms", selectedWorkspaceId || user?.workspaceId],
    queryFn: () => fetchWorkspaceFarms(token!, selectedWorkspaceId || user!.workspaceId!),
    enabled: Boolean(token && (mode === "workspace" ? user?.workspaceId : selectedWorkspaceId)),
  });
  const farmSeasons = useQuery({
    queryKey: ["debug-farm-seasons", mode, selectedWorkspaceId || user?.workspaceId, selectedFarmId],
    queryFn: () => mode === "admin"
      ? fetchAdminWorkspaceSeasons(token!, selectedWorkspaceId, selectedFarmId)
      : fetchFarmSeasons(token!, user!.workspaceId!, selectedFarmId),
    enabled: Boolean(token && ((mode === "admin" && selectedWorkspaceId && selectedFarmId) || (mode === "workspace" && user?.workspaceId && selectedFarmId))),
  });
  const accountSearchResult = useQuery({
    queryKey: ["debug-accounts", selectedWorkspaceId || user?.workspaceId, selectedFarmId, accountSearch, selectedAccountId],
    queryFn: () => fetchWorkspaceAccounts(token!, selectedWorkspaceId || user!.workspaceId!, {
      search: accountSearch.trim(),
      farmId: selectedFarmId || undefined,
      accountId: selectedAccountId || undefined,
    }),
    enabled: Boolean(token && (mode === "admin" ? selectedWorkspaceId : user?.workspaceId) && (accountSearch.trim().length > 0 || selectedAccountId)),
  });

  useEffect(() => {
    if (mode === "workspace" && user?.workspaceId && !selectedWorkspaceId) {
      setSelectedWorkspaceId(user.workspaceId);
    }
  }, [mode, selectedWorkspaceId, user?.workspaceId]);
  useEffect(() => {
    if (mode === "workspace" && user?.workspaceId) {
      setSelectedWorkspaceId(user.workspaceId);
    }
  }, [mode, user?.workspaceId]);
  useEffect(() => {
    const workspace = mode === "admin" ? selectedAdminWorkspace.data?.workspace : null;
    const farms = mode === "admin" ? workspace?.farms ?? [] : workspaceFarms.data?.farms ?? [];
    const activeFarm = farms.find((farm) => farm.active) ?? farms[0] ?? null;
    if (!farmSelectionTouched && !selectedFarmId && activeFarm) setSelectedFarmId(activeFarm.id);
  }, [farmSelectionTouched, mode, selectedAdminWorkspace.data?.workspace, selectedFarmId, workspaceFarms.data?.farms]);
  useEffect(() => {
    const activeSeason = farmSeasons.data?.seasons?.find((season) => season.status === "active") ?? farmSeasons.data?.seasons?.[0] ?? null;
    if (!seasonSelectionTouched && !selectedSeasonId && activeSeason) setSelectedSeasonId(activeSeason.id);
  }, [farmSeasons.data?.seasons, seasonSelectionTouched, selectedSeasonId]);
  useEffect(() => {
    if (!selectedWorkspaceId) return;
    if (mode === "admin") {
      setSelectedFarmId("");
      setSelectedSeasonId("");
      setFarmSelectionTouched(false);
      setSeasonSelectionTouched(false);
      setSelectedAccountId("");
    }
  }, [mode, selectedWorkspaceId]);

  const selectedWorkspace = mode === "admin"
    ? adminWorkspaces.data?.workspaces.find((item) => item.id === selectedWorkspaceId) ?? null
    : null;
  const selectedFarm = mode === "admin"
    ? selectedAdminWorkspace.data?.workspace?.farms?.find((farm) => farm.id === selectedFarmId) ?? null
    : workspaceFarms.data?.farms.find((farm) => farm.id === selectedFarmId) ?? null;
  const selectedSeason = farmSeasons.data?.seasons.find((season) => season.id === selectedSeasonId) ?? null;
  const selectedAccount = selectedAccountId
    ? accountSearchResult.data?.accounts.find((account) => account.id === selectedAccountId) ?? null
    : accountSearchResult.data?.accounts.find((account) => account.name.toLowerCase() === accountSearch.trim().toLowerCase()) ?? null;

  const workspaceId = mode === "admin" ? selectedWorkspaceId : (user?.workspaceId ?? "");
  const farmId = mode === "admin" ? selectedFarmId : (selectedFarmId || sync.farmId || "");
  const seasonId = mode === "admin" ? selectedSeasonId : (selectedSeasonId || sync.seasonId || "");
  const dbBackedSession = Boolean(token && user?.workspaceId);
  const trace = useQuery({
    queryKey: ["accounting-reconciliation-trace", mode, workspaceId, farmId, seasonId, selectedAccountId, accountSearch],
    enabled: false,
    queryFn: () => fetchAccountingReconciliationTrace(token!, {
      workspaceId: workspaceId || undefined,
      farmId: farmId || undefined,
      seasonId: seasonId || undefined,
      accountId: selectedAccountId || undefined,
      accountName: selectedAccountId ? undefined : accountSearch.trim() || undefined,
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
      workspaceId: workspaceId || null,
      farmId: farmId || null,
      seasonId: seasonId || null,
      dbBackedSession,
    });
  }, [dbBackedSession, farmId, isAdmin, runtime, seasonId, user?.id, user?.platformRole, workspaceId]);

  const tracePayload = trace.data as Record<string, unknown> | undefined;
  const debugContext = tracePayload?.debugContext as Record<string, unknown> | undefined;
  const selectedContext = tracePayload?.selectedContext as Record<string, unknown> | undefined;
  const filtersApplied = tracePayload?.filtersApplied as Record<string, unknown> | undefined;
  const permissionMode = debugContext?.permissionMode as string | undefined;
  const permissionPassed = debugContext?.permissionPassed as boolean | undefined;
  const permissionReason = debugContext?.reason as string | undefined;

  const canRunTrace = runtime.isDebugEnabled && Boolean(token) && Boolean(workspaceId) && Boolean(selectedAccountId || accountSearch.trim());

  return (
    <main className="shell-page">
      <BuildDiagnostics />
      <section className="record-panel">
        <h2>Accounting Reconciliation Trace</h2>
        <div className="build-diagnostics__grid">
          <article><span>Current environment</span><strong>{runtime.appEnv || "unset"}</strong></article>
          <article><span>Hostname</span><strong>{runtime.hostname || "unknown"}</strong></article>
          <article><span>Debug enabled</span><strong>{runtime.isDebugEnabled ? "yes" : "no"}</strong></article>
          <article><span>Current user id</span><strong>{user?.id ?? "unknown"}</strong></article>
          <article><span>Auth type</span><strong>{isAdmin ? "platform_admin" : "workspace_user"}</strong></article>
          <article><span>Current workspaceId</span><strong>{user?.workspaceId ?? "-"}</strong></article>
          <article><span>Current farmId</span><strong>{sync.farmId ?? "-"}</strong></article>
          <article><span>Current seasonId</span><strong>{sync.seasonId ?? "-"}</strong></article>
          <article><span>DB-backed session</span><strong>{dbBackedSession ? "yes" : "no"}</strong></article>
          <article><span>API base URL</span><strong>{config.apiUrl}</strong></article>
          <article><span>Selected workspace</span><strong>{selectedWorkspace ? labelWithId(selectedWorkspace.name, selectedWorkspace.id) : mode === "admin" ? "all workspaces" : labelWithId(user?.workspaceName ?? null, workspaceId || null)}</strong></article>
          <article><span>Selected farm</span><strong>{selectedFarm ? labelWithId(selectedFarm.name, selectedFarm.id) : "all farms"}</strong></article>
          <article><span>Selected season</span><strong>{selectedSeason ? labelWithId(selectedSeason.name, selectedSeason.id) : "all seasons"}</strong></article>
          <article><span>Selected account</span><strong>{selectedAccount ? labelWithId(selectedAccount.name, selectedAccount.id) : "-"}</strong></article>
        </div>

        {!isAdmin && mode === "admin" ? <p className="error">This panel is restricted to platform admins.</p> : null}
        {runtime.disabledReason && isAdmin ? <p className="error">{runtime.disabledReason}</p> : null}
        {!workspaceId ? <p className="context-message">Select a workspace/farm/season first, or provide workspaceId as platform admin.</p> : null}
        <p className="context-message">Use the selectors below to choose a workspace, farm, season, and account without typing UUIDs manually.</p>

        <div className="worker-action-form">
          {mode === "admin" && (
            <label>
              <span>Workspace</span>
              <select value={selectedWorkspaceId} onChange={(event) => { setSelectedWorkspaceId(event.target.value); setSelectedFarmId(""); setSelectedSeasonId(""); setSelectedAccountId(""); }}>
                <option value="">Select workspace</option>
                {(adminWorkspaces.data?.workspaces ?? []).map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>{workspace.name} ({workspace.id})</option>
                ))}
              </select>
            </label>
          )}
          {mode === "workspace" && (
            <label>
              <span>Workspace</span>
              <select value={workspaceId} disabled>
                <option value={workspaceId}>{user?.workspaceName ?? workspaceId}</option>
              </select>
            </label>
          )}
          <label>
            <span>Farm</span>
            <select
              value={farmId}
              onChange={(event) => { setSelectedFarmId(event.target.value); setFarmSelectionTouched(true); setSelectedSeasonId(""); setSeasonSelectionTouched(false); setSelectedAccountId(""); }}
              disabled={!workspaceId || mode === "workspace"}
            >
              <option value="">All farms</option>
              {(mode === "admin" ? selectedAdminWorkspace.data?.workspace?.farms ?? [] : workspaceFarms.data?.farms ?? []).map((farm) => (
                <option key={farm.id} value={farm.id}>{farm.name} ({farm.id})</option>
              ))}
            </select>
          </label>
          <label>
            <span>Season</span>
            <select value={seasonId} onChange={(event) => { setSelectedSeasonId(event.target.value); setSeasonSelectionTouched(true); }} disabled={!workspaceId || !farmId || mode === "workspace"}>
              <option value="">All seasons</option>
              {(farmSeasons.data?.seasons ?? []).map((season) => (
                <option key={season.id} value={season.id}>{season.name} ({season.id})</option>
              ))}
            </select>
          </label>
          <label>
            <span>Account search</span>
            <input value={accountSearch} onChange={(event) => { setAccountSearch(event.target.value); setSelectedAccountId(""); }} />
          </label>
          <label>
            <span>Matched account</span>
            <select value={selectedAccountId} onChange={(event) => setSelectedAccountId(event.target.value)} disabled={!workspaceId}>
              <option value="">Select account</option>
              {(accountSearchResult.data?.accounts ?? []).map((account) => (
                <option key={account.id} value={account.id}>{account.name} ({account.id}) - {account.farmName}</option>
              ))}
            </select>
          </label>
          <button type="button" onClick={() => void trace.refetch()} disabled={!canRunTrace || trace.isFetching}>
            {trace.isFetching ? "Loading..." : "Run Trace"}
          </button>
        </div>

        <p className="context-message">
          {selectedWorkspace ? `Workspace: ${selectedWorkspace.name} (${selectedWorkspace.id})` : mode === "workspace" ? `Workspace: ${user?.workspaceName ?? user?.workspaceId ?? "-"}` : "Workspace: all workspaces"}
          {" | "}
          {selectedFarm ? `Farm: ${selectedFarm.name} (${selectedFarm.id})` : "Farm: all farms"}
          {" | "}
          {selectedSeason ? `Season: ${selectedSeason.name} (${selectedSeason.id})` : "Season: all seasons"}
          {" | "}
          {selectedAccount ? `Account: ${selectedAccount.name} (${selectedAccount.id})` : "Account: not selected"}
        </p>

        {(permissionMode || typeof permissionPassed === "boolean") && (
          <div className="build-diagnostics__grid">
            <article><span>Permission mode</span><strong>{permissionMode ?? "-"}</strong></article>
            <article><span>Permission passed</span><strong>{permissionPassed ? "yes" : "no"}</strong></article>
            <article><span>Permission reason</span><strong>{permissionReason ?? "-"}</strong></article>
          </div>
        )}

        {trace.error ? <p className="error">{trace.error instanceof Error ? trace.error.message : "Unable to load reconciliation trace."}</p> : null}
        {trace.data ? (
          <div className="record-panel">
            <h3>Trace Result</h3>
            <pre>{JSON.stringify({
              selectedContext,
              filtersApplied,
              debugContext,
              ...tracePayload,
            }, null, 2)}</pre>
          </div>
        ) : null}
      </section>
    </main>
  );
}
