import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { BuildDiagnostics } from "../../components/BuildDiagnostics";
import { useAuth } from "../../auth/AuthProvider";
import { config } from "../../config";
import { fetchAccountingReconciliationTrace } from "../../lib/api";
import { getReconciliationDebugRuntime } from "../../lib/reconciliationDebug";

const defaultAccountName = "Younis Khan";

export function AccountingReconciliationDebug() {
  const { token, user } = useAuth();
  const [accountName, setAccountName] = useState(defaultAccountName);
  const runtime = useMemo(() => getReconciliationDebugRuntime(), []);
  const isAdmin = user?.platformRole === "platform_admin";
  const canRunTrace = runtime.isDebugEnabled && isAdmin && Boolean(token);
  const trace = useQuery({
    queryKey: ["accounting-reconciliation-trace", accountName],
    enabled: false,
    queryFn: () => fetchAccountingReconciliationTrace(token!, accountName),
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
      userRole: user?.platformRole ?? null,
    });
  }, [isAdmin, runtime, user?.platformRole]);

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
            <span>Admin status</span>
            <strong>{isAdmin ? "admin" : "not admin"}</strong>
          </article>
          <article>
            <span>API base URL</span>
            <strong>{config.apiUrl}</strong>
          </article>
          <article>
            <span>Auth session</span>
            <strong>{token ? "authenticated" : "missing token"}</strong>
          </article>
        </div>

        {!isAdmin ? <p className="error">This panel is restricted to platform admins.</p> : null}
        {runtime.disabledReason && isAdmin ? <p className="error">{runtime.disabledReason}</p> : null}

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
        {trace.data ? <pre>{JSON.stringify(trace.data, null, 2)}</pre> : null}
      </section>
    </main>
  );
}
