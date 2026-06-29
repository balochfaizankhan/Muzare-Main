type VoucherLike = {
  voucherNumber?: unknown;
  originalVoucherNumber?: unknown;
  legacyVoucherNumber?: unknown;
};

function cleanVoucherNumber(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export function getVoucherDisplayNumber(voucher: VoucherLike) {
  return cleanVoucherNumber(voucher.originalVoucherNumber)
    || cleanVoucherNumber(voucher.voucherNumber)
    || cleanVoucherNumber(voucher.legacyVoucherNumber);
}

export function parseVoucherSequenceNumber(value: string) {
  const match = /^V-(\d+)$/i.exec(value.trim());
  return match ? Number(match[1]) : null;
}

