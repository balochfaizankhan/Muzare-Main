import { Boxes, Gauge, Pencil, Plus, Trash2, Trophy, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../../auth/AuthProvider";
import { ResponsiveSelectField } from "../../components/ResponsivePicker";
import { SearchInput } from "../../components/SearchInput";
import { SubpageHeader } from "../../components/SubpageHeader";
import { formatDate, formatNumber } from "../../lib/format";
import { formatLocalDateKey } from "../../lib/dateOnly";
import {
  getActiveFarmId,
  getActiveSeasonId,
  makeLocalRecord,
  offlineDb,
  workspaceRecords,
  type HarvestEntry,
  type HarvestGroup,
} from "../../lib/offline-db";
import {
  buildGroupLeaderboard,
  buildHarvestSummary,
  cartonsPerPerson,
  sortLeaderboard,
  type HarvestGroupLeaderboardRow,
} from "../../lib/harvestPerformance";
import { hasModulePermission } from "../../lib/permissions";
import { translateStatus } from "../../lib/statusLabels";
import { deleteOperationalRecord, persistOperationalRecord } from "../../services/syncService";

const cartons = (value: number) => formatNumber(value, { maximumFractionDigits: 0 });
const ratio = (value: number) => formatNumber(value, { maximumFractionDigits: 1 });
const todayKey = () => formatLocalDateKey(new Date());
const toast = (message: string) => window.dispatchEvent(new CustomEvent("muzare-toast", { detail: message }));

function useHarvestPerms() {
  const { user } = useAuth();
  const workspaceId = user?.workspaceId ?? "";
  return useMemo(() => ({
    canView: !user || hasModulePermission(user, "harvest", "view", workspaceId),
    canCreate: Boolean(user && hasModulePermission(user, "harvest", "create", workspaceId)),
    canEdit: Boolean(user && hasModulePermission(user, "harvest", "edit", workspaceId)),
    canDelete: Boolean(user && hasModulePermission(user, "harvest", "delete", workspaceId)),
    canExport: Boolean(user && hasModulePermission(user, "harvest", "export", workspaceId)),
  }), [user, workspaceId]);
}

function useHarvestData() {
  const [groups, setGroups] = useState<HarvestGroup[]>([]);
  const [entries, setEntries] = useState<HarvestEntry[]>([]);
  const [ready, setReady] = useState(false);

  const refresh = useCallback(async () => {
    const [nextGroups, nextEntries] = await Promise.all([
      workspaceRecords(offlineDb.harvestGroups),
      workspaceRecords(offlineDb.harvestEntries),
    ]);
    setGroups([...nextGroups].sort((left, right) => left.name.localeCompare(right.name)));
    setEntries([...nextEntries].sort((left, right) => right.date.localeCompare(left.date) || right.createdAt.localeCompare(left.createdAt)));
    setReady(true);
  }, []);

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

  return { groups, entries, ready, refresh };
}

// ---------------------------------------------------------------------------
// Section shell + tabbed layout (mirrors WorkforceHub's shell so the module
// matches the rest of the SaaS chrome).
// ---------------------------------------------------------------------------
function HarvestShell({ title, description, tabs, children }: {
  title: string;
  description: string;
  tabs: Array<{ to: string; label: string }>;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const location = useLocation();
  const tabsRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const activeTab = tabsRef.current?.querySelector<HTMLElement>(".workforce-shell-tab.is-active");
    activeTab?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
  }, [location.pathname]);
  return (
    <div className="dashboard-page">
      <SubpageHeader title={title} />
      <main className="subpage module-workspace workforce-shell-main">
        <section className="workspace-intro workforce-shell-intro">
          <div>
            <h2>{title}</h2>
            <p>{description}</p>
          </div>
        </section>
        <section className="record-panel workforce-shell-panel">
          <nav ref={tabsRef} className="workforce-shell-tabs" aria-label={t("harvestPage.navigationAria")}>
            {tabs.map((tab) => (
              <NavLink key={tab.to} to={tab.to} end className={({ isActive }) => `workforce-shell-tab${isActive ? " is-active" : ""}`}>
                {tab.label}
              </NavLink>
            ))}
          </nav>
        </section>
        <div className="workforce-shell-content">{children}</div>
      </main>
    </div>
  );
}

