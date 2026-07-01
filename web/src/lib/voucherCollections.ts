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
  } = {},
) {
  const scoped = getAllVouchers(records, options);
  const visibility = options.visibility ?? "all";
  if (visibility === "settlements") return getSettlementGeneratedVouchers(scoped) as T[];
  if (visibility === "general-expenses") return getGeneralExpenseVouchers(scoped) as T[];
  return [...scoped] as T[];
}

export async function loadWorkspaceVouchers(options: {
  mode?: VoucherCollectionMode;
  includeDeleted?: boolean;
  visibility?: VoucherVisibility;
  includeGeneralFarmRecords?: boolean;
  includeImportedAcrossSeasons?: boolean;
} = {}): Promise<Voucher[]> {
  const records = await workspaceRecords(offlineDb.vouchers, {
    includeDeleted: true,
    includeGeneralFarmRecords: options.includeGeneralFarmRecords,
    includeImportedAcrossSeasons: options.includeImportedAcrossSeasons,
  });
  return getVisibleVouchers<Voucher>(records, options);
}
