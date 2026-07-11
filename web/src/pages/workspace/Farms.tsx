import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ChevronRight, Leaf, Map, MapPin, Pencil, Plus, Satellite, ShieldCheck, Trash2, UserRound, UsersRound, XCircle } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../../auth/AuthProvider";
import { BuildDiagnostics } from "../../components/BuildDiagnostics";
import { SubpageHeader } from "../../components/SubpageHeader";
import { config } from "../../config";
import {
  archiveWorkspaceFarm,
  createWorkspaceFarm,
  deleteWorkspaceFarm,
  fetchMe,
  fetchWorkspaceFarms,
  fetchWorkspaceProfile,
  requestWorkspaceFarmDeletion,
  repairWorkspaceContextRequest,
  restoreWorkspaceFarm,
  selectActiveFarm,
  updateMe,
  updateWorkspaceProfile,
  updateWorkspaceFarm,
  type Farm,
  type FarmInput,
  type UserProfileInput,
  type WorkspaceProfileInput,
} from "../../lib/api";
import { hasPermission } from "../../lib/permissions";

const emptyForm: FarmInput = { name: "", location: "", owner: "", remarks: "", contactName: "", contactEmail: "", contactPhone: "" };
const emptyProfile: WorkspaceProfileInput = { name: "", contactEmail: "", contactPhone: "" };
const emptyUserProfile: UserProfileInput = { displayName: "" };

