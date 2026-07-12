import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { ChevronRight, Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { SearchInput } from "../../components/SearchInput";
import { ClearableSelect } from "../../components/ClearableSelect";
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
  const [activeSearch, setActiveSearch] = useState("");
  const [activeGroupFilter, setActiveGroupFilter] = useState("");
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
  const [editorOpen, setEditorOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historySearch, setHistorySearch] = useState("");
  const [historyGroupFilter, setHistoryGroupFilter] = useState("");
  const [historyStatusFilter, setHistoryStatusFilter] = useState<"all" | "active" | "expired" | "upcoming" | "inactive">("all");
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
  const groupOptions = useMemo(() => Array.from(new Set(labourers.map((labourer) => labourer.group.trim()).filter(Boolean))).sort((left, right) => left.localeCompare(right)).map((group) => ({ value: group, label: group })), [labourers]);
  const historyRows = useMemo(() => rates
    .map((rate) => ({ rate, status: getWageRateStatus(rate, todayKey) }))
    .sort((left, right) => compareWageRates(left.rate, right.rate)), [rates, todayKey]);
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
  const filteredCurrentRates = useMemo(() => currentRates.filter(({ labourer }) => {
    const term = activeSearch.trim().toLowerCase();
    const matchesSearch = !term || labourer.name.toLowerCase().includes(term) || labourer.group.toLowerCase().includes(term);
    const matchesGroup = !activeGroupFilter || labourer.group === activeGroupFilter;
    return matchesSearch && matchesGroup;
  }), [activeGroupFilter, activeSearch, currentRates]);
  const historicalRateCount = useMemo(() => historyRows.filter(({ status }) => status !== "active").length, [historyRows]);
  const filteredHistoryRows = useMemo(() => historyRows.filter(({ rate, status }) => {
    const term = historySearch.trim().toLowerCase();
    const labourer = labourers.find((item) => item.id === rate.labourerId);
    const matchesSearch = !term || labourer?.name.toLowerCase().includes(term) || (labourer?.group ?? "").toLowerCase().includes(term) || (rate.notes ?? "").toLowerCase().includes(term);
    const matchesGroup = !historyGroupFilter || labourer?.group === historyGroupFilter;
    const matchesStatus = historyStatusFilter === "all" || status === historyStatusFilter;
    return matchesSearch && matchesGroup && matchesStatus;
  }), [historyGroupFilter, historyStatusFilter, historyRows, historySearch, labourers]);
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

  const openAddRates = () => {
    resetEditor();
    setSelectedIds([]);
    setDrafts({});
    setEffectiveFrom(today());
    setEffectiveTo("");
    setBulkDailyRate("");
    setBulkHalfDayRate("");
    setBulkRateType("daily");
    setBulkNotes("");
    setSearch("");
    setEditorOpen(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
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
    setEditorOpen(true);
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
      setEditorOpen(false);
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
      <main className="subpage module-workspace wage-rates-page">
        <section className="record-panel wage-rates-management-card">
          <div className="advances-heading">
            <h2>{t("wageRatesPage.heading")}</h2>
            <span>{t("wageRatesPage.description")}</span>
          </div>
          <div className="wage-rates-management-actions">
            <button className="primary-action wage-rates-management-actions__primary" type="button" onClick={openAddRates}>
              <Plus size={16} />
              <span>Add / Update Rates</span>
            </button>
            <button className="secondary-action wage-rates-management-actions__history" type="button" onClick={() => setHistoryOpen(true)}>
              <span>
                <strong>{t("wageRatesPage.history")}</strong>
                <small>{historicalRateCount} previous rates</small>
              </span>
              <ChevronRight size={16} />
            </button>
          </div>
        </section>

        <section className="record-panel wage-rates-active-section">
          <div className="advances-heading">
            <h2>{t("wageRatesPage.currentRates")}</h2>
            <span>{t("wageRatesPage.activeRateCount", { count: currentRates.length })}</span>
          </div>
          <div className="wage-rates-active-toolbar">
            <SearchInput placeholder={t("wageRatesPage.searchLabour")} value={activeSearch} onChange={setActiveSearch} />
            {groupOptions.length ? (
              <ClearableSelect aria-label="Group filter" value={activeGroupFilter} onChange={setActiveGroupFilter}>
                <option value="">All groups</option>
                {groupOptions.map((group) => (
                  <option key={group.value} value={group.value}>{group.label}</option>
                ))}
              </ClearableSelect>
            ) : null}
          </div>
          {(activeSearch || activeGroupFilter) ? <p className="wage-rates-active-note">Showing {filteredCurrentRates.length} of {currentRates.length} active rates</p> : null}
          {!filteredCurrentRates.length ? <p className="context-message">{t("wageRatesPage.noCurrentRates")}</p> : (
            <div className="wage-rate-active-list">
              {filteredCurrentRates.map(({ labourer, rate }) => (
                <article key={`${labourer.id}:${rate.id}`} className="wage-rate-active-card">
                  <div className="wage-rate-active-card__copy">
                    <div className="wage-rate-active-card__head">
                      <strong>{labourer.name}</strong>
                      <span>{money(rate.dailyRate)}</span>
                    </div>
                    <small>{labourer.group || "-"} · {t("wageRatesPage.effectiveRange", { from: rate.effectiveFrom, to: rate.effectiveTo || t("common.current") })}</small>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="record-panel wage-rates-history-card">
          <div className="advances-heading">
            <h2>{t("wageRatesPage.history")}</h2>
            <span>{t("wageRatesPage.historyDescription")}</span>
          </div>
          <div className="wage-rates-history-card__content">
            <p className="wage-rates-history-card__note">Active, expired, and upcoming wage-rate ranges are available in the history sheet.</p>
            <button className="secondary-action wage-rates-history-card__open" type="button" onClick={() => setHistoryOpen(true)}>
              <span>Open Wage Rate History</span>
              <ChevronRight size={16} />
            </button>
          </div>
        </section>
      </main>

      {editorOpen ? (
        <div className="worker-dialog-backdrop wage-rates-editor-backdrop" role="presentation" onClick={() => { if (!saving) { setEditorOpen(false); resetEditor(); } }}>
          <section
            className="worker-dialog worker-dialog--wide wage-rates-editor-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={editingRateId ? "Update wage rates" : "Add / Update Rates"}
            onClick={(event) => event.stopPropagation()}
          >
            <header className="worker-dialog__header wage-rates-editor__header">
              <div className="worker-dialog__title-stack">
                <span className="worker-dialog__eyebrow">Wage Rate Management</span>
                <h2>Add / Update Rates</h2>
                <p>Select multiple labourers, set effective dates, and save rate updates together.</p>
              </div>
              <button type="button" className="worker-dialog__icon-button" aria-label={t("common.close")} disabled={saving} onClick={() => { if (!saving) { setEditorOpen(false); resetEditor(); } }}>
                <X size={18} />
              </button>
            </header>
            <form className="wage-rates-editor-form" onSubmit={(event) => void submit(event)}>
              <div className="worker-dialog__body wage-rates-editor__body">
                {editingRateId ? (
                  <div className="wage-rates-edit-banner">
                    <div>
                      <strong>{t("wageRatesPage.editingRate")}</strong>
                      <span>{t("wageRatesPage.editingRateDescription")}</span>
                    </div>
                    <button className="secondary-action" type="button" disabled={saving} onClick={() => {
                      setSelectedIds([]);
                      setDrafts({});
                      setSearch("");
                      resetEditor();
                      setEditorOpen(false);
                    }}>{t("common.cancel")}</button>
                  </div>
                ) : null}

                <section className="wage-rates-editor-section">
                  <div className="advances-heading">
                    <h3>Rate details</h3>
                    <span>Set the values that will apply to the selected labourers.</span>
                  </div>
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
                  <div className="wage-rates-options">
                    <label className="compact-checkbox wage-rates-toggle-row"><input type="checkbox" checked={closePrevious} onChange={(event) => setClosePrevious(event.target.checked)} /><span>{t("wageRatesPage.closePrevious")}</span></label>
                    <label className="compact-checkbox wage-rates-toggle-row"><input type="checkbox" checked={replaceExisting} onChange={(event) => setReplaceExisting(event.target.checked)} /><span>{t("wageRatesPage.replaceExisting")}</span></label>
                  </div>
                  <button className="secondary-action wage-rates-apply-button" disabled={selectedCount === 0} type="button" onClick={applyBulkToSelected}>Apply values to selected labourers</button>
                  <label className="advances-filter-field advances-filter-field--full">
                    <span>{t("wageRatesPage.changeReason")}</span>
                    <input value={changeReason} onChange={(event) => setChangeReason(event.target.value)} placeholder={t("wageRatesPage.changeReasonPlaceholder")} />
                  </label>
                </section>

                <section className="wage-rates-editor-section">
                  <div className="wage-rates-selection-bar wage-rates-selection-bar--editor">
                    <div>
                      <strong>{selectedCount} selected from {filteredLabourers.length} labourers</strong>
                      <span>{filteredSelectedCount} matching labourers in the current search</span>
                    </div>
                    <div className="wage-rates-selection-actions">
                      <button className="secondary-action" disabled={filteredLabourers.length === 0} type="button" onClick={selectAllFiltered}>Select all filtered</button>
                      <button className="secondary-action" disabled={filteredSelectedCount === 0} type="button" onClick={deselectAllFiltered}>Clear filtered</button>
                    </div>
                  </div>
                  <SearchInput placeholder="Search labour" value={search} onChange={setSearch} />
                  <div className="wage-rate-labour-list">
                    {filteredLabourers.map((labourer) => {
                      const draft = drafts[labourer.id] ?? emptyDraft;
                      const latestRate = (ratesByLabourer.get(labourer.id) ?? []).sort(compareWageRates)[0];
                      const workingPeriod = getWorkerWorkingPeriod(labourer);
                      const selected = selectedIds.includes(labourer.id);
                      return (
                        <article key={labourer.id} className={`wage-rate-labour-row${selected ? " is-selected" : ""}`}>
                          <button type="button" className="wage-rate-labour-summary" onClick={() => toggleLabour(labourer.id)}>
                            <span className="wage-rate-labour-toggle">
                              <input type="checkbox" checked={selected} onChange={() => toggleLabour(labourer.id)} />
                              <span className="wage-rate-labour-summary__copy">
                                <strong>{labourer.name}</strong>
                                <span>{labourer.group || "-"} · {workingPeriod.workerEnd ? `${workingPeriod.workerStart} to ${workingPeriod.workerEnd}` : "Current"} · {latestRate ? money(latestRate.dailyRate) : t("wageRatesPage.noCurrentRate")}</span>
                              </span>
                            </span>
                            <span className="wage-rate-labour-summary-rate">{latestRate ? money(latestRate.dailyRate) : "-"}</span>
                          </button>
                          {selected ? (
                            <div className="wage-rate-entry-grid">
                              <input aria-label={`${labourer.name} ${t("wageRatesPage.dailyRate")}`} inputMode="decimal" type="number" min="0" step="0.01" value={draft.dailyRate} onChange={(event) => updateDraft(labourer.id, { dailyRate: event.target.value })} placeholder={t("wageRatesPage.dailyRate")} />
                              <input aria-label={`${labourer.name} ${t("wageRatesPage.halfDayRate")}`} inputMode="decimal" type="number" min="0" step="0.01" value={draft.halfDayRate} onChange={(event) => updateDraft(labourer.id, { halfDayRate: event.target.value })} placeholder={t("wageRatesPage.halfDayRate")} />
                              <input aria-label={`${labourer.name} ${t("wageRatesPage.notes")}`} value={draft.notes} onChange={(event) => updateDraft(labourer.id, { notes: event.target.value })} placeholder={t("wageRatesPage.notes")} />
                            </div>
                          ) : null}
                        </article>
                      );
                    })}
                  </div>
                </section>

                {overlapPreview.length ? (
                  <section className="wage-rates-editor-section">
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
                  </section>
                ) : null}
                {overlapSummary ? <p className="form-error">{overlapSummary}</p> : null}
                {error ? <p className="form-error">{error}</p> : null}
                {success ? <p className="context-message">{success}</p> : null}
              </div>
              <footer className="worker-dialog__footer wage-rates-submit-bar wage-rates-submit-bar--sticky">
                <span>{selectedCount === 0 ? "Select labourers and enter rates to continue." : `${selectedCount} selected`}</span>
                <button disabled={saving || !canManage || selectedCount === 0} type="submit">{saving ? t("advancesPage.saving") : editingRateId ? t("wageRatesPage.updateRates") : t("wageRatesPage.saveRates")}</button>
              </footer>
            </form>
          </section>
        </div>
      ) : null}

      {historyOpen ? (
        <div className="worker-dialog-backdrop wage-rates-history-backdrop" role="presentation" onClick={() => setHistoryOpen(false)}>
          <section
            className="worker-dialog worker-dialog--wide wage-rates-history-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={t("wageRatesPage.history")}
            onClick={(event) => event.stopPropagation()}
          >
            <header className="worker-dialog__header wage-rates-history__header">
              <div className="worker-dialog__title-stack">
                <span className="worker-dialog__eyebrow">{t("wageRatesPage.history")}</span>
                <h2>{t("wageRatesPage.history")}</h2>
                <p>{t("wageRatesPage.historyDescription")}</p>
              </div>
              <button type="button" className="worker-dialog__icon-button" aria-label={t("common.close")} onClick={() => setHistoryOpen(false)}>
                <X size={18} />
              </button>
            </header>
            <div className="worker-dialog__body wage-rates-history__body">
              <section className="wage-rates-history-summary">
                <article>
                  <span>Total records</span>
                  <strong>{historyRows.length}</strong>
                </article>
                <article>
                  <span>Current</span>
                  <strong>{historyRows.filter(({ status }) => status === "active").length}</strong>
                </article>
                <article>
                  <span>Expired</span>
                  <strong>{historyRows.filter(({ status }) => status === "expired").length}</strong>
                </article>
                <article>
                  <span>Future</span>
                  <strong>{historyRows.filter(({ status }) => status === "upcoming").length}</strong>
                </article>
              </section>

              <section className="wage-rates-history-filters">
                <SearchInput placeholder="Search labour" value={historySearch} onChange={setHistorySearch} />
                <div className="wage-rates-history-filters__row">
                  <ClearableSelect aria-label="Group filter" value={historyGroupFilter} onChange={setHistoryGroupFilter}>
                    <option value="">All groups</option>
                    {groupOptions.map((group) => (
                      <option key={group.value} value={group.value}>{group.label}</option>
                    ))}
                  </ClearableSelect>
                  <ClearableSelect aria-label="Status filter" value={historyStatusFilter} onChange={(value) => setHistoryStatusFilter(value as typeof historyStatusFilter)}>
                    <option value="all">All</option>
                    <option value="active">Current</option>
                    <option value="expired">Expired</option>
                    <option value="upcoming">Future</option>
                    <option value="inactive">Inactive</option>
                  </ClearableSelect>
                </div>
              </section>

              {!filteredHistoryRows.length ? (
                <p className="context-message">No wage rate history found.</p>
              ) : (
                <div className="wage-rates-history-list">
                  {filteredHistoryRows.map(({ rate, status }) => {
                    const labourer = labourers.find((item) => item.id === rate.labourerId);
                    const statusLabel = status === "active"
                      ? "Current"
                      : status === "expired"
                        ? "Expired"
                        : status === "upcoming"
                          ? "Future"
                          : "Inactive";
                    return (
                      <article key={rate.id} className="wage-rates-history-card-item">
                        <div className="wage-rates-history-card-item__head">
                          <strong>{labourer?.name ?? rate.labourerId}</strong>
                          <span>{money(rate.dailyRate)}</span>
                        </div>
                        <small>{labourer?.group || "-"} · {t("wageRatesPage.effectiveRange", { from: rate.effectiveFrom, to: rate.effectiveTo || t("common.current") })}</small>
                        <div className="wage-rates-history-card-item__meta">
                          <span className={`status-badge status-badge--${status}`}>{statusLabel}</span>
                          <span>Half-day {money(normalizeHalfDayRate(rate))}</span>
                          {canManage ? <button className="secondary-action wage-rates-history-card-item__edit" type="button" onClick={() => { setHistoryOpen(false); startEditingRate(rate); }}>{t("common.edit")}</button> : null}
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
