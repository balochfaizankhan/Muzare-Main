export function canonicalImportedVoucherNumber(payload: Record<string, unknown>): string {
  for (const key of ["originalVoucherNumber", "legacyVoucherNumber", "voucherNumber"] as const) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}
