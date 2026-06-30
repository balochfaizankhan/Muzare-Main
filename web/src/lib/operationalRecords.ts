type OperationalRecordLike = {
  deletedAt?: unknown;
  deleted?: unknown;
  status?: unknown;
  sourceType?: unknown;
  source_type?: unknown;
  oldExpenseId?: unknown;
  originalVoucherNumber?: unknown;
  old_android_id?: unknown;
  oldAndroidId?: unknown;
  voucherNumber?: unknown;
};

const deletedStatuses = new Set(["deleted", "void", "voided", "cancelled"]);

function normalizedString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export function isDeletedOperationalRecord(record: OperationalRecordLike | null | undefined) {
  if (!record) return false;
  if (normalizedString(record.deletedAt)) return true;
  if (record.deleted === true || normalizedString(record.deleted).toLowerCase() === "true") return true;
  const status = normalizedString(record.status).toLowerCase();
  return deletedStatuses.has(status);
}

export function isActiveOperationalRecord(record: OperationalRecordLike | null | undefined) {
  return !isDeletedOperationalRecord(record);
}

export function isImportedVoucherRecord(record: OperationalRecordLike | null | undefined) {
  if (!record) return false;
  return record.sourceType === "expense"
    || record.source_type === "expense"
    || typeof record.oldExpenseId === "string"
    || normalizedString(record.originalVoucherNumber).length > 0;
}

export function isImportedAccountRecord(record: OperationalRecordLike | null | undefined) {
  if (!record) return false;
  return record.sourceType === "account"
    || record.source_type === "account"
    || typeof record.old_android_id === "string"
    || typeof record.oldAndroidId === "string";
}

export function isActiveVoucher(record: OperationalRecordLike | null | undefined) {
  return Boolean(record && normalizedString(record.voucherNumber)) && isActiveOperationalRecord(record);
}
