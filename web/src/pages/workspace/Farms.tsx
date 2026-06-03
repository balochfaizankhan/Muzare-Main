import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Leaf, LogOut, MapPin, Pencil, Plus, ShieldCheck, UserRound, UsersRound, XCircle } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../../auth/AuthProvider";
import { SubpageHeader } from "../../components/SubpageHeader";
import {
  archiveWorkspaceFarm,
  createWorkspaceFarm,
  fetchWorkspaceFarms,
  fetchWorkspaceProfile,
  selectActiveFarm,
  updateWorkspaceProfile,
  updateWorkspaceFarm,
  type Farm,
  type FarmInput,
  type WorkspaceProfileInput,
} from "../../lib/api";
import { hasPermission } from "../../lib/permissions";

const emptyForm: FarmInput = { name: "", location: "", owner: "", remarks: "", contactName: "", contactEmail: "", contactPhone: "" };
const emptyProfile: WorkspaceProfileInput = { name: "", contactEmail: "", contactPhone: "" };

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
      <div className="workspace-profile__heading">
        <div><h2>{t("workspaceProfile.title")}</h2><p>{t("workspaceProfile.description")}</p></div>
        {!canEdit && <span>{t("workspaceProfile.ownerOnly")}</span>}
      </div>
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

  return (
    <div className="dashboard-page">
      <SubpageHeader title={isSettings ? t("workspaceProfile.settingsTitle") : t("farmsPage.title")} />
      <main className="subpage module-workspace">
        {isSettings && <section className="mobile-settings-menu">
          <button type="button" onClick={() => void logout()}><LogOut size={17} />{t("common.logout")}</button>
        </section>}
        {isSettings && token && workspaceId && <WorkspaceProfileCard token={token} workspaceId={workspaceId} />}
        {isSettings && <section className="settings-link-grid">
          <Link to="/workspace/settings/team"><UsersRound size={19} /><div><strong>{t("workspaceTeam.title")}</strong><span>{t("workspaceTeam.settingsCard")}</span></div></Link>
          <Link to="/workspace/settings/approvals"><ShieldCheck size={19} /><div><strong>{t("workspaceApprovals.title")}</strong><span>{t("workspaceApprovals.settingsCard")}</span></div></Link>
          <Link to="/workspace/seasons"><Leaf size={19} /><div><strong>{t("seasonsPage.title")}</strong><span>{t("seasonsPage.managementDescription")}</span></div></Link>
        </section>}
        <section className="workspace-intro">
          <div><h2>{t("farmsPage.managementTitle")}</h2><p>{t("farmsPage.managementDescription")}</p></div>
          {canManage && <button className="shell-action" type="button" onClick={() => { setEditing(null); setForm(emptyForm); setShowForm(true); }}><Plus size={16} />{t("farmsPage.createFarm")}</button>}
        </section>

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
        {farms.data && (
          <section className="farm-grid">
            {farms.data.farms.map((farm) => {
              const isCurrent = farms.data.activeFarmId === farm.id;
              return (
                <article className={`farm-card ${isCurrent ? "farm-card--active" : ""}`} key={farm.id}>
                  <header><div><strong>{farm.name}</strong><span>{farm.active ? t("common.active") : t("seasonsPage.archived")}</span></div>{isCurrent && <b><CheckCircle2 size={15} />{t("farmsPage.currentFarm")}</b>}</header>
                  <p><MapPin size={15} />{farm.location || t("farmsPage.locationNotRecorded")}</p>
                  <p><UserRound size={15} />{farm.owner || farm.contactName || t("farmsPage.contactNotRecorded")}</p>
                  {farm.contactEmail && <small>{farm.contactEmail}</small>}
                  {farm.contactPhone && <small>{farm.contactPhone}</small>}
                  {farm.remarks && <small>{farm.remarks}</small>}
                  <footer>
                    {farm.active && !isCurrent && <button type="button" onClick={() => select.mutate(farm.id)}><Leaf size={15} />{t("farmsPage.setActive")}</button>}
                    {canManage && <button type="button" onClick={() => edit(farm)}><Pencil size={15} />{t("farmsPage.edit")}</button>}
                    {canManage && farm.active && <button className="danger-button" type="button" onClick={() => archive.mutate(farm.id)}><XCircle size={15} />{t("farmsPage.archive")}</button>}
                  </footer>
                </article>
              );
            })}
            {!farms.data.farms.length && <p className="context-message">{t("farmsPage.noFarms")}</p>}
          </section>
        )}
      </main>
    </div>
  );
}