function UserProfileCard({ token, onLogout }: { token: string; onLogout: () => void }) {
  const { t } = useTranslation();
  const { user, updateUser } = useAuth();
  const [form, setForm] = useState<UserProfileInput>(emptyUserProfile);
  const profile = useQuery({
    queryKey: ["me"],
    queryFn: () => fetchMe(token),
    enabled: Boolean(token),
  });

  useEffect(() => {
    const nextName = profile.data?.user.displayName ?? user?.displayName ?? "";
    setForm({ displayName: nextName });
  }, [profile.data?.user.displayName, user?.displayName]);

  const save = useMutation({
    mutationFn: () => updateMe(token, form),
    onSuccess: async (result) => {
      updateUser(result.user);
      await profile.refetch();
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate();
  };

  return (
    <section className="record-panel workspace-profile">
      {profile.isLoading && <p className="context-message">{t("userProfile.loading")}</p>}
      {profile.isError && <p className="error">{profile.error.message}</p>}
      {(profile.data || user) && (
        <form className="module-form workspace-profile__form" onSubmit={submit}>
          <label><span>{t("userProfile.displayName")}</span><input required value={form.displayName} onChange={(event) => setForm({ displayName: event.target.value })} /></label>
          <label><span>{t("email")}</span><input disabled value={profile.data?.user.email ?? user?.email ?? ""} /></label>
          <div className="farm-actions workspace-profile__actions">
            <button disabled={save.isPending} type="submit">{save.isPending ? t("userProfile.saving") : t("userProfile.save")}</button>
            <button className="danger-button" type="button" onClick={onLogout}>{t("common.logout")}</button>
          </div>
          {save.isSuccess && <p className="success">{t("userProfile.saved")}</p>}
          {save.isError && <p className="error">{save.error.message}</p>}
        </form>
      )}
    </section>
  );
}

function WorkspaceProfileCard({ token, workspaceId }: { token: string; workspaceId: string }) {
  const { t } = useTranslation();
  const { user, updateUser } = useAuth();
  const [form, setForm] = useState<WorkspaceProfileInput>(emptyProfile);
  const profile = useQuery({
    queryKey: ["workspace-profile", workspaceId],
    queryFn: () => fetchWorkspaceProfile(token, workspaceId),
    enabled: Boolean(token && workspaceId),
  });
  const canEdit = user?.memberships.some((membership) => membership.active && membership.workspaceId === workspaceId && membership.role === "workspace_owner") ?? false;

  useEffect(() => {
    if (!profile.data?.workspace) return;
    setForm({
      name: profile.data.workspace.name,
      contactEmail: profile.data.workspace.contactEmail,
      contactPhone: profile.data.workspace.contactPhone ?? "",
    });
  }, [profile.data?.workspace]);

  const save = useMutation({
    mutationFn: () => updateWorkspaceProfile(token, workspaceId, form),
    onSuccess: async (result) => {
      updateUser(result.user);
      await profile.refetch();
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate();
  };

  return (
    <section className="record-panel workspace-profile">
      {!canEdit && <p className="context-message">{t("workspaceProfile.ownerOnly")}</p>}
      {profile.isLoading && <p className="context-message">{t("workspaceProfile.loading")}</p>}
      {profile.isError && <p className="error">{profile.error.message}</p>}
      {profile.data && (
        <form className="module-form workspace-profile__form" onSubmit={submit}>
          <label><span>{t("workspaceProfile.name")}</span><input required disabled={!canEdit} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
          <label><span>{t("workspaceProfile.contactEmail")}</span><input required disabled={!canEdit} type="email" value={form.contactEmail} onChange={(event) => setForm({ ...form, contactEmail: event.target.value })} /></label>
          <label><span>{t("workspaceProfile.contactPhone")}</span><input disabled={!canEdit} value={form.contactPhone} onChange={(event) => setForm({ ...form, contactPhone: event.target.value })} /></label>
          {canEdit && <div className="farm-actions"><button disabled={save.isPending} type="submit">{save.isPending ? t("workspaceProfile.saving") : t("workspaceProfile.save")}</button></div>}
          {save.isSuccess && <p className="success">{t("workspaceProfile.saved")}</p>}
          {save.isError && <p className="error">{save.error.message}</p>}
        </form>
      )}
    </section>
  );
}

export function Farms() {
  const { t } = useTranslation();
  const { user, token, logout } = useAuth();
  const location = useLocation();
  const client = useQueryClient();
  const workspaceId = user?.workspaceId ?? "";
  const isSettings = location.pathname.endsWith("/settings");
  const canManage = Boolean(user && workspaceId && hasPermission(user, "MANAGE_FARMS", workspaceId));
  const [editing, setEditing] = useState<Farm | null>(null);
  const [form, setForm] = useState<FarmInput>(emptyForm);
  const [showForm, setShowForm] = useState(false);

  const farms = useQuery({
    queryKey: ["workspace-farms", workspaceId],
    queryFn: () => fetchWorkspaceFarms(token!, workspaceId),
    enabled: Boolean(token && workspaceId),
  });
  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ["workspace-farms", workspaceId] }),
      client.invalidateQueries({ queryKey: ["bootstrap", workspaceId] }),
    ]);
    window.dispatchEvent(new Event("muzare-farm-changed"));
  };
  const save = useMutation({
    mutationFn: () => editing
      ? updateWorkspaceFarm(token!, workspaceId, editing.id, form)
      : createWorkspaceFarm(token!, workspaceId, form),
    onSuccess: async () => {
      setEditing(null); setForm(emptyForm); setShowForm(false);
      await refresh();
    },
  });
  const archive = useMutation({
    mutationFn: (farmId: string) => archiveWorkspaceFarm(token!, workspaceId, farmId),
    onSuccess: refresh,
  });
  const restoreFarm = useMutation({
    mutationFn: (farmId: string) => restoreWorkspaceFarm(token!, workspaceId, farmId),
    onSuccess: refresh,
  });
  const deleteFarm = useMutation({
    mutationFn: (farmId: string) => deleteWorkspaceFarm(token!, workspaceId, farmId),
    onSuccess: refresh,
  });
  const requestDeletion = useMutation({
    mutationFn: ({ farmId, reason }: { farmId: string; reason?: string }) => requestWorkspaceFarmDeletion(token!, workspaceId, farmId, { reason }),
    onSuccess: refresh,
  });
  const repairContext = useMutation({
    mutationFn: () => repairWorkspaceContextRequest(token!, workspaceId),
    onSuccess: refresh,
  });
  const select = useMutation({
    mutationFn: (farmId: string) => selectActiveFarm(token!, workspaceId, farmId),
    onSuccess: refresh,
  });

  const edit = (farm: Farm) => {
    setEditing(farm);
    setForm({
      name: farm.name, location: farm.location ?? "", owner: farm.owner ?? "", remarks: farm.remarks ?? "",
      contactName: farm.contactName ?? "", contactEmail: farm.contactEmail ?? "", contactPhone: farm.contactPhone ?? "",
    });
    setShowForm(true);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate();
  };

  useEffect(() => {
    if (!canManage) return;
    const params = new URLSearchParams(location.search);
    if (params.get("create") === "1") {
      setEditing(null);
      setForm(emptyForm);
      setShowForm(true);
    }
  }, [canManage, location.search]);

  const requestArchive = (farm: Farm) => {
    if (window.confirm(`${t("farmsPage.archiveFarmConfirm")}\n\n${t("farmsPage.archiveFarmDescription")}`)) archive.mutate(farm.id);
  };
  const requestDelete = (farm: Farm) => {
    if (window.confirm(`${t("farmsPage.deleteFarmConfirm")}\n\n${t("farmsPage.deleteFarmDescription")}`)) deleteFarm.mutate(farm.id);
  };
  const requestAdminDeletion = (farm: Farm) => {
    const reason = window.prompt(t("farmsPage.requestDeletionReason"), "");
    if (reason === null) return;
    requestDeletion.mutate({ farmId: farm.id, reason: reason.trim() || undefined });
  };
  const requestRestore = (farm: Farm) => {
    if (window.confirm(t("farmsPage.restoreFarmConfirm"))) restoreFarm.mutate(farm.id);
  };
  const activeFarms = farms.data?.farms ?? [];
  const historyFarms = farms.data?.historyFarms ?? [];
  const hasUsableFarm = activeFarms.length > 0;

  return (
    <div className="dashboard-page">
      <SubpageHeader title={isSettings ? t("workspaceProfile.settingsTitle") : t("farmsPage.title")} />
      <main className={`subpage module-workspace${isSettings ? " module-workspace--settings" : ""}`}>
        {isSettings && (
          <>
            <section className="settings-page-hero record-panel">
              <div>
                <h2>{t("workspaceProfile.settingsTitle")}</h2>
                <p>{t("workspaceProfile.settingsSubtitle")}</p>
              </div>
            </section>
            <section className="settings-page-stack">
              <section className="settings-section">
                <div className="settings-section__header">
                  <div>
                    <h2>{t("userProfile.title")}</h2>
                    <p>{t("userProfile.description")}</p>
                  </div>
                </div>
                {token && <UserProfileCard token={token} onLogout={() => void logout()} />}
              </section>

              <section className="settings-section">
                <div className="settings-section__header">
                  <div>
                    <h2>{t("workspaceProfile.title")}</h2>
                    <p>{t("workspaceProfile.description")}</p>
                  </div>
                </div>
                {token && workspaceId && <WorkspaceProfileCard token={token} workspaceId={workspaceId} />}
              </section>

              <section className="settings-section">
                <div className="settings-section__header">
                  <div>
                    <h2>{t("workspaceProfile.accessTitle")}</h2>
                    <p>Manage who can access the workspace and review approvals.</p>
                  </div>
                </div>
                <div className="settings-menu-grid">
                  <Link to="/workspace/settings/team" className="settings-menu-row"><UsersRound size={19} /><div><strong>{t("workspaceTeam.title")}</strong><span>{t("workspaceTeam.settingsCard")}</span></div><ChevronRight size={17} /></Link>
                  <Link to="/workspace/settings/approvals" className="settings-menu-row"><ShieldCheck size={19} /><div><strong>{t("workspaceApprovals.title")}</strong><span>{t("workspaceApprovals.settingsCard")}</span></div><ChevronRight size={17} /></Link>
                </div>
              </section>

              <section className="settings-section">
                <div className="settings-section__header">
                  <div>
                    <h2>{t("workspaceProfile.farmSetupTitle")}</h2>
                    <p>{t("farmsPage.managementDescription")}</p>
                  </div>
                </div>
                <div className="settings-menu-grid settings-menu-grid--farm">
                  <Link to="/workspace/seasons" className="settings-menu-row"><Leaf size={19} /><div><strong>{t("seasonsPage.title")}</strong><span>{t("seasonsPage.managementDescription")}</span></div><ChevronRight size={17} /></Link>
                  {canManage && <button className="shell-action settings-menu-row__button" type="button" onClick={() => { setEditing(null); setForm(emptyForm); setShowForm(true); }}><Plus size={16} /><span>{t("farmsPage.createFarm")}</span><ChevronRight size={17} /></button>}
                </div>
              </section>
            </section>
          </>
        )}
        {!isSettings && (
          <section className="workspace-intro">
            <div><h2>{t("farmsPage.managementTitle")}</h2><p>{t("farmsPage.managementDescription")}</p></div>
            {canManage && <button className="shell-action" type="button" onClick={() => { setEditing(null); setForm(emptyForm); setShowForm(true); }}><Plus size={16} />{t("farmsPage.createFarm")}</button>}
          </section>
        )}

        {showForm && canManage && (
          <section className="record-panel">
            <h2>{editing ? t("farmsPage.editFarm") : t("farmsPage.createFarm")}</h2>
            <form className="module-form farm-form" onSubmit={submit}>
              <input required placeholder={t("farmsPage.farmName")} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
              <input placeholder={t("farmsPage.location")} value={form.location} onChange={(event) => setForm({ ...form, location: event.target.value })} />
              <input placeholder={t("farmsPage.ownerOrOperator")} value={form.owner} onChange={(event) => setForm({ ...form, owner: event.target.value })} />
              <input placeholder={t("farmsPage.contactName")} value={form.contactName} onChange={(event) => setForm({ ...form, contactName: event.target.value })} />
              <input type="email" placeholder={t("farmsPage.contactEmail")} value={form.contactEmail} onChange={(event) => setForm({ ...form, contactEmail: event.target.value })} />
              <input placeholder={t("farmsPage.contactPhone")} value={form.contactPhone} onChange={(event) => setForm({ ...form, contactPhone: event.target.value })} />
              <input placeholder={t("farmsPage.notes")} value={form.remarks} onChange={(event) => setForm({ ...form, remarks: event.target.value })} />
              <div className="farm-actions">
                <button disabled={save.isPending} type="submit">{editing ? t("farmsPage.saveChanges") : t("farmsPage.createFarm")}</button>
                <button className="secondary-button" type="button" onClick={() => setShowForm(false)}>{t("farmsPage.cancel")}</button>
              </div>
            </form>
            {save.isError && <p className="error">{save.error.message}</p>}
          </section>
        )}

        {farms.isLoading && <p className="context-message">{t("farmsPage.loadingFarms")}</p>}
        {farms.isError && <p className="error">{farms.error.message}</p>}
        {farms.data?.contextWarning && (
          <section className="record-panel">
            <p className={farms.data.needsRepair ? "error" : "context-message"}>{farms.data.contextWarning}</p>
            {canManage && (
              <div className="farm-actions">
                {farms.data.needsRepair && (
                  <button type="button" onClick={() => repairContext.mutate()} disabled={repairContext.isPending}>
                    {repairContext.isPending ? "Repairing..." : "Repair workspace context"}
                  </button>
                )}
                {!hasUsableFarm && <button type="button" onClick={() => { setEditing(null); setForm(emptyForm); setShowForm(true); }}>{t("farmsPage.createFarm")}</button>}
              </div>
            )}
            {repairContext.data ? <p className="positive">{repairContext.data.message}</p> : null}
            {repairContext.isError ? <p className="error">{repairContext.error.message}</p> : null}
          </section>
        )}
        {farms.data && (
          <section className="farm-grid">
            {activeFarms.map((farm) => {
              const isCurrent = farms.data.activeFarmId === farm.id;
              const statusLabel = farm.deletedAt ? t("farmsPage.deleted") : farm.active ? t("common.active") : t("seasonsPage.archived");
              return (
                <article className={`farm-card ${isCurrent ? "farm-card--active" : ""}`} key={farm.id}>
                  <header className="farm-card__header">
                    <div className="farm-card__title">
                      <strong>{farm.name}</strong>
                      <div className="farm-card__badges">
                        <span className={`status-badge ${farm.deletedAt ? "status-badge--deleted" : farm.active ? "status-badge--active" : "status-badge--archived"}`}>{statusLabel}</span>
                        {isCurrent && <span className="status-badge status-badge--active"><CheckCircle2 size={13} />{t("farmsPage.currentFarm")}</span>}
                      </div>
                    </div>
                  </header>
                  <p><MapPin size={15} />{farm.location || t("farmsPage.locationNotRecorded")}</p>
                  <p><UserRound size={15} />{farm.owner || farm.contactName || t("farmsPage.contactNotRecorded")}</p>
                  {farm.contactEmail && <small>{farm.contactEmail}</small>}
                  {farm.contactPhone && <small>{farm.contactPhone}</small>}
                  {farm.remarks && <small>{farm.remarks}</small>}
                  <footer className="farm-card__footer">
                    <div className="farm-card__primary-actions">
                      {config.featureFarmMap && <Link to={`/workspace/${workspaceId}/farms/${farm.id}/operations-map`}><Satellite size={15} />{t("farmMap.operationsMap")}</Link>}
                      {config.featureFarmMap && canManage && <Link to={`/workspace/${workspaceId}/farms/${farm.id}/map-builder`}><Map size={15} />{t("farmMap.mapBuilder")}</Link>}
                      {farm.active && !isCurrent && <button className="farm-card__primary-action" type="button" onClick={() => select.mutate(farm.id)}><Leaf size={15} />{t("farmsPage.setActive")}</button>}
                    </div>
                    <div className="farm-card__secondary-actions">
                      {canManage && <button type="button" className="farm-card__secondary-action" onClick={() => edit(farm)}><Pencil size={15} />{t("farmsPage.edit")}</button>}
                      {farm.deletionRequestStatus === "pending" && <span className="status-badge status-badge--pending">{t("farmsPage.deletionPending")}</span>}
                      {canManage && farm.active && isCurrent && <button className="danger-button farm-card__secondary-action farm-card__danger-action" type="button" onClick={() => requestArchive(farm)}><XCircle size={15} />{t("farmsPage.archive")}</button>}
                      {canManage && !isCurrent && farm.deletionRequestStatus !== "pending" && (
                        <details className="farm-card__danger-details">
                          <summary>{t("farmsPage.moreActions")}</summary>
                          <div className="farm-card__danger-menu">
                            {farm.active && <button className="danger-button farm-card__danger-action" type="button" onClick={() => requestArchive(farm)}><XCircle size={15} />{t("farmsPage.archive")}</button>}
                            <button className="danger-button farm-card__danger-action" type="button" onClick={() => requestDelete(farm)}><Trash2 size={15} />{t("farmsPage.deleteFarm")}</button>
                            <button type="button" className="farm-card__secondary-link" onClick={() => requestAdminDeletion(farm)}>{t("farmsPage.requestDeletion")}</button>
                          </div>
                        </details>
                      )}
                    </div>
                  </footer>
                </article>
              );
            })}
            {!activeFarms.length && <p className="context-message">{t("farmsPage.noUsableFarms")}</p>}
          </section>
        )}
        {Boolean(historyFarms.length) && (
          <details className="record-panel farm-history-details">
            <summary>
              <span>
                <strong>{t("farmsPage.historyTitle")}</strong>
                <small>{t("farmsPage.historyDescription")}</small>
              </span>
              <b>{historyFarms.length}</b>
            </summary>
            <section className="farm-grid farm-grid--history">
              {historyFarms.map((farm) => (
                <article className="farm-card farm-card--history" key={farm.id}>
                  <header className="farm-card__header">
                    <div className="farm-card__title">
                      <strong>{farm.name}</strong>
                      <div className="farm-card__badges">
                        <span className={`status-badge ${farm.deletedAt ? "status-badge--deleted" : "status-badge--archived"}`}>{farm.deletedAt ? t("farmsPage.deleted") : t("seasonsPage.archived")}</span>
                      </div>
                    </div>
                  </header>
                  <p><MapPin size={15} />{farm.location || t("farmsPage.locationNotRecorded")}</p>
                  <p><UserRound size={15} />{farm.owner || farm.contactName || t("farmsPage.contactNotRecorded")}</p>
                  {farm.remarks && <small>{farm.remarks}</small>}
                  <footer className="farm-card__footer">
                    {canManage && <button type="button" className="farm-card__secondary-action" onClick={() => requestRestore(farm)}><Leaf size={15} />{t("farmsPage.restoreFarm")}</button>}
                  </footer>
                </article>
              ))}
            </section>
          </details>
        )}
        {isSettings && (
          <section className="settings-section settings-section--diagnostics">
            <div className="settings-section__header">
              <div>
                <h2>{t("workspaceProfile.systemTitle")}</h2>
                <p>View app version details and technical reconciliation tools.</p>
              </div>
            </div>
            <BuildDiagnostics compact />
            <details className="settings-diagnostics-details">
              <summary>
                <span>
                  <strong>Accounting Reconciliation Trace</strong>
                  <small>Inspect labour settlement reconciliation</small>
                </span>
                <ChevronRight size={16} />
              </summary>
              <Link to="/debug/accounting-reconciliation" className="settings-diagnostics-details__link">Open diagnostics</Link>
            </details>
          </section>
        )}
        {deleteFarm.isError && <p className="error">{deleteFarm.error.message}</p>}
        {requestDeletion.isError && <p className="error">{requestDeletion.error.message}</p>}
        {restoreFarm.isError && <p className="error">{restoreFarm.error.message}</p>}
      </main>
    </div>
  );
}
