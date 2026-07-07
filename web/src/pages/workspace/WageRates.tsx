import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { SearchInput } from "../../components/SearchInput";
import { bulkUpsertWageRates, fetchWageRates, validateWageRateOverlap, type WageRateBulkRowInput, type WageRateOverlapPreview } from "../../lib/api";
import { getActiveFarmId, getActiveSeasonId, offlineDb, workspaceRecords, type Labourer, type WageRate } from "../../lib/offline-db";
import { canCreate, canEdit } from "../../lib/permissions";
import { formatMoney } from "../../lib/format";
import { compareWageRates, getWageRateStatus, normalizeHalfDayRate } from "../../lib/wageRates";
import { useAuth } from "../../auth/AuthProvider";
import { getWorkerWorkingPeriod, isWorkerEligibleForWageRatePeriod, sortWorkersForDisplay } from "../../lib/workerEligibility";

const today = () => new Date().toISOString().slice(0, 10);
const money = formatMoney;

type RowDraft = {
  dailyRate: string;
  halfDayRate: string;
  rateType: WageRate["rateType"];
  notes: string;
};

const emptyDraft: RowDraft = {
  dailyRate: "",
  halfDayRate: "",
  rateType: "daily",
  notes: "",
};

export function WageRates() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const { token, user } = useAuth();
  const workspaceId = user?.workspaceId ?? "";
  const [labourers, setLabourers] = useState<Labourer[]>([]);
  const [rates, setRates] = useState<WageRate[]>([]);
  const [search, setSearch] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState(today());
  const [effectiveTo, setEffectiveTo] = useState("");
  const [bulkDailyRate, setBulkDailyRate] = useState("");
  const [bulkHalfDayRate, setBulkHalfDayRate] = useState("");
  const [bulkRateType, setBulkRateType] = useState<WageRate["rateType"]>("daily");
  const [bulkNotes, setBulkNotes] = useState("");
  const [closePrevious, setClosePrevious] = useState(false);
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [changeReason, setChangeReason] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<Record<string, RowDraft>>({});
  const [editingRateId, setEditingRateId] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [overlapSummary, setOverlapSummary] = useState<string>("");
  const [overlapPreview, setOverlapPreview] = useState<WageRateOverlapPreview[]>([]);
  const canManage = Boolean(user && workspaceId && (canCreate(user, "wages", workspaceId) || canEdit(user, "wages", workspaceId)));
  const activeFarmId = getActiveFarmId();
  const activeSeasonId = getActiveSeasonId();

  const refresh = useCallback(async () => {
    const nextLabourers = await workspaceRecords(offlineDb.labourers);
    setLabourers(sortWorkersForDisplay(nextLabourers, { includeArchived: false }));
    if (!activeFarmId || !activeSeasonId) {
      setRates([]);
      return;
    }
    if (token && workspaceId && navigator.onLine) {
      try {
        const response = await fetchWageRates(token, workspaceId, {
          farmId: activeFarmId!,
          seasonId: activeSeasonId!,
          includeInactive: true,
        });
        await offlineDb.wageRates.bulkPut(response.rates.map((rate) => ({ ...rate, pendingSync: false })));
      } catch {
        // keep cache
      }
    }
    const nextRates = await workspaceRecords(offlineDb.wageRates, { includeDeleted: true });
    setRates(nextRates.sort(compareWageRates));
  }, [activeFarmId, activeSeasonId, token, workspaceId]);

  useEffect(() => {
    void refresh();
    const handle = () => void refresh();
    window.addEventListener("muzare-data-refresh", handle);
    window.addEventListener("muzare-local-data-change", handle);
    return () => {
      window.removeEventListener("muzare-data-refresh", handle);
      window.removeEventListener("muzare-local-data-change", handle);
    };
  }, [refresh]);
  useEffect(() => {
    const labourId = searchParams.get("labourId") ?? "";
    if (!labourId) return;
    setSelectedIds([labourId]);
  }, [searchParams]);

  const todayKey = today();
  const wageRangeTo = effectiveTo || effectiveFrom;
  const filteredLabourers = useMemo(() => sortWorkersForDisplay(labourers.filter((labourer) => {
    const term = search.trim().toLowerCase();
    return isWorkerEligibleForWageRatePeriod(labourer, effectiveFrom, wageRangeTo)
      && (!term || labourer.name.toLowerCase().includes(term) || labourer.group.toLowerCase().includes(term));
  }), { includeArchived: false }), [effectiveFrom, labourers, search, wageRangeTo]);
  const ratesByLabourer = useMemo(() => {
    const map = new Map<string, WageRate[]>();
    for (const rate of rates) {
      const current = map.get(rate.labourerId) ?? [];
      current.push(rate);
      map.set(rate.labourerId, current);
    }
    return map;
  }, [rates]);
  const currentRates = useMemo(() => labourers.flatMap((labourer) => {
    const current = (ratesByLabourer.get(labourer.id) ?? [])
      .filter((rate) => getWageRateStatus(rate, todayKey) === "active")
      .sort(compareWageRates)[0];
    return current ? [{ labourer, rate: current }] : [];
  }), [labourers, ratesByLabourer, todayKey]);
  const selectedCount = selectedIds.length;
  const filteredIds = useMemo(() => filteredLabourers.map((labourer) => labourer.id), [filteredLabourers]);
  const filteredSelectedCount = useMemo(() => filteredIds.filter((id) => selectedIds.includes(id)).length, [filteredIds, selectedIds]);

  const toggleLabour = (labourerId: string) => {
    setSelectedIds((current) => current.includes(labourerId)
      ? current.filter((item) => item !== labourerId)
      : [...current, labourerId]);
  };

  const selectAllFiltered = () => {
    setSelectedIds((current) => [...new Set([...current, ...filteredIds])]);
  };

  const deselectAllFiltered = () => {
    setSelectedIds((current) => current.filter((id) => !filteredIds.includes(id)));
  };

  const applyBulkToSelected = () => {
    if (!selectedIds.length) return;
    setDrafts((current) => Object.fromEntries([
      ...Object.entries(current),
      ...selectedIds.map((labourerId) => [labourerId, {
        dailyRate: bulkDailyRate,
        halfDayRate: bulkHalfDayRate,
        rateType: bulkRateType,
        notes: bulkNotes,
      } satisfies RowDraft]),
    ]));
  };

  const updateDraft = (labourerId: string, update: Partial<RowDraft>) => {
    setDrafts((current) => ({
      ...current,
      [labourerId]: { ...(current[labourerId] ?? emptyDraft), ...update },
    }));
  };

  const resetEditor = () => {
    setEditingRateId("");
    setClosePrevious(false);
    setReplaceExisting(false);
    setChangeReason("");
    setOverlapSummary("");
    setOverlapPreview([]);
  };

  const startEditingRate = (rate: WageRate) => {
    const labourer = labourers.find((item) => item.id === rate.labourerId);
    setEditingRateId(rate.id);
    setSelectedIds([rate.labourerId]);
    setEffectiveFrom(rate.effectiveFrom);
    setEffectiveTo(rate.effectiveTo ?? "");
    setBulkDailyRate(String(rate.dailyRate));
    setBulkHalfDayRate(String(normalizeHalfDayRate(rate)));
    setBulkRateType(rate.rateType);
    setBulkNotes(rate.notes ?? "");
    setDrafts({
      [rate.labourerId]: {
        dailyRate: String(rate.dailyRate),
        halfDayRate: String(normalizeHalfDayRate(rate)),
        rateType: rate.rateType,
        notes: rate.notes ?? "",
      },
    });
    setSearch(labourer?.name ?? "");
    setError("");
    setSuccess("");
    setOverlapSummary("");
    setOverlapPreview([]);
    setReplaceExisting(false);
    setClosePrevious(false);
    setChangeReason("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setSuccess("");
    setOverlapSummary("");
    setOverlapPreview([]);
    if (!canManage) {
      setError(t("common.viewOnlyAccess"));
      return;
    }
    if (!activeFarmId || !activeSeasonId) {
      setError(t("farmsPage.noActiveSeason"));
      return;
    }
    if (!navigator.onLine) {
      setError(t("wageRatesPage.onlineRequired"));
      return;
    }
    const rows: WageRateBulkRowInput[] = selectedIds.flatMap((labourerId) => {
      const draft = drafts[labourerId];
      const dailyRate = Number(draft?.dailyRate ?? "");
      if (!Number.isFinite(dailyRate) || dailyRate < 0) return [];
      const halfDayRate = draft?.halfDayRate ? Number(draft.halfDayRate) : undefined;
      return [{
        id: editingRateId && selectedIds.length === 1 && labourerId === selectedIds[0] ? editingRateId : undefined,
        labourerId,
        dailyRate,
        halfDayRate,
        rateType: draft?.rateType ?? bulkRateType,
        notes: draft?.notes ?? bulkNotes,
      }];
    });
    if (!rows.length) {
      setError(t("wageRatesPage.noSelectedRates"));
      return;
    }
    setSaving(true);
    try {
      const preview = await validateWageRateOverlap(token!, workspaceId, {
        farmId: activeFarmId!,
        seasonId: activeSeasonId!,
        effectiveFrom,
        effectiveTo: effectiveTo || null,
        rows,
      });
      setOverlapPreview(preview.overlaps);
      if (!preview.valid && !closePrevious && !replaceExisting) {
        setOverlapSummary(preview.overlaps.map((item) => `${item.labourName ?? item.labourerId}: ${item.overlaps.length}`).join(" · "));
        setError(t("wageRatesPage.overlapDetected"));
        return;
      }
      const response = await bulkUpsertWageRates(token!, workspaceId, {
        farmId: activeFarmId!,
        seasonId: activeSeasonId!,
        effectiveFrom,
        effectiveTo: effectiveTo || null,
        rateType: bulkRateType,
        notes: bulkNotes,
        closePrevious,
        replaceExisting,
        changeReason: changeReason.trim() || undefined,
        rows,
      });
      await offlineDb.wageRates.bulkPut(response.rates.map((rate) => ({ ...rate, pendingSync: false })));
      setSuccess(t("wageRatesPage.savedSuccess", { count: response.rates.length }));
      setSelectedIds([]);
      setDrafts({});
      resetEditor();
      window.dispatchEvent(new Event("muzare-local-data-change"));
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("wageRatesPage.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
        <section className="record-panel workforce-shell-intro workforce-shell-intro--nested">
          <div>
            <h2>{t("wageRatesPage.heading")}</h2>
            <p>{t("wageRatesPage.description")}</p>
          </div>
        </section>

        <section className="record-panel">
          <div className="advances-heading">
            <h2>{t("wageRatesPage.currentRates")}</h2>
            <span>{t("wageRatesPage.activeRateCount", { count: currentRates.length })}</span>
          </div>
          {!currentRates.length ? <p className="context-message">{t("wageRatesPage.noCurrentRates")}</p> : (
            <div className="team-list">
              {currentRates.map(({ labourer, rate }) => (
                <article key={`${labourer.id}:${rate.id}`} className="team-card">
                  <div>
                    <strong>{labourer.name}</strong>
                    <span>{labourer.group || "-"}</span>
                    <small>{t("wageRatesPage.effectiveRange", { from: rate.effectiveFrom, to: rate.effectiveTo || t("common.current") })}</small>
                  </div>
                  <div>
                    <strong>{money(rate.dailyRate)}</strong>
                    <small>{t("wageRatesPage.halfDayRate")}: {money(normalizeHalfDayRate(rate))}</small>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="record-panel">
          <div className="advances-heading">
            <h2>{t("wageRatesPage.bulkEntry")}</h2>
            <span>{t("wageRatesPage.bulkEntryDescription")}</span>
          </div>
          <form className="module-form wage-rates-form" onSubmit={(event) => void submit(event)}>
            {editingRateId ? (
              <div className="wage-rates-edit-banner">
                <div>
                  <strong>{t("wageRatesPage.editingRate")}</strong>
                  <span>{t("wageRatesPage.editingRateDescription")}</span>
                </div>
                <button className="secondary-action" type="button" onClick={() => {
                  setSelectedIds([]);
                  setDrafts({});
                  setSearch("");
                  resetEditor();
                }}>{t("common.cancel")}</button>
              </div>
            ) : null}
            <div className="advances-filter-row wage-rates-toolbar">
              <label className="advances-filter-field"><span>{t("wageRatesPage.effectiveFrom")}</span><input required type="date" value={effectiveFrom} onChange={(event) => setEffectiveFrom(event.target.value)} /></label>
              <label className="advances-filter-field"><span>{t("wageRatesPage.effectiveTo")}</span><input type="date" value={effectiveTo} onChange={(event) => setEffectiveTo(event.target.value)} /></label>
              <label className="advances-filter-field"><span>{t("wageRatesPage.rateType")}</span><select value={bulkRateType} onChange={(event) => setBulkRateType(event.target.value as WageRate["rateType"])}><option value="daily">{t("wageRatesPage.dailyRateType")}</option><option value="half_day">{t("wageRatesPage.halfDayRateType")}</option><option value="monthly">{t("wageRatesPage.monthlyRateType")}</option><option value="custom">{t("wageRatesPage.customRateType")}</option></select></label>
            </div>
            <div className="advances-filter-row wage-rates-toolbar">
              <label className="advances-filter-field"><span>{t("wageRatesPage.dailyRate")}</span><input inputMode="decimal" type="number" min="0" step="0.01" value={bulkDailyRate} onChange={(event) => setBulkDailyRate(event.target.value)} /></label>
              <label className="advances-filter-field"><span>{t("wageRatesPage.halfDayRate")}</span><input inputMode="decimal" type="number" min="0" step="0.01" value={bulkHalfDayRate} onChange={(event) => setBulkHalfDayRate(event.target.value)} /></label>
              <label className="advances-filter-field advances-filter-field--full"><span>{t("wageRatesPage.notes")}</span><input value={bulkNotes} onChange={(event) => setBulkNotes(event.target.value)} /></label>
            </div>
            <div className="permission-dialog__meta wage-rates-options">
              <label className="compact-checkbox"><input type="checkbox" checked={closePrevious} onChange={(event) => setClosePrevious(event.target.checked)} />{t("wageRatesPage.closePrevious")}</label>
              <label className="compact-checkbox"><input type="checkbox" checked={replaceExisting} onChange={(event) => setReplaceExisting(event.target.checked)} />{t("wageRatesPage.replaceExisting")}</label>
              <button className="secondary-action" disabled={selectedCount === 0} type="button" onClick={applyBulkToSelected}>{t("wageRatesPage.applyBulkRate")}</button>
            </div>
            <label className="advances-filter-field advances-filter-field--full">
              <span>{t("wageRatesPage.changeReason")}</span>
              <input value={changeReason} onChange={(event) => setChangeReason(event.target.value)} placeholder={t("wageRatesPage.changeReasonPlaceholder")} />
            </label>
            <SearchInput placeholder={t("wageRatesPage.searchLabour")} value={search} onChange={setSearch} />
            <div className="wage-rates-selection-bar">
              <div>
                <strong>{t("wageRatesPage.selectedCount", { count: selectedCount })}</strong>
                <span>{t("wageRatesPage.filteredSelectionCount", { count: filteredSelectedCount, total: filteredLabourers.length })}</span>
              </div>
              <div className="wage-rates-selection-actions">
                <button className="secondary-action" disabled={filteredLabourers.length === 0} type="button" onClick={selectAllFiltered}>{t("wageRatesPage.selectAll")}</button>
                <button className="secondary-action" disabled={filteredSelectedCount === 0} type="button" onClick={deselectAllFiltered}>{t("wageRatesPage.deselectAll")}</button>
              </div>
            </div>
            <div className="wage-rate-labour-list">
              {filteredLabourers.map((labourer) => {
                const draft = drafts[labourer.id] ?? emptyDraft;
                const latestRate = (ratesByLabourer.get(labourer.id) ?? []).sort(compareWageRates)[0];
                const workingPeriod = getWorkerWorkingPeriod(labourer);
                return (
                  <article key={labourer.id} className={`wage-rate-labour-row${selectedIds.includes(labourer.id) ? " is-selected" : ""}`}>
                    <div className="wage-rate-labour-main">
                      <label className="compact-checkbox wage-rate-labour-toggle">
                        <input type="checkbox" checked={selectedIds.includes(labourer.id)} onChange={() => toggleLabour(labourer.id)} />
                        <strong>{labourer.name}</strong>
                      </label>
                      <span>{labourer.group || "-"}</span>
                      <small>{latestRate ? `${t("wageRatesPage.currentRate")}: ${money(latestRate.dailyRate)}` : t("wageRatesPage.noCurrentRate")}</small>
                      <small>{workingPeriod.workerEnd ? `Left after ${workingPeriod.workerEnd}` : "Active for selected period"}</small>
                    </div>
                    <div className="wage-rate-entry-grid">
                      <input aria-label={`${labourer.name} ${t("wageRatesPage.dailyRate")}`} inputMode="decimal" type="number" min="0" step="0.01" value={draft.dailyRate} onChange={(event) => updateDraft(labourer.id, { dailyRate: event.target.value })} placeholder={t("wageRatesPage.dailyRate")} />
                      <input aria-label={`${labourer.name} ${t("wageRatesPage.halfDayRate")}`} inputMode="decimal" type="number" min="0" step="0.01" value={draft.halfDayRate} onChange={(event) => updateDraft(labourer.id, { halfDayRate: event.target.value })} placeholder={t("wageRatesPage.halfDayRate")} />
                      <input aria-label={`${labourer.name} ${t("wageRatesPage.notes")}`} value={draft.notes} onChange={(event) => updateDraft(labourer.id, { notes: event.target.value })} placeholder={t("wageRatesPage.notes")} />
                    </div>
                  </article>
                );
              })}
            </div>
            {overlapPreview.length ? (
              <div className="wage-rate-overlap-list">
                {overlapPreview.map((item) => (
                  <article key={item.labourerId} className="wage-rate-overlap-card">
                    <div className="wage-rate-overlap-head">
                      <strong>{item.labourName ?? item.labourerId}</strong>
                      <span>{t("wageRatesPage.affectedAttendance", { count: item.affectedAttendanceCount })}</span>
                    </div>
                    <small>{t("wageRatesPage.overlapAffectedDates", { from: item.affectedFrom, to: item.affectedTo || t("common.current") })}</small>
                    <ul>
                      {item.overlaps.map((overlap) => (
                        <li key={overlap.id}>
                          <span>{t("wageRatesPage.effectiveRange", { from: overlap.effectiveFrom, to: overlap.effectiveTo || t("common.current") })}</span>
                          <strong>{money(overlap.dailyRate)} / {money(overlap.halfDayRate)}</strong>
                        </li>
                      ))}
                    </ul>
                  </article>
                ))}
              </div>
            ) : null}
            {overlapSummary ? <p className="form-error">{overlapSummary}</p> : null}
            {error ? <p className="form-error">{error}</p> : null}
            {success ? <p className="context-message">{success}</p> : null}
            <div className="wage-rates-submit-bar">
              <span>{selectedCount === 0 ? t("wageRatesPage.noSelectionReady") : t("wageRatesPage.readyToSave", { count: selectedCount })}</span>
              <button disabled={saving || !canManage || selectedCount === 0} type="submit">{saving ? t("advancesPage.saving") : editingRateId ? t("wageRatesPage.updateRates") : t("wageRatesPage.saveRates")}</button>
            </div>
          </form>
        </section>

        <section className="record-panel">
          <div className="advances-heading">
            <h2>{t("wageRatesPage.history")}</h2>
            <span>{t("wageRatesPage.historyDescription")}</span>
          </div>
          {!rates.length ? <p className="context-message">{t("wageRatesPage.noHistory")}</p> : (
            <div className="attendance-import-table-wrap report-wide-table">
              <table className="report-data-table">
                <thead>
                  <tr>
                    <th>{t("reportsPage.labour")}</th>
                    <th>{t("wageRatesPage.effectiveFrom")}</th>
                    <th>{t("wageRatesPage.effectiveTo")}</th>
                    <th>{t("wageRatesPage.dailyRate")}</th>
                    <th>{t("wageRatesPage.halfDayRate")}</th>
                    <th>{t("common.status")}</th>
                    <th>{t("common.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {rates.map((rate) => (
                    <tr key={rate.id}>
                      <td>{labourers.find((labourer) => labourer.id === rate.labourerId)?.name ?? rate.labourerId}</td>
                      <td>{rate.effectiveFrom}</td>
                      <td>{rate.effectiveTo || "-"}</td>
                      <td>{money(rate.dailyRate)}</td>
                      <td>{money(normalizeHalfDayRate(rate))}</td>
                      <td>{t(`wageRatesPage.status.${getWageRateStatus(rate, todayKey)}`)}</td>
                      <td>{canManage ? <button className="secondary-action" type="button" onClick={() => startEditingRate(rate)}>{t("common.edit")}</button> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
    </>
  );
}
