import { useQuery } from "@tanstack/react-query";
import {
  BanknoteArrowDown,
  BookOpenText,
  CalendarRange,
  Leaf,
  LogOut,
  PackageOpen,
  ShoppingBasket,
  UsersRound,
  Wifi,
  WifiOff,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Brand } from "../components/Brand";
import { LanguageSwitch } from "../components/LanguageSwitch";
import { useAuth } from "../auth/AuthProvider";
import { fetchBootstrap } from "../lib/api";

const modules = [
  { key: "workforce", path: "/workforce", icon: UsersRound },
  { key: "expenses", path: "/expenses", icon: BanknoteArrowDown },
  { key: "sales", path: "/sales", icon: ShoppingBasket },
  { key: "dispatch", path: "/dispatch", icon: PackageOpen },
  { key: "accounts", path: "/accounts", icon: BookOpenText },
  { key: "partnerLedger", path: "/partner-ledger", icon: Leaf },
] as const;

export function DashboardPage() {
  const { t } = useTranslation();
  const { user, token, logout } = useAuth();
  const query = useQuery({
    queryKey: ["bootstrap", user?.id],
    queryFn: () => fetchBootstrap(token!),
    enabled: Boolean(user && token),
    retry: false,
  });

  const farm = query.data?.farms[0];
  const season = farm ? query.data?.seasons.find((item) => item.farmId === farm.id) : query.data?.seasons[0];
  const StatusIcon = query.data ? Wifi : WifiOff;

  return (
    <div className="dashboard-page">
      <header className="toolbar">
        <Brand compact />
        <div className="toolbar__actions">
          <LanguageSwitch />
          <button className="ghost-icon" onClick={() => void logout()} title={t("logout")}>
            <LogOut size={18} />
          </button>
        </div>
      </header>

      <main className="dashboard">
        <section className="selection-row">
          <Link className="selector-card" to="/farms">
            <Leaf size={20} />
            <div>
              <span>{t("currentFarm")}</span>
              <strong>{farm?.name ?? t("noFarm")}</strong>
            </div>
          </Link>
          <Link className="selector-card" to="/seasons">
            <CalendarRange size={20} />
            <div>
              <span>{t("currentSeason")}</span>
              <strong>{season?.name ?? t("noSeason")}</strong>
            </div>
          </Link>
        </section>

        <p className="section-heading">{t("operations")}</p>
        <section className="module-grid" aria-label={t("operations")}>
          {modules.map(({ key, path, icon: Icon }) => (
            <Link className="module-card" key={key} to={path}>
              <Icon size={35} />
              <span>{t(key)}</span>
            </Link>
          ))}
        </section>

        <section className="status-card">
          <StatusIcon size={21} />
          <div>
            <strong>{query.data ? t("connected") : t("offlineReady")}</strong>
            <p>{query.isError ? query.error.message : query.data ? t("connectedReady") : t("connectionPending")}</p>
          </div>
        </section>
      </main>
    </div>
  );
}
