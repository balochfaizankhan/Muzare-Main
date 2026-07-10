import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { SearchInput } from "../../components/SearchInput";
import { formatMoney } from "../../lib/format";
import {
  labourEarningScopeLabel,
  labourEarningTypeLabel,
  labourEarningsByScope,
  sumLabourEarnings,
} from "../../lib/labourEarnings";
import { canCreate } from "../../lib/permissions";
import {
  compareLabourers,
  getActiveFarmId,
  getActiveSeasonId,
  makeLocalRecord,
  offlineDb,
  workspaceRecords,
  type LabourEarning,
  type LabourGroup,
  type Labourer,
} from "../../lib/offline-db";
import { isActiveOperationalRecord } from "../../lib/operationalRecords";
import { useAuth } from "../../auth/AuthProvider";
import { persistOperationalRecord } from "../../services/syncService";

const money = formatMoney;
const today = () => new Date().toISOString().slice(0, 10);
const labourEarningStatusLabel = (status: string) => {
  switch (status) {
    case "pending_settlement":
      return "Pending settlement";
    case "settled":
      return "Settled";
    case "voided":
      return "Voided";
    case "cancelled":
      return "Cancelled";
    default:
      return status;
  }
};

const labourEarningTargetLabel = (
  earning: LabourEarning,
  labourer: Labourer | null,
  group: LabourGroup | null,
) => {
  if (earning.earningScope === "group") return group?.name ?? earning.labourGroupName ?? "Labour earning";
  return labourer?.name ?? "Labour earning";
};

