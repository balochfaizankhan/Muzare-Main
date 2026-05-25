import { useQuery } from "@tanstack/react-query";
import { CalendarRange, Leaf } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../auth/AuthProvider";
import { SubpageHeader } from "../components/SubpageHeader";
import { fetchBootstrap } from "../lib/api";

type ContextKind = "farms" | "seasons";

export function ContextPage({ kind }: { kind: ContextKind }) {
  const { t } = useTranslation();
  const { user, token } = useAuth();
  const query = useQuery({
    queryKey: ["bootstrap", user?.id],
    queryFn: () => fetchBootstrap(token!),
    enabled: Boolean(user && token),
    retry: false,
  });

  const isFarms = kind === "farms";
  const title = t(isFarms ? "farms" : "seasons");
  const Icon = isFarms ? Leaf : CalendarRange;

  return (
    <div className="dashboard-page">
      <SubpageHeader title={title} />
      <main className="subpage">
        <section className="module-hero">
          <Icon size={42} />
          <div>
            <h2>{title}</h2>
            <p>{t(isFarms ? "farmsDescription" : "seasonsDescription")}</p>
          </div>
        </section>
        {query.isLoading && <p className="context-message">{t("loadingData")}</p>}
        {query.isError && <p className="error">{query.error.message}</p>}
        {query.data && (
          <section className="context-list" aria-label={title}>
            {(isFarms ? query.data.farms : query.data.seasons).map((item) => (
              <article className="context-item" key={item.id}>
                <strong>{item.name}</strong>
                {"year" in item ? <span>{item.year}</span> : <span>{item.location ?? t("locationPending")}</span>}
              </article>
            ))}
            {(isFarms ? query.data.farms : query.data.seasons).length === 0 && (
              <p className="context-message">{t(isFarms ? "noFarm" : "noSeason")}</p>
            )}
          </section>
        )}
        <p className="read-only-note">{t("contextReadOnly")}</p>
      </main>
    </div>
  );
}
