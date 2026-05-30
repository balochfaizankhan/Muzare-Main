import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Leaf, MapPin, Pencil, Plus, UserRound, XCircle } from "lucide-react";
import { useState, type FormEvent } from "react";
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
  const { user, token } = useAuth();
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
      <SubpageHeader title="Farms" />
      <main className="subpage module-workspace">
        <section className="workspace-intro">
          <div><h2>Farm Management</h2><p>Create farms, maintain contact details, and choose the active operating context.</p></div>
          {canManage && <button className="shell-action" type="button" onClick={() => { setEditing(null); setForm(emptyForm); setShowForm(true); }}><Plus size={16} />Create Farm</button>}
        </section>

        {showForm && canManage && (
          <section className="record-panel">
            <h2>{editing ? "Edit Farm" : "Create Farm"}</h2>
            <form className="module-form farm-form" onSubmit={submit}>
              <input required placeholder="Farm name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
              <input placeholder="Location" value={form.location} onChange={(event) => setForm({ ...form, location: event.target.value })} />
              <input placeholder="Owner or operator" value={form.owner} onChange={(event) => setForm({ ...form, owner: event.target.value })} />
              <input placeholder="Contact name" value={form.contactName} onChange={(event) => setForm({ ...form, contactName: event.target.value })} />
              <input type="email" placeholder="Contact email" value={form.contactEmail} onChange={(event) => setForm({ ...form, contactEmail: event.target.value })} />
              <input placeholder="Contact phone" value={form.contactPhone} onChange={(event) => setForm({ ...form, contactPhone: event.target.value })} />
              <input placeholder="Notes" value={form.remarks} onChange={(event) => setForm({ ...form, remarks: event.target.value })} />
              <div className="farm-actions">
                <button disabled={save.isPending} type="submit">{editing ? "Save Changes" : "Create Farm"}</button>
                <button className="secondary-button" type="button" onClick={() => setShowForm(false)}>Cancel</button>
              </div>
            </form>
            {save.isError && <p className="error">{save.error.message}</p>}
          </section>
        )}

        {farms.isLoading && <p className="context-message">Loading farms...</p>}
        {farms.isError && <p className="error">{farms.error.message}</p>}
        {farms.data && (
          <section className="farm-grid">
            {farms.data.farms.map((farm) => {
              const isCurrent = farms.data.activeFarmId === farm.id;
              return (
                <article className={`farm-card ${isCurrent ? "farm-card--active" : ""}`} key={farm.id}>
                  <header><div><strong>{farm.name}</strong><span>{farm.active ? "Active" : "Archived"}</span></div>{isCurrent && <b><CheckCircle2 size={15} />Current Farm</b>}</header>
                  <p><MapPin size={15} />{farm.location || "Location not recorded"}</p>
                  <p><UserRound size={15} />{farm.owner || farm.contactName || "Contact not recorded"}</p>
                  {farm.contactEmail && <small>{farm.contactEmail}</small>}
                  {farm.contactPhone && <small>{farm.contactPhone}</small>}
                  {farm.remarks && <small>{farm.remarks}</small>}
                  <footer>
                    {farm.active && !isCurrent && <button type="button" onClick={() => select.mutate(farm.id)}><Leaf size={15} />Set Active</button>}
                    {canManage && <button type="button" onClick={() => edit(farm)}><Pencil size={15} />Edit</button>}
                    {canManage && farm.active && <button className="danger-button" type="button" onClick={() => archive.mutate(farm.id)}><XCircle size={15} />Archive</button>}
                  </footer>
                </article>
              );
            })}
            {!farms.data.farms.length && <p className="context-message">No farms exist yet. Create the first farm to begin operations.</p>}
          </section>
        )}
      </main>
    </div>
  );
}
