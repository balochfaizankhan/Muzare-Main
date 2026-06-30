import { offlineDb, workspaceRecords, type Voucher } from "./offline-db";
import { isActiveVoucher, isDeletedOperationalRecord } from "./operationalRecords";

type VoucherRecordLike = {
  voucherNumber?: unknown;
  originalVoucherNumber?: unknown;
  legacyVoucherNumber?: unknown;
  deletedAt?: unknown;
  deleted?: unknown;
  status?: unknown;
};

export type VoucherCollectionMode = "active" | "deleted" | "all";

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

export async function loadWorkspaceVouchers(options: {
  mode?: VoucherCollectionMode;
  includeDeleted?: boolean;
  includeGeneralFarmRecords?: boolean;
  includeImportedAcrossSeasons?: boolean;
} = {}): Promise<Voucher[]> {
  const records = await workspaceRecords(offlineDb.vouchers, {
    includeDeleted: true,
    includeGeneralFarmRecords: options.includeGeneralFarmRecords,
    includeImportedAcrossSeasons: options.includeImportedAcrossSeasons,
  });
  return getAllVouchers(records, options);
}
