import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../auth/AuthProvider";
import { canEdit } from "../../lib/permissions";
import {
  buildDispatchAvailability,
  type DispatchWithMarketReturns,
} from "../../lib/dispatch-sales";
import {
  offlineDb,
  workspaceConfigRecords,
  workspaceRecords,
  type Dispatch,
} from "../../lib/offline-db";
import { persistOperationalRecord } from "../../services/syncService";
import { ModulePage } from "../ModulePage";
import "./RecordCardHierarchy.css";
import "./SalesDispatchReturn.css";

function SalesDispatchReturnEnhancement() {
  const { t } = useTranslation();
  const { user, sessionRefreshing } = useAuth();
  const workspaceId = user?.workspaceId ?? "";
  const canReturnDispatch = Boolean(
    !sessionRefreshing && user && workspaceId && canEdit(user, "dispatch", workspaceId),
  );

  useEffect(() => {
    if (!canReturnDispatch) return;

    let cancelled = false;
    let decorating = false;

    const decorate = async () => {
      if (decorating || cancelled) return;
      const list = document.querySelector<HTMLElement>(".sales-availability-list");
      if (!list) return;
      decorating = true;

      try {
        const [dispatches, sales, vehicles, dateTypes] = await Promise.all([
          workspaceRecords(offlineDb.dispatches),
          workspaceRecords(offlineDb.sales),
          workspaceRecords(offlineDb.vehicles),
          workspaceConfigRecords(offlineDb.dateTypes),
        ]);
        if (cancelled) return;

        const availability = buildDispatchAvailability(
          dispatches,
          sales,
          dateTypes,
          (dispatch) =>
            vehicles.find((vehicle) => vehicle.id === dispatch.vehicleId)?.number
            ?? dispatch.vehicleNumber
            ?? t("modulePageExtra.unknownVehicleFallback", { defaultValue: "Unknown vehicle" }),
        ).filter((item) => item.remainingCartons > 0);

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

          button.textContent = t("salesPage.returnToFarm", { defaultValue: "Return to farm" });
          button.disabled = false;
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
              window.dispatchEvent(new Event("muzare-data-refresh"));
              window.dispatchEvent(new CustomEvent("muzare-toast", {
                detail: t("salesPage.returnToFarmSuccess", {
                  defaultValue: "{{count}} cartons returned to the farm.",
                  count: match.remainingCartons,
                }),
              }));
            } catch (error) {
              button!.disabled = false;
              button!.textContent = t("salesPage.returnToFarm", { defaultValue: "Return to farm" });
              window.dispatchEvent(new CustomEvent("muzare-toast", {
                detail: error instanceof Error
                  ? error.message
                  : t("salesPage.returnToFarmFailed", { defaultValue: "Unable to return cartons. Please try again." }),
              }));
            }
          };
        });
      } finally {
        decorating = false;
      }
    };

    const observer = new MutationObserver(() => void decorate());
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("muzare-data-refresh", decorate);
    window.addEventListener("muzare-local-data-change", decorate);
    void decorate();

    return () => {
      cancelled = true;
      observer.disconnect();
      window.removeEventListener("muzare-data-refresh", decorate);
      window.removeEventListener("muzare-local-data-change", decorate);
    };
  }, [canReturnDispatch, t]);

  return null;
}

export function Sales() {
  return (
    <>
      <ModulePage module="sales" />
      <SalesDispatchReturnEnhancement />
    </>
  );
}
