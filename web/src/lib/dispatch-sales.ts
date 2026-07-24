import i18n from "../i18n";
import type { DateType, Dispatch, Sale } from "./offline-db";
import { isActiveOperationalRecord } from "./operationalRecords";

export type DispatchAvailability = {
  dispatch: Dispatch;
  itemId: string;
  dateTypeId: string;
  dateTypeName: string;
  vehicleLabel: string;
  dispatchedCartons: number;
  soldCartons: number;
  remainingCartons: number;
  searchText: string;
};

export const dispatchItemKey = (dispatchId?: string, dispatchItemId?: string) =>
  dispatchId && dispatchItemId ? `${dispatchId}:${dispatchItemId}` : "";

export const dispatchCartons = (dispatch: Dispatch) =>
  dispatch.items?.reduce((sum, item) => sum + item.cartons, 0) ?? dispatch.cartons ?? 0;

export const saleDispatchKey = (sale: Pick<Sale, "dispatchId" | "dispatchItemId">) =>
  dispatchItemKey(sale.dispatchId, sale.dispatchItemId);

export const saleProduceLabel = (sale: Pick<Sale, "dateTypeName" | "produceType" | "dispatchId">) =>
  sale.dateTypeName?.trim() || sale.produceType?.trim()
  || (sale.dispatchId ? i18n.t("dispatchSales.dispatchSale") : i18n.t("dispatchSales.unlinkedSale"));

export const resolveSaleType = (sale: Pick<Sale, "saleType" | "dispatchId">) =>
  sale.saleType ?? (sale.dispatchId ? "dispatch_sale" : "farm_direct_sale");

export function soldQuantityByDispatchItem(sales: Sale[]) {
  const sold = new Map<string, number>();
  for (const sale of sales) {
    if (!isActiveOperationalRecord(sale)) continue;
    const key = saleDispatchKey(sale);
    if (!key) continue;
    sold.set(key, (sold.get(key) ?? 0) + Number(sale.quantity || 0));
  }
  return sold;
}

export function buildDispatchAvailability(
  dispatches: Dispatch[],
  sales: Sale[],
  dateTypes: DateType[],
  vehicleLabel: (dispatch: Dispatch) => string,
) {
  const dateTypeNames = new Map(dateTypes.map((type) => [type.id, type.name]));
  const soldByItem = soldQuantityByDispatchItem(sales);
  const rows: DispatchAvailability[] = [];

  for (const dispatch of dispatches) {
    if (!isActiveOperationalRecord(dispatch)) continue;
    const items = dispatch.items ?? [];
    for (const item of items) {
      const key = dispatchItemKey(dispatch.id, item.id);
      const soldCartons = soldByItem.get(key) ?? 0;
      const remainingCartons = Math.max(item.cartons - soldCartons, 0);
      const dateTypeName = item.dateTypeName ?? dateTypeNames.get(item.dateTypeId) ?? i18n.t("dispatchSales.unknownType");
      const vehicle = vehicleLabel(dispatch);
      rows.push({
        dispatch,
        itemId: item.id,
        dateTypeId: item.dateTypeId,
        dateTypeName,
        vehicleLabel: vehicle,
        dispatchedCartons: item.cartons,
        soldCartons,
        remainingCartons,
        searchText: `${dispatch.date} ${dateTypeName} ${vehicle}`.toLowerCase(),
      });
    }
  }

  return rows.sort((a, b) =>
    b.dispatch.date.localeCompare(a.dispatch.date)
    || a.dateTypeName.localeCompare(b.dateTypeName)
    || a.vehicleLabel.localeCompare(b.vehicleLabel));
}
