import { ClipboardList, Plus } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { ModulePage } from "../ModulePage";
import "./DispatchCompact.css";

type DispatchTab = "entry" | "records";

type DispatchWorkspaceMounts = {
  root: HTMLElement;
  tabs: HTMLElement;
  form: HTMLElement;
  records: HTMLElement;
};

function DispatchWorkspaceEnhancements() {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<DispatchTab>("entry");
  const [recordCount, setRecordCount] = useState(0);
  const [mounts, setMounts] = useState<DispatchWorkspaceMounts | null>(null);

  useLayoutEffect(() => {
    let pageObserver: MutationObserver | null = null;
    let installed: DispatchWorkspaceMounts | null = null;

    const install = () => {
      if (installed) return true;

      const overview = document.querySelector<HTMLElement>(".dispatch-overview-card");
      const form = document.querySelector<HTMLElement>(".dispatch-form-card");
      const records = document.querySelector<HTMLElement>(".dispatch-records-panel");
      const root = overview?.parentElement;
      if (!overview || !form || !records || !root || form.parentElement !== root || records.parentElement !== root) return false;

      const tabs = document.createElement("div");
      tabs.className = "dispatch-compact-tabs-mount";
      tabs.setAttribute("aria-label", t("modulePageExtra.dispatchWorkspaceNavigation", { defaultValue: "Dispatch workspace navigation" }));
      root.insertBefore(tabs, form);
      root.classList.add("dispatch-compact-workspace");
      root.dataset.dispatchTab = "entry";

      installed = { root, tabs, form, records };
      setMounts(installed);
      pageObserver?.disconnect();
      return true;
    };

    if (!install()) {
      pageObserver = new MutationObserver(() => install());
      pageObserver.observe(document.body, { childList: true, subtree: true });
    }

    return () => {
      pageObserver?.disconnect();
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
    if (!mounts) return;
    mounts.root.dataset.dispatchTab = activeTab;
  }, [activeTab, mounts]);

  useEffect(() => {
    if (!mounts) return;

    const detailsLabel = t("common.details", { defaultValue: "Details" });
    const hideDetailsLabel = t("common.hideDetails", { defaultValue: "Hide details" });

    const decorateCards = () => {
      const cards = Array.from(mounts.records.querySelectorAll<HTMLElement>(".dispatch-record-card"));
      setRecordCount(cards.length);

      cards.forEach((card) => {
        if (card.dataset.compactEnhanced === "true") return;
        const breakdown = card.querySelector<HTMLElement>(".dispatch-breakdown");
        const footer = card.querySelector<HTMLElement>("footer");
        if (!breakdown || !footer) return;

        card.dataset.compactEnhanced = "true";
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
    };

    const recordsObserver = new MutationObserver(decorateCards);
    recordsObserver.observe(mounts.records, { childList: true, subtree: true });
    decorateCards();

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
      recordsObserver.disconnect();
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
      <button
        type="button"
        role="tab"
        aria-selected={activeTab === "entry"}
        className={activeTab === "entry" ? "is-active" : undefined}
        onClick={changeTab("entry")}
      >
        <Plus size={17} />
        <span>{t("dispatchPage.createNewDispatch")}</span>
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={activeTab === "records"}
        className={activeTab === "records" ? "is-active" : undefined}
        onClick={changeTab("records")}
      >
        <ClipboardList size={17} />
        <span>{t("dispatchPage.dispatchRecords")}</span>
        {recordCount > 0 && <small className="bidi-isolate">{recordCount}</small>}
      </button>
    </div>,
    mounts.tabs,
  );
}

export function Dispatch() {
  return <>
    <ModulePage module="dispatch" />
    <DispatchWorkspaceEnhancements />
  </>;
}
