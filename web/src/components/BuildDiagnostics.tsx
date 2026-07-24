import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { fetchHealth } from "../lib/api";
import { formatDate } from "../lib/format";

export function BuildDiagnostics({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  const health = useQuery({
    queryKey: ["health"],
    queryFn: fetchHealth,
    staleTime: 60_000,
  });

  const apiCommit = health.data?.gitCommit ?? t("common.loading");
  const apiVersion = health.data?.appVersion ?? "-";
  const apiBuildTime = health.data?.buildTime ?? "-";
  const frontendVersion = __APP_VERSION__;
  const frontendBuildTime = __BUILD_TIME__;
  const formatBuildTime = (value: string) => {
    if (!value || value === "-") return "-";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return formatDate(date, { dateStyle: "medium", timeStyle: "short" });
  };
  const displayBuildTime = formatBuildTime(apiBuildTime !== "-" ? apiBuildTime : frontendBuildTime);

  return (
    <section className={`record-panel build-diagnostics ${compact ? "build-diagnostics--compact" : ""}`}>
      <div className="build-diagnostics__heading">
        <div>
          <h2>{t("buildDiagnostics.title")}</h2>
          <p>{t("buildDiagnostics.description")}</p>
        </div>
        <span>{apiVersion === frontendVersion ? t("buildDiagnostics.matched") : t("buildDiagnostics.checkBuild")}</span>
      </div>
      <div className="build-diagnostics__grid">
        <article>
          <span>{t("buildDiagnostics.frontendVersion")}</span>
          <strong>{frontendVersion}</strong>
        </article>
        <article>
          <span>{t("buildDiagnostics.apiVersion")}</span>
          <strong>{apiVersion}</strong>
        </article>
        <article>
          <span>{t("buildDiagnostics.lastUpdate")}</span>
          <strong>{displayBuildTime}</strong>
        </article>
      </div>
      <details className="build-diagnostics__details">
        <summary>{t("buildDiagnostics.technicalDetails")}</summary>
        <div className="build-diagnostics__grid build-diagnostics__grid--technical">
          <article>
            <span>{t("buildDiagnostics.frontendCommit")}</span>
            <strong>{__GIT_COMMIT_HASH__}</strong>
          </article>
          <article>
            <span>{t("buildDiagnostics.frontendBuild")}</span>
            <strong>{frontendBuildTime}</strong>
          </article>
          <article>
            <span>{t("buildDiagnostics.apiCommit")}</span>
            <strong>{apiCommit}</strong>
          </article>
          <article>
            <span>{t("buildDiagnostics.apiBuild")}</span>
            <strong>{apiBuildTime}</strong>
          </article>
        </div>
      </details>
      {health.isError ? <p className="error">{health.error.message}</p> : null}
    </section>
  );
}
