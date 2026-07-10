import { Check, Plus, ArrowLeft } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { SearchInput } from "../../components/SearchInput";
import { LabourSelectCombobox } from "../../components/LabourSelectCombobox";
import { SubpageHeader } from "../../components/SubpageHeader";
import { formatMoney } from "../../lib/format";
import { getActiveFarmId, getActiveSeasonId, makeLocalRecord, offlineDb, workspaceRecords, type LabourGroup, type LabourWageSettlement, type Labourer, type Advance } from "../../lib/offline-db";
import { isActiveOperationalRecord } from "../../lib/operationalRecords";
import { sortWorkersForDisplay } from "../../lib/workerEligibility";
import { persistOperationalRecord } from "../../services/syncService";

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
      setError("Group name is required.");
      return;
    }
    const duplicate = groups.some((group) => group.id !== initialGroup?.id && normalize(group.name) === normalize(name));
    if (duplicate) {
      setError("A labour group with this name already exists.");
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
      setError(caught instanceof Error ? caught.message : "Unable to save the group.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="worker-dialog-backdrop worker-action-backdrop" role="presentation" onClick={onClose}>
      <section className="worker-action-dialog" role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}>
        <header>
          <h2>{title}</h2>
          <button type="button" aria-label={`Close ${title}`} onClick={onClose}>X</button>
        </header>
        <form className="worker-action-form" onSubmit={(event) => void submit(event)}>
          <label><span>Group name *</span><input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
          <label><span>Phone / contact</span><input value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} /></label>
          <label>
            <span>Foreman</span>
            <LabourSelectCombobox
              ariaLabel="Select foreman"
              options={[...labourers].sort((left, right) => {
                const leftActive = left.active !== false ? 0 : 1;
                const rightActive = right.active !== false ? 0 : 1;
                return leftActive - rightActive || left.name.localeCompare(right.name);
              })}
              value={form.foremanId}
              onChange={(value) => setForm({ ...form, foremanId: value })}
              placeholder="Select foreman"
              noResultsLabel="No labourers found"
              clearValue=""
            />
          </label>
          <label><span>Notes</span><textarea value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></label>
          <label><span>Status</span><select value={form.active ? "active" : "inactive"} onChange={(event) => setForm({ ...form, active: event.target.value === "active" })}><option value="active">Active</option><option value="inactive">Inactive</option></select></label>
          <p className="context-message">Selecting a foreman will also assign that labourer to the group if needed.</p>
          {error ? <p className="worker-action-error">{error}</p> : null}
          <footer>
            <button type="button" onClick={onClose}>Cancel</button>
            <button type="submit" disabled={busy}>{busy ? "Saving..." : "Save group"}</button>
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
      setError(caught instanceof Error ? caught.message : "Unable to complete the bulk update.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="worker-dialog-backdrop worker-action-backdrop" role="presentation" onClick={onClose}>
      <section className="worker-action-dialog" role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}>
        <header>
          <h2>{title}</h2>
          <button type="button" aria-label={`Close ${title}`} onClick={onClose}>X</button>
        </header>
        <form className="worker-action-form" onSubmit={(event) => void submit(event)}>
          <p>{details}</p>
          {error ? <p className="worker-action-error">{error}</p> : null}
          <footer>
            <button type="button" onClick={onClose}>Cancel</button>
            <button type="submit" disabled={busy}>{busy ? "Applying..." : confirmLabel}</button>
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
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams();
  const groupId = params.groupId ?? "";
  const isMembersView = location.pathname.endsWith("/members");
  const { labourers, groups, settlements, advances, refresh } = useLabourGroupsData();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<LabourStatusFilter>("all");
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
    toast(previousGroup ? "Labour group updated." : "Labour group created.");
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
      ? `${affected.length} labourers removed from ${selectedGroup.name}.`
      : currentAction === "move"
        ? `${affected.length} labourers moved to ${selectedGroup.name}.`
        : `${affected.length} labourers assigned to ${selectedGroup.name}.`);
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
            <span>{group.active !== false ? "Active" : "Inactive"}</span>
          </div>
          <button type="button" className="secondary-button" onClick={() => navigate(`/workspace/workforce/labour-groups/${group.id}`)}>View</button>
        </div>
        <div className="workforce-group-card__metrics">
          <article><span>Total members</span><strong>{stats.members.length}</strong></article>
          <article><span>Active today</span><strong>{stats.activeMembers.length}</strong></article>
          <article><span>Inactive today</span><strong>{stats.inactiveMembers.length}</strong></article>
        </div>
        <div className="workforce-group-card__foreman">
          <span>Foreman</span>
          <strong>{foreman?.name ?? "No foreman assigned"}</strong>
        </div>
        <div className="workforce-group-card__copy">
          {contact ? <small>Contact: {contact}</small> : null}
          {notes ? <p>{notes}</p> : null}
        </div>
        <div className="workforce-group-card__actions">
          <button type="button" className="workforce-group-card__action workforce-group-card__action--primary" onClick={() => navigate(`/workspace/workforce/labour-groups/${group.id}/members`)}>Manage members</button>
          <button type="button" className="workforce-group-card__action workforce-group-card__action--primary" onClick={() => navigate(`/workspace/labour-payments/settlements?groupId=${encodeURIComponent(group.id)}`)}>Create settlement</button>
          <button type="button" className="workforce-group-card__action workforce-group-card__action--secondary" onClick={() => navigate(`/workspace/workforce/labour-groups/${group.id}`)}>View details</button>
          <button type="button" className="workforce-group-card__action workforce-group-card__action--secondary" onClick={() => setEditingGroup(group)}>Edit</button>
        </div>
      </article>
    );
  };

  if (!isMembersView && selectedGroup) {
    const stats = memberStats ?? { members: [], activeMembers: [], inactiveMembers: [], lastSettlement: null, advanceBalance: 0, unsettledWages: 0 };
    const foreman = labourById.get(selectedGroup.foremanId ?? selectedGroup.foremanLabourId ?? "") ?? null;
    return (
      <div className="dashboard-page">
        <SubpageHeader title="Labour Groups" />
        <main className="subpage module-workspace workforce-shell-main">
          <section className="record-panel workforce-group-page-header">
            <Link className="workforce-group-page-header__back" to="/workspace/workforce/labour-groups" aria-label="Back to labour groups">
              <ArrowLeft size={18} />
            </Link>
            <div className="workforce-group-page-header__copy">
              <h2>{selectedGroup.name}</h2>
              <p>{selectedGroup.phone || "No contact"} {selectedGroup.notes ? `- ${selectedGroup.notes}` : ""}</p>
            </div>
            <span className={`sync-badge ${selectedGroup.active !== false ? "sync-badge--online" : "sync-badge--error"}`}>{selectedGroup.active !== false ? "Active" : "Inactive"}</span>
          </section>
          <section className="record-panel workforce-group-detail-grid">
            <article><span>Total members</span><strong>{stats.members.length}</strong></article>
            <article><span>Active today</span><strong>{stats.activeMembers.length}</strong></article>
            <article><span>Inactive today</span><strong>{stats.inactiveMembers.length}</strong></article>
            <article><span>Outstanding advances</span><strong>{money(stats.advanceBalance)}</strong></article>
            <article><span>Unsettled wages</span><strong>{money(stats.unsettledWages)}</strong></article>
            <article><span>Last settlement</span><strong>{stats.lastSettlement ? stats.lastSettlement.settlementDate : "-"}</strong></article>
            <article><span>Foreman</span><strong>{foreman?.name ?? "No foreman assigned"}</strong></article>
          </section>
          <p className="context-message">Settlement eligibility is based on wage-period attendance, not only the current active status.</p>
          <section className="record-panel workforce-group-section">
            <div className="workforce-group-section__heading">
              <h2>Members</h2>
              <div className="module-inline-actions">
                <button type="button" onClick={() => navigate(`/workspace/workforce/labour-groups/${selectedGroup.id}/members`)}>Manage members</button>
                <button type="button" onClick={() => setEditingGroup(selectedGroup)}>Edit group</button>
                <button type="button" onClick={() => navigate(`/workspace/labour-payments/settlements?groupId=${encodeURIComponent(selectedGroup.id)}`)}>Create settlement</button>
              </div>
            </div>
            <div className="workforce-group-member-list">
              {stats.members.length ? stats.members.map((labourer) => {
                const label = labourer.active !== false ? "Active" : "Inactive";
                return (
                  <article key={labourer.id} className="workforce-group-member-row">
                    <div>
                      <strong>{labourer.name}</strong>
                      <span>{labourSerial(labourer) || "No serial"} - {label}</span>
                    </div>
                    <span>{labourer.phone || labourer.mobile || ""}</span>
                  </article>
                );
              }) : <p className="empty-records">No labourers are assigned to this group yet.</p>}
            </div>
          </section>
        </main>
        {editingGroup ? <GroupEditorPanel title="Edit Labour Group" initialGroup={editingGroup} groups={groups} labourers={labourers} onClose={() => setEditingGroup(null)} onSave={saveGroup} /> : null}
      </div>
    );
  }

  if (isMembersView && selectedGroup) {
    const stats = memberStats ?? { members: [], activeMembers: [], inactiveMembers: [], lastSettlement: null, advanceBalance: 0, unsettledWages: 0 };
    const selectionSummary = currentAction === "remove"
      ? `${selectedIds.length} selected. ${selectedInThisGroup} will be removed from ${selectedGroup.name}.`
      : currentAction === "move"
        ? `${selectedIds.length} selected. ${selectedInAnotherGroup} will be moved to ${selectedGroup.name}.`
        : `${selectedIds.length} selected. ${selectedNoGroup > 0 ? selectedNoGroup : selectedIds.length} will be assigned to ${selectedGroup.name}.`;
    const confirmLabel = currentAction === "remove" ? "Remove from group" : currentAction === "move" ? "Move to this group" : "Add to group";
    return (
      <div className="dashboard-page">
        <SubpageHeader title="Labour Groups" />
        <main className="subpage module-workspace workforce-shell-main">
          <section className="record-panel workforce-group-page-header">
            <Link className="workforce-group-page-header__back" to={`/workspace/workforce/labour-groups/${selectedGroup.id}`} aria-label="Back to group detail">
              <ArrowLeft size={18} />
            </Link>
            <div className="workforce-group-page-header__copy">
              <h2>{selectedGroup.name}</h2>
              <p>Manage members and bulk assignment.</p>
            </div>
            <span className="sync-badge sync-badge--online">{selectedIds.length} selected</span>
          </section>
          <section className="record-panel workforce-group-detail-grid">
            <article><span>Assigned</span><strong>{stats.members.length}</strong></article>
            <article><span>Active today</span><strong>{stats.activeMembers.length}</strong></article>
            <article><span>Inactive today</span><strong>{stats.inactiveMembers.length}</strong></article>
            <article><span>Visible</span><strong>{visibleLabourers.length}</strong></article>
          </section>
          <section className="record-panel workforce-group-members-panel">
            <div className="workforce-group-members-panel__top">
              <SearchInput placeholder="Search labour name, phone, or serial" value={search} onChange={setSearch} />
              <div className="workforce-group-filter-row">
                <button type="button" className={statusFilter === "all" ? "is-active" : ""} onClick={() => setStatusFilter("all")}>All</button>
                <button type="button" className={statusFilter === "active" ? "is-active" : ""} onClick={() => setStatusFilter("active")}>Active</button>
                <button type="button" className={statusFilter === "inactive" ? "is-active" : ""} onClick={() => setStatusFilter("inactive")}>Inactive</button>
              </div>
              <div className="workforce-group-filter-row">
                <button type="button" className={membershipFilter === "all" ? "is-active" : ""} onClick={() => setMembershipFilter("all")}>All group statuses</button>
                <button type="button" className={membershipFilter === "no_group" ? "is-active" : ""} onClick={() => setMembershipFilter("no_group")}>No group</button>
                <button type="button" className={membershipFilter === "in_group" ? "is-active" : ""} onClick={() => setMembershipFilter("in_group")}>Already in this group</button>
                <button type="button" className={membershipFilter === "another_group" ? "is-active" : ""} onClick={() => setMembershipFilter("another_group")}>In another group</button>
              </div>
              <div className="workforce-group-bulk-actions">
                <button type="button" onClick={selectVisible}>Select all visible</button>
                <button type="button" onClick={selectVisibleActive}>Select all active visible</button>
                <button type="button" onClick={selectVisibleNoGroup}>Select all no-group visible</button>
                <button type="button" onClick={clearSelection}>Clear selection</button>
              </div>
            </div>
            <div className="workforce-group-member-list workforce-group-member-list--selectable">
              {visibleLabourers.length ? visibleLabourers.map((labourer) => {
                const checked = selectedIds.includes(labourer.id);
                const workerGroup = labourer.groupId ? groupLookup.get(labourer.groupId) ?? null : null;
                const currentGroupName = workerGroup?.name ?? labourer.group?.trim() ?? "No group";
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
                      <strong>{serial ? `${serial} ${labourer.name}` : labourer.name}</strong>
                      <span>{labourer.active !== false ? "Active" : "Inactive"} - {money(Number(labourer.dailyWage ?? labourer.dailyRate ?? 0) || 0)}/day</span>
                      <small>Current group: {currentGroupName}</small>
                      {inOtherGroup ? <em className="status-inactive">In another group</em> : null}
                    </span>
                  </button>
                );
              }) : <p className="empty-records">No labourers match the current search and filters.</p>}
            </div>
          </section>
        </main>
        {selectedIds.length > 0 ? (
          <div className="workforce-group-sticky-bar" role="status" aria-live="polite">
            <strong>{selectedIds.length} selected</strong>
            <span>{selectionSummary}</span>
            <div className="workforce-group-sticky-bar__actions">
              <button type="button" className="secondary-button" onClick={clearSelection}>Clear</button>
              <button type="button" onClick={() => setBulkAction(currentAction)}>{confirmLabel}</button>
            </div>
          </div>
        ) : null}
        {bulkAction ? (
          <ConfirmBulkPanel
            title={bulkAction === "remove" ? "Remove members" : bulkAction === "move" ? "Move members" : "Add members"}
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
      <SubpageHeader title="Labour Groups" />
        <main className="subpage module-workspace workforce-shell-main">
        <section className="record-panel workforce-groups-shell">
          <div className="workforce-group-page-header workforce-group-page-header--stacked">
            <div className="workforce-group-page-header__copy">
              <h2>Labour Groups / Foremen</h2>
              <p>Manage group leaders and assign labourers.</p>
            </div>
            <button type="button" className="secondary-button" onClick={() => setShowCreate(true)}>
              <Plus size={16} /> Create group
            </button>
          </div>
          <SearchInput placeholder="Search groups" value={search} onChange={setSearch} />
          <div className="workforce-group-filter-row">
            <button type="button" className={statusFilter === "all" ? "is-active" : ""} onClick={() => setStatusFilter("all")}>All</button>
            <button type="button" className={statusFilter === "active" ? "is-active" : ""} onClick={() => setStatusFilter("active")}>Active</button>
            <button type="button" className={statusFilter === "inactive" ? "is-active" : ""} onClick={() => setStatusFilter("inactive")}>Inactive</button>
          </div>
          <div className="workforce-group-list">
            {visibleGroups.length ? visibleGroups.map((group) => groupCardAction(group)) : <p className="empty-records">No labour groups found.</p>}
          </div>
        </section>
      </main>
      {showCreate ? <GroupEditorPanel title="Create Labour Group" groups={groups} labourers={labourers} onClose={() => setShowCreate(false)} onSave={async (record) => saveGroup(record, false)} /> : null}
      {editingGroup ? <GroupEditorPanel title="Edit Labour Group" initialGroup={editingGroup} groups={groups} labourers={labourers} onClose={() => setEditingGroup(null)} onSave={saveGroup} /> : null}
    </div>
  );
}
