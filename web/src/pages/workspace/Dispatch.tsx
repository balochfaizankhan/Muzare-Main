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

const dispatchSerialFor = (dispatch: DispatchRecord) =>
  dispatch.serialNumber?.trim()
  || dispatch.dispatchNumber?.trim()
  || `DIS-${dispatch.date.replaceAll("-", "")}-${dispatch.id.slice(0, 3).toUpperCase()}`;

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
    const detailsLabel = t("common.details", { defaultValue: "Details" });
    const hideDetailsLabel = t("common.hideDetails", { defaultValue: "Hide details" });
    let decorationScheduled = false;
    let balanceRefreshSequence = 0;

    const correctReturnedBalances = async () => {
      const sequence = ++balanceRefreshSequence;
      const [dispatches, sales, vehicles, dateTypes] = await Promise.all([
        workspaceRecords(offlineDb.dispatches),
        workspaceRecords(offlineDb.sales),
        workspaceRecords(offlineDb.vehicles),
        workspaceConfigRecords(offlineDb.dateTypes),
      ]);
      if (sequence !== balanceRefreshSequence) return;

      const availability = buildDispatchAvailability(
        dispatches,
        sales,
        dateTypes,
        (dispatch) => vehicles.find((vehicle) => vehicle.id === dispatch.vehicleId)?.number
          ?? dispatch.vehicleNumber
          ?? t("modulePageExtra.unknownVehicleFallback", { defaultValue: "Unknown vehicle" }),
      );
      const rowsByDispatch = new Map<string, typeof availability>();
      for (const row of availability) rowsByDispatch.set(row.dispatch.id, [...(rowsByDispatch.get(row.dispatch.id) ?? []), row]);

      const totalRemaining = String(availability.reduce((sum, row) => sum + row.remainingCartons, 0));
      const remainingLabel = t("salesPage.remainingCartons");
      mounts.root.querySelectorAll<HTMLElement>(".dispatch-overview-card__metric, .dispatch-kpi-grid > article").forEach((metric) => {
        if (metric.querySelector("span")?.textContent?.trim() !== remainingLabel) return;
        const value = metric.querySelector<HTMLElement>("strong");
        if (value && value.textContent !== totalRemaining) value.textContent = totalRemaining;
      });

      const dispatchBySerial = new Map(dispatches.map((dispatch) => [dispatchSerialFor(dispatch), dispatch]));
      mounts.records.querySelectorAll<HTMLElement>(".dispatch-record-card").forEach((card) => {
        const serial = card.querySelector<HTMLElement>("header strong")?.textContent?.trim() ?? "";
        const dispatch = dispatchBySerial.get(serial);
        if (!dispatch) return;
        const rows = rowsByDispatch.get(dispatch.id) ?? [];
        const sold = rows.reduce((sum, row) => sum + row.soldCartons, 0);
        const remaining = rows.reduce((sum, row) => sum + row.remainingCartons, 0);
        const linkedSales = sales.filter((sale) => !sale.deletedAt && sale.dispatchId === dispatch.id).length;
        const signature = rows.map((row) => `${row.itemId}:${row.soldCartons}:${row.returnedCartons}:${row.remainingCartons}`).join("|");
        if (card.dataset.returnBalanceSignature === signature) return;
        card.dataset.returnBalanceSignature = signature;

        const summary = card.querySelector<HTMLElement>(".dispatch-linked-summary");
        const nextSummary = `${t("salesPage.soldCartons")} ${sold} | ${remainingLabel} ${remaining} | ${t("dispatchPage.linkedSales")} ${linkedSales}`;
        if (summary && summary.textContent !== nextSummary) summary.textContent = nextSummary;

        Array.from(card.querySelectorAll<HTMLElement>(".dispatch-breakdown > span")).forEach((element, index) => {
          const row = rows[index];
          if (!row) return;
          const nextText = `${row.dateTypeName}: ${row.dispatchedCartons} | ${t("salesPage.soldCartons")} ${row.soldCartons} | ${remainingLabel} ${row.remainingCartons}`;
          if (element.textContent !== nextText) element.textContent = nextText;
        });
      });
    };

    const decorateCards = () => {
      decorationScheduled = false;
      const cards = Array.from(mounts.records.querySelectorAll<HTMLElement>(".dispatch-record-card"));
      setRecordCount(cards.length);
      cards.forEach((card) => {
        if (card.dataset.compactEnhanced === "true") return;
        const header = card.querySelector<HTMLElement>("header");
        const breakdown = card.querySelector<HTMLElement>(".dispatch-breakdown");
        const footer = card.querySelector<HTMLElement>("footer");
        if (!header || !breakdown || !footer) return;
        card.dataset.compactEnhanced = "true";

        const primaryItems = document.createElement("div");
        primaryItems.className = "dispatch-record-card__primary-items";
        primaryItems.setAttribute("aria-label", t("modulePageExtra.dispatchTypesAndCartons", { defaultValue: "Dispatch types and cartons" }));
        Array.from(breakdown.children).forEach((row) => {
          const cartonText = row.querySelector<HTMLElement>(".bidi-isolate")?.textContent?.trim() ?? "";
          const cartonCount = Number(cartonText);
          const leadingText = Array.from(row.childNodes).find((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())?.textContent ?? "";
          const typeName = leadingText.replace(/\s*[:：]\s*$/u, "").trim();
          if (!typeName || !Number.isFinite(cartonCount)) return;
          const item = document.createElement("div");
          item.className = "dispatch-record-card__primary-item";
          const name = document.createElement("strong");
          name.textContent = typeName;
          const quantity = document.createElement("span");
          quantity.className = "bidi-isolate";
          quantity.textContent = t("dashboardPage.cartonsCount", { count: cartonCount });
          item.append(name, quantity);
          primaryItems.append(item);
        });
        if (primaryItems.childElementCount > 0) header.after(primaryItems);

        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "dispatch-record-card__details-toggle";
        toggle.textContent = detailsLabel;
        toggle.setAttribute("aria-expanded", "false");
        toggle.addEventListener("click", (event) => {
          event.stopPropagation();
          const expanded = card.classList.toggle("is-expanded");
          toggle.textContent = expanded ? hideDetailsLabel : detailsLabel;
          toggle.setAttribute("aria-expanded", String(expanded));
        });
        footer.before(toggle);
      });
      void correctReturnedBalances();
    };

    const scheduleDecoration = () => {
      if (decorationScheduled) return;
      decorationScheduled = true;
      requestAnimationFrame(decorateCards);
    };
    const recordsObserver = new MutationObserver(scheduleDecoration);
    recordsObserver.observe(mounts.records, { childList: true, subtree: true });
    scheduleDecoration();

    const refreshBalances = () => void correctReturnedBalances();
    window.addEventListener("muzare-data-refresh", refreshBalances);
    window.addEventListener("muzare-local-data-change", refreshBalances);

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
      balanceRefreshSequence += 1;
      recordsObserver.disconnect();
      window.removeEventListener("muzare-data-refresh", refreshBalances);
      window.removeEventListener("muzare-local-data-change", refreshBalances);
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
