import { Boxes, ChevronRight, Gauge, Sprout, Trophy } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { formatDate, formatNumber } from "../lib/format";
import { offlineDb, workspaceRecords, type HarvestEntry, type HarvestGroup } from "../lib/offline-db";
import { buildGroupLeaderboard, buildHarvestSummary, sortLeaderboard } from "../lib/harvestPerformance";
import { hasModulePermission } from "../lib/permissions";
import { scheduleBackgroundTask } from "../lib/startupPerf";

const cartons = (value: number) => formatNumber(value, { maximumFractionDigits: 0 });
const ratio = (value: number) => formatNumber(value, { maximumFractionDigits: 1 });
const todayKey = () => new Date().toISOString().slice(0, 10);

// Self-contained dashboard section. Loads its own harvest data in the background so it
// never blocks the main dashboard render, and hides itself entirely when the module has
// not been adopted (no groups and no entries) to avoid cluttering existing workspaces.
export function HarvestDashboardSection() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [groups, setGroups] = useState<HarvestGroup[]>([]);
  const [entries, setEntries] = useState<HarvestEntry[]>([]);
  const [ready, setReady] = useState(false);

  const refresh = useCallback(async () => {
    const [nextGroups, nextEntries] = await Promise.all([
      workspaceRecords(offlineDb.harvestGroups),
      workspaceRecords(offlineDb.harvestEntries),
    ]);
    setGroups(nextGroups);
    setEntries([...nextEntries].sort((left, right) => right.date.localeCompare(left.date) || right.createdAt.localeCompare(left.createdAt)));
    setReady(true);
  }, []);

  useEffect(() => {
    void scheduleBackgroundTask(() => refresh());
    const handle = () => void refresh();
    window.addEventListener("muzare-data-refresh", handle);
    window.addEventListener("muzare-local-data-change", handle);
    return () => {
      window.removeEventListener("muzare-data-refresh", handle);
      window.removeEventListener("muzare-local-data-change", handle);
    };
  }, [refresh]);

  const summary = useMemo(() => buildHarvestSummary(groups, entries, { todayKey: todayKey() }), [groups, entries]);
  const topGroups = useMemo(
    () => sortLeaderboard(buildGroupLeaderboard(groups, entries).filter((row) => row.entriesCount > 0), "cartonsPerPerson", "desc").slice(0, 5),
    [groups, entries],
  );
  const recent = useMemo(() => entries.slice(0, 5), [entries]);
  const groupNameById = useMemo(() => new Map(groups.map((group) => [group.id, group.name])), [groups]);

  if (user && !hasModulePermission(user, "harvest", "view")) return null;
  // Not adopted yet — keep the dashboard clean.
  if (ready && groups.length === 0 && entries.length === 0) return null;

  return (
    <section className="dashboard-quick-section">
      <div className="dashboard-section-heading dashboard-section-heading--split">
        <div>
          <h2>{t("harvestPage.title")}</h2>
          <p>{t("harvestPage.description")}</p>
        </div>
        <Link className="dashboard-section-link" to="/workspace/harvest/dashboard"><span>{t("dashboardPage.viewAll")}</span><ChevronRight size={14} /></Link>
      </div>
      <div className="dashboard-kpi-grid harvest-kpi-grid">
        <div className="dashboard-kpi-card dashboard-kpi-card--green">
          <div className="dashboard-kpi-card__header"><span className="dashboard-kpi-card__icon"><Boxes size={18} /></span></div>
          <span>{t("harvestPage.todaysCartons")}</span>
          <strong className="bidi-isolate">{ready ? cartons(summary.todayTotalCartons) : "—"}</strong>
          <small>{t("harvestPage.kpiTotalCartons")}: <span className="bidi-isolate">{ready ? cartons(summary.totalCartons) : "—"}</span></small>
        </div>
        <div className="dashboard-kpi-card dashboard-kpi-card--amber">
          <div className="dashboard-kpi-card__header"><span className="dashboard-kpi-card__icon"><Gauge size={18} /></span></div>
          <span>{t("harvestPage.kpiAvgPerPerson")}</span>
          <strong className="bidi-isolate">{ready ? ratio(summary.averageCartonsPerPerson) : "—"}</strong>
          <small>{t("harvestPage.kpiAvgDetail")}</small>
        </div>
        <div className="dashboard-kpi-card dashboard-kpi-card--purple">
          <div className="dashboard-kpi-card__header"><span className="dashboard-kpi-card__icon"><Trophy size={18} /></span></div>
          <span>{t("harvestPage.kpiBestGroup")}</span>
          <strong>{ready ? (summary.bestGroup?.groupName ?? "—") : "—"}</strong>
          <small>{summary.bestGroup ? t("harvestPage.kpiBestDetail", { value: ratio(summary.bestGroup.cartonsPerPerson) }) : t("harvestPage.kpiActiveGroups")}</small>
        </div>
      </div>
      <div className="dashboard-home__grid harvest-dashboard-section__grid">
        <section className="dashboard-activity-card">
          <div className="dashboard-section-heading dashboard-section-heading--split">
            <div><h2>{t("harvestPage.topGroups")}</h2></div>
            <Link className="dashboard-section-link" to="/workspace/harvest/dashboard"><Sprout size={14} /></Link>
          </div>
          {topGroups.length ? (
            <div className="dashboard-activity-list">
              {topGroups.map((row, index) => (
                <div className="dashboard-activity-item" key={row.groupId}>
                  <div className="dashboard-activity-item__icon dashboard-activity-item__icon--emerald">{index + 1}</div>
                  <div className="dashboard-activity-item__copy">
                    <strong>{row.groupName || t("harvestPage.unknownGroup")}</strong>
                    <span>{t("harvestPage.entriesRecorded", { count: row.entriesCount })}</span>
                  </div>
                  <div className="dashboard-activity-item__meta">
                    <strong className="bidi-isolate">{ratio(row.cartonsPerPerson)}</strong>
                    <small>{t("harvestPage.perPersonShort")}</small>
                  </div>
                </div>
              ))}
            </div>
          ) : <p className="activity-empty">{t("harvestPage.noLeaderboardData")}</p>}
        </section>
        <section className="dashboard-activity-card">
          <div className="dashboard-section-heading dashboard-section-heading--split">
            <div><h2>{t("harvestPage.recentEntriesHeading")}</h2></div>
            <Link className="dashboard-section-link" to="/workspace/harvest/entry"><ChevronRight size={14} /></Link>
          </div>
          {recent.length ? (
            <div className="dashboard-activity-list">
              {recent.map((entry) => (
                <div className="dashboard-activity-item" key={entry.id}>
                  <div className="dashboard-activity-item__icon dashboard-activity-item__icon--emerald"><Boxes size={16} /></div>
                  <div className="dashboard-activity-item__copy">
                    <strong>{groupNameById.get(entry.harvestGroupId) ?? entry.harvestGroupName ?? t("harvestPage.unknownGroup")}</strong>
                    <span className="bidi-isolate">{formatDate(entry.date, { dateStyle: "medium" })}</span>
                  </div>
                  <div className="dashboard-activity-item__meta">
                    <strong className="bidi-isolate">{cartons(entry.cartonsHarvested)}</strong>
                    <small>{t("harvestPage.cartonsShort")}</small>
                  </div>
                </div>
              ))}
            </div>
          ) : <p className="activity-empty">{t("harvestPage.noEntriesYet")}</p>}
        </section>
      </div>
    </section>
  );
}
