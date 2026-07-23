import { Check, Plus, ArrowLeft } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { SearchInput } from "../../components/SearchInput";
import { LabourSelectCombobox } from "../../components/LabourSelectCombobox";
import { SubpageHeader } from "../../components/SubpageHeader";
import { useAppBack } from "../../hooks/useAppBack";
import { formatMoney } from "../../lib/format";
import { getActiveFarmId, getActiveSeasonId, makeLocalRecord, offlineDb, workspaceRecords, type LabourGroup, type LabourWageSettlement, type Labourer, type Advance } from "../../lib/offline-db";
import { isActiveOperationalRecord } from "../../lib/operationalRecords";
import { sortWorkersForDisplay } from "../../lib/workerEligibility";
import { persistOperationalRecord } from "../../services/syncService";
import { translateStatus } from "../../lib/statusLabels";

const money = formatMoney;

type LabourStatusFilter = "all" | "active" | "inactive";
type MembershipFilter = "all" | "no_group" | "in_group" | "another_group";

type GroupForm = {
  name: string;
  phone: string;
  notes: string;
  active: boolean;
  foremanId: string;
};

const normalize = (value: string) => value.trim().toLowerCase();
const normalizeGroupKey = (value?: string | null) => value?.trim().toLowerCase() ?? "";
const labourSerial = (labourer: Labourer) => labourer.oldLabourId || labourer.oldAndroidId || (typeof labourer.sortOrder === "number" ? `#${labourer.sortOrder}` : typeof labourer.androidSortOrder === "number" ? `#${labourer.androidSortOrder}` : typeof labourer.originalIndex === "number" ? `#${labourer.originalIndex}` : "");

function isLabourerInGroup(labourer: Pick<Labourer, "groupId" | "group">, group: Pick<LabourGroup, "id" | "name">) {
  return labourer.groupId === group.id || normalizeGroupKey(labourer.group) === normalizeGroupKey(group.name);
}

