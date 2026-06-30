type VoucherLike = {
  voucherNumber?: unknown;
  originalVoucherNumber?: unknown;
  legacyVoucherNumber?: unknown;
  allowVoucherNumberEdit?: unknown;
  voucherNumberEdited?: unknown;
  sourceType?: unknown;
  source_type?: unknown;
  oldExpenseId?: unknown;
};

function cleanVoucherNumber(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export function canonicalImportedVoucherNumber(voucher: VoucherLike) {
  return cleanVoucherNumber(voucher.originalVoucherNumber)
    || cleanVoucherNumber(voucher.legacyVoucherNumber)
    || cleanVoucherNumber(voucher.voucherNumber);
}

export function isImportedVoucher(voucher: VoucherLike) {
  return cleanVoucherNumber(voucher.oldExpenseId).length > 0
    || cleanVoucherNumber(voucher.sourceType) === "expense"
    || cleanVoucherNumber(voucher.source_type) === "expense";
}

export function getVoucherDisplayNumber(voucher: VoucherLike) {
  if (voucher.voucherNumberEdited === true) {
    return cleanVoucherNumber(voucher.voucherNumber)
      || canonicalImportedVoucherNumber(voucher);
  }
  if (isImportedVoucher(voucher)) {
    return canonicalImportedVoucherNumber(voucher);
  }
  return cleanVoucherNumber(voucher.voucherNumber)
    || canonicalImportedVoucherNumber(voucher);
}

export function canonicalizeImportedVoucherRecord<T extends VoucherLike>(voucher: T): T {
  if (!isImportedVoucher(voucher) || voucher.allowVoucherNumberEdit === true || voucher.voucherNumberEdited === true) {
    return voucher;
  }
  const canonicalNumber = canonicalImportedVoucherNumber(voucher);
  if (!canonicalNumber || canonicalNumber === cleanVoucherNumber(voucher.voucherNumber)) return voucher;
  return {
    ...voucher,
    voucherNumber: canonicalNumber,
    originalVoucherNumber: cleanVoucherNumber(voucher.originalVoucherNumber) || canonicalNumber,
    legacyVoucherNumber: cleanVoucherNumber(voucher.legacyVoucherNumber) || canonicalNumber,
  };
}

export function parseVoucherSequenceNumber(value: string) {
  const match = /^V-(\d+)$/i.exec(value.trim());
  return match ? Number(match[1]) : null;
}

export function normalizeVoucherNumber(value: string) {
  const parsed = parseVoucherSequenceNumber(value);
  return parsed ? `V-${String(parsed).padStart(4, "0")}` : null;
}
