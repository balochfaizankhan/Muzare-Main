import { PackageOpen, TrendingUp } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { DashboardPage as DashboardPageBase } from "./DashboardPageBase";
import { formatLocalDateKey } from "../lib/dateOnly";
import { formatMoney } from "../lib/format";
import { offlineDb, workspaceRecords } from "../lib/offline-db";
import { isActiveOperationalRecord } from "../lib/operationalRecords";

type DailyDashboardMetrics = {
  ready: boolean;
  salesAmount: number;
  cartons: number;
};

type DashboardEnhancementMounts = {
  salesCard: HTMLElement;
  dispatchCard: HTMLElement;
  heroDispatch: HTMLElement;
  salesQuickAction: HTMLElement;
};

type HiddenElement = {
  element: HTMLElement;
  previousDisplay: string;
};

const emptyMetrics: DailyDashboardMetrics = {
  ready: false,
  salesAmount: 0,
  cartons: 0,
};

function makePortalMount(name: string) {
  const mount = document.createElement("div");
  mount.dataset.dashboardEnhancement = name;
  mount.style.display = "contents";
  return mount;
}

function DashboardEnhancements() {
  const { t } = useTranslation();
  const [metrics, setMetrics] = useState<DailyDashboardMetrics>(emptyMetrics);
  const [mounts, setMounts] = useState<DashboardEnhancementMounts | null>(null);

  const loadDailyMetrics = useCallback(async () => {
    try {
      const [sales, dispatches] = await Promise.all([
        workspaceRecords(offlineDb.sales),
        workspaceRecords(offlineDb.dispatches),
      ]);
      const date = formatLocalDateKey(new Date());
      const activeSales = sales.filter(isActiveOperationalRecord).filter((sale) => sale.date === date);
      const activeDispatches = dispatches.filter(isActiveOperationalRecord).filter((dispatch) => dispatch.date === date);
      setMetrics({
        ready: true,
        salesAmount: activeSales.reduce((sum, sale) => sum + Number(sale.amount || 0), 0),
        cartons: activeDispatches.reduce(
          (sum, dispatch) => sum + (dispatch.items?.reduce((itemSum, item) => itemSum + Number(item.cartons || 0), 0) ?? Number(dispatch.cartons || 0)),
          0,
        ),
      });
    } catch (error) {
      console.error("Dashboard daily sales and carton metrics failed to load", error);
      setMetrics(emptyMetrics);
    }
  }, []);

  useEffect(() => {
    void loadDailyMetrics();
    const refresh = () => void loadDailyMetrics();
    window.addEventListener("muzare-data-refresh", refresh);
    window.addEventListener("muzare-local-data-change", refresh);
    return () => {
      window.removeEventListener("muzare-data-refresh", refresh);
      window.removeEventListener("muzare-local-data-change", refresh);
    };
  }, [loadDailyMetrics]);

  useLayoutEffect(() => {
    let observer: MutationObserver | null = null;
    let hidden: HiddenElement[] = [];
    let installedMounts: DashboardEnhancementMounts | null = null;

    const hide = (element: HTMLElement) => {
      hidden.push({ element, previousDisplay: element.style.display });
      element.style.display = "none";
    };

    const install = () => {
      if (installedMounts) return true;
      const grid = document.querySelector<HTMLElement>(".dashboard-kpi-grid");
      const heroStats = document.querySelector<HTMLElement>(".dashboard-hero-card__stats");
      const quickGrid = document.querySelector<HTMLElement>(".dashboard-quick-grid");
      if (!grid || !heroStats || !quickGrid) return false;

      const originalCards = Array.from(grid.children).filter((node): node is HTMLElement => node instanceof HTMLElement && !node.dataset.dashboardEnhancement);
      const labourDueCard = originalCards[0];
      const dispatchCard = originalCards.find((node) => node.matches('a[href="/workspace/dispatch"]')) ?? originalCards[3];
      const heroDispatch = Array.from(heroStats.children).filter((node): node is HTMLElement => node instanceof HTMLElement)[1];
      const reportsQuickAction = quickGrid.querySelector<HTMLElement>('a[href="/workspace/reports"]');
      if (!labourDueCard || !dispatchCard || !heroDispatch || !reportsQuickAction) return false;

      const salesCard = makePortalMount("sales-card");
      const replacementDispatchCard = makePortalMount("dispatch-card");
      const replacementHeroDispatch = makePortalMount("hero-dispatch");
      const salesQuickAction = makePortalMount("sales-quick-action");

      grid.insertBefore(salesCard, labourDueCard);
      grid.insertBefore(replacementDispatchCard, dispatchCard);
      heroStats.insertBefore(replacementHeroDispatch, heroDispatch);
      quickGrid.insertBefore(salesQuickAction, reportsQuickAction);

      hide(labourDueCard);
      hide(dispatchCard);
      hide(heroDispatch);
      hide(reportsQuickAction);

      installedMounts = {
        salesCard,
        dispatchCard: replacementDispatchCard,
        heroDispatch: replacementHeroDispatch,
        salesQuickAction,
      };
      setMounts(installedMounts);
      observer?.disconnect();
      return true;
    };

    if (!install()) {
      observer = new MutationObserver(() => install());
      observer.observe(document.body, { childList: true, subtree: true });
    }

    return () => {
      observer?.disconnect();
      hidden.forEach(({ element, previousDisplay }) => {
        element.style.display = previousDisplay;
      });
      if (installedMounts) Object.values(installedMounts).forEach((mount) => mount.remove());
      hidden = [];
      installedMounts = null;
      setMounts(null);
    };
  }, []);

  if (!mounts) return null;
  const salesValue = metrics.ready ? formatMoney(metrics.salesAmount) : "—";
  const cartonsValue = metrics.ready ? String(metrics.cartons) : "—";
  const todayLabel = t("common.today");

  return <>
    {createPortal(
      <Link className="dashboard-kpi-card dashboard-kpi-card--green" to="/workspace/sales">
        <div className="dashboard-kpi-card__icon"><TrendingUp size={18} /></div>
        <span>{t("layout.sales")}</span>
        <strong className="bidi-isolate">{salesValue}</strong>
        <small>{todayLabel}</small>
      </Link>,
      mounts.salesCard,
    )}
    {createPortal(
      <Link className="dashboard-kpi-card dashboard-kpi-card--blue" to="/workspace/dispatch">
        <div className="dashboard-kpi-card__icon"><PackageOpen size={18} /></div>
        <span>{t("dashboard.dispatchesLabel")}</span>
        <strong className="bidi-isolate">{cartonsValue}</strong>
        <small>{todayLabel}</small>
      </Link>,
      mounts.dispatchCard,
    )}
    {createPortal(
      <article className="dashboard-hero-card__stat">
        <PackageOpen size={18} />
        <div>
          <span>{t("dashboard.dispatchesLabel")}</span>
          <strong>{metrics.ready ? t("dashboardPage.cartonsTodayCount", { count: metrics.cartons }) : "--"}</strong>
        </div>
      </article>,
      mounts.heroDispatch,
    )}
    {createPortal(
      <Link to="/workspace/sales" className="dashboard-quick-card">
        <TrendingUp size={18} />
        <strong>{t("layout.sales")}</strong>
      </Link>,
      mounts.salesQuickAction,
    )}
  </>;
}

export function DashboardPage() {
  return <>
    <DashboardPageBase />
    <DashboardEnhancements />
  </>;
}
