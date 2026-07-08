import { ChevronDown, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { formatWorkspaceActivityDateTime, loadWorkspaceActivity, type WorkspaceActivityItem, type WorkspaceActivityModule } from "../../lib/workspaceActivity";

type PeriodFilter = "today" | "last7" | "month" | "custom";

const moduleOrder: WorkspaceActivityModule[] = ["attendance", "labour", "expenses", "dispatch", "sales", "accounts"];
const moduleLabels: Record<WorkspaceActivityModule, string> = {
  attendance: "Attendance",
  labour: "Labour",
  expenses: "Expenses",
  dispatch: "Dispatch",
  sales: "Sales",
  accounts: "Accounts",
};

const todayKey = () => new Date().toISOString().slice(0, 10);

const shiftDateKey = (days: number) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
};

const monthStartKey = () => {
  const date = new Date();
  date.setDate(1);
  return date.toISOString().slice(0, 10);
};

const isWithinRange = (value: string, from: string, to: string) => (!from || value >= from) && (!to || value <= to);

const getPeriodRange = (period: PeriodFilter, from: string, to: string) => {
  switch (period) {
    case "today":
      return { from: todayKey(), to: todayKey() };
    case "last7":
      return { from: shiftDateKey(-6), to: todayKey() };
    case "month":
      return { from: monthStartKey(), to: todayKey() };
    case "custom":
      return { from, to };
    default:
      return { from: "", to: "" };
  }
};

function ActivitySummary({ activity, expandable, expanded }: { activity: WorkspaceActivityItem; expandable?: boolean; expanded?: boolean }) {
  const Icon = activity.icon;
  return (
    <>
      <div className={`dashboard-activity-item__icon dashboard-activity-item__icon--${activity.tone}`}>
        <Icon size={16} />
      </div>
      <div className="dashboard-activity-item__copy">
        <strong>{activity.title}</strong>
        <span>{activity.detail}</span>
      </div>
      <div className="dashboard-activity-item__meta">
        <strong>{activity.value}</strong>
        <small>{formatWorkspaceActivityDateTime(activity.createdAt)}</small>
      </div>
      {expandable ? <ChevronDown size={16} className={`activity-log-item__chevron${expanded ? " is-open" : ""}`} /> : activity.path ? <ChevronRight size={16} className="activity-log-item__chevron" /> : null}
    </>
  );
}

export function ActivityLog() {
  const [activities, setActivities] = useState<WorkspaceActivityItem[]>([]);
  const [period, setPeriod] = useState<PeriodFilter>("last7");
  const [moduleFilter, setModuleFilter] = useState<"all" | WorkspaceActivityModule>("all");
  const [fromDate, setFromDate] = useState(shiftDateKey(-6));
  const [toDate, setToDate] = useState(todayKey());
  const [expandedIds, setExpandedIds] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    setActivities(await loadWorkspaceActivity());
  }, []);

  useEffect(() => {
    void refresh();
    window.addEventListener("muzare-data-refresh", refresh);
    window.addEventListener("muzare-local-data-change", refresh);
    return () => {
      window.removeEventListener("muzare-data-refresh", refresh);
      window.removeEventListener("muzare-local-data-change", refresh);
    };
  }, [refresh]);

  const availableModules = useMemo(
    () => moduleOrder.filter((module) => activities.some((activity) => activity.module === module)),
    [activities],
  );

  const range = useMemo(() => getPeriodRange(period, fromDate, toDate), [period, fromDate, toDate]);

  const filteredActivities = useMemo(
    () => activities.filter((activity) =>
      (moduleFilter === "all" || activity.module === moduleFilter)
      && isWithinRange(activity.activityDate, range.from, range.to)),
    [activities, moduleFilter, range.from, range.to],
  );

  const toggleExpanded = (id: string) => {
    setExpandedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  };

  return (
    <div className="dashboard-page">
      <main className="subpage activity-log-page">
        <section className="activity-log-card">
          <header className="activity-log-header">
            <div>
              <h1>Activity Log</h1>
              <p>All recent workspace activity</p>
            </div>
          </header>

          <div className="activity-log-filters">
            <div className="activity-log-chip-row" role="tablist" aria-label="Activity period">
              {[
                ["today", "Today"],
                ["last7", "Last 7 days"],
                ["month", "This month"],
                ["custom", "Custom"],
              ].map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={period === value ? "is-active" : ""}
                  onClick={() => setPeriod(value as PeriodFilter)}
                >
                  {label}
                </button>
              ))}
            </div>

            {period === "custom" && (
              <div className="activity-log-date-row">
                <label>
                  <span>From</span>
                  <input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} />
                </label>
                <label>
                  <span>To</span>
                  <input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} />
                </label>
              </div>
            )}

            <div className="activity-log-chip-row" role="tablist" aria-label="Activity module">
              <button type="button" className={moduleFilter === "all" ? "is-active" : ""} onClick={() => setModuleFilter("all")}>All</button>
              {availableModules.map((module) => (
                <button
                  key={module}
                  type="button"
                  className={moduleFilter === module ? "is-active" : ""}
                  onClick={() => setModuleFilter(module)}
                >
                  {moduleLabels[module]}
                </button>
              ))}
            </div>
          </div>

          {!filteredActivities.length ? (
            <p className="activity-empty">No activity found for this period.</p>
          ) : (
            <div className="activity-log-list">
              {filteredActivities.map((activity) => {
                const expandable = Boolean(activity.expandable && activity.children?.length);
                const expanded = expandedIds.includes(activity.id);
                const visibleChildren = expanded ? (activity.children ?? []) : (activity.children ?? []).slice(0, 5);
                return (
                  <article
                    className={`activity-log-item-shell${expandable ? " activity-log-item-shell--expandable" : ""}${expanded ? " is-open" : ""}`}
                    key={activity.id}
                  >
                    {expandable ? (
                      <>
                        <button type="button" className="dashboard-activity-item activity-log-item activity-log-item__toggle" onClick={() => toggleExpanded(activity.id)}>
                          <ActivitySummary activity={activity} expandable expanded={expanded} />
                        </button>
                        <div className="activity-log-item__details">
                          <div className="activity-log-item__detail-list">
                            {visibleChildren.map((child) => (
                              <article key={child.id} className="activity-log-item__detail-row">
                                <strong>{child.title}</strong>
                                <span>{child.detail ?? ""}</span>
                                <small>{child.value ?? ""}</small>
                              </article>
                            ))}
                          </div>
                          {!expanded && (activity.children?.length ?? 0) > visibleChildren.length ? <p className="activity-log-item__more">+ {(activity.children?.length ?? 0) - visibleChildren.length} more</p> : null}
                          {activity.path ? <Link className="activity-log-item__open" to={activity.path}>Open {activity.moduleLabel}</Link> : null}
                        </div>
                      </>
                    ) : activity.path ? (
                      <Link to={activity.path} className="dashboard-activity-item activity-log-item">
                        <ActivitySummary activity={activity} />
                      </Link>
                    ) : (
                      <article className="dashboard-activity-item activity-log-item activity-log-item--static">
                        <ActivitySummary activity={activity} />
                      </article>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

export default ActivityLog;
