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
  dispatches: number;
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
  previousStyle: string | null;
};

const emptyMetrics: DailyDashboardMetrics = {
  ready: false,
  salesAmount: 0,
  dispatches: 0,
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
        dispatches: activeDispatches.length,
        cartons: activeDispatches.reduce(
          (sum, dispatch) => sum + (dispatch.items?.reduce((itemSum, item) => itemSum + Number(item.cartons || 0), 0) ?? Number(dispatch.cartons || 0)),
          0,
        ),
      });
    } catch (error) {
      console.error("Dashboard daily sales and dispatch metrics failed to load", error);
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

    const hide = (element: HTMLElement | null) => {
      if (!element) return;
      hidden.push({ element, previousStyle: element.getAttribute("style") });
      element.style.setProperty("display", "none", "important");
    };

    const install = () => {
      if (installedMounts) return true;
      const grid = document.querySelector<HTMLElement>(".dashboard-kpi-grid");
      const heroStats = document.querySelector<HTMLElement>(".dashboard-hero-card__stats");
      const quickGrid = document.querySelector<HTMLElement>(".dashboard-quick-grid");
      if (!grid || !heroStats || !quickGrid) return false;

      const labourDueCard = grid.querySelector<HTMLElement>('.dashboard-kpi-card--amber');
      const labourAdvanceCard = grid.querySelector<HTMLElement>('a[href="/workspace/labour-payments/advances"]');
      const originalDispatchCard = grid.querySelector<HTMLElement>('a[href="/workspace/dispatch"]');
      const heroDispatch = Array.from(heroStats.children).filter((node): node is HTMLElement => node instanceof HTMLElement)[1];
      const reportsQuickAction = quickGrid.querySelector<HTMLElement>('a[href="/workspace/reports"]');
      if (!labourDueCard || !originalDispatchCard || !heroDispatch || !reportsQuickAction) return false;

      const salesCard = makePortalMount("sales-card");
      const dispatchCard = makePortalMount("dispatch-card");
      const replacementHeroDispatch = makePortalMount("hero-dispatch");
      const salesQuickAction = makePortalMount("sales-quick-action");

      grid.insertBefore(salesCard, labourDueCard);
      grid.insertBefore(dispatchCard, originalDispatchCard);
      heroStats.insertBefore(replacementHeroDispatch, heroDispatch);
      quickGrid.insertBefore(salesQuickAction, reportsQuickAction);

      hide(labourDueCard);
      hide(labourAdvanceCard);
      hide(originalDispatchCard);
      hide(heroDispatch);
      hide(reportsQuickAction);

      installedMounts = {
        salesCard,
        dispatchCard,
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
      hidden.forEach(({ element, previousStyle }) => {
        if (previousStyle === null) element.removeAttribute("style");
        else element.setAttribute("style", previousStyle);
      });
      if (installedMounts) Object.values(installedMounts).forEach((mount) => mount.remove());
      hidden = [];
      installedMounts = null;
      setMounts(null);
    };
  }, []);

  if (!mounts) return null;
  const salesValue = metrics.ready ? formatMoney(metrics.salesAmount) : "—";
  const vehicleValue = metrics.ready ? String(metrics.dispatches) : "—";
  const cartonValue = metrics.ready ? String(metrics.cartons) : "—";
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
      <Link
        className="dashboard-kpi-card dashboard-kpi-card--blue"
        to="/workspace/dispatch"
        style={{ gridColumn: "1 / -1", minHeight: 142 }}
      >
        <div style={{ alignItems: "center", display: "flex", gap: 10 }}>
          <div className="dashboard-kpi-card__icon"><PackageOpen size={18} /></div>
          <span>{t("dashboard.dispatchesLabel")}</span>
        </div>
        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(2, minmax(0, 1fr))", marginTop: 12 }}>
          <div style={{ borderInlineEnd: "1px solid var(--border)", display: "grid", gap: 4, paddingInlineEnd: 12 }}>
            <strong className="bidi-isolate" style={{ fontSize: "1.55rem" }}>{vehicleValue}</strong>
            <small>{t("reportsPage.vehicle")}</small>
          </div>
          <div style={{ display: "grid", gap: 4, paddingInlineStart: 2 }}>
            <strong className="bidi-isolate" style={{ fontSize: "1.55rem" }}>{cartonValue}</strong>
            <small>{t("harvestPage.colCartons")}</small>
          </div>
        </div>
        <small style={{ marginTop: 10 }}>{todayLabel}</small>
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
