import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { TFunction } from "i18next";
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
import { translateStatus } from "../../lib/statusLabels";
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

const labourEarningTargetLabel = (
  t: TFunction,
  earning: LabourEarning,
  labourer: Labourer | null,
  group: LabourGroup | null,
) => {
  if (earning.earningScope === "group") return group?.name ?? earning.labourGroupName ?? t("labourEarningsPage.labourEarningFallback");
  return labourer?.name ?? t("labourEarningsPage.labourEarningFallback");
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
      setError(t("labourEarningsPage.validAmountDescriptionRequired"));
      return;
    }
    if (!formType) {
      setError(t("labourEarningsPage.selectWorkType"));
      return;
    }
    if (earningScope === "individual") {
      if (!workTargetId) {
        setError(t("labourEarningsPage.selectLabourerError"));
        return;
      }
      const labourer = labourById.get(workTargetId);
      if (!labourer) {
        setError(t("labourEarningsPage.selectExistingLabourer"));
        return;
      }
    } else {
      if (!workTargetId) {
        setError(t("labourEarningsPage.selectLabourGroupError"));
        return;
      }
      if (!selectedGroupForemanId) {
        setError(t("labourEarningsPage.groupNoForeman"));
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
      setSuccess(t("labourEarningsPage.earningRecorded"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("labourEarningsPage.unableToRecord"));
    } finally {
      setSaving(false);
    }
  };

  const voidPendingEarning = async (earning: LabourEarning) => {
    if (!canManage) return;
    if (earning.status === "settled") {
      setError(t("labourEarningsPage.settledCannotVoid"));
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
          <h2>{t("labourEarningsPage.heading")}</h2>
          <p>{t("labourEarningsPage.introDescription")}</p>
        </div>
      </section>

      <section className="record-panel">
        <div className="advances-heading">
          <h2>{t("labourEarningsPage.recordTitle")}</h2>
          <span>{t("labourEarningsPage.recordDescription")}</span>
        </div>
        <form className="module-form labour-earnings-form" onSubmit={(event) => void submit(event)}>
          <div className="advances-filter-row">
            <label className="advances-filter-field">
              <span>{t("labourEarningsPage.earningsFor")}</span>
              <select value={earningScope} onChange={(event) => {
                const nextScope = event.target.value === "group" ? "group" : "individual";
                setEarningScope(nextScope);
                setWorkTargetId("");
                setSelectedForemanId("");
              }}>
                <option value="individual">{t("labourEarningsPage.individualLabourOption")}</option>
                <option value="group">{t("labourEarningsPage.labourGroup")}</option>
              </select>
            </label>
            <label className="advances-filter-field">
              <span>{t("labourEarningsPage.dateLabel")}</span>
              <input required type="date" value={earningDate} onChange={(event) => setEarningDate(event.target.value)} />
            </label>
            {earningScope === "individual" ? (
              <label className="advances-filter-field">
                <span>{t("labourEarningsPage.labourerLabel")}</span>
                <select required value={workTargetId} onChange={(event) => setWorkTargetId(event.target.value)}>
                  <option value="">{t("labourEarningsPage.selectLabourerPlaceholder")}</option>
                  {labourers.map((labourer) => <option key={labourer.id} value={labourer.id}>{labourer.name}</option>)}
                </select>
              </label>
            ) : (
              <label className="advances-filter-field">
                <span>{t("labourEarningsPage.labourGroup")}</span>
                <select required value={workTargetId} onChange={(event) => {
                  const nextGroupId = event.target.value;
                  setWorkTargetId(nextGroupId);
                  const nextGroup = groupById.get(nextGroupId) ?? null;
                  setSelectedForemanId(nextGroup?.foremanId ?? nextGroup?.foremanLabourId ?? "");
                }}>
                  <option value="">{t("labourEarningsPage.selectGroupPlaceholder")}</option>
                  {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
                </select>
              </label>
            )}
          </div>
          <div className="advances-filter-row">
            <label className="advances-filter-field">
              <span>{t("labourEarningsPage.assignedForeman")}</span>
              <input readOnly value={earningScope === "group" ? selectedGroupForeman?.name ?? "" : (selectedTargetLabourer?.group ? "" : "")} placeholder={earningScope === "group" ? t("labourEarningsPage.resolvedFromGroup") : t("labourEarningsPage.notRequired")} />
            </label>
            <label className="advances-filter-field">
              <span>{t("labourEarningsPage.earningsType")}</span>
              <select value={formType} onChange={(event) => setFormType(event.target.value as LabourEarning["earningType"])}>{["lump_sum", "task", "bonus", "incentive", "adjustment", "other"].map((type) => <option key={type} value={type}>{labourEarningTypeLabel(type as LabourEarning["earningType"])}</option>)}</select>
            </label>
            <label className="advances-filter-field">
              <span>{t("labourEarningsPage.earningsAmount")}</span>
              <input required type="number" min="0" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} />
            </label>
          </div>
          <div className="advances-filter-row">
            <label className="advances-filter-field advances-filter-field--full">
              <span>{t("labourEarningsPage.descriptionLabel")}</span>
              <input required value={description} onChange={(event) => setDescription(event.target.value)} placeholder={t("labourEarningsPage.descriptionPlaceholder")} />
            </label>
          </div>
          <label className="advances-filter-field advances-filter-field--full">
            <span>{t("farmsPage.notes")}</span>
            <input value={notes} onChange={(event) => setNotes(event.target.value)} placeholder={t("labourEarningsPage.notesPlaceholder")} />
          </label>
          {error ? <p className="form-error">{error}</p> : null}
          {success ? <p className="context-message">{success}</p> : null}
          <button disabled={!canManage || saving} type="submit">{saving ? t("labourEarningsPage.savingEllipsis") : earningScope === "group" ? t("labourEarningsPage.recordGroupEarning") : t("labourEarningsPage.recordLabourEarning")}</button>
        </form>
      </section>

      <section className="record-panel">
        <div className="advances-heading">
          <h2>{t("labourEarningsPage.ledgerTitle")}</h2>
          <span className="bidi-isolate">{t("labourEarningsPage.entriesCount", { count: visibleEarnings.length })}</span>
        </div>
        <div className="labour-earnings-filters">
          <div className="labour-earnings-filter-row labour-earnings-filter-row--full">
            <SearchInput placeholder={t("labourEarningsPage.searchPlaceholder")} value={search} onChange={setSearch} />
          </div>
          <div className="labour-earnings-filter-row labour-earnings-filter-row--full">
            <label className="advances-filter-field">
              <span>{t("labourEarningsPage.scopeLabel")}</span>
              <select value={scopeFilter} onChange={(event) => setScopeFilter(event.target.value as "all" | "individual" | "group")}>
                <option value="all">{t("labourEarningsPage.allScopes")}</option>
                <option value="individual">{t("labourEarningsPage.individualOption")}</option>
                <option value="group">{t("labourEarningsPage.groupOption")}</option>
              </select>
            </label>
          </div>
          <div className="labour-earnings-filter-row">
            <label className="advances-filter-field"><span>{t("labourEarningsPage.labourerLabel")}</span><select value={selectedLabourerId} onChange={(event) => setSelectedLabourerId(event.target.value)}><option value="">{t("labourEarningsPage.allLabourers")}</option>{labourers.map((labourer) => <option key={labourer.id} value={labourer.id}>{labourer.name}</option>)}</select></label>
            <label className="advances-filter-field"><span>{t("labourEarningsPage.labourGroup")}</span><select value={selectedGroupId} onChange={(event) => setSelectedGroupId(event.target.value)}><option value="">{t("labourEarningsPage.allGroups")}</option>{groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>
          </div>
          <div className="labour-earnings-filter-row">
            <label className="advances-filter-field"><span>{t("labourEarningsPage.typeLabel")}</span><select value={earningType} onChange={(event) => setEarningType(event.target.value as LabourEarning["earningType"] | "")}><option value="">{t("labourEarningsPage.allTypes")}</option>{["lump_sum", "task", "bonus", "incentive", "adjustment", "other"].map((type) => <option key={type} value={type}>{labourEarningTypeLabel(type as LabourEarning["earningType"])}</option>)}</select></label>
            <label className="advances-filter-field"><span>{t("labourEarningsPage.statusLabel")}</span><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">{t("labourEarningsPage.allStatus")}</option><option value="pending_settlement">{t("status.pending_settlement")}</option><option value="settled">{t("status.settled")}</option><option value="voided">{t("status.voided")}</option></select></label>
          </div>
          <div className="labour-earnings-filter-row">
            <label className="advances-filter-field"><span>{t("labourEarningsPage.fromLabel")}</span><input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
            <label className="advances-filter-field"><span>{t("labourEarningsPage.toLabel")}</span><input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
          </div>
          <div className="labour-earnings-filter-row">
            <label className="advances-filter-field"><span>{t("labourEarningsPage.minAmount")}</span><input type="number" min="0" step="0.01" value={minAmount} onChange={(event) => setMinAmount(event.target.value)} /></label>
            <label className="advances-filter-field"><span>{t("labourEarningsPage.maxAmount")}</span><input type="number" min="0" step="0.01" value={maxAmount} onChange={(event) => setMaxAmount(event.target.value)} /></label>
          </div>
        </div>
        <div className="reports-kpis labour-earnings-kpis">
          <article><span>{t("labourEarningsPage.individualEarnings")}</span><strong className="bidi-isolate">{money(totals.individual)}</strong></article>
          <article><span>{t("labourEarningsPage.groupEarnings")}</span><strong className="bidi-isolate">{money(totals.group)}</strong></article>
          <article><span>{t("labourEarningsPage.pendingEarnings")}</span><strong className="bidi-isolate">{money(sumLabourEarnings(pending))}</strong></article>
          <article><span>{t("labourEarningsPage.settledEarnings")}</span><strong className="bidi-isolate">{money(sumLabourEarnings(settled))}</strong></article>
          <article><span>{t("labourEarningsPage.voidedEarnings")}</span><strong className="bidi-isolate">{money(sumLabourEarnings(voided))}</strong></article>
        </div>
        {!visibleEarnings.length ? (
          <p className="context-message">{t("labourEarningsPage.emptyState")}</p>
        ) : (
          <div className="labour-earnings-list">
            <div className="labour-earnings-mobile-list">
              {visibleEarnings.map((earning) => {
                const labourer = earning.labourerId ? labourById.get(earning.labourerId) ?? null : null;
                const group = earning.labourGroupId ? groupById.get(earning.labourGroupId) ?? null : null;
                const foreman = earning.foremanId ? labourById.get(earning.foremanId) ?? null : null;
                const title = labourEarningTargetLabel(t, earning, labourer, group);
                return (
                  <article className="labour-earnings-card" key={earning.id}>
                    <header className="labour-earnings-card__header">
                      <div className="labour-earnings-card__title">
                        <strong>{title}</strong>
                        <span><span className="bidi-isolate">{earning.earningDate}</span> · {labourEarningScopeLabel(earning)} · {labourEarningTypeLabel(earning.earningType)}</span>
                      </div>
                      <strong className="labour-earnings-card__amount bidi-isolate">{money(earning.amount)}</strong>
                    </header>
                    <div className="labour-earnings-card__status-row">
                      <span className={`labour-earnings-status-chip labour-earnings-status-chip--${earning.status}`}>{translateStatus(t, earning.status)}</span>
                    </div>
                    <details>
                      <summary>{t("labourEarningsPage.viewDetails")}</summary>
                      <dl>
                        <div>
                          <dt>{t("labourEarningsPage.scopeLabel")}</dt>
                          <dd>{labourEarningScopeLabel(earning)}</dd>
                        </div>
                        <div>
                          <dt>{t("labourEarningsPage.typeLabel")}</dt>
                          <dd>{labourEarningTypeLabel(earning.earningType)}</dd>
                        </div>
                        <div>
                          <dt>{t("labourEarningsPage.referenceLabel")}</dt>
                          <dd>{earning.linkedSettlementId ? <span className="bidi-isolate">{earning.linkedSettlementId}</span> : t("labourEarningsPage.noReference")}</dd>
                        </div>
                        <div>
                          <dt>{t("labourEarningsPage.sourceIdLabel")}</dt>
                          <dd><span className="bidi-isolate">{earning.id}</span></dd>
                        </div>
                        <div>
                          <dt>{t("farmsPage.notes")}</dt>
                          <dd>{earning.notes?.trim() ? earning.notes : t("labourEarningsPage.noNotes")}</dd>
                        </div>
                        {earning.earningScope === "group" && <div>
                          <dt>{t("labourEarningsPage.foremanLabel")}</dt>
                          <dd>{foreman?.name ?? (earning.foremanId ? <span className="bidi-isolate">{earning.foremanId}</span> : t("labourEarningsPage.noForeman"))}</dd>
                        </div>}
                      </dl>
                      <button type="button" onClick={() => navigate("/workspace/labour-payments/earnings")}>{t("labourEarningsPage.openSourceRecord")}</button>
                    </details>
                  </article>
                );
              })}
            </div>
            <div className="attendance-import-table-wrap report-wide-table">
            <table className="report-data-table">
              <thead>
                <tr>
                  <th>{t("labourEarningsPage.dateLabel")}</th>
                  <th>{t("labourEarningsPage.scopeLabel")}</th>
                  <th>{t("labourEarningsPage.labourOrGroupColumn")}</th>
                  <th>{t("labourEarningsPage.foremanLabel")}</th>
                  <th>{t("labourEarningsPage.typeLabel")}</th>
                  <th>{t("labourEarningsPage.descriptionLabel")}</th>
                  <th>{t("labourEarningsPage.amountLabel")}</th>
                  <th>{t("labourEarningsPage.statusLabel")}</th>
                  <th>{t("labourEarningsPage.settlementLabel")}</th>
                  <th>{t("labourEarningsPage.actionsLabel")}</th>
                </tr>
              </thead>
              <tbody>
                {visibleEarnings.map((earning) => {
                  const labourer = earning.labourerId ? labourById.get(earning.labourerId) ?? null : null;
                  const group = earning.labourGroupId ? groupById.get(earning.labourGroupId) ?? null : null;
                  const foreman = earning.foremanId ? labourById.get(earning.foremanId) ?? null : null;
                  return (
                    <tr key={earning.id}>
                      <td><span className="bidi-isolate">{earning.earningDate}</span></td>
                      <td><span className={`status-chip status-chip--${earning.earningScope}`}>{labourEarningScopeLabel(earning)}</span></td>
                      <td>{earning.earningScope === "group"
                        ? group?.name ?? earning.labourGroupName ?? t("labourEarningsPage.labourGroup")
                        : labourer?.name ?? (earning.labourerId ? <span className="bidi-isolate">{earning.labourerId}</span> : t("labourEarningsPage.labourerLabel"))}</td>
                      <td>{earning.earningScope === "group" ? foreman?.name ?? (earning.foremanId ? <span className="bidi-isolate">{earning.foremanId}</span> : "-") : "-"}</td>
                      <td>{labourEarningTypeLabel(earning.earningType)}</td>
                      <td>{earning.description}</td>
                      <td><span className="bidi-isolate">{money(earning.amount)}</span></td>
                      <td><span className={`labour-earnings-status-chip labour-earnings-status-chip--${earning.status}`}>{translateStatus(t, earning.status)}</span></td>
                      <td>{earning.linkedSettlementId ? <span className="bidi-isolate">{earning.linkedSettlementId}</span> : "-"}</td>
                      <td>{earning.status === "pending_settlement" && canManage ? <button className="worker-dialog__link worker-dialog__link--danger" type="button" onClick={() => void voidPendingEarning(earning)}>{t("labourEarningsPage.voidAction")}</button> : "-"}</td>
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
