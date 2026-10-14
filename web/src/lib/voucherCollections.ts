import { offlineDb, workspaceRecords, type Voucher } from "./offline-db";
import { getGeneralExpenseVouchers, getSettlementGeneratedVouchers, type SettlementVoucherLike } from "./labourWageSettlements";
import { isActiveVoucher, isDeletedOperationalRecord } from "./operationalRecords";

type VoucherRecordLike = SettlementVoucherLike & {
  voucherNumber?: unknown;
  originalVoucherNumber?: unknown;
  legacyVoucherNumber?: unknown;
  settlementNumber?: unknown;
};

export type VoucherCollectionMode = "active" | "deleted" | "all";
export type VoucherVisibility = "all" | "general-expenses" | "settlements";

export function getActiveVouchers<T extends VoucherRecordLike>(records: readonly T[]) {
  return records.filter((record) => isActiveVoucher(record));
}

export function getDeletedVouchers<T extends VoucherRecordLike>(records: readonly T[]) {
  return records.filter((record) => isDeletedOperationalRecord(record));
}

export function getAllVouchers<T extends VoucherRecordLike>(
  records: readonly T[],
  options: { includeDeleted?: boolean; mode?: VoucherCollectionMode } = {},
) {
  const mode = options.mode ?? (options.includeDeleted ? "all" : "active");
  if (mode === "all") return [...records];
  if (mode === "deleted") return getDeletedVouchers(records);
  return getActiveVouchers(records);
}

export function getVisibleVouchers<T extends VoucherRecordLike>(
  records: readonly T[],
  options: {
    includeDeleted?: boolean;
    mode?: VoucherCollectionMode;
    visibility?: VoucherVisibility;
    settlements?: readonly { id?: string; status?: unknown; accountingStatus?: unknown; deletedAt?: unknown; voidedAt?: unknown; reversedAt?: unknown; deleted?: unknown }[];
  } = {},
) {
  const scoped = getAllVouchers(records, options);
  const visibility = options.visibility ?? "all";
  if (visibility === "settlements") return getSettlementGeneratedVouchers(scoped) as T[];
  if (visibility === "general-expenses") return getGeneralExpenseVouchers(scoped, options.settlements) as T[];
  return [...scoped] as T[];
}

export async function loadWorkspaceVouchers(options: {
  mode?: VoucherCollectionMode;
  includeDeleted?: boolean;
  visibility?: VoucherVisibility;
  /**
   * @deprecated Expense vouchers are season-scoped financial records. These compatibility
   * flags are intentionally ignored so an imported/general-farm voucher can never leak into
   * another active season. Historical imports must be assigned to the correct season instead.
   */
  includeGeneralFarmRecords?: boolean;
  includeImportedAcrossSeasons?: boolean;
} = {}): Promise<Voucher[]> {
  // Financial vouchers are strictly workspace + farm + ACTIVE SEASON scoped.
  // Never widen this read for convenience: Dashboard, Expenses, Accounts and Reports all
  // consume this shared selector and must reconcile to the exact same season boundary.
  const records = await workspaceRecords(offlineDb.vouchers, {
    includeDeleted: true,
  });
  return getVisibleVouchers<Voucher>(records, options);
}
