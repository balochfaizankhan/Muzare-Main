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

  return (
    <section className={`record-panel build-diagnostics ${compact ? "build-diagnostics--compact" : ""}`}>
      <h2>Runtime Versions</h2>
      <div className="build-diagnostics__grid">
        <article>
          <span>Frontend commit</span>
          <strong>{__GIT_COMMIT_HASH__}</strong>
        </article>
        <article>
          <span>Frontend version</span>
          <strong>{__APP_VERSION__}</strong>
        </article>
        <article>
          <span>Frontend build</span>
          <strong>{__BUILD_TIME__}</strong>
        </article>
        <article>
          <span>API commit</span>
          <strong>{apiCommit}</strong>
        </article>
        <article>
          <span>API version</span>
          <strong>{apiVersion}</strong>
        </article>
        <article>
          <span>API build</span>
          <strong>{apiBuildTime}</strong>
        </article>
      </div>
      {health.isError ? <p className="error">{health.error.message}</p> : null}
    </section>
  );
}