function useLabourGroupsData() {
  const [labourers, setLabourers] = useState<Labourer[]>([]);
  const [groups, setGroups] = useState<LabourGroup[]>([]);
  const [settlements, setSettlements] = useState<LabourWageSettlement[]>([]);
  const [advances, setAdvances] = useState<Advance[]>([]);

  const refresh = useCallback(async () => {
    const [nextLabourers, nextGroups, nextSettlements, nextAdvances] = await Promise.all([
      workspaceRecords(offlineDb.labourers),
      workspaceRecords(offlineDb.labourGroups),
      workspaceRecords(offlineDb.labourWageSettlements, { includeDeleted: true }),
      workspaceRecords(offlineDb.advances),
    ]);
    setLabourers(sortWorkersForDisplay(nextLabourers, { includeArchived: false }));
    setGroups([...nextGroups].sort((left, right) => left.name.localeCompare(right.name)));
    setSettlements(nextSettlements);
    setAdvances(nextAdvances.filter((advance) => isActiveOperationalRecord(advance)));
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

  return { labourers, groups, settlements, advances, refresh, setLabourers };
}

function GroupEditorPanel({
  title,
  initialGroup,
  groups,
  labourers,
  onClose,
  onSave,
}: {
  title: string;
  initialGroup?: LabourGroup | null;
  groups: LabourGroup[];
  labourers: Labourer[];
  onClose: () => void;
  onSave: (record: LabourGroup, changedName: boolean) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState<GroupForm>({
    name: initialGroup?.name ?? "",
    phone: initialGroup?.phone ?? "",
    notes: initialGroup?.notes ?? "",
    active: initialGroup?.active !== false,
    foremanId: initialGroup?.foremanId ?? initialGroup?.foremanLabourId ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const name = form.name.trim();
    if (!name) {
      setError(t("labourGroupsPage.groupNameRequired"));
      return;
    }
    const duplicate = groups.some((group) => group.id !== initialGroup?.id && normalize(group.name) === normalize(name));
    if (duplicate) {
      setError(t("labourGroupsPage.duplicateGroupName"));
      return;
    }
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const normalizedForemanId = form.foremanId || undefined;
      await onSave({
        ...(initialGroup ?? makeLocalRecord()),
        name,
        phone: form.phone.trim() || undefined,
        notes: form.notes.trim() || undefined,
        active: form.active,
        foremanId: normalizedForemanId,
        foremanLabourId: normalizedForemanId,
        updatedAt: new Date().toISOString(),
      }, name !== (initialGroup?.name ?? ""));
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("labourGroupsPage.unableToSaveGroup"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="worker-dialog-backdrop worker-action-backdrop" role="presentation" onClick={onClose}>
      <section className="worker-action-dialog" role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}>
        <header>
          <h2>{title}</h2>
          <button type="button" aria-label={t("labourGroupsPage.closeDialogAria", { title })} onClick={onClose}>X</button>
        </header>
        <form className="worker-action-form" onSubmit={(event) => void submit(event)}>
          <label><span>{t("labourGroupsPage.groupNameLabel")}</span><input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
          <label><span>{t("workforcePage.phoneContact")}</span><input value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} /></label>
          <label>
            <span>{t("labourGroupsPage.foremanLabel")}</span>
            <LabourSelectCombobox
              ariaLabel={t("labourGroupsPage.selectForeman")}
              options={[...labourers].sort((left, right) => {
                const leftActive = left.active !== false ? 0 : 1;
                const rightActive = right.active !== false ? 0 : 1;
                return leftActive - rightActive || left.name.localeCompare(right.name);
              })}
              value={form.foremanId}
              onChange={(value) => setForm({ ...form, foremanId: value })}
              placeholder={t("labourGroupsPage.selectForeman")}
              noResultsLabel={t("labourGroupsPage.noLabourersOption")}
              clearValue=""
            />
          </label>
          <label><span>{t("labourGroupsPage.notesLabel")}</span><textarea value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></label>
          <label><span>{t("workforcePage.statusLabel")}</span><select value={form.active ? "active" : "inactive"} onChange={(event) => setForm({ ...form, active: event.target.value === "active" })}><option value="active">{translateStatus(t, "active")}</option><option value="inactive">{translateStatus(t, "inactive")}</option></select></label>
          <p className="context-message">{t("labourGroupsPage.foremanAssignmentHint")}</p>
          {error ? <p className="worker-action-error">{error}</p> : null}
          <footer>
            <button type="button" onClick={onClose}>{t("common.cancel")}</button>
            <button type="submit" disabled={busy}>{busy ? t("workforcePage.saving") : t("labourGroupsPage.saveGroup")}</button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function ConfirmBulkPanel({
  title,
  details,
  confirmLabel,
  onClose,
  onConfirm,
}: {
  title: string;
  details: ReactNode;
  confirmLabel: string;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onConfirm();
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("labourGroupsPage.unableToCompleteBulkUpdate"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="worker-dialog-backdrop worker-action-backdrop" role="presentation" onClick={onClose}>
      <section className="worker-action-dialog" role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}>
        <header>
          <h2>{title}</h2>
          <button type="button" aria-label={t("labourGroupsPage.closeDialogAria", { title })} onClick={onClose}>X</button>
        </header>
        <form className="worker-action-form" onSubmit={(event) => void submit(event)}>
          <p>{details}</p>
          {error ? <p className="worker-action-error">{error}</p> : null}
          <footer>
            <button type="button" onClick={onClose}>{t("common.cancel")}</button>
            <button type="submit" disabled={busy}>{busy ? t("labourGroupsPage.applying") : confirmLabel}</button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function groupMemberStats(group: LabourGroup, labourers: Labourer[], settlements: LabourWageSettlement[], advances: Advance[]) {
  const members = labourers.filter((labourer) => isLabourerInGroup(labourer, group));
  const activeMembers = members.filter((labourer) => labourer.active !== false);
  const inactiveMembers = members.filter((labourer) => labourer.active === false);
  const memberIds = new Set(members.map((labourer) => labourer.id));
  const foremanId = group.foremanId ?? group.foremanLabourId ?? null;
  const pendingWages = settlements
    .filter((settlement) => settlement.status === "posted" && (settlement.groupId === group.id || (foremanId && settlement.foremanId === foremanId)))
    .sort((left, right) => right.settlementDate.localeCompare(left.settlementDate));
  const lastSettlement = pendingWages[0] ?? null;
  const advanceBalance = Math.max(
    advances.filter((advance) => memberIds.has(advance.labourerId)).reduce((sum, advance) => sum + Number(advance.amount || 0), 0)
      - settlements.filter((settlement) => settlement.status === "posted" && (settlement.groupId === group.id || (foremanId && settlement.foremanId === foremanId)))
        .reduce((sum, settlement) => sum + Number(settlement.advanceAdjustedNow ?? settlement.settledAdvanceAmount ?? 0), 0),
    0,
  );
  const unsettledWages = settlements
    .filter((settlement) => settlement.status === "posted" && (settlement.groupId === group.id || (foremanId && settlement.foremanId === foremanId)))
    .reduce((sum, settlement) => sum + Number((settlement.grossWages ?? settlement.totalEarned ?? 0) - (settlement.advanceAdjustedNow ?? settlement.settledAdvanceAmount ?? 0) - Number(settlement.paidAmount ?? settlement.payableBalance ?? 0)), 0);
  return { members, activeMembers, inactiveMembers, lastSettlement, advanceBalance, unsettledWages };
}

export function LabourGroupsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams();
  const groupId = params.groupId ?? "";
  const backToGroupList = useAppBack("/workspace/workforce/labour-groups");
  const backToGroupDetail = useAppBack(`/workspace/workforce/labour-groups/${groupId}`);
  const isMembersView = location.pathname.endsWith("/members");
  const { labourers, groups, settlements, advances, refresh } = useLabourGroupsData();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<LabourStatusFilter>("active");
  const [membershipFilter, setMembershipFilter] = useState<MembershipFilter>("all");
  const [showCreate, setShowCreate] = useState(false);
  const [editingGroup, setEditingGroup] = useState<LabourGroup | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkAction, setBulkAction] = useState<"add" | "remove" | "move" | null>(null);

  const selectedGroup = useMemo(() => groups.find((group) => group.id === groupId) ?? null, [groupId, groups]);
  const memberStats = useMemo(() => selectedGroup ? groupMemberStats(selectedGroup, labourers, settlements, advances) : null, [advances, labourers, selectedGroup, settlements]);
  const groupLookup = useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups]);
  const labourById = useMemo(() => new Map(labourers.map((labourer) => [labourer.id, labourer])), [labourers]);
  const visibleGroups = useMemo(() => {
    const term = normalize(search);
    return groups.filter((group) => {
      const statusMatch = statusFilter === "all" || (statusFilter === "active" ? group.active !== false : group.active === false);
      const searchMatch = !term
        || normalize(group.name).includes(term)
        || normalize(group.phone ?? "").includes(term)
        || normalize(group.notes ?? "").includes(term);
      return statusMatch && searchMatch;
    });
  }, [groups, search, statusFilter]);
  const visibleLabourers = useMemo(() => {
    const term = normalize(search);
    return labourers.filter((labourer) => {
      const workerGroup = labourer.groupId ? groupLookup.get(labourer.groupId) ?? null : null;
      const legacyGroupName = labourer.group?.trim() ?? "";
      const inSelectedGroup = selectedGroup ? isLabourerInGroup(labourer, selectedGroup) : false;
      const labourStatus = labourer.active !== false ? "active" : "inactive";
      const memberStatus = !labourer.groupId && !legacyGroupName
        ? "no_group"
        : inSelectedGroup
          ? "in_group"
          : "another_group";
      const searchMatch = !term
        || normalize(labourer.name).includes(term)
        || normalize(labourer.phone ?? labourer.mobile ?? "").includes(term)
        || normalize(labourSerial(labourer)).includes(term)
        || normalize(labourer.group ?? workerGroup?.name ?? "").includes(term);
      const statusMatch = statusFilter === "all" || statusFilter === labourStatus;
      const membershipMatch = membershipFilter === "all" || membershipFilter === memberStatus;
      return searchMatch && statusMatch && membershipMatch;
    });
  }, [groupLookup, labourers, membershipFilter, search, selectedGroup?.id, statusFilter]);
  const selectedLabourers = useMemo(() => selectedIds.map((id) => labourers.find((labourer) => labourer.id === id)).filter(Boolean) as Labourer[], [labourers, selectedIds]);
  const selectedInThisGroup = selectedGroup ? selectedLabourers.filter((labourer) => isLabourerInGroup(labourer, selectedGroup)).length : 0;
  const selectedInAnotherGroup = selectedGroup ? selectedLabourers.filter((labourer) => !isLabourerInGroup(labourer, selectedGroup) && (labourer.groupId || labourer.group?.trim())).length : 0;
  const selectedNoGroup = selectedLabourers.filter((labourer) => !labourer.groupId && !labourer.group?.trim()).length;
  const currentAction = selectedIds.length === 0
    ? null
    : selectedInAnotherGroup > 0
      ? "move"
      : selectedInThisGroup > 0 && selectedNoGroup === 0
        ? "remove"
        : "add";

  useEffect(() => {
    setSelectedIds([]);
  }, [groupId]);

  const toast = (message: string) => window.dispatchEvent(new CustomEvent("muzare-toast", { detail: message }));

  const saveGroup = async (record: LabourGroup, changedName: boolean) => {
    const previousGroup = groups.find((group) => group.id === record.id) ?? null;
    const normalizedForemanId = record.foremanLabourId ?? record.foremanId ?? undefined;
    const nextRecord = {
      ...record,
      foremanId: normalizedForemanId,
      foremanLabourId: normalizedForemanId,
      workspaceId: record.workspaceId ?? (selectedGroup?.workspaceId ?? ""),
      farmId: record.farmId ?? selectedGroup?.farmId ?? getActiveFarmId() ?? undefined,
      seasonId: record.seasonId ?? selectedGroup?.seasonId ?? getActiveSeasonId() ?? undefined,
      pendingSync: true,
    } as LabourGroup;
    await persistOperationalRecord("labourGroup", nextRecord);
    if (nextRecord.foremanId) {
      const foreman = labourers.find((labourer) => labourer.id === nextRecord.foremanId) ?? null;
      if (foreman && foreman.groupId !== nextRecord.id) {
        await persistOperationalRecord("labourer", {
          ...foreman,
          groupId: nextRecord.id,
          group: nextRecord.name,
          updatedAt: new Date().toISOString(),
          pendingSync: true,
        });
      }
    }
    if (previousGroup && changedName) {
      const renamedMembers = labourers.filter((labourer) => isLabourerInGroup(labourer, record) && labourer.group !== record.name);
      for (const labourer of renamedMembers) {
        await persistOperationalRecord("labourer", {
          ...labourer,
          group: record.name,
          updatedAt: new Date().toISOString(),
          pendingSync: true,
        });
      }
    }
    await refresh();
    toast(previousGroup ? t("labourGroupsPage.groupUpdatedToast") : t("labourGroupsPage.groupCreatedToast"));
  };

  const bulkUpdateMembers = async () => {
    if (!selectedGroup || !currentAction) return;
    const affected = selectedLabourers.filter((labourer) =>
      currentAction === "remove"
        ? labourer.groupId === selectedGroup.id
        : currentAction === "add"
          ? labourer.groupId !== selectedGroup.id
          : labourer.groupId !== selectedGroup.id,
    );
    const updates = affected.map((labourer) => persistOperationalRecord("labourer", {
      ...labourer,
      groupId: currentAction === "remove" ? undefined : selectedGroup.id,
      group: currentAction === "remove" ? "" : selectedGroup.name,
      updatedAt: new Date().toISOString(),
      pendingSync: true,
    }));
    await Promise.all(updates);
    setSelectedIds([]);
    await refresh();
    toast(currentAction === "remove"
      ? t("labourGroupsPage.labourersRemovedToast", { count: affected.length, group: selectedGroup.name })
      : currentAction === "move"
        ? t("labourGroupsPage.labourersMovedToast", { count: affected.length, group: selectedGroup.name })
        : t("labourGroupsPage.labourersAssignedToast", { count: affected.length, group: selectedGroup.name }));
  };

  const selectVisible = () => setSelectedIds((current) => Array.from(new Set([...current, ...visibleLabourers.map((labourer) => labourer.id)])));
  const clearSelection = () => setSelectedIds([]);
  const selectVisibleActive = () => setSelectedIds((current) => Array.from(new Set([...current, ...visibleLabourers.filter((labourer) => labourer.active !== false).map((labourer) => labourer.id)])));
  const selectVisibleNoGroup = () => setSelectedIds((current) => Array.from(new Set([...current, ...visibleLabourers.filter((labourer) => !labourer.groupId).map((labourer) => labourer.id)])));

  const groupCardAction = (group: LabourGroup) => {
    const stats = groupMemberStats(group, labourers, settlements, advances);
    const foreman = labourById.get(group.foremanId ?? group.foremanLabourId ?? "") ?? null;
    const contact = group.phone?.trim() || "";
    const notes = group.notes?.trim() || "";
    return (
      <article className="workforce-group-card" key={group.id}>
        <div className="workforce-group-card__header">
          <div>
            <strong>{group.name}</strong>
            <span>{translateStatus(t, group.active !== false ? "active" : "inactive")}</span>
          </div>
          <button type="button" className="secondary-button" onClick={() => navigate(`/workspace/workforce/labour-groups/${group.id}`)}>{t("common.view")}</button>
        </div>
        <div className="workforce-group-card__metrics">
          <article><span>{t("labourGroupsPage.totalMembers")}</span><strong className="bidi-isolate">{stats.members.length}</strong></article>
          <article><span>{t("labourGroupsPage.activeToday")}</span><strong className="bidi-isolate">{stats.activeMembers.length}</strong></article>
          <article><span>{t("labourGroupsPage.inactiveToday")}</span><strong className="bidi-isolate">{stats.inactiveMembers.length}</strong></article>
        </div>
        <div className="workforce-group-card__foreman">
          <span>{t("labourGroupsPage.foremanLabel")}</span>
          <strong>{foreman?.name ?? t("labourGroupsPage.noForemanAssigned")}</strong>
        </div>
        <div className="workforce-group-card__copy">
          {contact ? <small>{t("labourGroupsPage.contact")}: <span className="bidi-isolate">{contact}</span></small> : null}
          {notes ? <p>{notes}</p> : null}
        </div>
        <div className="workforce-group-card__actions">
          <button type="button" className="workforce-group-card__action workforce-group-card__action--primary" onClick={() => navigate(`/workspace/workforce/labour-groups/${group.id}/members`)}>{t("labourGroupsPage.manageMembers")}</button>
          <button type="button" className="workforce-group-card__action workforce-group-card__action--primary" onClick={() => navigate(`/workspace/labour-payments/direct-due?scope=group&groupId=${encodeURIComponent(group.id)}`)}>{t("labourGroupsPage.createLabourDue")}</button>
          <button type="button" className="workforce-group-card__action workforce-group-card__action--secondary" onClick={() => navigate(`/workspace/workforce/labour-groups/${group.id}`)}>{t("labourGroupsPage.viewDetails")}</button>
          <button type="button" className="workforce-group-card__action workforce-group-card__action--secondary" onClick={() => setEditingGroup(group)}>{t("common.edit")}</button>
        </div>
      </article>
    );
  };

  if (!isMembersView && selectedGroup) {
    const stats = memberStats ?? { members: [], activeMembers: [], inactiveMembers: [], lastSettlement: null, advanceBalance: 0, unsettledWages: 0 };
    const foreman = labourById.get(selectedGroup.foremanId ?? selectedGroup.foremanLabourId ?? "") ?? null;
    return (
      <div className="dashboard-page">
        <SubpageHeader title={t("labourGroupsPage.pageTitle")} />
        <main className="subpage module-workspace workforce-shell-main">
          <section className="record-panel workforce-group-page-header">
            <button className="workforce-group-page-header__back" type="button" onClick={backToGroupList} aria-label={t("labourGroupsPage.backToGroups")}>
              <ArrowLeft size={18} />
            </button>
            <div className="workforce-group-page-header__copy">
              <h2>{selectedGroup.name}</h2>
              <p>{selectedGroup.phone ? <span className="bidi-isolate">{selectedGroup.phone}</span> : t("labourGroupsPage.noContact")} {selectedGroup.notes ? `- ${selectedGroup.notes}` : ""}</p>
            </div>
            <span className={`sync-badge ${selectedGroup.active !== false ? "sync-badge--online" : "sync-badge--error"}`}>{translateStatus(t, selectedGroup.active !== false ? "active" : "inactive")}</span>
          </section>
          <section className="record-panel workforce-group-detail-grid">
            <article><span>{t("labourGroupsPage.totalMembers")}</span><strong className="bidi-isolate">{stats.members.length}</strong></article>
            <article><span>{t("labourGroupsPage.activeToday")}</span><strong className="bidi-isolate">{stats.activeMembers.length}</strong></article>
            <article><span>{t("labourGroupsPage.inactiveToday")}</span><strong className="bidi-isolate">{stats.inactiveMembers.length}</strong></article>
            <article><span>{t("labourGroupsPage.outstandingAdvances")}</span><strong className="bidi-isolate">{money(stats.advanceBalance)}</strong></article>
            <article><span>{t("labourGroupsPage.unsettledWages")}</span><strong className="bidi-isolate">{money(stats.unsettledWages)}</strong></article>
            <article><span>{t("labourGroupsPage.lastSettlement")}</span><strong>{stats.lastSettlement ? <span className="bidi-isolate">{stats.lastSettlement.settlementDate}</span> : "-"}</strong></article>
            <article><span>{t("labourGroupsPage.foremanLabel")}</span><strong>{foreman?.name ?? t("labourGroupsPage.noForemanAssigned")}</strong></article>
          </section>
          <p className="context-message">{t("labourGroupsPage.settlementEligibilityNote")}</p>
          <section className="record-panel workforce-group-section">
            <div className="workforce-group-section__heading">
              <h2>{t("labourGroupsPage.membersHeading")}</h2>
              <div className="module-inline-actions">
                <button type="button" onClick={() => navigate(`/workspace/workforce/labour-groups/${selectedGroup.id}/members`)}>{t("labourGroupsPage.manageMembers")}</button>
                <button type="button" onClick={() => setEditingGroup(selectedGroup)}>{t("labourGroupsPage.editGroup")}</button>
                <button type="button" onClick={() => navigate(`/workspace/labour-payments/direct-due?scope=group&groupId=${encodeURIComponent(selectedGroup.id)}`)}>{t("labourGroupsPage.createLabourDue")}</button>
              </div>
            </div>
            <div className="workforce-group-member-list">
              {stats.members.length ? stats.members.map((labourer) => {
                const serial = labourSerial(labourer);
                return (
                  <article key={labourer.id} className="workforce-group-member-row">
                    <div>
                      <strong>{labourer.name}</strong>
                      <span>{serial ? <span className="bidi-isolate">{serial}</span> : t("labourGroupsPage.noSerial")} - {translateStatus(t, labourer.active !== false ? "active" : "inactive")}</span>
                    </div>
                    <span className="bidi-isolate">{labourer.phone || labourer.mobile || ""}</span>
                  </article>
                );
              }) : <p className="empty-records">{t("labourGroupsPage.noMembersAssignedYet")}</p>}
            </div>
          </section>
        </main>
        {editingGroup ? <GroupEditorPanel title={t("labourGroupsPage.editGroupDialogTitle")} initialGroup={editingGroup} groups={groups} labourers={labourers} onClose={() => setEditingGroup(null)} onSave={saveGroup} /> : null}
      </div>
    );
  }

  if (isMembersView && selectedGroup) {
    const stats = memberStats ?? { members: [], activeMembers: [], inactiveMembers: [], lastSettlement: null, advanceBalance: 0, unsettledWages: 0 };
    const selectionSummary = currentAction === "remove"
      ? `${t("common.itemsSelectedCount", { count: selectedIds.length })}. ${t("labourGroupsPage.willBeRemovedFromGroup", { count: selectedInThisGroup, group: selectedGroup.name })}`
      : currentAction === "move"
        ? `${t("common.itemsSelectedCount", { count: selectedIds.length })}. ${t("labourGroupsPage.willBeMovedToGroup", { count: selectedInAnotherGroup, group: selectedGroup.name })}`
        : `${t("common.itemsSelectedCount", { count: selectedIds.length })}. ${t("labourGroupsPage.willBeAssignedToGroup", { count: selectedNoGroup > 0 ? selectedNoGroup : selectedIds.length, group: selectedGroup.name })}`;
    const confirmLabel = currentAction === "remove" ? t("labourGroupsPage.removeFromGroup") : currentAction === "move" ? t("labourGroupsPage.moveToThisGroup") : t("labourGroupsPage.addToGroup");
    return (
      <div className="dashboard-page">
        <SubpageHeader title={t("labourGroupsPage.pageTitle")} />
        <main className="subpage module-workspace workforce-shell-main">
          <section className="record-panel workforce-group-page-header">
            <button className="workforce-group-page-header__back" type="button" onClick={backToGroupDetail} aria-label={t("labourGroupsPage.backToGroupDetail")}>
              <ArrowLeft size={18} />
            </button>
            <div className="workforce-group-page-header__copy">
              <h2>{selectedGroup.name}</h2>
              <p>{t("labourGroupsPage.manageMembersIntro")}</p>
            </div>
            <span className="sync-badge sync-badge--online">{t("common.itemsSelectedCount", { count: selectedIds.length })}</span>
          </section>
          <section className="record-panel workforce-group-detail-grid">
            <article><span>{t("labourGroupsPage.assigned")}</span><strong className="bidi-isolate">{stats.members.length}</strong></article>
            <article><span>{t("labourGroupsPage.activeToday")}</span><strong className="bidi-isolate">{stats.activeMembers.length}</strong></article>
            <article><span>{t("labourGroupsPage.inactiveToday")}</span><strong className="bidi-isolate">{stats.inactiveMembers.length}</strong></article>
            <article><span>{t("labourGroupsPage.visible")}</span><strong className="bidi-isolate">{visibleLabourers.length}</strong></article>
          </section>
          <section className="record-panel workforce-group-members-panel">
            <div className="workforce-group-members-panel__top">
              <SearchInput placeholder={t("labourGroupsPage.searchMembersPlaceholder")} value={search} onChange={setSearch} />
              <div className="workforce-group-filter-row">
                <button type="button" className={statusFilter === "all" ? "is-active" : ""} onClick={() => setStatusFilter("all")}>{t("common.all")}</button>
                <button type="button" className={statusFilter === "active" ? "is-active" : ""} onClick={() => setStatusFilter("active")}>{translateStatus(t, "active")}</button>
                <button type="button" className={statusFilter === "inactive" ? "is-active" : ""} onClick={() => setStatusFilter("inactive")}>{translateStatus(t, "inactive")}</button>
              </div>
              <div className="workforce-group-filter-row">
                <button type="button" className={membershipFilter === "all" ? "is-active" : ""} onClick={() => setMembershipFilter("all")}>{t("labourGroupsPage.allGroupStatuses")}</button>
                <button type="button" className={membershipFilter === "no_group" ? "is-active" : ""} onClick={() => setMembershipFilter("no_group")}>{t("labourGroupsPage.noGroup")}</button>
                <button type="button" className={membershipFilter === "in_group" ? "is-active" : ""} onClick={() => setMembershipFilter("in_group")}>{t("labourGroupsPage.alreadyInThisGroup")}</button>
                <button type="button" className={membershipFilter === "another_group" ? "is-active" : ""} onClick={() => setMembershipFilter("another_group")}>{t("labourGroupsPage.inAnotherGroup")}</button>
              </div>
              <div className="workforce-group-bulk-actions">
                <button type="button" onClick={selectVisible}>{t("labourGroupsPage.selectAllVisible")}</button>
                <button type="button" onClick={selectVisibleActive}>{t("labourGroupsPage.selectAllActiveVisible")}</button>
                <button type="button" onClick={selectVisibleNoGroup}>{t("labourGroupsPage.selectAllNoGroupVisible")}</button>
                <button type="button" onClick={clearSelection}>{t("common.clearSelection")}</button>
              </div>
            </div>
            <div className="workforce-group-member-list workforce-group-member-list--selectable">
              {visibleLabourers.length ? visibleLabourers.map((labourer) => {
                const checked = selectedIds.includes(labourer.id);
                const workerGroup = labourer.groupId ? groupLookup.get(labourer.groupId) ?? null : null;
                const currentGroupName = workerGroup?.name ?? labourer.group?.trim() ?? "";
                const serial = labourSerial(labourer);
                const inOtherGroup = !isLabourerInGroup(labourer, selectedGroup) && Boolean(labourer.groupId || labourer.group?.trim());
                return (
                  <button
                    type="button"
                    key={labourer.id}
                    className={`workforce-group-select-card${checked ? " is-selected" : ""}`}
                    onClick={() => setSelectedIds((current) => current.includes(labourer.id) ? current.filter((id) => id !== labourer.id) : [...current, labourer.id])}
                  >
                    <span className="workforce-group-select-card__check">{checked ? <Check size={15} /> : null}</span>
                    <span className="workforce-group-select-card__copy">
                      <strong>{serial ? <><span className="bidi-isolate">{serial}</span> {labourer.name}</> : labourer.name}</strong>
                      <span>{translateStatus(t, labourer.active !== false ? "active" : "inactive")} - <span className="bidi-isolate">{money(Number(labourer.dailyWage ?? labourer.dailyRate ?? 0) || 0)}</span>{t("labourGroupsPage.perDay")}</span>
                      <small>{t("labourGroupsPage.currentGroup")}: {currentGroupName || t("labourGroupsPage.noGroup")}</small>
                      {inOtherGroup ? <em className="status-inactive">{t("labourGroupsPage.inAnotherGroup")}</em> : null}
                    </span>
                  </button>
                );
              }) : <p className="empty-records">{t("labourGroupsPage.noLabourersMatchFilters")}</p>}
            </div>
          </section>
        </main>
        {selectedIds.length > 0 ? (
          <div className="workforce-group-sticky-bar" role="status" aria-live="polite">
            <strong>{t("common.itemsSelectedCount", { count: selectedIds.length })}</strong>
            <span>{selectionSummary}</span>
            <div className="workforce-group-sticky-bar__actions">
              <button type="button" className="secondary-button" onClick={clearSelection}>{t("common.clear")}</button>
              <button type="button" onClick={() => setBulkAction(currentAction)}>{confirmLabel}</button>
            </div>
          </div>
        ) : null}
        {bulkAction ? (
          <ConfirmBulkPanel
            title={bulkAction === "remove" ? t("labourGroupsPage.removeMembersDialogTitle") : bulkAction === "move" ? t("labourGroupsPage.moveMembersDialogTitle") : t("labourGroupsPage.addMembersDialogTitle")}
            details={selectionSummary}
            confirmLabel={confirmLabel}
            onClose={() => setBulkAction(null)}
            onConfirm={bulkUpdateMembers}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div className="dashboard-page">
      <SubpageHeader title={t("labourGroupsPage.pageTitle")} />
        <main className="subpage module-workspace workforce-shell-main">
        <section className="record-panel workforce-groups-shell">
          <div className="workforce-group-page-header workforce-group-page-header--stacked">
            <div className="workforce-group-page-header__copy">
              <h2>{t("labourGroupsPage.groupsForemenHeading")}</h2>
              <p>{t("labourGroupsPage.manageForemenIntro")}</p>
            </div>
            <button type="button" className="secondary-button" onClick={() => setShowCreate(true)}>
              <Plus size={16} /> {t("labourGroupsPage.createGroup")}
            </button>
          </div>
          <SearchInput placeholder={t("labourGroupsPage.searchGroupsPlaceholder")} value={search} onChange={setSearch} />
          <div className="workforce-group-filter-row">
            <button type="button" className={statusFilter === "all" ? "is-active" : ""} onClick={() => setStatusFilter("all")}>{t("common.all")}</button>
            <button type="button" className={statusFilter === "active" ? "is-active" : ""} onClick={() => setStatusFilter("active")}>{translateStatus(t, "active")}</button>
            <button type="button" className={statusFilter === "inactive" ? "is-active" : ""} onClick={() => setStatusFilter("inactive")}>{translateStatus(t, "inactive")}</button>
          </div>
          <div className="workforce-group-list">
            {visibleGroups.length ? visibleGroups.map((group) => groupCardAction(group)) : <p className="empty-records">{t("labourGroupsPage.noLabourGroupsFound")}</p>}
          </div>
        </section>
      </main>
      {showCreate ? <GroupEditorPanel title={t("labourGroupsPage.createGroupDialogTitle")} groups={groups} labourers={labourers} onClose={() => setShowCreate(false)} onSave={async (record) => saveGroup(record, false)} /> : null}
      {editingGroup ? <GroupEditorPanel title={t("labourGroupsPage.editGroupDialogTitle")} initialGroup={editingGroup} groups={groups} labourers={labourers} onClose={() => setEditingGroup(null)} onSave={saveGroup} /> : null}
    </div>
  );
}
