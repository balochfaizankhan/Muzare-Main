import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../auth/AuthProvider";
import { ensureSalesEntryData, invalidateEntryData } from "../../lib/entryDataQueries";
import { markEntryPerformance, measureEntryPerformance, waitForElement } from "../../lib/entryPerformance";
import { canEdit } from "../../lib/permissions";
import {
  buildDispatchAvailability,
  type DispatchAvailabilityItem,
  type DispatchWithMarketReturns,
} from "../../lib/dispatch-sales";
import { offlineDb, type Dispatch } from "../../lib/offline-db";
import { persistOperationalRecord } from "../../services/syncService";
import { ModulePage } from "../ModulePage";
import "./RecordCardHierarchy.css";
import "./SalesDispatchReturn.css";

type AvailabilityLoader = () => Promise<DispatchAvailabilityItem[]>;

function SalesDispatchSelectionHandoff() {
  useEffect(() => {
    let cancelled = false;
    let activeList: HTMLElement | null = null;

    const bringSaleEntryIntoView = async () => {
      // Give the existing dispatch-selection handler time to populate the form.
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (cancelled) return;

      const form = await waitForElement<HTMLElement>(".sales-form", { maxFrames: 90 });
      if (cancelled || !form) return;

      const editableNumbers = Array.from(form.querySelectorAll<HTMLInputElement>('input[type="number"]:not([readonly]):not([disabled])'));
      const cartonsField = editableNumbers[0] ?? null;
      const target = cartonsField?.closest<HTMLElement>("label") ?? cartonsField ?? form;
      target.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });

      if (cartonsField) {
        window.setTimeout(() => {
          if (cancelled) return;
          cartonsField.focus({ preventScroll: true });
          cartonsField.select();
        }, 260);
      }
    };

    const handleSelection = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const button = target.closest<HTMLButtonElement>("button");
      if (!button || !activeList?.contains(button)) return;
      if (button.classList.contains("sales-dispatch-return-action")) return;
      void bringSaleEntryIntoView();
    };

    void waitForElement<HTMLElement>(".sales-availability-list", { maxFrames: 180 }).then((list) => {
      if (cancelled || !list) return;
      activeList = list;
      list.addEventListener("click", handleSelection);
    });

    return () => {
      cancelled = true;
      activeList?.removeEventListener("click", handleSelection);
    };
  }, []);

  return null;
}

