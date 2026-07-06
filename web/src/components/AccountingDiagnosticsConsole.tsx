import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import { config } from "../config";
import {
  fetchAccountingReconciliationTrace,
  fetchAdminWorkspace,
  fetchAdminWorkspaces,
  fetchAdminWorkspaceSeasons,
  fetchWorkspaceAccounts,
} from "../lib/api";
import { formatMoney } from "../lib/format";
import { BuildDiagnostics } from "./BuildDiagnostics";

const money = formatMoney;
const defaultAccountSearch = "Younis Khan";
const snapshotFields = [
  "purchaseVouchersPaid",
  "businessFundsGiven",
  "businessFundsReceived",
  "labourAdvancesPaid",
  "labourAdvancesSettledThroughWageSettlements",
  "outstandingLabourAdvances",
  "labourSettlementCashPaid",
  "labourSettlementNonCashApplied",
  "moneyReturned",
  "adjustments",
  "farmOwesPartner",
] as const;

type Snapshot = Record<string, unknown>;
type TraceResponse = Record<string, unknown>;

type SnapshotDiff = {
  field: string;
  canonical: string;
  partnerStatus: string;
};

type AuditRow = {
  accountId: string;
  accountName: string;
  accountType: string;
  farmName: string;
  passed: boolean;
  differenceCount: number;
  differences: SnapshotDiff[];
  helperValues: Snapshot;
  partnerStatusValues: Snapshot;
  aliasMatches: number;
  nameFallbackMatches: number;
  unmappedRows: number;
  deletedIncludedCount: number;
  voidedIncludedCount: number;
};

function valueToText(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value.toString() : "NaN";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value == null) return "-";
  return JSON.stringify(value);
}

function compareSnapshots(helper: Snapshot | undefined, partnerStatus: Snapshot | undefined) {
  const differences: SnapshotDiff[] = [];
  for (const field of snapshotFields) {
    const canonical = helper?.[field];
    const reported = partnerStatus?.[field];
    if (canonical !== reported) {
      differences.push({
        field,
        canonical: valueToText(canonical),
        partnerStatus: valueToText(reported),
      });
    }
  }
  return differences;
}

function labelWithId(name?: string | null, id?: string | null) {
  return `${name ?? "-"}${id ? ` (${id})` : ""}`;
}