export function LabourEarnings() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const workspaceId = user?.workspaceId ?? "";
  const activeFarmId = getActiveFarmId();
  const activeSeasonId = getActiveSeasonId();
  const canManage = Boolean(user && workspaceId && canCreate(user, "wages", workspaceId));

  const [labourers, setLabourers] = useState<Labourer[]>([]);
  const [groups, setGroups] = useState<LabourGroup[]>([]);
  const [earnings, setEarnings] = useState<LabourEarning[]>([]);
  const [search, setSearch] = useState("");
  const [scopeFilter, setScopeFilter] = useState<"all" | "individual" | "group">("all");
  const [status, setStatus] = useState("");
  const [earningType, setEarningType] = useState<LabourEarning["earningType"] | "">("");
  const [selectedLabourerId, setSelectedLabourerId] = useState("");
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [selectedForemanId, setSelectedForemanId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [minAmount, setMinAmount] = useState("");
  const [maxAmount, setMaxAmount] = useState("");
  const [earningDate, setEarningDate] = useState(today());
  const [earningScope, setEarningScope] = useState<"individual" | "group">("individual");
  const [workTargetId, setWorkTargetId] = useState("");
  const [amount, setAmount] = useState("");
  const [formType, setFormType] = useState<LabourEarning["earningType"]>("lump_sum");
  const [description, setDescription] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  useEffect(() => {
    const refresh = async () => {
      const [nextLabourers, nextGroups, nextEarnings] = await Promise.all([
        workspaceRecords(offlineDb.labourers),
        workspaceRecords(offlineDb.labourGroups),
        workspaceRecords(offlineDb.labourEarnings, { includeDeleted: true }),
      ]);
      setLabourers(nextLabourers.sort(compareLabourers));
      setGroups(nextGroups.sort((left, right) => left.name.localeCompare(right.name)));
      setEarnings(nextEarnings.sort((left, right) => right.earningDate.localeCompare(left.earningDate) || right.updatedAt.localeCompare(left.updatedAt)));
    };
    void refresh();
    window.addEventListener("muzare-data-refresh", refresh);
    window.addEventListener("muzare-local-data-change", refresh);
    return () => {
      window.removeEventListener("muzare-data-refresh", refresh);
      window.removeEventListener("muzare-local-data-change", refresh);
    };
  }, []);

  const labourById = useMemo(() => new Map(labourers.map((labourer) => [labourer.id, labourer])), [labourers]);
  const groupById = useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups]);
  const selectedGroup = useMemo(() => groupById.get(selectedGroupId) ?? null, [groupById, selectedGroupId]);
  const selectedGroupForemanId = selectedGroup?.foremanId ?? selectedGroup?.foremanLabourId ?? "";
  const selectedGroupForeman = useMemo(() => labourById.get(selectedGroupForemanId) ?? null, [labourById, selectedGroupForemanId]);
  const selectedTargetLabourer = useMemo(() => labourById.get(workTargetId) ?? null, [labourById, workTargetId]);
  const selectedTargetGroup = useMemo(() => groupById.get(workTargetId) ?? null, [groupById, workTargetId]);
  const visibleEarnings = useMemo(() => earnings.filter((earning) => {
    const labourer = earning.labourerId ? labourById.get(earning.labourerId) : null;
    const group = earning.labourGroupId ? groupById.get(earning.labourGroupId) : null;
    const term = search.trim().toLowerCase();
    const targetName = earning.earningScope === "group"
      ? `${group?.name ?? earning.labourGroupName ?? ""} ${selectedGroupForeman?.name ?? ""}`
      : labourer?.name ?? "";
    return (scopeFilter === "all" || earning.earningScope === scopeFilter)
      && (!status || earning.status === status)
      && (!earningType || earning.earningType === earningType)
      && (!from || earning.earningDate >= from)
      && (!to || earning.earningDate <= to)
      && (!minAmount || earning.amount >= Number(minAmount))
      && (!maxAmount || earning.amount <= Number(maxAmount))
      && (!selectedLabourerId || earning.labourerId === selectedLabourerId)
      && (!selectedGroupId || earning.labourGroupId === selectedGroupId)
      && (!selectedForemanId || earning.foremanId === selectedForemanId)
      && (!term || [targetName, earning.description, earning.notes, earning.earningType].join(" ").toLowerCase().includes(term));
  }), [earnings, labourById, groupById, search, scopeFilter, status, earningType, from, to, minAmount, maxAmount, selectedLabourerId, selectedGroupId, selectedForemanId, selectedGroupForeman?.name]);
  const pending = visibleEarnings.filter((earning) => earning.status === "pending_settlement" && isActiveOperationalRecord(earning));
  const settled = visibleEarnings.filter((earning) => earning.status === "settled" && isActiveOperationalRecord(earning));
  const voided = visibleEarnings.filter((earning) => earning.status === "voided" || !isActiveOperationalRecord(earning));
  const totals = labourEarningsByScope(visibleEarnings);

  useEffect(() => {
    if (earningScope === "group" && selectedGroupForemanId && !selectedForemanId) {
      setSelectedForemanId(selectedGroupForemanId);
    }
  }, [earningScope, selectedGroupForemanId, selectedForemanId]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setSuccess("");
    if (!canManage) {
      setError(t("common.viewOnlyAccess"));
      return;
    }
    if (!activeFarmId || !activeSeasonId) {
      setError(t("farmsPage.noActiveSeason"));
      return;
    }
    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0 || !description.trim()) {
      setError("Enter a valid amount and description before saving.");
      return;
    }
    if (!formType) {
      setError("Select a work type.");
      return;
    }
    if (earningScope === "individual") {
      if (!workTargetId) {
        setError("Select a labourer.");
        return;
      }
      const labourer = labourById.get(workTargetId);
      if (!labourer) {
        setError("Select an existing labourer.");
        return;
      }
    } else {
      if (!workTargetId) {
        setError("Select a labour group.");
        return;
      }
      if (!selectedGroupForemanId) {
        setError("The selected group has no assigned foreman.");
        return;
      }
    }
    setSaving(true);
    try {
      const targetGroup = earningScope === "group" ? groupById.get(workTargetId) ?? null : selectedTargetLabourer?.groupId ? groupById.get(selectedTargetLabourer.groupId) ?? null : null;
      const foremanId = earningScope === "group" ? selectedGroupForemanId : targetGroup?.foremanId ?? targetGroup?.foremanLabourId ?? null;
      await persistOperationalRecord("labourEarning", {
        ...makeLocalRecord(),
        workspaceId,
        farmId: activeFarmId,
        seasonId: activeSeasonId,
        earningScope,
        labourerId: earningScope === "individual" ? workTargetId : null,
        labourGroupId: earningScope === "group" ? workTargetId : targetGroup?.id ?? selectedTargetLabourer?.groupId ?? null,
        labourGroupName: earningScope === "group" ? selectedTargetGroup?.name ?? null : targetGroup?.name ?? selectedTargetLabourer?.group ?? null,
        foremanId: foremanId ?? null,
        earningDate,
        amount: numericAmount,
        earningType: formType,
        description: description.trim(),
        notes: notes.trim() || undefined,
        status: "pending_settlement",
        createdBy: user?.id,
        updatedBy: user?.id,
      });
      setAmount("");
      setDescription("");
      setNotes("");
      setSuccess("Labour earning recorded. It will be included in the next wage settlement.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to record this labour earning.");
    } finally {
      setSaving(false);
    }
  };

  const voidPendingEarning = async (earning: LabourEarning) => {
    if (!canManage) return;
    if (earning.status === "settled") {
      setError("Settled labour earnings must be reversed through settlement or adjustment workflow.");
      return;
    }
    await persistOperationalRecord("labourEarning", {
      ...earning,
      status: "voided",
      deletedAt: earning.deletedAt ?? null,
      updatedBy: user?.id,
    });
  };

  return (
    <>
      <section className="record-panel workforce-shell-intro workforce-shell-intro--nested">
        <div>
          <h2>Labour Earnings Ledger</h2>
          <p>Record non-attendance labour earnings for an individual labourer or an entire labour group, then settle them with wage settlement and advances.</p>
        </div>
      </section>

      <section className="record-panel">
        <div className="advances-heading">
          <h2>Record Labour Earning</h2>
          <span>These entries do not touch cash, accounts, or partner ledgers until settlement.</span>
        </div>
        <form className="module-form labour-earnings-form" onSubmit={(event) => void submit(event)}>
          <div className="advances-filter-row">
            <label className="advances-filter-field">
              <span>Earnings for</span>
              <select value={earningScope} onChange={(event) => {
                const nextScope = event.target.value === "group" ? "group" : "individual";
                setEarningScope(nextScope);
                setWorkTargetId("");
                setSelectedForemanId("");
              }}>
                <option value="individual">Individual labour</option>
                <option value="group">Labour group</option>
              </select>
            </label>
            <label className="advances-filter-field">
              <span>Date</span>
              <input required type="date" value={earningDate} onChange={(event) => setEarningDate(event.target.value)} />
            </label>
            {earningScope === "individual" ? (
              <label className="advances-filter-field">
                <span>Labourer</span>
                <select required value={workTargetId} onChange={(event) => setWorkTargetId(event.target.value)}>
                  <option value="">Select labourer</option>
                  {labourers.map((labourer) => <option key={labourer.id} value={labourer.id}>{labourer.name}</option>)}
                </select>
              </label>
            ) : (
              <label className="advances-filter-field">
                <span>Labour group</span>
                <select required value={workTargetId} onChange={(event) => {
                  const nextGroupId = event.target.value;
                  setWorkTargetId(nextGroupId);
                  const nextGroup = groupById.get(nextGroupId) ?? null;
                  setSelectedForemanId(nextGroup?.foremanId ?? nextGroup?.foremanLabourId ?? "");
                }}>
                  <option value="">Select group</option>
                  {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
                </select>
              </label>
            )}
          </div>
          <div className="advances-filter-row">
            <label className="advances-filter-field">
              <span>Assigned foreman</span>
              <input readOnly value={earningScope === "group" ? selectedGroupForeman?.name ?? "" : (selectedTargetLabourer?.group ? "" : "")} placeholder={earningScope === "group" ? "Resolved from selected group" : "Not required"} />
            </label>
            <label className="advances-filter-field">
              <span>Earnings type</span>
              <select value={formType} onChange={(event) => setFormType(event.target.value as LabourEarning["earningType"])}>{["lump_sum", "task", "bonus", "incentive", "adjustment", "other"].map((type) => <option key={type} value={type}>{labourEarningTypeLabel(type as LabourEarning["earningType"])}</option>)}</select>
            </label>
            <label className="advances-filter-field">
              <span>Earnings amount</span>
              <input required type="number" min="0" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} />
            </label>
          </div>
          <div className="advances-filter-row">
            <label className="advances-filter-field advances-filter-field--full">
              <span>Description</span>
              <input required value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What was earned?" />
            </label>
          </div>
          <label className="advances-filter-field advances-filter-field--full">
            <span>Notes</span>
            <input value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Optional notes" />
          </label>
          {error ? <p className="form-error">{error}</p> : null}
          {success ? <p className="context-message">{success}</p> : null}
          <button disabled={!canManage || saving} type="submit">{saving ? "Saving..." : earningScope === "group" ? "Record group earning" : "Record labour earning"}</button>
        </form>
      </section>

      <section className="record-panel">
        <div className="advances-heading">
          <h2>Labour earnings ledger</h2>
          <span>{visibleEarnings.length} entries</span>
        </div>
        <div className="labour-earnings-filters">
          <div className="labour-earnings-filter-row labour-earnings-filter-row--full">
            <SearchInput placeholder="Search earnings" value={search} onChange={setSearch} />
          </div>
          <div className="labour-earnings-filter-row labour-earnings-filter-row--full">
            <label className="advances-filter-field">
              <span>Scope</span>
              <select value={scopeFilter} onChange={(event) => setScopeFilter(event.target.value as "all" | "individual" | "group")}>
                <option value="all">All scopes</option>
                <option value="individual">Individual</option>
                <option value="group">Group</option>
              </select>
            </label>
          </div>
          <div className="labour-earnings-filter-row">
            <label className="advances-filter-field"><span>Labourer</span><select value={selectedLabourerId} onChange={(event) => setSelectedLabourerId(event.target.value)}><option value="">All labourers</option>{labourers.map((labourer) => <option key={labourer.id} value={labourer.id}>{labourer.name}</option>)}</select></label>
            <label className="advances-filter-field"><span>Labour group</span><select value={selectedGroupId} onChange={(event) => setSelectedGroupId(event.target.value)}><option value="">All groups</option>{groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>
          </div>
          <div className="labour-earnings-filter-row">
            <label className="advances-filter-field"><span>Type</span><select value={earningType} onChange={(event) => setEarningType(event.target.value as LabourEarning["earningType"] | "")}><option value="">All types</option>{["lump_sum", "task", "bonus", "incentive", "adjustment", "other"].map((type) => <option key={type} value={type}>{labourEarningTypeLabel(type as LabourEarning["earningType"])}</option>)}</select></label>
            <label className="advances-filter-field"><span>Status</span><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All status</option><option value="pending_settlement">Pending settlement</option><option value="settled">Settled</option><option value="voided">Voided</option></select></label>
          </div>
          <div className="labour-earnings-filter-row">
            <label className="advances-filter-field"><span>From</span><input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
            <label className="advances-filter-field"><span>To</span><input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
          </div>
          <div className="labour-earnings-filter-row">
            <label className="advances-filter-field"><span>Min amount</span><input type="number" min="0" step="0.01" value={minAmount} onChange={(event) => setMinAmount(event.target.value)} /></label>
            <label className="advances-filter-field"><span>Max amount</span><input type="number" min="0" step="0.01" value={maxAmount} onChange={(event) => setMaxAmount(event.target.value)} /></label>
          </div>
        </div>
        <div className="reports-kpis labour-earnings-kpis">
          <article><span>Individual earnings</span><strong>{money(totals.individual)}</strong></article>
          <article><span>Group earnings</span><strong>{money(totals.group)}</strong></article>
          <article><span>Pending earnings</span><strong>{money(sumLabourEarnings(pending))}</strong></article>
          <article><span>Settled earnings</span><strong>{money(sumLabourEarnings(settled))}</strong></article>
          <article><span>Voided earnings</span><strong>{money(sumLabourEarnings(voided))}</strong></article>
        </div>
        {!visibleEarnings.length ? (
          <p className="context-message">No labour earnings entries match this filter yet.</p>
        ) : (
          <div className="labour-earnings-list">
            <div className="labour-earnings-mobile-list">
              {visibleEarnings.map((earning) => {
                const labourer = earning.labourerId ? labourById.get(earning.labourerId) ?? null : null;
                const group = earning.labourGroupId ? groupById.get(earning.labourGroupId) ?? null : null;
                const foreman = earning.foremanId ? labourById.get(earning.foremanId) ?? null : null;
                const title = labourEarningTargetLabel(earning, labourer, group);
                return (
                  <article className="labour-earnings-card" key={earning.id}>
                    <header className="labour-earnings-card__header">
                      <div className="labour-earnings-card__title">
                        <strong>{title}</strong>
                        <span>{earning.earningDate} · {labourEarningScopeLabel(earning)} · {labourEarningTypeLabel(earning.earningType)}</span>
                      </div>
                      <strong className="labour-earnings-card__amount">{money(earning.amount)}</strong>
                    </header>
                    <div className="labour-earnings-card__status-row">
                      <span className={`labour-earnings-status-chip labour-earnings-status-chip--${earning.status}`}>{labourEarningStatusLabel(earning.status)}</span>
                    </div>
                    <details>
                      <summary>View details</summary>
                      <dl>
                        <div>
                          <dt>Scope</dt>
                          <dd>{labourEarningScopeLabel(earning)}</dd>
                        </div>
                        <div>
                          <dt>Type</dt>
                          <dd>{labourEarningTypeLabel(earning.earningType)}</dd>
                        </div>
                        <div>
                          <dt>Reference</dt>
                          <dd>{earning.linkedSettlementId ?? "No reference"}</dd>
                        </div>
                        <div>
                          <dt>Source ID</dt>
                          <dd>{earning.id}</dd>
                        </div>
                        <div>
                          <dt>Notes</dt>
                          <dd>{earning.notes?.trim() ? earning.notes : "No notes"}</dd>
                        </div>
                        {earning.earningScope === "group" && <div>
                          <dt>Foreman</dt>
                          <dd>{foreman?.name ?? earning.foremanId ?? "No foreman"}</dd>
                        </div>}
                      </dl>
                      <button type="button" onClick={() => navigate("/workspace/labour-payments/earnings")}>Open source record</button>
                    </details>
                  </article>
                );
              })}
            </div>
            <div className="attendance-import-table-wrap report-wide-table">
            <table className="report-data-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Scope</th>
                  <th>Labour / Group</th>
                  <th>Foreman</th>
                  <th>Type</th>
                  <th>Description</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th>Settlement</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {visibleEarnings.map((earning) => {
                  const labourer = earning.labourerId ? labourById.get(earning.labourerId) ?? null : null;
                  const group = earning.labourGroupId ? groupById.get(earning.labourGroupId) ?? null : null;
                  const foreman = earning.foremanId ? labourById.get(earning.foremanId) ?? null : null;
                  return (
                    <tr key={earning.id}>
                      <td>{earning.earningDate}</td>
                      <td><span className={`status-chip status-chip--${earning.earningScope}`}>{labourEarningScopeLabel(earning)}</span></td>
                      <td>{earning.earningScope === "group" ? group?.name ?? earning.labourGroupName ?? "Labour group" : labourer?.name ?? earning.labourerId ?? "Labourer"}</td>
                      <td>{earning.earningScope === "group" ? foreman?.name ?? earning.foremanId ?? "-" : "-"}</td>
                      <td>{labourEarningTypeLabel(earning.earningType)}</td>
                      <td>{earning.description}</td>
                      <td>{money(earning.amount)}</td>
                      <td><span className={`labour-earnings-status-chip labour-earnings-status-chip--${earning.status}`}>{labourEarningStatusLabel(earning.status)}</span></td>
                      <td>{earning.linkedSettlementId ?? "-"}</td>
                      <td>{earning.status === "pending_settlement" && canManage ? <button className="worker-dialog__link worker-dialog__link--danger" type="button" onClick={() => void voidPendingEarning(earning)}>Void</button> : "-"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          </div>
        )}
      </section>
    </>
  );
}
