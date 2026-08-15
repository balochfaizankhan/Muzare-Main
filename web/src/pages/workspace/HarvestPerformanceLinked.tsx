import { Pencil, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../auth/AuthProvider";
import { ResponsiveSelectField } from "../../components/ResponsivePicker";
import { SearchInput } from "../../components/SearchInput";
import i18n from "../../i18n";
import { formatLocalDateKey } from "../../lib/dateOnly";
import { formatDate, formatNumber } from "../../lib/format";
import { cartonsPerPerson } from "../../lib/harvestPerformance";
import {
  getActiveFarmId,
  getActiveSeasonId,
  makeLocalRecord,
  offlineDb,
  workspaceRecords,
  type HarvestEntry,
  type HarvestGroup,
  type LabourGroup,
} from "../../lib/offline-db";
import { hasModulePermission } from "../../lib/permissions";
import { translateStatus } from "../../lib/statusLabels";
import { deleteOperationalRecord, persistOperationalRecord } from "../../services/syncService";
import {
  HarvestDashboardPage as BaseHarvestDashboardPage,
  HarvestReportsPage as BaseHarvestReportsPage,
  HarvestSectionLayout as BaseHarvestSectionLayout,
} from "./HarvestPerformance";
import "../../harvest-linked-groups.css";

const linkedResources = {
  en: {
    linkedGroupsIntro: "Choose which workforce groups participate in harvest, or create harvest-only crews for productivity tracking.",
    workforceGroupBadge: "Workforce group",
    harvestOnlyGroupBadge: "Harvest-only group",
    activeMembers: "{{count}} active members",
    groupMembers: "{{count}} group members",
    harvestWorkers: "{{count}} harvest workers",
    foremanExcluded: "Foreman excluded",
    managedInWorkforce: "Managed in Workforce",
    linkedMembersHint: "Harvest workers are counted automatically from Workforce. The foreman is excluded when present in the group.",
    linkedGroupNoMembers: "This workforce group has no harvest workers. Check its active members and foreman in Workforce.",
    noGroupsMatch: "No groups match this view.",
    participationLabel: "Harvest participation",
    participatesInHarvest: "Participates",
    doesNotParticipate: "Not participating",
    participationHint: "Only participating groups appear in Daily Entry.",
    participationSaved: "Harvest participation updated.",
  },
  ar: {
    linkedGroupsIntro: "اختر مجموعات العمالة المشاركة في الحصاد، أو أنشئ فرق حصاد مستقلة لتتبع الإنتاجية.",
    workforceGroupBadge: "مجموعة عمالة",
    harvestOnlyGroupBadge: "مجموعة حصاد مستقلة",
    activeMembers: "{{count}} أعضاء نشطون",
    groupMembers: "{{count}} أعضاء المجموعة",
    harvestWorkers: "{{count}} عمال حصاد",
    foremanExcluded: "المشرف مستبعد",
    managedInWorkforce: "تُدار من قسم العمالة",
    linkedMembersHint: "يتم احتساب عمال الحصاد تلقائياً من قسم العمالة، مع استبعاد المشرف إذا كان ضمن المجموعة.",
    linkedGroupNoMembers: "لا يوجد عمال حصاد في هذه المجموعة. تحقق من الأعضاء النشطين والمشرف في قسم العمالة.",
    noGroupsMatch: "لا توجد مجموعات تطابق هذا العرض.",
    participationLabel: "المشاركة في الحصاد",
    participatesInHarvest: "مشاركة",
    doesNotParticipate: "غير مشاركة",
    participationHint: "تظهر المجموعات المشاركة فقط في الإدخال اليومي.",
    participationSaved: "تم تحديث مشاركة الحصاد.",
  },
  ur: {
    linkedGroupsIntro: "منتخب کریں کہ کون سے لیبر گروپ کٹائی میں حصہ لیں گے، یا پیداواری صلاحیت کے لیے الگ کٹائی گروپ بنائیں۔",
    workforceGroupBadge: "لیبر گروپ",
    harvestOnlyGroupBadge: "صرف کٹائی گروپ",
    activeMembers: "{{count}} فعال اراکین",
    groupMembers: "{{count}} گروپ اراکین",
    harvestWorkers: "{{count}} کٹائی کارکن",
    foremanExcluded: "فورمین شامل نہیں",
    managedInWorkforce: "ورک فورس میں منظم",
    linkedMembersHint: "کٹائی کارکنوں کی تعداد ورک فورس سے خودکار طور پر لی جاتی ہے۔ گروپ میں موجود فورمین کو شمار نہیں کیا جاتا۔",
    linkedGroupNoMembers: "اس گروپ میں کٹائی کے لیے کوئی کارکن نہیں۔ ورک فورس میں فعال اراکین اور فورمین چیک کریں۔",
    noGroupsMatch: "اس منظر سے مطابقت رکھنے والا کوئی گروپ نہیں۔",
    participationLabel: "کٹائی میں شرکت",
    participatesInHarvest: "شامل ہے",
    doesNotParticipate: "شامل نہیں",
    participationHint: "صرف منتخب گروپ روزانہ کٹائی کے اندراج میں نظر آئیں گے۔",
    participationSaved: "کٹائی میں شرکت اپ ڈیٹ ہو گئی۔",
  },
} as const;

for (const [language, harvestPage] of Object.entries(linkedResources)) {
  i18n.addResourceBundle(language, "translation", { harvestPage }, true, true);
}

type HarvestSourceLabourGroup = LabourGroup & { harvestParticipating?: boolean };
type LinkedHarvestGroup = HarvestGroup & {
  sourceLabourGroupId?: string;
  linkedMemberCount?: number;
  linkedTotalMemberCount?: number;
  foremanExcluded?: boolean;
  harvestParticipating?: boolean;
  sourceActive?: boolean;
  sourceKind?: "workforce";
};

type GroupForm = { name: string; notes: string; active: boolean };
type EntryForm = { id?: string; date: string; harvestGroupId: string; membersCount: string; cartonsHarvested: string; notes: string };

const linkedId = (labourGroupId: string) => `workforce:${labourGroupId}`;
const todayKey = () => formatLocalDateKey(new Date());
const cartons = (value: number) => formatNumber(value, { maximumFractionDigits: 0 });
const ratio = (value: number) => formatNumber(value, { maximumFractionDigits: 1 });
const toast = (message: string) => window.dispatchEvent(new CustomEvent("muzare-toast", { detail: message }));
const isLinkedGroup = (group: HarvestGroup | LinkedHarvestGroup) => Boolean((group as LinkedHarvestGroup).sourceLabourGroupId);
const isParticipating = (group: HarvestGroup | LinkedHarvestGroup) => !isLinkedGroup(group) || (group as LinkedHarvestGroup).harvestParticipating !== false;
const sourceIsActive = (group: HarvestGroup | LinkedHarvestGroup) => isLinkedGroup(group) ? (group as LinkedHarvestGroup).sourceActive !== false : group.active !== false;
const emptyEntryForm = (): EntryForm => ({ date: todayKey(), harvestGroupId: "", membersCount: "", cartonsHarvested: "", notes: "" });

function useHarvestPerms() {
  const { user } = useAuth();
  const workspaceId = user?.workspaceId ?? "";
  return useMemo(() => ({
    canCreate: Boolean(user && hasModulePermission(user, "harvest", "create", workspaceId)),
    canEdit: Boolean(user && hasModulePermission(user, "harvest", "edit", workspaceId)),
    canDelete: Boolean(user && hasModulePermission(user, "harvest", "delete", workspaceId)),
    canConfigureParticipation: Boolean(user && hasModulePermission(user, "workforce", "edit", workspaceId)),
  }), [user, workspaceId]);
}

async function syncWorkforceGroupsIntoHarvest() {
  const [rawLabourGroups, labourers, currentHarvestGroups] = await Promise.all([
    workspaceRecords(offlineDb.labourGroups),
    workspaceRecords(offlineDb.labourers),
    workspaceRecords(offlineDb.harvestGroups, { includeDeleted: true }),
  ]);
  const labourGroups = rawLabourGroups as HarvestSourceLabourGroup[];

  const groupIdByName = new Map(labourGroups.map((group) => [group.name.trim().toLowerCase(), group.id]));
  const memberIdsByGroup = new Map<string, Set<string>>();
  for (const labourer of labourers) {
    if (labourer.active === false || labourer.isArchived || Boolean(labourer.endedOn)) continue;
    const groupId = labourer.groupId || groupIdByName.get((labourer.group ?? "").trim().toLowerCase());
    if (!groupId) continue;
    const memberIds = memberIdsByGroup.get(groupId) ?? new Set<string>();
    memberIds.add(labourer.id);
    memberIdsByGroup.set(groupId, memberIds);
  }

  const existingById = new Map(currentHarvestGroups.map((group) => [group.id, group as LinkedHarvestGroup]));
  const expectedIds = new Set<string>();
  const puts: LinkedHarvestGroup[] = [];

  for (const labourGroup of labourGroups) {
    const id = linkedId(labourGroup.id);
    expectedIds.add(id);
    const current = existingById.get(id);
    const sourceActive = labourGroup.active !== false;
    const participating = labourGroup.harvestParticipating !== false;
    const memberIds = memberIdsByGroup.get(labourGroup.id) ?? new Set<string>();
    const totalMemberCount = memberIds.size;
    const foremanId = labourGroup.foremanLabourId ?? labourGroup.foremanId ?? undefined;
    const foremanExcluded = Boolean(foremanId && memberIds.has(foremanId));
    const harvestMemberCount = Math.max(totalMemberCount - (foremanExcluded ? 1 : 0), 0);
    const next: LinkedHarvestGroup = {
      id,
      workspaceId: labourGroup.workspaceId,
      farmId: labourGroup.farmId,
      seasonId: labourGroup.seasonId,
      createdAt: current?.createdAt ?? labourGroup.createdAt,
      updatedAt: labourGroup.updatedAt,
      pendingSync: false,
      name: labourGroup.name,
      active: sourceActive && participating,
      notes: labourGroup.notes,
      sourceLabourGroupId: labourGroup.id,
      linkedMemberCount: harvestMemberCount,
      linkedTotalMemberCount: totalMemberCount,
      foremanExcluded,
      harvestParticipating: participating,
      sourceActive,
      sourceKind: "workforce",
    };
    if (!current
      || current.name !== next.name
      || current.active !== next.active
      || current.notes !== next.notes
      || current.linkedMemberCount !== next.linkedMemberCount
      || current.linkedTotalMemberCount !== next.linkedTotalMemberCount
      || current.foremanExcluded !== next.foremanExcluded
      || current.harvestParticipating !== next.harvestParticipating
      || current.sourceActive !== next.sourceActive
      || current.deletedAt) {
      puts.push(next);
    }
  }

  for (const current of currentHarvestGroups.map((group) => group as LinkedHarvestGroup)) {
    if (!current.sourceLabourGroupId || expectedIds.has(current.id) || current.active === false) continue;
    puts.push({ ...current, active: false, sourceActive: false, pendingSync: false, updatedAt: new Date().toISOString() });
  }

  if (puts.length) {
    await offlineDb.harvestGroups.bulkPut(puts);
    window.dispatchEvent(new Event("muzare-local-data-change"));
  }
}

function useLinkedHarvestBridge() {
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(async () => {
    try {
      await syncWorkforceGroupsIntoHarvest();
    } catch {
      // Farm/season may still be bootstrapping; the next workspace refresh retries.
    } finally {
      setRevision((value) => value + 1);
    }
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

  return { revision, refresh };
}

function GroupEditor({ initial, allGroups, onClose, onSaved }: {
  initial?: HarvestGroup | null;
  allGroups: HarvestGroup[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState<GroupForm>({ name: initial?.name ?? "", notes: initial?.notes ?? "", active: initial?.active !== false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const name = form.name.trim();
    if (!name) return setError(t("harvestPage.groupNameRequired"));
    if (allGroups.some((group) => group.id !== initial?.id && group.name.trim().toLowerCase() === name.toLowerCase())) {
      return setError(t("harvestPage.duplicateGroupName"));
    }
    setBusy(true);
    setError("");
    try {
      await persistOperationalRecord("harvestGroup", {
        ...(initial ?? makeLocalRecord()),
        name,
        notes: form.notes.trim() || undefined,
        active: form.active,
        farmId: initial?.farmId ?? getActiveFarmId() ?? undefined,
        seasonId: initial?.seasonId ?? getActiveSeasonId() ?? undefined,
        updatedAt: new Date().toISOString(),
        pendingSync: true,
      } as HarvestGroup);
      await onSaved();
      toast(t("harvestPage.groupSavedToast"));
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("harvestPage.unableToSaveGroup"));
    } finally {
      setBusy(false);
    }
  };

  return <div className="worker-dialog-backdrop worker-action-backdrop" role="presentation" onClick={onClose}>
    <section className="worker-action-dialog" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
      <header><h2>{initial ? t("harvestPage.editGroupDialogTitle") : t("harvestPage.createGroupDialogTitle")}</h2><button type="button" onClick={onClose}>✕</button></header>
      <form className="worker-action-form" onSubmit={(event) => void submit(event)}>
        <label><span>{t("harvestPage.groupNameLabel")}</span><input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
        <label><span>{t("harvestPage.notesLabel")}</span><textarea value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></label>
        <label><span>{t("harvestPage.statusLabel")}</span><select value={form.active ? "active" : "inactive"} onChange={(event) => setForm({ ...form, active: event.target.value === "active" })}><option value="active">{translateStatus(t, "active")}</option><option value="inactive">{translateStatus(t, "inactive")}</option></select></label>
        {error ? <p className="worker-action-error">{error}</p> : null}
        <footer><button type="button" onClick={onClose}>{t("common.cancel")}</button><button type="submit" disabled={busy}>{busy ? t("harvestPage.saving") : t("harvestPage.saveGroup")}</button></footer>
      </form>
    </section>
  </div>;
}

export function HarvestSectionLayout() {
  useLinkedHarvestBridge();
  return <div className="harvest-linked-module"><BaseHarvestSectionLayout /></div>;
}

export function HarvestDashboardPage() {
  useLinkedHarvestBridge();
  return <BaseHarvestDashboardPage />;
}

export function HarvestReportsPage() {
  useLinkedHarvestBridge();
  return <BaseHarvestReportsPage />;
}

export function HarvestGroupsPage() {
  const { t } = useTranslation();
  const perms = useHarvestPerms();
  const bridge = useLinkedHarvestBridge();
  const [groups, setGroups] = useState<LinkedHarvestGroup[]>([]);
  const [entries, setEntries] = useState<HarvestEntry[]>([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive">("active");
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<HarvestGroup | null>(null);
  const [participationBusyId, setParticipationBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    await syncWorkforceGroupsIntoHarvest();
    const [nextGroups, nextEntries] = await Promise.all([workspaceRecords(offlineDb.harvestGroups), workspaceRecords(offlineDb.harvestEntries)]);
    setGroups(nextGroups.map((group) => group as LinkedHarvestGroup).sort((a, b) => a.name.localeCompare(b.name)));
    setEntries(nextEntries);
  }, []);

  useEffect(() => { void refresh(); }, [bridge.revision, refresh]);

  const countByGroup = useMemo(() => {
    const map = new Map<string, number>();
    for (const entry of entries) map.set(entry.harvestGroupId, (map.get(entry.harvestGroupId) ?? 0) + 1);
    return map;
  }, [entries]);

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return groups.filter((group) => {
      const active = sourceIsActive(group);
      const statusMatch = statusFilter === "all" || (statusFilter === "active" ? active : !active);
      const searchMatch = !term || group.name.toLowerCase().includes(term) || (group.notes ?? "").toLowerCase().includes(term);
      return statusMatch && searchMatch;
    });
  }, [groups, search, statusFilter]);

  const updateParticipation = async (group: LinkedHarvestGroup, participating: boolean) => {
    if (!group.sourceLabourGroupId || participationBusyId) return;
    setParticipationBusyId(group.id);
    try {
      const labourGroups = await workspaceRecords(offlineDb.labourGroups);
      const source = labourGroups.find((item) => item.id === group.sourceLabourGroupId) as HarvestSourceLabourGroup | undefined;
      if (!source) return;
      await persistOperationalRecord("labourGroup", {
        ...source,
        harvestParticipating: participating,
        updatedAt: new Date().toISOString(),
        pendingSync: true,
      } as HarvestSourceLabourGroup);
      await refresh();
      toast(t("harvestPage.participationSaved"));
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : t("common.unableToSave"));
    } finally {
      setParticipationBusyId(null);
    }
  };

  const remove = async (group: HarvestGroup) => {
    if (countByGroup.get(group.id)) return toast(t("harvestPage.groupHasEntries"));
    if (!window.confirm(t("harvestPage.deleteGroupConfirm", { name: group.name }))) return;
    await deleteOperationalRecord("harvestGroup", group);
    await refresh();
    toast(t("harvestPage.groupDeletedToast"));
  };

  return <section className="record-panel workforce-groups-shell harvest-linked-groups-page">
    <div className="workforce-group-page-header workforce-group-page-header--stacked">
      <div className="workforce-group-page-header__copy"><h2>{t("harvestPage.groupsHeading")}</h2><p>{t("harvestPage.linkedGroupsIntro")}</p></div>
      {perms.canCreate ? <button type="button" className="secondary-button" onClick={() => setShowCreate(true)}><Plus size={16} /> {t("harvestPage.createGroup")}</button> : null}
    </div>
    <SearchInput placeholder={t("harvestPage.searchGroupsPlaceholder")} value={search} onChange={setSearch} />
    <div className="workforce-group-filter-row">
      <button type="button" className={statusFilter === "all" ? "is-active" : ""} onClick={() => setStatusFilter("all")}>{t("common.all")}</button>
      <button type="button" className={statusFilter === "active" ? "is-active" : ""} onClick={() => setStatusFilter("active")}>{translateStatus(t, "active")}</button>
      <button type="button" className={statusFilter === "inactive" ? "is-active" : ""} onClick={() => setStatusFilter("inactive")}>{translateStatus(t, "inactive")}</button>
    </div>
    <div className="harvest-group-list">
      {visible.length ? visible.map((group) => {
        const linked = isLinkedGroup(group);
        const participating = isParticipating(group);
        const sourceActive = sourceIsActive(group);
        return <article className={`harvest-group-card${linked ? " harvest-group-card--labour" : ""}${linked && !participating ? " is-not-participating" : ""}`} key={group.id}>
          <div className="harvest-group-card__header">
            <div className="harvest-group-card__identity"><strong>{group.name}</strong><span className="harvest-group-source-badge">{linked ? t("harvestPage.workforceGroupBadge") : t("harvestPage.harvestOnlyGroupBadge")}</span></div>
            <span className={`sync-badge ${sourceActive ? "sync-badge--online" : "sync-badge--error"}`}>{translateStatus(t, sourceActive ? "active" : "inactive")}</span>
          </div>
          <p className="harvest-group-card__meta">{t("harvestPage.entriesRecorded", { count: countByGroup.get(group.id) ?? 0 })}</p>
          {linked ? <>
            <p className="harvest-group-card__linked-note">
              {t("harvestPage.groupMembers", { count: group.linkedTotalMemberCount ?? 0 })} · {t("harvestPage.harvestWorkers", { count: group.linkedMemberCount ?? 0 })}
              {group.foremanExcluded ? ` · ${t("harvestPage.foremanExcluded")}` : ""} · {t("harvestPage.managedInWorkforce")}
            </p>
            <div className="harvest-participation-row">
              <div><strong>{t("harvestPage.participationLabel")}</strong><small>{t("harvestPage.participationHint")}</small></div>
              <button
                type="button"
                role="switch"
                aria-checked={participating}
                className={`harvest-participation-toggle${participating ? " is-on" : ""}`}
                disabled={!perms.canConfigureParticipation || participationBusyId === group.id || !sourceActive}
                onClick={() => void updateParticipation(group, !participating)}
              >
                <span className="harvest-participation-toggle__track" aria-hidden="true"><span /></span>
                <span>{participating ? t("harvestPage.participatesInHarvest") : t("harvestPage.doesNotParticipate")}</span>
              </button>
            </div>
          </> : group.notes ? <p className="harvest-group-card__notes">{group.notes}</p> : null}
          {!linked && (perms.canEdit || perms.canDelete) ? <div className="harvest-group-card__actions">
            {perms.canEdit ? <button type="button" className="secondary-button" onClick={() => setEditing(group)}><Pencil size={14} /> {t("common.edit")}</button> : null}
            {perms.canDelete ? <button type="button" className="danger-link" onClick={() => void remove(group)}><Trash2 size={14} /> {t("common.delete")}</button> : null}
          </div> : null}
        </article>;
      }) : <p className="empty-records">{t("harvestPage.noGroupsMatch")}</p>}
    </div>
    {showCreate ? <GroupEditor allGroups={groups} onClose={() => setShowCreate(false)} onSaved={refresh} /> : null}
    {editing ? <GroupEditor initial={editing} allGroups={groups} onClose={() => setEditing(null)} onSaved={refresh} /> : null}
  </section>;
}

export function HarvestEntryPage() {
  const { t } = useTranslation();
  const perms = useHarvestPerms();
  const bridge = useLinkedHarvestBridge();
  const [groups, setGroups] = useState<LinkedHarvestGroup[]>([]);
  const [entries, setEntries] = useState<HarvestEntry[]>([]);
  const [form, setForm] = useState<EntryForm>(emptyEntryForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    await syncWorkforceGroupsIntoHarvest();
    const [nextGroups, nextEntries] = await Promise.all([workspaceRecords(offlineDb.harvestGroups), workspaceRecords(offlineDb.harvestEntries)]);
    setGroups(nextGroups.map((group) => group as LinkedHarvestGroup).sort((a, b) => a.name.localeCompare(b.name)));
    setEntries(nextEntries.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)));
  }, []);
  useEffect(() => { void refresh(); }, [bridge.revision, refresh]);

  const selectedGroup = groups.find((group) => group.id === form.harvestGroupId) ?? null;
  const linked = selectedGroup ? isLinkedGroup(selectedGroup) : false;
  const selectable = groups.filter((group) => ((group.active !== false && isParticipating(group)) || group.id === form.harvestGroupId));
  const groupNameById = new Map(groups.map((group) => [group.id, group.name]));
  const membersCount = Number(form.membersCount) || 0;
  const cartonsHarvested = Number(form.cartonsHarvested) || 0;
  const perPerson = cartonsPerPerson(cartonsHarvested, membersCount);
  const canSubmit = !busy && Boolean(form.harvestGroupId) && membersCount > 0 && form.cartonsHarvested !== "" && cartonsHarvested >= 0;
  const reset = () => { setForm(emptyEntryForm()); setError(""); };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!form.harvestGroupId) return setError(t("harvestPage.selectGroupError"));
    if (membersCount <= 0) return setError(linked ? t("harvestPage.linkedGroupNoMembers") : t("harvestPage.membersCountError"));
    if (cartonsHarvested < 0) return setError(t("harvestPage.cartonsError"));
    setBusy(true);
    setError("");
    try {
      const existing = form.id ? entries.find((entry) => entry.id === form.id) : null;
      await persistOperationalRecord("harvestEntry", {
        ...(existing ?? makeLocalRecord()),
        date: form.date,
        harvestGroupId: form.harvestGroupId,
        harvestGroupName: selectedGroup?.name ?? "",
        membersCount,
        cartonsHarvested,
        cartonsPerPerson: perPerson,
        notes: form.notes.trim() || undefined,
        updatedAt: new Date().toISOString(),
        pendingSync: true,
      } as HarvestEntry);
      await refresh();
      toast(existing ? t("harvestPage.entryUpdatedToast") : t("harvestPage.entrySavedToast"));
      reset();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("harvestPage.unableToSaveEntry"));
    } finally {
      setBusy(false);
    }
  };

  const edit = (entry: HarvestEntry) => {
    setForm({ id: entry.id, date: entry.date, harvestGroupId: entry.harvestGroupId, membersCount: String(entry.membersCount), cartonsHarvested: String(entry.cartonsHarvested), notes: entry.notes ?? "" });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const remove = async (entry: HarvestEntry) => {
    if (!window.confirm(t("harvestPage.deleteEntryConfirm"))) return;
    await deleteOperationalRecord("harvestEntry", entry);
    if (form.id === entry.id) reset();
    await refresh();
    toast(t("harvestPage.entryDeletedToast"));
  };

  if (!perms.canCreate && !perms.canEdit) return <section className="record-panel"><p className="empty-records">{t("harvestPage.noEntryPermission")}</p></section>;

  return <div className="harvest-entry-layout">
    <section className="record-panel harvest-entry-panel">
      <div className="harvest-entry-panel__heading"><h2>{form.id ? t("harvestPage.editEntryHeading") : t("harvestPage.newEntryHeading")}</h2>{form.id ? <button type="button" className="secondary-button" onClick={reset}>{t("harvestPage.newEntry")}</button> : null}</div>
      <form className="module-form harvest-entry-form" onSubmit={(event) => void submit(event)}>
        <div className="harvest-entry-form__row">
          <label className="harvest-entry-form__field"><span>{t("harvestPage.dateLabel")}</span><input type="date" required value={form.date} max={todayKey()} onChange={(event) => setForm({ ...form, date: event.target.value })} /></label>
          <label className="harvest-entry-form__field"><span>{t("harvestPage.groupLabel")}</span><ResponsiveSelectField title={t("harvestPage.groupLabel")} ariaLabel={t("harvestPage.groupLabel")} placeholder={t("harvestPage.selectGroup")} value={form.harvestGroupId} onChange={(value) => {
            const next = groups.find((group) => group.id === value);
            setForm({ ...form, harvestGroupId: value, membersCount: next && isLinkedGroup(next) ? String(next.linkedMemberCount ?? 0) : "" });
          }} options={selectable.map((group) => ({ value: group.id, label: group.name, secondary: isLinkedGroup(group) ? t("harvestPage.workforceGroupBadge") : t("harvestPage.harvestOnlyGroupBadge") }))} allowClear={false} autoFocusSearch={false} /></label>
        </div>
        <div className="harvest-entry-form__row">
          <label className="harvest-entry-form__field"><span>{t("harvestPage.membersCountLabel")}</span><input type="number" min={1} inputMode="numeric" required readOnly={linked} value={form.membersCount} onChange={(event) => setForm({ ...form, membersCount: event.target.value })} />{linked ? <small className="harvest-entry-form__hint">{(selectedGroup?.linkedMemberCount ?? 0) > 0 ? t("harvestPage.linkedMembersHint") : t("harvestPage.linkedGroupNoMembers")}</small> : null}</label>
          <label className="harvest-entry-form__field"><span>{t("harvestPage.cartonsHarvestedLabel")}</span><input type="number" min={0} inputMode="numeric" required value={form.cartonsHarvested} onChange={(event) => setForm({ ...form, cartonsHarvested: event.target.value })} /></label>
        </div>
        <div className="harvest-entry-form__calc" aria-live="polite"><span>{t("harvestPage.cartonsPerPerson")}</span><strong className="bidi-isolate">{ratio(perPerson)}</strong></div>
        <label className="harvest-entry-form__field harvest-entry-form__field--full"><span>{t("harvestPage.notesLabel")} <em>{t("harvestPage.optional")}</em></span><textarea value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></label>
        {error ? <p className="form-error">{error}</p> : null}
        <div className="harvest-entry-form__actions"><button type="submit" disabled={!canSubmit}>{busy ? t("harvestPage.saving") : form.id ? t("harvestPage.updateEntry") : t("harvestPage.saveEntry")}</button></div>
      </form>
    </section>
    <section className="record-panel harvest-recent-panel">
      <h2>{t("harvestPage.recentEntriesHeading")}</h2>
      <div className="harvest-recent-list">
        {entries.slice(0, 12).length ? entries.slice(0, 12).map((entry) => <article className="harvest-recent-row" key={entry.id}>
          <div className="harvest-recent-row__main"><strong>{groupNameById.get(entry.harvestGroupId) ?? entry.harvestGroupName ?? t("harvestPage.unknownGroup")}</strong><span className="bidi-isolate">{formatDate(entry.date, { dateStyle: "medium" })}</span></div>
          <div className="harvest-recent-row__stats"><span>{t("harvestPage.membersShort")}: <strong className="bidi-isolate">{cartons(entry.membersCount)}</strong></span><span>{t("harvestPage.cartonsShort")}: <strong className="bidi-isolate">{cartons(entry.cartonsHarvested)}</strong></span><span>{t("harvestPage.perPersonShort")}: <strong className="bidi-isolate">{ratio(entry.cartonsPerPerson)}</strong></span></div>
          <div className="harvest-recent-row__actions">{perms.canEdit ? <button type="button" className="icon-button" onClick={() => edit(entry)}><Pencil size={15} /></button> : null}{perms.canDelete ? <button type="button" className="icon-button danger-link" onClick={() => void remove(entry)}><Trash2 size={15} /></button> : null}</div>
        </article>) : <p className="empty-records">{t("harvestPage.noEntriesYet")}</p>}
      </div>
    </section>
  </div>;
}