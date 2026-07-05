import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import { fetchAccountingReconciliationTrace } from "../lib/api";

const defaultAccountName = "Younis Khan";

export function AccountingReconciliationDebugPanel() {
  const { token, user } = useAuth();
  const [accountName, setAccountName] = useState(defaultAccountName);
  const canView = import.meta.env.DEV && Boolean(token && user?.platformRole === "platform_admin");
  const trace = useQuery({
    queryKey: ["accounting-reconciliation-trace", accountName],
    enabled: false,
    queryFn: () => fetchAccountingReconciliationTrace(token!, accountName),
  });

  if (!canView) return null;

  return (
    <section className="record-panel">
      <h2>Accounting Reconciliation Trace</h2>
      <p>Temporary dev-only trace for labour wage settlement reconciliation. This uses the logged-in session and does not expose any token.</p>
      <div className="worker-action-form">
        <label>
          <span>Account name</span>
          <input value={accountName} onChange={(event) => setAccountName(event.target.value)} />
        </label>
        <button type="button" onClick={() => void trace.refetch()} disabled={trace.isFetching || !token}>
          {trace.isFetching ? "Loading..." : "Run trace"}
        </button>
      </div>
      {trace.error ? <p className="error">{trace.error instanceof Error ? trace.error.message : "Unable to load reconciliation trace."}</p> : null}
      {trace.data ? <pre>{JSON.stringify(trace.data, null, 2)}</pre> : null}
    </section>
  );
}
