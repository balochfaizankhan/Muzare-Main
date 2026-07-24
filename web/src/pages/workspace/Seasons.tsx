import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarCheck, CheckCircle2, Leaf, Pencil, Plus, XCircle } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
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
import { formatDate } from "../../lib/format";
import { hasPermission } from "../../lib/permissions";

const emptyForm: SeasonInput = { name: "", cropType: "", startsOn: "", expectedEndsOn: "", actualEndsOn: "", status: "planned", notes: "" };
const displayDate = (value: string) => {
  const date = new Date(`${value.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return formatDate(date, { day: "numeric", month: "short", year: "numeric" });
};

export function Seasons() {
  const { t } = useTranslation();
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
      <SubpageHeader title={t("seasonsPage.title")} />
      <main className="subpage module-workspace">
        <section className="workspace-intro">
          <div><h2>{t("seasonsPage.managementTitle")}</h2><p>{t("seasonsPage.managementDescription")}</p></div>
          {canManage && farmId && <button className="shell-action" type="button" onClick={() => { setEditing(null); setForm(emptyForm); setShowForm(true); }}><Plus size={16} />{t("seasonsPage.createSeason")}</button>}
        </section>
        {!farmId && <p className="context-message">{t("seasonsPage.createOrSelectFarm")}</p>}
        {farmId && seasons.data && !seasons.data.activeSeasonId && <p className="context-message">{t("seasonsPage.noActiveSeason")}</p>}

        {showForm && canManage && (
          <section className="record-panel">
            <h2>{editing ? t("seasonsPage.editSeason") : t("seasonsPage.createSeason")}</h2>
            <form className="module-form farm-form" onSubmit={submit}>
              <input required placeholder={t("seasonsPage.seasonName")} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
              <input placeholder={t("seasonsPage.cropType")} value={form.cropType} onChange={(event) => setForm({ ...form, cropType: event.target.value })} />
              <label><span>{t("seasonsPage.startDate")}</span><input required type="date" value={form.startsOn} onChange={(event) => setForm({ ...form, startsOn: event.target.value })} /></label>
              <label><span>{t("seasonsPage.expectedEndDate")}</span><input type="date" value={form.expectedEndsOn} onChange={(event) => setForm({ ...form, expectedEndsOn: event.target.value })} /></label>
              <label><span>{t("seasonsPage.actualEndDate")}</span><input type="date" value={form.actualEndsOn} onChange={(event) => setForm({ ...form, actualEndsOn: event.target.value })} /></label>
              <select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value as SeasonInput["status"] })}>
                <option value="planned">{t("seasonsPage.planned")}</option><option value="active">{t("seasonsPage.active")}</option><option value="closed">{t("seasonsPage.closed")}</option><option value="archived">{t("seasonsPage.archived")}</option>
              </select>
              <input placeholder={t("seasonsPage.notes")} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} />
              <div className="farm-actions">
                <button disabled={save.isPending} type="submit">{editing ? t("seasonsPage.saveChanges") : t("seasonsPage.createSeason")}</button>
                <button className="secondary-button" type="button" onClick={() => setShowForm(false)}>{t("seasonsPage.cancel")}</button>
              </div>
            </form>
            {save.isError && <p className="error">{save.error.message}</p>}
          </section>
        )}

        {seasons.isLoading && <p className="context-message">{t("seasonsPage.loadingCycles")}</p>}
        {seasons.isError && <p className="error">{seasons.error.message}</p>}
        {seasons.data && (
          <section className="farm-grid">
            {seasons.data.seasons.map((season) => {
              const current = season.id === seasons.data.activeSeasonId;
              return (
                <article className={`farm-card ${current ? "farm-card--active" : ""}`} key={season.id}>
                  <header><div><strong>{season.name}</strong><span>{t(`seasonsPage.${season.status}`)}</span></div>{current && <b><CheckCircle2 size={15} />{t("seasonsPage.currentSeason")}</b>}</header>
                  <p><Leaf size={15} />{season.cropType || t("seasonsPage.cropTypeNotRecorded")}</p>
                  <p><CalendarCheck size={15} />{displayDate(season.startsOn)} {t("reports.to")} {season.expectedEndsOn ? displayDate(season.expectedEndsOn) : t("seasonsPage.openEnded")}</p>
                  {season.actualEndsOn && <small>{t("seasonsPage.actualEnd")}: {displayDate(season.actualEndsOn)}</small>}
                  {season.notes && <small>{season.notes}</small>}
                  <footer>
                    {season.status !== "archived" && !current && <button type="button" onClick={() => select.mutate(season.id)}><CheckCircle2 size={15} />{t("seasonsPage.setActive")}</button>}
                    {canManage && <button type="button" onClick={() => edit(season)}><Pencil size={15} />{t("seasonsPage.edit")}</button>}
                    {canManage && season.status !== "archived" && <button className="danger-button" type="button" onClick={() => archive.mutate(season.id)}><XCircle size={15} />{t("seasonsPage.archive")}</button>}
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