function SalesDispatchReturnEnhancement() {
  const { t } = useTranslation();
  const { user, sessionRefreshing } = useAuth();
  const workspaceId = user?.workspaceId ?? "";
  const canReturnDispatch = Boolean(
    !sessionRefreshing && user && workspaceId && canEdit(user, "dispatch", workspaceId),
  );

  useEffect(() => {
    markEntryPerformance("sales-navigation-start");
  }, []);

  useEffect(() => {
    if (!canReturnDispatch) return;

    let cancelled = false;
    let listObserver: MutationObserver | null = null;
    let decorating = false;
    let decorationQueued = false;
    let availabilityPromise: Promise<DispatchAvailabilityItem[]> | null = null;

    const loadAvailability: AvailabilityLoader = () => {
      availabilityPromise ??= ensureSalesEntryData().then(({ dispatches, sales, vehicles, dateTypes }) => buildDispatchAvailability(
        dispatches,
        sales,
        dateTypes,
        (dispatch) =>
          vehicles.find((vehicle) => vehicle.id === dispatch.vehicleId)?.number
          ?? dispatch.vehicleNumber
          ?? t("modulePageExtra.unknownVehicleFallback", { defaultValue: "Unknown vehicle" }),
      ).filter((item) => item.remainingCartons > 0));
      return availabilityPromise;
    };

    const decorate = async (list: HTMLElement) => {
      if (decorating || cancelled) return;
      decorating = true;

      try {
        const availability = await loadAvailability();
        if (cancelled) return;

        const usedKeys = new Set<string>();
        const cards = Array.from(list.querySelectorAll<HTMLElement>(":scope > article"));

        cards.forEach((card) => {
          const date = card.querySelector<HTMLElement>("header strong")?.textContent?.trim() ?? "";
          const typeName = card.querySelector<HTMLElement>("header h3")?.textContent?.trim() ?? "";
          const vehicle = card.querySelector<HTMLElement>("header p")?.textContent?.trim() ?? "";
          const match = availability.find((item) => {
            const key = `${item.dispatch.id}:${item.itemId}`;
            return !usedKeys.has(key)
              && item.dispatch.date === date
              && item.dateTypeName === typeName
              && item.vehicleLabel === vehicle;
          });
          if (!match) return;

          const matchKey = `${match.dispatch.id}:${match.itemId}`;
          usedKeys.add(matchKey);
          card.dataset.dispatchReturnKey = matchKey;

          const footer = card.querySelector<HTMLElement>("footer");
          if (!footer) return;

          let button = footer.querySelector<HTMLButtonElement>(".sales-dispatch-return-action");
          if (!button) {
            button = document.createElement("button");
            button.type = "button";
            button.className = "sales-dispatch-return-action";
            footer.append(button);
          }

          const returnLabel = t("salesPage.returnToFarm", { defaultValue: "Return to farm" });
          if (button.textContent !== returnLabel && !button.disabled) button.textContent = returnLabel;
          if (!button.dataset.returnBound) {
            button.dataset.returnBound = "true";
            button.onclick = async (event) => {
              event.stopPropagation();
              const confirmed = window.confirm(
                t("salesPage.returnToFarmConfirm", {
                  defaultValue: "Return {{count}} unsold cartons of {{type}} to the farm? This dispatch item will close and disappear from sale availability.",
                  count: match.remainingCartons,
                  type: match.dateTypeName,
                }),
              );
              if (!confirmed) return;

              button!.disabled = true;
              button!.textContent = t("common.saving", { defaultValue: "Saving…" });
              try {
                const latest = await offlineDb.dispatches.get(match.dispatch.id);
                if (!latest) throw new Error("Dispatch not found");

                const latestWithReturns = latest as DispatchWithMarketReturns;
                const now = new Date().toISOString();
                const updated: DispatchWithMarketReturns = {
                  ...latestWithReturns,
                  updatedAt: now,
                  marketReturns: [
                    ...(latestWithReturns.marketReturns ?? []),
                    {
                      id: crypto.randomUUID(),
                      dispatchItemId: match.itemId,
                      dateTypeId: match.dateTypeId,
                      dateTypeName: match.dateTypeName,
                      cartons: match.remainingCartons,
                      returnedAt: now,
                      note: t("salesPage.unsoldMarketReturn", { defaultValue: "Unsold market return" }),
                    },
                  ],
                };

                await persistOperationalRecord("dispatch", updated as Dispatch);
                availabilityPromise = null;
                await Promise.allSettled([
                  invalidateEntryData("sales"),
                  invalidateEntryData("dispatch"),
                ]);
                window.dispatchEvent(new Event("muzare-data-refresh"));
                window.dispatchEvent(new CustomEvent("muzare-toast", {
                  detail: t("salesPage.returnToFarmSuccess", {
                    defaultValue: "{{count}} cartons returned to the farm.",
                    count: match.remainingCartons,
                  }),
                }));
              } catch (error) {
                button!.disabled = false;
                button!.textContent = returnLabel;
                window.dispatchEvent(new CustomEvent("muzare-toast", {
                  detail: error instanceof Error
                    ? error.message
                    : t("salesPage.returnToFarmFailed", { defaultValue: "Unable to return cartons. Please try again." }),
                }));
              }
            };
          }
        });

        markEntryPerformance("sales-dispatch-selector-ready");
        measureEntryPerformance("sales-navigation-to-selector", "sales-navigation-start", "sales-dispatch-selector-ready");
      } finally {
        decorating = false;
        if (decorationQueued && !cancelled) {
          decorationQueued = false;
          void decorate(list);
        }
      }
    };

    const requestDecoration = (list: HTMLElement) => {
      if (decorating) {
        decorationQueued = true;
        return;
      }
      requestAnimationFrame(() => void decorate(list));
    };

    let activeList: HTMLElement | null = null;
    void waitForElement<HTMLElement>(".sales-availability-list", { maxFrames: 180 }).then((list) => {
      if (cancelled || !list) return;
      activeList = list;
      listObserver = new MutationObserver(() => requestDecoration(list));
      listObserver.observe(list, { childList: true, subtree: true });
      requestDecoration(list);
    });

    const refreshDecoration = () => {
      availabilityPromise = null;
      if (activeList) requestDecoration(activeList);
    };
    window.addEventListener("muzare-data-refresh", refreshDecoration);
    window.addEventListener("muzare-local-data-change", refreshDecoration);

    return () => {
      cancelled = true;
      listObserver?.disconnect();
      window.removeEventListener("muzare-data-refresh", refreshDecoration);
      window.removeEventListener("muzare-local-data-change", refreshDecoration);
    };
  }, [canReturnDispatch, t]);

  return null;
}

export function Sales() {
  return (
    <>
      <ModulePage module="sales" />
      <SalesDispatchSelectionHandoff />
      <SalesDispatchReturnEnhancement />
    </>
  );
}
