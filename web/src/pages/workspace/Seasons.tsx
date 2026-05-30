import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarCheck, CheckCircle2, Leaf, Pencil, Plus, XCircle } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useAuth } from "../../auth/AuthProvider";
import { SubpageHeader } from "../../components/SubpageHeader";
import { useSyncState } from "../../hooks/useSyncState";
import {
  archiveFarmSeason,
  createFarmSeason,
  fetchBootstrap,
  fetchFarmSeasons,
  selectActiveSeason,
  updateFarmSeason,
  type Season,
  type SeasonInput,
} from "../../lib/api";
import { hasPermission } from "../../lib/permissions";

const emptyForm: SeasonInput = { name: "", cropType: "", startsOn: "", expectedEndsOn: "", actualEndsOn: "", status: "planned", notes: "" };

export function Seasons() {
  const { user, token } = useAuth();
  const sync = useSyncState();
  const client = useQueryClient();
  const workspaceId = user?.workspaceId ?? "";
  const [editing, setEditing] = useState<Season | null>(null);
  const [form, setForm] = useState<SeasonInput>(emptyForm);
  const [showForm, setShowForm] = useState(false);
  const bootstrap = useQuery({
    queryKey: ["bootstrap", workspaceId, sync.farmId, sync.seasonId],
    queryFn: () => fetchBootstrap(token!),
    enabled: Boolean(token && workspaceId),
  });
  const farmId = bootstrap.data?.activeFarmId ?? "";
  const canManage = Boolean(user && workspaceId && hasPermission(user, "MANAGE_SEASONS", workspaceId));
  const seasons = useQuery({
    queryKey: ["workspace-seasons", workspaceId, farmId],
    queryFn: () => fetchFarmSeasons(token!, workspaceId, farmId),
    enabled: Boolean(token && workspaceId && farmId),
  });
  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ["workspace-seasons", workspaceId, farmId] }),
      client.invalidateQueries({ queryKey: ["bootstrap", workspaceId] }),
    ]);
    window.dispatchEvent(new Event("muzare-season-changed"));
  };
  const save = useMutation({
    mutationFn: () => editing
      ? updateFarmSeason(token!, workspaceId, farmId, editing.id, form)
      : createFarmSeason(token!, workspaceId, farmId, form),
    onSuccess: async () => {
      setEditing(null); setForm(emptyForm); setShowForm(false);
      await refresh();
    },
  });
  const select = useMutation({ mutationFn: (seasonId: string) => selectActiveSeason(token!, workspaceId, farmId, seasonId), onSuccess: refresh });
  const archive = useMutation({ mutationFn: (seasonId: string) => archiveFarmSeason(token!, workspaceId, farmId, seasonId), onSuccess: refresh });

  const edit = (season: Season) => {
    setEditing(season);
    setForm({
      name: season.name, cropType: season.cropType ?? "", startsOn: season.startsOn,
      expectedEndsOn: season.expectedEndsOn ?? "", actualEndsOn: season.actualEndsOn ?? "",
      status: season.status, notes: season.notes ?? "",
    });
    setShowForm(true);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate();
  };

  return (
    <div className="dashboard-page">
      <SubpageHeader title="Seasons" />
      <main className="subpage module-workspace">
        <section className="workspace-intro">
          <div><h2>Seasons and Crop Cycles</h2><p>Choose the active operating season before recording farm activity.</p></div>
          {canManage && farmId && <button className="shell-action" type="button" onClick={() => { setEditing(null); setForm(emptyForm); setShowForm(true); }}><Plus size={16} />Create Season</button>}
        </section>
        {!farmId && <p className="context-message">Create or select an active farm before managing seasons.</p>}
        {farmId && seasons.data && !seasons.data.activeSeasonId && <p className="context-message">No active season. Create or select a season to begin operations.</p>}

        {showForm && canManage && (
          <section className="record-panel">
            <h2>{editing ? "Edit Season" : "Create Season"}</h2>
            <form className="module-form farm-form" onSubmit={submit}>
              <input required placeholder="Season name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
              <input placeholder="Crop type" value={form.cropType} onChange={(event) => setForm({ ...form, cropType: event.target.value })} />
              <label><span>Start date</span><input required type="date" value={form.startsOn} onChange={(event) => setForm({ ...form, startsOn: event.target.value })} /></label>
              <label><span>Expected end date</span><input type="date" value={form.expectedEndsOn} onChange={(event) => setForm({ ...form, expectedEndsOn: event.target.value })} /></label>
              <label><span>Actual end date</span><input type="date" value={form.actualEndsOn} onChange={(event) => setForm({ ...form, actualEndsOn: event.target.value })} /></label>
              <select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value as SeasonInput["status"] })}>
                <option value="planned">Planned</option><option value="active">Active</option><option value="closed">Closed</option><option value="archived">Archived</option>
              </select>
              <input placeholder="Notes" value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} />
              <div className="farm-actions">
                <button disabled={save.isPending} type="submit">{editing ? "Save Changes" : "Create Season"}</button>
                <button className="secondary-button" type="button" onClick={() => setShowForm(false)}>Cancel</button>
              </div>
            </form>
            {save.isError && <p className="error">{save.error.message}</p>}
          </section>
        )}

        {seasons.isLoading && <p className="context-message">Loading crop cycles...</p>}
        {seasons.isError && <p className="error">{seasons.error.message}</p>}
        {seasons.data && (
          <section className="farm-grid">
            {seasons.data.seasons.map((season) => {
              const current = season.id === seasons.data.activeSeasonId;
              return (
                <article className={`farm-card ${current ? "farm-card--active" : ""}`} key={season.id}>
                  <header><div><strong>{season.name}</strong><span>{season.status}</span></div>{current && <b><CheckCircle2 size={15} />Current Season</b>}</header>
                  <p><Leaf size={15} />{season.cropType || "Crop type not recorded"}</p>
                  <p><CalendarCheck size={15} />{season.startsOn} to {season.expectedEndsOn || "open-ended"}</p>
                  {season.actualEndsOn && <small>Actual end: {season.actualEndsOn}</small>}
                  {season.notes && <small>{season.notes}</small>}
                  <footer>
                    {season.status !== "archived" && !current && <button type="button" onClick={() => select.mutate(season.id)}><CheckCircle2 size={15} />Set Active</button>}
                    {canManage && <button type="button" onClick={() => edit(season)}><Pencil size={15} />Edit</button>}
                    {canManage && season.status !== "archived" && <button className="danger-button" type="button" onClick={() => archive.mutate(season.id)}><XCircle size={15} />Archive</button>}
                  </footer>
                </article>
              );
            })}
          </section>
        )}
      </main>
    </div>
  );
}
