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
          <strong>{apiBuildTime || frontendBuildTime}</strong>
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
