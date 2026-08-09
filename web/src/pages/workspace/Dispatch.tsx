import { ClipboardList, Plus } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { buildDispatchAvailability } from "../../lib/dispatch-sales";
import { ensureDispatchEntryData } from "../../lib/entryDataQueries";
import { markEntryPerformance, measureEntryPerformance, waitForElement } from "../../lib/entryPerformance";
import { offlineDb, workspaceConfigRecords, workspaceRecords, type Dispatch as DispatchRecord } from "../../lib/offline-db";
import { ModulePage } from "../ModulePage";
import "./DispatchCompact.css";
import "./RecordCardHierarchy.css";
import "./DispatchMobileRecordsCompact.css";
import "./DispatchMasterDialogsMobile.css";

type DispatchTab = "entry" | "records";
type DispatchWorkspaceMounts = { root: HTMLElement; tabs: HTMLElement; form: HTMLElement; records: HTMLElement };
type AvailabilityRow = ReturnType<typeof buildDispatchAvailability>[number];

const dispatchSerialFor = (dispatch: DispatchRecord) =>
  dispatch.serialNumber?.trim()
  || dispatch.dispatchNumber?.trim()
  || `DIS-${dispatch.date.replaceAll("-", "")}-${dispatch.id.slice(0, 3).toUpperCase()}`;

async function loadDispatchCardData() {
  const [dispatches, sales, vehicles, dateTypes] = await Promise.all([
    workspaceRecords(offlineDb.dispatches),
    workspaceRecords(offlineDb.sales),
    workspaceRecords(offlineDb.vehicles),
    workspaceConfigRecords(offlineDb.dateTypes),
  ]);
  const availability = buildDispatchAvailability(
    dispatches,
    sales,
    dateTypes,
    (dispatch) => vehicles.find((vehicle) => vehicle.id === dispatch.vehicleId)?.number ?? dispatch.vehicleNumber ?? "",
  );
  const linkedSalesByDispatch = sales.reduce((map, sale) => {
    if (sale.deletedAt || !sale.dispatchId) return map;
    map.set(sale.dispatchId, (map.get(sale.dispatchId) ?? 0) + 1);
    return map;
  }, new Map<string, number>());
  return { availability, linkedSalesByDispatch };
}

