import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Leaf, LogOut, MapPin, Pencil, Plus, UserRound, XCircle } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";
import { useAuth } from "../../auth/AuthProvider";
import { SubpageHeader } from "../../components/SubpageHeader";
import {
  archiveWorkspaceFarm,
  createWorkspaceFarm,
  fetchWorkspaceFarms,
  selectActiveFarm,
  updateWorkspaceFarm,
  type Farm,
  type FarmInput,
} from "../../lib/api";
import { hasPermission } from "../../lib/permissions";

const emptyForm: FarmInput = { name: "", location: "", owner: "", remarks: "", contactName: "", contactEmail: "", contactPhone: "" };

export function Farms() {
  const { t } = useTranslation();
  const { user, token, logout } = useAuth();
  const location = useLocation();
  const client = useQueryClient();
  const workspaceId = user?.workspaceId ?? "";
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
      <SubpageHeader title={t("farmsPage.title")} />
      <main className="subpage module-workspace">
        {location.pathname.endsWith("/settings") && <section className="mobile-settings-menu">
          <button type="button" onClick={() => void logout()}><LogOut size={17} />{t("common.logout")}</button>
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