export function AccountingDiagnosticsConsole({ initialWorkspaceId = "" }: { initialWorkspaceId?: string }) {
  const { token, user } = useAuth();
  const isAdmin = user?.platformRole === "platform_admin";
  const [workspaceId, setWorkspaceId] = useState("");
  const [farmId, setFarmId] = useState("");
  const [seasonId, setSeasonId] = useState("");
  const [accountSearch, setAccountSearch] = useState(defaultAccountSearch);
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [auditRows, setAuditRows] = useState<AuditRow[]>([]);
  const [auditSummary, setAuditSummary] = useState<{
    totalAccountsChecked: number;
    passedAccounts: number;
    failedAccounts: number;
    rowsMatchedByAlias: number;
    rowsMatchedOnlyByName: number;
    unmappedRows: number;
    deletedIncludedCount: number;
    voidedIncludedCount: number;
  } | null>(null);
  const [selectedAuditRow, setSelectedAuditRow] = useState<AuditRow | null>(null);

  useEffect(() => {
    if (initialWorkspaceId && !workspaceId) {
      setWorkspaceId(initialWorkspaceId);
    }
  }, [initialWorkspaceId, workspaceId]);

  const workspaces = useQuery({
    queryKey: ["accounting-diagnostics-workspaces"],
    enabled: Boolean(token && isAdmin),
    queryFn: () => fetchAdminWorkspaces(token!),
  });
  const selectedWorkspace = useQuery({
    queryKey: ["accounting-diagnostics-workspace", workspaceId],
    enabled: Boolean(token && isAdmin && workspaceId),
    queryFn: () => fetchAdminWorkspace(token!, workspaceId),
  });
  const selectedWorkspaceData = selectedWorkspace.data?.workspace ?? null;
  const farms = selectedWorkspaceData?.farms ?? [];
  const farmQuery = useQuery({
    queryKey: ["accounting-diagnostics-seasons", workspaceId, farmId],
    enabled: Boolean(token && isAdmin && workspaceId && farmId),
    queryFn: () => fetchAdminWorkspaceSeasons(token!, workspaceId, farmId),
  });
  const accounts = useQuery({
    queryKey: ["accounting-diagnostics-accounts", workspaceId, farmId, accountSearch, selectedAccountId],
    enabled: Boolean(token && isAdmin && workspaceId && (accountSearch.trim() || selectedAccountId)),
    queryFn: () => fetchWorkspaceAccounts(token!, workspaceId, {
      search: accountSearch.trim(),
      farmId: farmId || undefined,
      accountId: selectedAccountId || undefined,
    }),
  });

  const selectedFarm = farms.find((item) => item.id === farmId) ?? null;
  const seasonOptions = farmId ? farmQuery.data?.seasons ?? [] : [];
  const selectedSeason = seasonOptions.find((item) => item.id === seasonId) ?? null;
  const matchedAccount = selectedAccountId
    ? accounts.data?.accounts.find((item) => item.id === selectedAccountId) ?? null
    : accounts.data?.accounts.find((item) => item.name.toLowerCase() === accountSearch.trim().toLowerCase()) ?? null;

  useEffect(() => {
    if (!matchedAccount) return;
    if (!farmId && matchedAccount.farmId) {
      setFarmId(matchedAccount.farmId);
    }
  }, [farmId, matchedAccount]);

  useEffect(() => {
    if (!farmId || seasonId) return;
    const activeSeason = farmQuery.data?.seasons?.find((item) => item.status === "active") ?? farmQuery.data?.seasons?.[0] ?? null;
    if (activeSeason) setSeasonId(activeSeason.id);
  }, [farmId, farmQuery.data?.seasons, seasonId]);

  const trace = useQuery({
    queryKey: ["accounting-diagnostics-trace", workspaceId, farmId, seasonId, selectedAccountId, accountSearch],
    enabled: false,
    queryFn: () => fetchAccountingReconciliationTrace(token!, {
      workspaceId: workspaceId || undefined,
      farmId: farmId || undefined,
      seasonId: seasonId || undefined,
      accountId: selectedAccountId || undefined,
      accountName: selectedAccountId ? undefined : accountSearch.trim() || undefined,
    }),
  });

  const tracePayload = (trace.data ?? null) as TraceResponse | null;
  const traceHelperValues = (tracePayload?.currentHelperValues ?? null) as Snapshot | null;
  const tracePartnerStatusValues = (tracePayload?.partnerStatusValues ?? null) as Snapshot | null;

  const canRunTrace = Boolean(token && workspaceId && (selectedAccountId || accountSearch.trim()));
  const auditAllFarms = !farmId;
  const auditAllSeasons = !seasonId;

  const runAudit = async () => {
    if (!token) return;
    if (!workspaceId) {
      setAuditError("Select a workspace first.");
      return;
    }
    setAuditLoading(true);
    setAuditError(null);
    setSelectedAuditRow(null);
    try {
      const workspaceAccounts = await fetchWorkspaceAccounts(token, workspaceId, {
        farmId: farmId || undefined,
      });
      const partnerAccounts = (workspaceAccounts.accounts ?? [])
        .filter((account) => account.accountType === "partner" && account.active);

      const rows = await Promise.all(partnerAccounts.map(async (account) => {
        const result = await fetchAccountingReconciliationTrace(token, {
          workspaceId,
          farmId: farmId || undefined,
          seasonId: seasonId || undefined,
          accountId: account.id,
        });
        const payload = (result as TraceResponse) ?? {};
        const helperValues = (payload.currentHelperValues ?? {}) as Snapshot;
        const partnerStatusValues = (payload.partnerStatusValues ?? {}) as Snapshot;
        const differences = compareSnapshots(helperValues, partnerStatusValues);
        const advancesSection = payload.advances as { rows?: Array<Record<string, unknown>> } | undefined;
        const settlementsSection = payload.labourWageSettlements as { rows?: Array<Record<string, unknown>> } | undefined;
        const advanceRows = advancesSection?.rows ?? [];
        const settlementRows = settlementsSection?.rows ?? [];
        const aliasMatches = advanceRows.filter((row) => row.includedByAlias === true).length;
        const nameFallbackMatches = advanceRows.filter((row) => row.includedByNameFallback === true).length;
        const unmappedRows = advanceRows.filter((row) => row.currentHelperIncluded === false && row.sourceOfTruthIncluded === false && !row.resolvedAccountId).length;
        const deletedIncludedCount = settlementRows.filter((row) => row.deleted === true && row.included === true).length;
        const voidedIncludedCount = settlementRows.filter((row) => row.voided === true && row.included === true).length;
        const pass = differences.length === 0 && deletedIncludedCount === 0 && voidedIncludedCount === 0 && unmappedRows === 0;
        return {
          accountId: account.id,
          accountName: account.name,
          accountType: account.accountType,
          farmName: account.farmName,
          passed: pass,
          differenceCount: differences.length,
          differences,
          helperValues,
          partnerStatusValues,
          aliasMatches,
          nameFallbackMatches,
          unmappedRows,
          deletedIncludedCount,
          voidedIncludedCount,
        } satisfies AuditRow;
      }));

      const summary = {
        totalAccountsChecked: rows.length,
        passedAccounts: rows.filter((row) => row.passed).length,
        failedAccounts: rows.filter((row) => !row.passed).length,
        rowsMatchedByAlias: rows.reduce((sum, row) => sum + row.aliasMatches, 0),
        rowsMatchedOnlyByName: rows.reduce((sum, row) => sum + row.nameFallbackMatches, 0),
        unmappedRows: rows.reduce((sum, row) => sum + row.unmappedRows, 0),
        deletedIncludedCount: rows.reduce((sum, row) => sum + row.deletedIncludedCount, 0),
        voidedIncludedCount: rows.reduce((sum, row) => sum + row.voidedIncludedCount, 0),
      };

      setAuditRows(rows);
      setAuditSummary(summary);
    } catch (error) {
      setAuditError(error instanceof Error ? error.message : "Unable to run parity audit.");
    } finally {
      setAuditLoading(false);
    }
  };

  useEffect(() => {
    if (import.meta.env.DEV || import.meta.env.VITE_ENABLE_RECONCILIATION_DEBUG === "true") {
      console.info("[accounting-diagnostics]", {
        hostname: window.location.hostname,
        environment: import.meta.env.VITE_APP_ENV ?? import.meta.env.MODE,
        debugEnabled: import.meta.env.VITE_ENABLE_RECONCILIATION_DEBUG,
        userId: user?.id ?? null,
        isAdmin,
        workspaceId: workspaceId || null,
        farmId: farmId || null,
        seasonId: seasonId || null,
        apiBaseUrl: config.apiUrl,
      });
    }
  }, [farmId, isAdmin, seasonId, user?.id, workspaceId]);

  return (
    <>
      <BuildDiagnostics />
      <section className="record-panel">
        <h2>Accounting Reconciliation Trace</h2>
        <p>Open the canonical partner trace directly from diagnostics, without leaving the admin surface.</p>
        <div className="build-diagnostics__grid">
          <article><span>Environment</span><strong>{import.meta.env.VITE_APP_ENV ?? import.meta.env.MODE ?? "unset"}</strong></article>
          <article><span>Hostname</span><strong>{window.location.hostname}</strong></article>
          <article><span>Debug enabled</span><strong>{import.meta.env.VITE_ENABLE_RECONCILIATION_DEBUG === "true" ? "yes" : "no"}</strong></article>
          <article><span>Auth type</span><strong>{isAdmin ? "platform_admin" : "workspace_user"}</strong></article>
          <article><span>API base URL</span><strong>{config.apiUrl}</strong></article>
          <article><span>Selected workspace</span><strong>{workspaceId ? labelWithId(selectedWorkspaceData?.name, workspaceId) : "Select a workspace"}</strong></article>
          <article><span>Selected farm</span><strong>{farmId ? labelWithId(selectedFarm?.name, farmId) : "All farms"}</strong></article>
          <article><span>Selected season</span><strong>{seasonId ? labelWithId(selectedSeason?.name, seasonId) : "All seasons"}</strong></article>
          <article><span>Selected account</span><strong>{matchedAccount ? labelWithId(matchedAccount.name, matchedAccount.id) : "Not selected"}</strong></article>
        </div>
        {auditAllFarms || auditAllSeasons ? <p className="context-message">You are auditing {auditAllFarms ? "all farms" : "the selected farm"} / {auditAllSeasons ? "all seasons" : "the selected season"}.</p> : null}
        <div className="worker-action-form">
          <label>
            <span>Workspace</span>
            <select value={workspaceId} onChange={(event) => { setWorkspaceId(event.target.value); setFarmId(""); setSeasonId(""); setSelectedAccountId(""); }}>
              <option value="">Select workspace</option>
              {(workspaces.data?.workspaces ?? []).map((workspace) => (
                <option key={workspace.id} value={workspace.id}>{workspace.name} ({workspace.id})</option>
              ))}
            </select>
          </label>
          <label>
            <span>Farm</span>
            <select value={farmId} onChange={(event) => { setFarmId(event.target.value); setSeasonId(""); }} disabled={!workspaceId}>
              <option value="">All farms</option>
              {farms.map((farm) => (
                <option key={farm.id} value={farm.id}>{farm.name} ({farm.id})</option>
              ))}
            </select>
          </label>
          <label>
            <span>Season</span>
            <select value={seasonId} onChange={(event) => setSeasonId(event.target.value)} disabled={!workspaceId}>
              <option value="">All seasons</option>
              {seasonOptions.map((season) => (
                <option key={season.id} value={season.id}>{season.name} ({season.id})</option>
              ))}
            </select>
          </label>
          <label>
            <span>Account search</span>
            <input value={accountSearch} onChange={(event) => { setAccountSearch(event.target.value); setSelectedAccountId(""); }} placeholder="Search account name" />
          </label>
          <label>
            <span>Matched account</span>
            <select value={selectedAccountId} onChange={(event) => setSelectedAccountId(event.target.value)} disabled={!workspaceId}>
              <option value="">Select account</option>
              {(accounts.data?.accounts ?? []).map((account) => (
                <option key={account.id} value={account.id}>{account.name} ({account.id}) - {account.farmName}</option>
              ))}
            </select>
          </label>
          <div className="worker-action-form__actions">
            <button type="button" onClick={() => void trace.refetch()} disabled={!canRunTrace || trace.isFetching}>
              {trace.isFetching ? "Loading..." : "Run Trace"}
            </button>
            <a href="/admin/accounting-reconciliation-debug">Open full debug page</a>
          </div>
        </div>
        {!workspaceId ? <p className="context-message">Select a workspace first. Farm and season filters are optional.</p> : null}
        <p className="context-message">The trace uses the authenticated API session and returns the canonical snapshot plus the partner status snapshot for comparison.</p>
        {trace.error ? <p className="error">{trace.error instanceof Error ? trace.error.message : "Unable to load reconciliation trace."}</p> : null}
        {traceHelperValues && tracePartnerStatusValues ? (
          <div className="build-diagnostics__grid">
            <article><span>Canonical farm owes partner</span><strong>{money(Number(traceHelperValues.farmOwesPartner ?? 0))}</strong></article>
            <article><span>Partner status farm owes partner</span><strong>{money(Number(tracePartnerStatusValues.farmOwesPartner ?? 0))}</strong></article>
            <article><span>Settled through wage settlements</span><strong>{money(Number(traceHelperValues.labourAdvancesSettledThroughWageSettlements ?? 0))}</strong></article>
            <article><span>Outstanding labour advances</span><strong>{money(Number(traceHelperValues.outstandingLabourAdvances ?? 0))}</strong></article>
          </div>
        ) : null}
        {trace.data ? (
          <div className="record-panel">
            <h3>Single-Account Trace JSON</h3>
            <pre>{JSON.stringify(trace.data, null, 2)}</pre>
          </div>
        ) : null}
      </section>

      <section className="record-panel">
        <h2>All-Accounts Parity Audit</h2>
        <p>Runs the same authenticated reconciliation trace for every active partner account in the selected workspace scope.</p>
        <div className="worker-action-form__actions">
          <button type="button" onClick={() => void runAudit()} disabled={!workspaceId || auditLoading}>
            {auditLoading ? "Running audit..." : "Run All-Accounts Audit"}
          </button>
        </div>
        {auditError ? <p className="error">{auditError}</p> : null}
        {auditSummary ? (
          <div className="build-diagnostics__grid">
            <article><span>Total accounts checked</span><strong>{auditSummary.totalAccountsChecked}</strong></article>
            <article><span>Passed accounts</span><strong>{auditSummary.passedAccounts}</strong></article>
            <article><span>Failed accounts</span><strong>{auditSummary.failedAccounts}</strong></article>
            <article><span>Rows matched by alias</span><strong>{auditSummary.rowsMatchedByAlias}</strong></article>
            <article><span>Rows matched only by name</span><strong>{auditSummary.rowsMatchedOnlyByName}</strong></article>
            <article><span>Unmapped rows</span><strong>{auditSummary.unmappedRows}</strong></article>
            <article><span>Deleted rows included incorrectly</span><strong>{auditSummary.deletedIncludedCount}</strong></article>
            <article><span>Voided rows included incorrectly</span><strong>{auditSummary.voidedIncludedCount}</strong></article>
          </div>
        ) : null}
        {auditRows.length ? (
          <div className="attendance-import-table-wrap">
            <table className="report-data-table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Farm</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th>Outstanding</th>
                  <th>Farm owes partner</th>
                  <th>Diffs</th>
                  <th>Mapping flags</th>
                </tr>
              </thead>
              <tbody>
                {auditRows.map((row) => (
                  <tr key={row.accountId} onClick={() => setSelectedAuditRow(row)} style={{ cursor: "pointer" }}>
                    <td>{row.accountName}<br /><small>{row.accountId}</small></td>
                    <td>{row.farmName}</td>
                    <td>{row.accountType}</td>
                    <td>{row.passed ? "PASS" : "FAIL"}</td>
                    <td>{money(Number(row.helperValues.outstandingLabourAdvances ?? 0))}</td>
                    <td>{money(Number(row.helperValues.farmOwesPartner ?? 0))}</td>
                    <td>{row.differenceCount}</td>
                    <td>{`alias ${row.aliasMatches}, name ${row.nameFallbackMatches}, unmapped ${row.unmappedRows}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {selectedAuditRow ? (
          <div className="record-panel">
            <h3>Selected Audit Row JSON</h3>
            <pre>{JSON.stringify(selectedAuditRow, null, 2)}</pre>
          </div>
        ) : null}
        {auditRows.some((row) => row.differenceCount > 0) ? (
          <div className="record-panel">
            <h3>Field Differences</h3>
            <div className="attendance-import-table-wrap">
              <table className="report-data-table">
                <thead><tr><th>Account</th><th>Field</th><th>Canonical</th><th>Partner status</th></tr></thead>
                <tbody>
                  {auditRows.flatMap((row) => row.differences.map((diff) => (
                    <tr key={`${row.accountId}:${diff.field}`}>
                      <td>{row.accountName}</td>
                      <td>{diff.field}</td>
                      <td>{diff.canonical}</td>
                      <td>{diff.partnerStatus}</td>
                    </tr>
                  )))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
        {auditRows.length ? <pre>{JSON.stringify({ auditSummary, auditRows }, null, 2)}</pre> : null}
      </section>
    </>
  );
}