function DispatchWorkspaceEnhancements() {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<DispatchTab>("entry");
  const [recordCount, setRecordCount] = useState(0);
  const [mounts, setMounts] = useState<DispatchWorkspaceMounts | null>(null);

  useEffect(() => {
    markEntryPerformance("dispatch-navigation-start");
    void ensureDispatchEntryData();
  }, []);

  useLayoutEffect(() => {
    let cancelled = false;
    let installed: DispatchWorkspaceMounts | null = null;
    const install = async () => {
      const overview = await waitForElement<HTMLElement>(".dispatch-overview-card", { maxFrames: 180 });
      if (cancelled || !overview?.parentElement) return;
      const root = overview.parentElement;
      const [form, records] = await Promise.all([
        waitForElement<HTMLElement>(".dispatch-form-card", { root, maxFrames: 120 }),
        waitForElement<HTMLElement>(".dispatch-records-panel", { root, maxFrames: 120 }),
      ]);
      if (cancelled || !form || !records || form.parentElement !== root || records.parentElement !== root) return;

      const tabs = document.createElement("div");
      tabs.className = "dispatch-compact-tabs-mount";
      tabs.setAttribute("aria-label", t("modulePageExtra.dispatchWorkspaceNavigation", { defaultValue: "Dispatch workspace navigation" }));
      root.insertBefore(tabs, form);
      root.classList.add("dispatch-compact-workspace");
      root.dataset.dispatchTab = "entry";
      installed = { root, tabs, form, records };
      setMounts(installed);
      markEntryPerformance("dispatch-form-mounted");
      measureEntryPerformance("dispatch-navigation-to-form", "dispatch-navigation-start", "dispatch-form-mounted");
    };

    void install();
    return () => {
      cancelled = true;
      if (installed) {
        installed.root.classList.remove("dispatch-compact-workspace");
        delete installed.root.dataset.dispatchTab;
        installed.tabs.remove();
      }
      installed = null;
      setMounts(null);
    };
  }, [t]);

  useEffect(() => {
    if (mounts) mounts.root.dataset.dispatchTab = activeTab;
  }, [activeTab, mounts]);

  useEffect(() => {
    if (!mounts) return;
    let cancelled = false;
    let renderScheduled = false;
    let refreshSequence = 0;

    const renderCards = async () => {
      renderScheduled = false;
      const sequence = ++refreshSequence;
      const { availability, linkedSalesByDispatch } = await loadDispatchCardData();
      if (cancelled || sequence !== refreshSequence) return;

      const rowsByDispatch = new Map<string, AvailabilityRow[]>();
      for (const row of availability) rowsByDispatch.set(row.dispatch.id, [...(rowsByDispatch.get(row.dispatch.id) ?? []), row]);
      const dispatchBySerial = new Map(availability.map((row) => [dispatchSerialFor(row.dispatch), row.dispatch]));

      const totalRemaining = String(availability.reduce((sum, row) => sum + row.remainingCartons, 0));
      const remainingLabel = t("salesPage.remainingCartons");
      mounts.root.querySelectorAll<HTMLElement>(".dispatch-overview-card__metric, .dispatch-kpi-grid > article").forEach((metric) => {
        if (metric.querySelector("span")?.textContent?.trim() !== remainingLabel) return;
        const value = metric.querySelector<HTMLElement>("strong");
        if (value) value.textContent = totalRemaining;
      });

      const cards = Array.from(mounts.records.querySelectorAll<HTMLElement>(".dispatch-record-card"));
      setRecordCount(cards.length);
      cards.forEach((card) => {
        const serial = card.querySelector<HTMLElement>("header strong")?.textContent?.trim() ?? "";
        const dispatch = dispatchBySerial.get(serial);
        if (!dispatch) return;
        const rows = rowsByDispatch.get(dispatch.id) ?? [];
        if (!rows.length) return;

        const linkedSales = linkedSalesByDispatch.get(dispatch.id) ?? 0;
        const signature = `${rows.map((row) => `${row.itemId}:${row.dispatchedCartons}:${row.soldCartons}:${row.returnedCartons}:${row.remainingCartons}`).join("|")}|sales:${linkedSales}`;
        if (card.dataset.authoritativeSignature === signature && card.dataset.compactEnhanced === "true") return;
        card.dataset.authoritativeSignature = signature;
        card.dataset.compactEnhanced = "true";
        card.querySelectorAll(".dispatch-record-card__primary-items, .dispatch-record-card__detail-panel, .dispatch-record-card__details-toggle").forEach((element) => element.remove());

        const header = card.querySelector<HTMLElement>("header");
        const originalBreakdown = card.querySelector<HTMLElement>(".dispatch-breakdown");
        const summary = card.querySelector<HTMLElement>(".dispatch-linked-summary");
        const footer = card.querySelector<HTMLElement>("footer");
        if (!header || !footer) return;
        if (originalBreakdown) originalBreakdown.hidden = true;

        const primaryItems = document.createElement("div");
        primaryItems.className = "dispatch-record-card__primary-items";
        primaryItems.setAttribute("aria-label", t("modulePageExtra.dispatchTypesAndCartons", { defaultValue: "Dispatch types and cartons" }));
        rows.forEach((row) => {
          const item = document.createElement("div");
          item.className = "dispatch-record-card__primary-item";
          const name = document.createElement("strong");
          name.textContent = row.dateTypeName;
          const quantity = document.createElement("span");
          quantity.className = "bidi-isolate";
          quantity.textContent = t("dashboardPage.cartonsCount", { count: row.dispatchedCartons });
          item.append(name, quantity);
          primaryItems.append(item);
        });
        header.after(primaryItems);

        const detailPanel = document.createElement("div");
        detailPanel.className = "dispatch-record-card__detail-panel";
        detailPanel.hidden = true;
        rows.forEach((row) => {
          const detail = document.createElement("div");
          detail.className = "dispatch-record-card__detail-row";
          const name = document.createElement("strong");
          name.textContent = row.dateTypeName;
          const values = document.createElement("div");
          const dispatchedValue = document.createElement("span");
          dispatchedValue.textContent = `${t("dispatchPage.cartons")} `;
          const dispatchedStrong = document.createElement("b");
          dispatchedStrong.textContent = String(row.dispatchedCartons);
          dispatchedValue.append(dispatchedStrong);
          const soldValue = document.createElement("span");
          soldValue.textContent = `${t("salesPage.soldCartons")} `;
          const soldStrong = document.createElement("b");
          soldStrong.textContent = String(row.soldCartons);
          soldValue.append(soldStrong);
          const remainingValue = document.createElement("span");
          remainingValue.textContent = `${remainingLabel} `;
          const remainingStrong = document.createElement("b");
          remainingStrong.textContent = String(row.remainingCartons);
          remainingValue.append(remainingStrong);
          values.append(dispatchedValue, soldValue, remainingValue);
          if (row.returnedCartons > 0) {
            const returned = document.createElement("span");
            returned.className = "dispatch-record-card__returned";
            returned.textContent = `${t("returnedToFarmReport.title", { defaultValue: "Returned to farm" })} ${row.returnedCartons}`;
            values.append(returned);
          }
          detail.append(name, values);
          detailPanel.append(detail);
        });
        primaryItems.after(detailPanel);

        const sold = rows.reduce((sum, row) => sum + row.soldCartons, 0);
        const remaining = rows.reduce((sum, row) => sum + row.remainingCartons, 0);
        if (summary) summary.textContent = `${t("salesPage.soldCartons")} ${sold} · ${remainingLabel} ${remaining} · ${t("dispatchPage.linkedSales")} ${linkedSales}`;

        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "dispatch-record-card__details-toggle";
        const setExpanded = (expanded: boolean) => {
          card.classList.toggle("is-expanded", expanded);
          detailPanel.hidden = !expanded;
          toggle.textContent = expanded
            ? t("common.hideDetails", { defaultValue: "Hide details" })
            : t("common.details", { defaultValue: "Details" });
          toggle.setAttribute("aria-expanded", String(expanded));
        };
        setExpanded(false);
        toggle.addEventListener("click", (event) => {
          event.stopPropagation();
          setExpanded(!card.classList.contains("is-expanded"));
        });
        footer.before(toggle);
      });
    };

    const scheduleRender = () => {
      if (renderScheduled) return;
      renderScheduled = true;
      requestAnimationFrame(() => void renderCards());
    };
    const recordsObserver = new MutationObserver(scheduleRender);
    recordsObserver.observe(mounts.records, { childList: true, subtree: true });
    scheduleRender();
    window.addEventListener("muzare-data-refresh", scheduleRender);
    window.addEventListener("muzare-local-data-change", scheduleRender);

    const handleRecordAction = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const button = target.closest<HTMLButtonElement>("button");
      if (!button || button.classList.contains("danger-link") || button.classList.contains("dispatch-record-card__details-toggle")) return;
      setActiveTab("entry");
      window.setTimeout(() => mounts.form.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
    };
    mounts.records.addEventListener("click", handleRecordAction);

    return () => {
      cancelled = true;
      refreshSequence += 1;
      recordsObserver.disconnect();
      window.removeEventListener("muzare-data-refresh", scheduleRender);
      window.removeEventListener("muzare-local-data-change", scheduleRender);
      mounts.records.removeEventListener("click", handleRecordAction);
    };
  }, [mounts, t]);

  if (!mounts) return null;
  const changeTab = (tab: DispatchTab) => (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setActiveTab(tab);
    window.setTimeout(() => mounts.tabs.scrollIntoView({ behavior: "smooth", block: "nearest" }), 0);
  };

  return createPortal(
    <div className="dispatch-compact-tabs" role="tablist" aria-label={t("modulePageExtra.dispatchWorkspaceNavigation", { defaultValue: "Dispatch workspace" })}>
      <button type="button" role="tab" aria-selected={activeTab === "entry"} className={activeTab === "entry" ? "is-active" : undefined} onClick={changeTab("entry")}>
        <Plus size={17} /><span>{t("dispatchPage.createNewDispatch")}</span>
      </button>
      <button type="button" role="tab" aria-selected={activeTab === "records"} className={activeTab === "records" ? "is-active" : undefined} onClick={changeTab("records")}>
        <ClipboardList size={17} /><span>{t("dispatchPage.dispatchRecords")}</span>
        {recordCount > 0 && <small className="bidi-isolate">{recordCount}</small>}
      </button>
    </div>,
    mounts.tabs,
  );
}

export function Dispatch() {
  return <><ModulePage module="dispatch" /><DispatchWorkspaceEnhancements /></>;
}
