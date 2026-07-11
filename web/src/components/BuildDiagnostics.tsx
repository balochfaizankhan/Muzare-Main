import { useQuery } from "@tanstack/react-query";
import { fetchHealth } from "../lib/api";

export function BuildDiagnostics({ compact = false }: { compact?: boolean }) {
  const health = useQuery({
    queryKey: ["health"],
    queryFn: fetchHealth,
    staleTime: 60_000,
  });

  const apiCommit = health.data?.gitCommit ?? "loading";
  const apiVersion = health.data?.appVersion ?? "-";
  const apiBuildTime = health.data?.buildTime ?? "-";
  const frontendVersion = __APP_VERSION__;
  const frontendBuildTime = __BUILD_TIME__;
  const formatBuildTime = (value: string) => {
    if (!value || value === "-") return "-";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    const formatted = new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
    const parts = formatted.split(", ");
    return parts.length >= 3 ? `${parts[0]}, ${parts[1]} · ${parts.slice(2).join(", ")}` : formatted;
  };
  const displayBuildTime = formatBuildTime(apiBuildTime !== "-" ? apiBuildTime : frontendBuildTime);

  return (
    <section className={`record-panel build-diagnostics ${compact ? "build-diagnostics--compact" : ""}`}>
      <div className="build-diagnostics__heading">
        <div>
          <h2>App Version</h2>
          <p>Front-end and API release information.</p>
        </div>
        <span>{apiVersion === frontendVersion ? "Matched" : "Check build"}</span>
      </div>
      <div className="build-diagnostics__grid">
        <article>
          <span>Frontend version</span>
          <strong>{frontendVersion}</strong>
        </article>
        <article>
          <span>API version</span>
          <strong>{apiVersion}</strong>
        </article>
        <article>
          <span>Last update</span>
          <strong>{displayBuildTime}</strong>
        </article>
      </div>
      <details className="build-diagnostics__details">
        <summary>Technical details</summary>
        <div className="build-diagnostics__grid build-diagnostics__grid--technical">
          <article>
            <span>Frontend commit</span>
            <strong>{__GIT_COMMIT_HASH__}</strong>
          </article>
          <article>
            <span>Frontend build</span>
            <strong>{frontendBuildTime}</strong>
          </article>
          <article>
            <span>API commit</span>
            <strong>{apiCommit}</strong>
          </article>
          <article>
            <span>API build</span>
            <strong>{apiBuildTime}</strong>
          </article>
        </div>
      </details>
      {health.isError ? <p className="error">{health.error.message}</p> : null}
    </section>
  );
}