export function HarvestSectionLayout() {
  const { t } = useTranslation();
  const tabs = useMemo(() => [
    { to: "/workspace/harvest/dashboard", label: t("harvestPage.tabs.dashboard") },
    { to: "/workspace/harvest/entry", label: t("harvestPage.tabs.entry") },
    { to: "/workspace/harvest/groups", label: t("harvestPage.tabs.groups") },
    { to: "/workspace/harvest/reports", label: t("harvestPage.tabs.reports") },
  ], [t]);
  return (
    <HarvestShell title={t("harvestPage.title")} description={t("harvestPage.description")} tabs={tabs}>
      <Outlet />
    </HarvestShell>
  );
}

// ---------------------------------------------------------------------------
// KPI grid
// ---------------------------------------------------------------------------
type KpiTone = "green" | "blue" | "amber" | "purple";
function KpiCard({ icon, tone, label, value, detail }: { icon: ReactNode; tone: KpiTone; label: string; value: string; detail?: string }) {
  return (
    <div className={`dashboard-kpi-card dashboard-kpi-card--${tone}`}>
      <div className="dashboard-kpi-card__header">
        <span className="dashboard-kpi-card__icon">{icon}</span>
      </div>
      <span>{label}</span>
      <strong className="bidi-isolate">{value}</strong>
      {detail ? <small>{detail}</small> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Groups CRUD
// ---------------------------------------------------------------------------
type GroupForm = { name: string; notes: string; active: boolean };

function GroupEditorPanel({ title, initialGroup, groups, onClose, onSave }: {
  title: string;
  initialGroup?: HarvestGroup | null;
  groups: HarvestGroup[];
  onClose: () => void;
  onSave: (record: HarvestGroup) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState<GroupForm>({
    name: initialGroup?.name ?? "",
    notes: initialGroup?.notes ?? "",
    active: initialGroup?.active !== false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const name = form.name.trim();
    if (!name) {
      setError(t("harvestPage.groupNameRequired"));
      return;
    }
    if (groups.some((group) => group.id !== initialGroup?.id && group.name.trim().toLowerCase() === name.toLowerCase())) {
      setError(t("harvestPage.duplicateGroupName"));
      return;
    }
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onSave({
        ...(initialGroup ?? makeLocalRecord()),
        name,
        notes: form.notes.trim() || undefined,
        active: form.active,
        updatedAt: new Date().toISOString(),
      } as HarvestGroup);
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("harvestPage.unableToSaveGroup"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="worker-dialog-backdrop worker-action-backdrop" role="presentation" onClick={onClose}>
      <section className="worker-action-dialog" role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}>
        <header>
          <h2>{title}</h2>
          <button type="button" aria-label={t("common.cancel")} onClick={onClose}>✕</button>
        </header>
        <form className="worker-action-form" onSubmit={(event) => void submit(event)}>
          <label><span>{t("harvestPage.groupNameLabel")}</span><input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
          <label><span>{t("harvestPage.notesLabel")}</span><textarea value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></label>
          <label><span>{t("harvestPage.statusLabel")}</span>
            <select value={form.active ? "active" : "inactive"} onChange={(event) => setForm({ ...form, active: event.target.value === "active" })}>
              <option value="active">{translateStatus(t, "active")}</option>
              <option value="inactive">{translateStatus(t, "inactive")}</option>
            </select>
          </label>
          {error ? <p className="worker-action-error">{error}</p> : null}
          <footer>
            <button type="button" onClick={onClose}>{t("common.cancel")}</button>
            <button type="submit" disabled={busy}>{busy ? t("harvestPage.saving") : t("harvestPage.saveGroup")}</button>
          </footer>
        </form>
      </section>
    </div>
  );
}

export function HarvestGroupsPage() {
  const { t } = useTranslation();
  const perms = useHarvestPerms();
  const { groups, entries, refresh } = useHarvestData();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive">("active");
  const [showCreate, setShowCreate] = useState(false);
  const [editingGroup, setEditingGroup] = useState<HarvestGroup | null>(null);

  const entryCountByGroup = useMemo(() => {
    const map = new Map<string, number>();
    for (const entry of entries) map.set(entry.harvestGroupId, (map.get(entry.harvestGroupId) ?? 0) + 1);
    return map;
  }, [entries]);

  const visibleGroups = useMemo(() => {
    const term = search.trim().toLowerCase();
    return groups.filter((group) => {
      const statusMatch = statusFilter === "all" || (statusFilter === "active" ? group.active !== false : group.active === false);
      const searchMatch = !term || group.name.toLowerCase().includes(term) || (group.notes ?? "").toLowerCase().includes(term);
      return statusMatch && searchMatch;
    });
  }, [groups, search, statusFilter]);

  const saveGroup = async (record: HarvestGroup) => {
    await persistOperationalRecord("harvestGroup", {
      ...record,
      farmId: record.farmId ?? getActiveFarmId() ?? undefined,
      seasonId: record.seasonId ?? getActiveSeasonId() ?? undefined,
      pendingSync: true,
    });
    await refresh();
    toast(t("harvestPage.groupSavedToast"));
  };

  const removeGroup = async (group: HarvestGroup) => {
    if ((entryCountByGroup.get(group.id) ?? 0) > 0) {
      toast(t("harvestPage.groupHasEntries"));
      return;
    }
    if (!window.confirm(t("harvestPage.deleteGroupConfirm", { name: group.name }))) return;
    await deleteOperationalRecord("harvestGroup", group);
    await refresh();
    toast(t("harvestPage.groupDeletedToast"));
  };

  return (
    <section className="record-panel workforce-groups-shell">
      <div className="workforce-group-page-header workforce-group-page-header--stacked">
        <div className="workforce-group-page-header__copy">
          <h2>{t("harvestPage.groupsHeading")}</h2>
          <p>{t("harvestPage.groupsIntro")}</p>
        </div>
        {perms.canCreate ? (
          <button type="button" className="secondary-button" onClick={() => setShowCreate(true)}>
            <Plus size={16} /> {t("harvestPage.createGroup")}
          </button>
        ) : null}
      </div>
      <SearchInput placeholder={t("harvestPage.searchGroupsPlaceholder")} value={search} onChange={setSearch} />
      <div className="workforce-group-filter-row">
        <button type="button" className={statusFilter === "all" ? "is-active" : ""} onClick={() => setStatusFilter("all")}>{t("common.all")}</button>
        <button type="button" className={statusFilter === "active" ? "is-active" : ""} onClick={() => setStatusFilter("active")}>{translateStatus(t, "active")}</button>
        <button type="button" className={statusFilter === "inactive" ? "is-active" : ""} onClick={() => setStatusFilter("inactive")}>{translateStatus(t, "inactive")}</button>
      </div>
      <div className="harvest-group-list">
        {visibleGroups.length ? visibleGroups.map((group) => (
          <article className="harvest-group-card" key={group.id}>
            <div className="harvest-group-card__header">
              <strong>{group.name}</strong>
              <span className={`sync-badge ${group.active !== false ? "sync-badge--online" : "sync-badge--error"}`}>{translateStatus(t, group.active !== false ? "active" : "inactive")}</span>
            </div>
            <p className="harvest-group-card__meta">{t("harvestPage.entriesRecorded", { count: entryCountByGroup.get(group.id) ?? 0 })}</p>
            {group.notes ? <p className="harvest-group-card__notes">{group.notes}</p> : null}
            {(perms.canEdit || perms.canDelete) ? (
              <div className="harvest-group-card__actions">
                {perms.canEdit ? <button type="button" className="secondary-button" onClick={() => setEditingGroup(group)}><Pencil size={14} /> {t("common.edit")}</button> : null}
                {perms.canDelete ? <button type="button" className="danger-link" onClick={() => void removeGroup(group)}><Trash2 size={14} /> {t("common.delete")}</button> : null}
              </div>
            ) : null}
          </article>
        )) : <p className="empty-records">{t("harvestPage.noGroupsFound")}</p>}
      </div>
      {showCreate ? <GroupEditorPanel title={t("harvestPage.createGroupDialogTitle")} groups={groups} onClose={() => setShowCreate(false)} onSave={saveGroup} /> : null}
      {editingGroup ? <GroupEditorPanel title={t("harvestPage.editGroupDialogTitle")} initialGroup={editingGroup} groups={groups} onClose={() => setEditingGroup(null)} onSave={saveGroup} /> : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Daily harvest entry
// ---------------------------------------------------------------------------
type EntryForm = { id?: string; date: string; harvestGroupId: string; membersCount: string; cartonsHarvested: string; notes: string };
const emptyEntryForm = (): EntryForm => ({ id: undefined, date: todayKey(), harvestGroupId: "", membersCount: "", cartonsHarvested: "", notes: "" });

export function HarvestEntryPage() {
  const { t } = useTranslation();
  const perms = useHarvestPerms();
  const { groups, entries, refresh } = useHarvestData();
  const [form, setForm] = useState<EntryForm>(emptyEntryForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const groupNameById = useMemo(() => new Map(groups.map((group) => [group.id, group.name])), [groups]);
  const selectableGroups = useMemo(() => {
    const active = groups.filter((group) => group.active !== false);
    // Keep the currently-selected group visible even if it was deactivated mid-edit.
    if (form.harvestGroupId && !active.some((group) => group.id === form.harvestGroupId)) {
      const current = groups.find((group) => group.id === form.harvestGroupId);
      if (current) return [current, ...active];
    }
    return active;
  }, [groups, form.harvestGroupId]);

  const membersCount = Number(form.membersCount) || 0;
  const cartonsHarvested = Number(form.cartonsHarvested) || 0;
  const perPerson = cartonsPerPerson(cartonsHarvested, membersCount);

  const recentEntries = useMemo(() => entries.slice(0, 12), [entries]);

  const resetForm = () => { setForm(emptyEntryForm()); setError(""); };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!form.harvestGroupId) { setError(t("harvestPage.selectGroupError")); return; }
    if (membersCount <= 0) { setError(t("harvestPage.membersCountError")); return; }
    if (cartonsHarvested < 0) { setError(t("harvestPage.cartonsError")); return; }
    setBusy(true);
    setError("");
    try {
      const existing = form.id ? entries.find((entry) => entry.id === form.id) : null;
      await persistOperationalRecord("harvestEntry", {
        ...(existing ?? makeLocalRecord()),
        date: form.date,
        harvestGroupId: form.harvestGroupId,
        harvestGroupName: groupNameById.get(form.harvestGroupId) ?? "",
        membersCount,
        cartonsHarvested,
        cartonsPerPerson: perPerson,
        notes: form.notes.trim() || undefined,
        updatedAt: new Date().toISOString(),
        pendingSync: true,
      } as HarvestEntry);
      await refresh();
      toast(existing ? t("harvestPage.entryUpdatedToast") : t("harvestPage.entrySavedToast"));
      resetForm();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("harvestPage.unableToSaveEntry"));
    } finally {
      setBusy(false);
    }
  };

  const editEntry = (entry: HarvestEntry) => {
    setForm({
      id: entry.id,
      date: entry.date,
      harvestGroupId: entry.harvestGroupId,
      membersCount: String(entry.membersCount ?? ""),
      cartonsHarvested: String(entry.cartonsHarvested ?? ""),
      notes: entry.notes ?? "",
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const removeEntry = async (entry: HarvestEntry) => {
    if (!window.confirm(t("harvestPage.deleteEntryConfirm"))) return;
    await deleteOperationalRecord("harvestEntry", entry);
    if (form.id === entry.id) resetForm();
    await refresh();
    toast(t("harvestPage.entryDeletedToast"));
  };

  if (!perms.canCreate && !perms.canEdit) {
    return <section className="record-panel"><p className="empty-records">{t("harvestPage.noEntryPermission")}</p></section>;
  }

  return (
    <div className="harvest-entry-layout">
      <section className="record-panel harvest-entry-panel">
        <div className="harvest-entry-panel__heading">
          <h2>{form.id ? t("harvestPage.editEntryHeading") : t("harvestPage.newEntryHeading")}</h2>
          {form.id ? <button type="button" className="secondary-button" onClick={resetForm}>{t("harvestPage.newEntry")}</button> : null}
        </div>
        <form className="module-form harvest-entry-form" onSubmit={(event) => void submit(event)}>
          <div className="harvest-entry-form__row">
            <label className="harvest-entry-form__field">
              <span>{t("harvestPage.dateLabel")}</span>
              <input type="date" required value={form.date} max={todayKey()} onChange={(event) => setForm({ ...form, date: event.target.value })} />
            </label>
            <label className="harvest-entry-form__field">
              <span>{t("harvestPage.groupLabel")}</span>
              <ResponsiveSelectField
                title={t("harvestPage.groupLabel")}
                ariaLabel={t("harvestPage.groupLabel")}
                placeholder={t("harvestPage.selectGroup")}
                value={form.harvestGroupId}
                onChange={(value) => setForm({ ...form, harvestGroupId: value })}
                options={selectableGroups.map((group) => ({ value: group.id, label: group.name }))}
                autoFocusSearch={false}
              />
            </label>
          </div>
          <div className="harvest-entry-form__row">
            <label className="harvest-entry-form__field">
              <span>{t("harvestPage.membersCountLabel")}</span>
              <input type="number" min={1} inputMode="numeric" required value={form.membersCount} onChange={(event) => setForm({ ...form, membersCount: event.target.value })} />
            </label>
            <label className="harvest-entry-form__field">
              <span>{t("harvestPage.cartonsHarvestedLabel")}</span>
              <input type="number" min={0} inputMode="numeric" required value={form.cartonsHarvested} onChange={(event) => setForm({ ...form, cartonsHarvested: event.target.value })} />
            </label>
          </div>
          <div className="harvest-entry-form__calc" aria-live="polite">
            <span>{t("harvestPage.cartonsPerPerson")}</span>
            <strong className="bidi-isolate">{ratio(perPerson)}</strong>
          </div>
          <label className="harvest-entry-form__field harvest-entry-form__field--full">
            <span>{t("harvestPage.notesLabel")} <em>{t("harvestPage.optional")}</em></span>
            <textarea value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} />
          </label>
          {error ? <p className="form-error">{error}</p> : null}
          <div className="harvest-entry-form__actions">
            <button type="submit" disabled={busy}>{busy ? t("harvestPage.saving") : form.id ? t("harvestPage.updateEntry") : t("harvestPage.saveEntry")}</button>
          </div>
        </form>
      </section>

      <section className="record-panel harvest-recent-panel">
        <h2>{t("harvestPage.recentEntriesHeading")}</h2>
        <div className="harvest-recent-list">
          {recentEntries.length ? recentEntries.map((entry) => (
            <article className="harvest-recent-row" key={entry.id}>
              <div className="harvest-recent-row__main">
                <strong>{groupNameById.get(entry.harvestGroupId) ?? entry.harvestGroupName ?? t("harvestPage.unknownGroup")}</strong>
                <span className="bidi-isolate">{formatDate(entry.date, { dateStyle: "medium" })}</span>
              </div>
              <div className="harvest-recent-row__stats">
                <span>{t("harvestPage.membersShort")}: <strong className="bidi-isolate">{cartons(entry.membersCount)}</strong></span>
                <span>{t("harvestPage.cartonsShort")}: <strong className="bidi-isolate">{cartons(entry.cartonsHarvested)}</strong></span>
                <span>{t("harvestPage.perPersonShort")}: <strong className="bidi-isolate">{ratio(entry.cartonsPerPerson)}</strong></span>
              </div>
              <div className="harvest-recent-row__actions">
                {perms.canEdit ? <button type="button" className="icon-button" aria-label={t("common.edit")} onClick={() => editEntry(entry)}><Pencil size={15} /></button> : null}
                {perms.canDelete ? <button type="button" className="icon-button danger-link" aria-label={t("common.delete")} onClick={() => void removeEntry(entry)}><Trash2 size={15} /></button> : null}
              </div>
            </article>
          )) : <p className="empty-records">{t("harvestPage.noEntriesYet")}</p>}
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
type LeaderboardSortKey = "cartonsPerPerson" | "totalCartons" | "crewSize" | "groupName";

function Leaderboard({ rows }: { rows: HarvestGroupLeaderboardRow[] }) {
  const { t } = useTranslation();
  const [sortKey, setSortKey] = useState<LeaderboardSortKey>("cartonsPerPerson");
  const [direction, setDirection] = useState<"asc" | "desc">("desc");
  const sorted = useMemo(() => sortLeaderboard(rows, sortKey, direction), [rows, sortKey, direction]);
  const toggle = (key: LeaderboardSortKey) => {
    if (key === sortKey) setDirection((current) => (current === "desc" ? "asc" : "desc"));
    else { setSortKey(key); setDirection(key === "groupName" ? "asc" : "desc"); }
  };
  const indicator = (key: LeaderboardSortKey) => (key === sortKey ? (direction === "desc" ? " ▼" : " ▲") : "");
  if (!rows.length) return <p className="empty-records">{t("harvestPage.noLeaderboardData")}</p>;
  return (
    <div className="harvest-leaderboard-wrap">
      <table className="harvest-leaderboard">
        <thead>
          <tr>
            <th scope="col" className="harvest-leaderboard__rank">#</th>
            <th scope="col"><button type="button" onClick={() => toggle("groupName")}>{t("harvestPage.colGroup")}{indicator("groupName")}</button></th>
            <th scope="col" className="harvest-leaderboard__num"><button type="button" onClick={() => toggle("crewSize")}>{t("harvestPage.colMembers")}{indicator("crewSize")}</button></th>
            <th scope="col" className="harvest-leaderboard__num"><button type="button" onClick={() => toggle("totalCartons")}>{t("harvestPage.colCartons")}{indicator("totalCartons")}</button></th>
            <th scope="col" className="harvest-leaderboard__num"><button type="button" onClick={() => toggle("cartonsPerPerson")}>{t("harvestPage.colPerPerson")}{indicator("cartonsPerPerson")}</button></th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, index) => (
            <tr key={row.groupId} className={!row.active ? "is-inactive" : undefined}>
              <td className="harvest-leaderboard__rank">{sortKey === "cartonsPerPerson" && direction === "desc" ? index + 1 : "-"}</td>
              <td>
                <div className="harvest-leaderboard__group">
                  <strong>{row.groupName || t("harvestPage.unknownGroup")}</strong>
                  {!row.active ? <span className="harvest-leaderboard__tag">{translateStatus(t, "inactive")}</span> : null}
                </div>
              </td>
              <td className="harvest-leaderboard__num bidi-isolate">{cartons(row.crewSize)}</td>
              <td className="harvest-leaderboard__num bidi-isolate">{cartons(row.totalCartons)}</td>
              <td className="harvest-leaderboard__num harvest-leaderboard__num--accent bidi-isolate">{ratio(row.cartonsPerPerson)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function HarvestDashboardPage() {
  const { t } = useTranslation();
  const { groups, entries, ready } = useHarvestData();
  const summary = useMemo(() => buildHarvestSummary(groups, entries, { todayKey: todayKey() }), [groups, entries]);
  const leaderboard = useMemo(() => buildGroupLeaderboard(groups, entries), [groups, entries]);

  return (
    <div className="harvest-dashboard">
      <div className="dashboard-kpi-grid harvest-kpi-grid">
        <KpiCard tone="green" icon={<Boxes size={18} />} label={t("harvestPage.kpiTotalCartons")} value={ready ? cartons(summary.totalCartons) : "—"} detail={t("harvestPage.kpiEntriesDetail", { count: summary.totalEntries })} />
        <KpiCard tone="blue" icon={<Users size={18} />} label={t("harvestPage.kpiActiveGroups")} value={ready ? cartons(summary.activeGroups) : "—"} detail={t("harvestPage.kpiGroupsDetail", { count: groups.length })} />
        <KpiCard tone="amber" icon={<Gauge size={18} />} label={t("harvestPage.kpiAvgPerPerson")} value={ready ? ratio(summary.averageCartonsPerPerson) : "—"} detail={t("harvestPage.kpiAvgDetail")} />
        <KpiCard tone="purple" icon={<Trophy size={18} />} label={t("harvestPage.kpiBestGroup")} value={ready ? (summary.bestGroup?.groupName ?? "—") : "—"} detail={summary.bestGroup ? t("harvestPage.kpiBestDetail", { value: ratio(summary.bestGroup.cartonsPerPerson) }) : undefined} />
      </div>
      <section className="record-panel harvest-leaderboard-panel">
        <div className="harvest-leaderboard-panel__heading">
          <h2>{t("harvestPage.leaderboardHeading")}</h2>
          <p>{t("harvestPage.leaderboardIntro")}</p>
        </div>
        <Leaderboard rows={leaderboard} />
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------
function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadCsv(filename: string, rows: unknown[][]) {
  const href = URL.createObjectURL(new Blob([rows.map((row) => row.map(csvCell).join(",")).join("\n")], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(href);
}

function printSection(sectionId: string) {
  document.querySelectorAll(".reports-print-section.is-print-target").forEach((node) => node.classList.remove("is-print-target"));
  const section = document.querySelector<HTMLElement>(`.reports-print-section[data-print-section="${sectionId}"]`);
  if (!section) return;
  const previousTitle = document.title;
  section.classList.add("is-print-target");
  document.documentElement.setAttribute("data-muzare-print-section", sectionId);
  document.title = `Muzare - ${section.dataset.printTitle ?? sectionId}`;
  const cleanup = () => {
    section.classList.remove("is-print-target");
    document.documentElement.removeAttribute("data-muzare-print-section");
    document.title = previousTitle;
  };
  window.addEventListener("afterprint", cleanup, { once: true });
  requestAnimationFrame(() => requestAnimationFrame(() => window.print()));
}

export function HarvestReportsPage() {
  const { t } = useTranslation();
  const perms = useHarvestPerms();
  const { groups, entries } = useHarvestData();
  const [groupId, setGroupId] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const groupNameById = useMemo(() => new Map(groups.map((group) => [group.id, group.name])), [groups]);

  const filtered = useMemo(() => entries.filter((entry) => {
    if (groupId && entry.harvestGroupId !== groupId) return false;
    if (fromDate && entry.date < fromDate) return false;
    if (toDate && entry.date > toDate) return false;
    return true;
  }), [entries, groupId, fromDate, toDate]);

  const summary = useMemo(() => buildHarvestSummary(groups, filtered), [groups, filtered]);
  const leaderboard = useMemo(() => buildGroupLeaderboard(groups, filtered).filter((row) => row.entriesCount > 0), [groups, filtered]);
  const highest = useMemo(() => leaderboard.reduce<HarvestGroupLeaderboardRow | null>((best, row) => (!best || row.cartonsPerPerson > best.cartonsPerPerson ? row : best), null), [leaderboard]);
  const lowest = useMemo(() => leaderboard.reduce<HarvestGroupLeaderboardRow | null>((worst, row) => (!worst || row.cartonsPerPerson < worst.cartonsPerPerson ? row : worst), null), [leaderboard]);

  const rangeLabel = fromDate || toDate
    ? `${fromDate ? formatDate(fromDate, { dateStyle: "medium" }) : "…"} – ${toDate ? formatDate(toDate, { dateStyle: "medium" }) : "…"}`
    : t("harvestPage.allDates");
  const printGeneratedAt = formatDate(new Date(), { dateStyle: "medium", timeStyle: "short" });
  const printGroupLabel = groupId ? (groupNameById.get(groupId) ?? t("harvestPage.unknownGroup")) : t("harvestPage.allGroups");

  const clearFilters = () => { setGroupId(""); setFromDate(""); setToDate(""); };

  const exportCsv = () => {
    const rows: unknown[][] = [];
    rows.push([t("harvestPage.reportTitle")]);
    rows.push([t("harvestPage.kpiTotalCartons"), summary.totalCartons]);
    rows.push([t("harvestPage.kpiAvgPerPerson"), Number(summary.averageCartonsPerPerson.toFixed(2))]);
    rows.push([t("harvestPage.highestProductivity"), highest ? `${highest.groupName} (${highest.cartonsPerPerson.toFixed(2)})` : ""]);
    rows.push([t("harvestPage.lowestProductivity"), lowest ? `${lowest.groupName} (${lowest.cartonsPerPerson.toFixed(2)})` : ""]);
    rows.push([]);
    rows.push([t("harvestPage.colDate"), t("harvestPage.colGroup"), t("harvestPage.colMembers"), t("harvestPage.colCartons"), t("harvestPage.colPerPerson"), t("harvestPage.notesLabel")]);
    for (const entry of filtered) {
      rows.push([
        entry.date,
        groupNameById.get(entry.harvestGroupId) ?? entry.harvestGroupName ?? "",
        entry.membersCount,
        entry.cartonsHarvested,
        Number((entry.cartonsPerPerson ?? 0).toFixed(2)),
        entry.notes ?? "",
      ]);
    }
    downloadCsv(`harvest-report-${todayKey()}.csv`, rows);
  };

  return (
    <div className="reports-page harvest-reports">
      <section className="record-panel reports-filter-panel no-print">
        <div className="reports-filter-heading">
          <h2>{t("harvestPage.reportFilters")}</h2>
          <button type="button" className="secondary-button" onClick={clearFilters}>{t("harvestPage.clearFilters")}</button>
        </div>
        <div className="harvest-reports__filters">
          <label className="harvest-entry-form__field">
            <span>{t("harvestPage.groupLabel")}</span>
            <ResponsiveSelectField
              title={t("harvestPage.groupLabel")}
              ariaLabel={t("harvestPage.groupLabel")}
              placeholder={t("harvestPage.allGroups")}
              allLabel={t("harvestPage.allGroups")}
              allowClear
              value={groupId}
              onChange={setGroupId}
              options={groups.map((group) => ({ value: group.id, label: group.name }))}
              autoFocusSearch={false}
            />
          </label>
          <label className="harvest-entry-form__field">
            <span>{t("harvestPage.fromDate")}</span>
            <input type="date" value={fromDate} max={toDate || undefined} onChange={(event) => setFromDate(event.target.value)} />
          </label>
          <label className="harvest-entry-form__field">
            <span>{t("harvestPage.toDate")}</span>
            <input type="date" value={toDate} min={fromDate || undefined} onChange={(event) => setToDate(event.target.value)} />
          </label>
        </div>
      </section>

      <section className="record-panel reports-print-section reports-print-section--document harvest-report-section" data-print-section="harvest-report" data-print-title={t("harvestPage.reportTitle")} data-print-layout="portrait">
        <header className="reports-view-header">
          <div>
            <h2>{t("harvestPage.reportTitle")}</h2>
            <p>{rangeLabel}{groupId ? ` · ${groupNameById.get(groupId) ?? ""}` : ""}</p>
          </div>
          <div className="reports-actions no-print">
            {perms.canExport ? <button type="button" onClick={exportCsv}>{t("harvestPage.exportCsv")}</button> : null}
            <button type="button" onClick={() => printSection("harvest-report")}>{t("harvestPage.print")}</button>
          </div>
        </header>
        <header className="report-document-header report-document-only">
          <div className="report-document-brand"><strong>Muzare</strong><span>{t("harvestPage.reportTitle")}</span></div>
          <div className="report-document-title"><h1>{t("harvestPage.reportTitle")}</h1><p className="bidi-isolate">{rangeLabel}</p></div>
          <dl className="report-document-meta">
            <div><dt>{t("harvestPage.groupLabel")}</dt><dd>{printGroupLabel}</dd></div>
            <div><dt>{t("reportsPage.transactions")}</dt><dd className="bidi-isolate">{filtered.length}</dd></div>
            <div><dt>{t("reportsPage.generated")}</dt><dd className="bidi-isolate">{printGeneratedAt}</dd></div>
          </dl>
        </header>
        <div className="reports-kpis harvest-report-kpis">
          <article><span>{t("harvestPage.kpiTotalCartons")}</span><strong className="bidi-isolate">{cartons(summary.totalCartons)}</strong></article>
          <article><span>{t("harvestPage.kpiAvgPerPerson")}</span><strong className="bidi-isolate">{ratio(summary.averageCartonsPerPerson)}</strong></article>
          <article><span>{t("harvestPage.highestProductivity")}</span><strong className="bidi-isolate">{highest ? `${ratio(highest.cartonsPerPerson)} · ${highest.groupName}` : "—"}</strong></article>
          <article><span>{t("harvestPage.lowestProductivity")}</span><strong className="bidi-isolate">{lowest ? `${ratio(lowest.cartonsPerPerson)} · ${lowest.groupName}` : "—"}</strong></article>
        </div>
        <h3 className="harvest-report-subheading">{t("harvestPage.dailyHistory")}</h3>
        {filtered.length ? (
          <div className="harvest-leaderboard-wrap">
            <table className="harvest-leaderboard report-wide-table">
              <thead>
                <tr>
                  <th scope="col">{t("harvestPage.colDate")}</th>
                  <th scope="col">{t("harvestPage.colGroup")}</th>
                  <th scope="col" className="harvest-leaderboard__num">{t("harvestPage.colMembers")}</th>
                  <th scope="col" className="harvest-leaderboard__num">{t("harvestPage.colCartons")}</th>
                  <th scope="col" className="harvest-leaderboard__num">{t("harvestPage.colPerPerson")}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((entry) => (
                  <tr key={entry.id}>
                    <td className="bidi-isolate">{formatDate(entry.date, { dateStyle: "medium" })}</td>
                    <td>{groupNameById.get(entry.harvestGroupId) ?? entry.harvestGroupName ?? t("harvestPage.unknownGroup")}</td>
                    <td className="harvest-leaderboard__num bidi-isolate">{cartons(entry.membersCount)}</td>
                    <td className="harvest-leaderboard__num bidi-isolate">{cartons(entry.cartonsHarvested)}</td>
                    <td className="harvest-leaderboard__num harvest-leaderboard__num--accent bidi-isolate">{ratio(entry.cartonsPerPerson)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="empty-records">{t("harvestPage.noEntriesForFilters")}</p>}
        <footer className="report-document-footer report-document-only"><span>Muzare</span><span>{t("harvestPage.reportTitle")}</span><span className="bidi-isolate">{printGeneratedAt}</span></footer>
      </section>
    </div>
  );
}
