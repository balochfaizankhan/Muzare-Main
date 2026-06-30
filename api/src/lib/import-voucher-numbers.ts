function clean(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export function canonicalImportedVoucherNumber(payload: Record<string, unknown>): string {
  for (const key of ["originalVoucherNumber", "legacyVoucherNumber", "voucherNumber"] as const) {
    const value = clean(payload[key]);
    if (value) return value;
  }
  return "";
}

export function isImportedVoucherPayload(payload: Record<string, unknown>, sourceType?: string | null): boolean {
  return sourceType === "expense"
    || clean(payload.source_type) === "expense"
    || clean(payload.sourceType) === "expense"
    || clean(payload.oldExpenseId).length > 0
    || clean(payload.originalVoucherNumber).length > 0
    || clean(payload.legacyVoucherNumber).length > 0;
}

export function hasExplicitVoucherNumberEdit(payload: Record<string, unknown>): boolean {
  return payload.allowVoucherNumberEdit === true;
}

export function wasImportedVoucherNumberEdited(payload: Record<string, unknown>): boolean {
  return payload.voucherNumberEdited === true;
}

export function stripVoucherNumberControlFields<T extends Record<string, unknown>>(payload: T): T {
  const next = { ...payload };
  delete next.allowVoucherNumberEdit;
  return next;
}

export function resolveVoucherPayloadForWrite(args: {
  incomingPayload: Record<string, unknown>;
  existingPayload?: Record<string, unknown> | null;
  sourceType?: string | null;
  requestedVoucherNumber?: string | null;
}) {
  const explicitVoucherNumberEdit = hasExplicitVoucherNumberEdit(args.incomingPayload);
  const existingImported = args.existingPayload ? isImportedVoucherPayload(args.existingPayload, args.sourceType) : false;
  const incomingImported = isImportedVoucherPayload(args.incomingPayload, args.sourceType);
  const importedVoucher = existingImported || incomingImported;
  const existingCanonicalNumber = args.existingPayload ? canonicalImportedVoucherNumber(args.existingPayload) : "";
  const incomingCanonicalNumber = canonicalImportedVoucherNumber(args.incomingPayload);
  const canonicalNumber = existingCanonicalNumber || incomingCanonicalNumber;
  const existingStoredVoucherNumber = args.existingPayload ? clean(args.existingPayload.voucherNumber) : "";
  const existingVoucherWasEdited = args.existingPayload ? wasImportedVoucherNumberEdited(args.existingPayload) : false;
  const resolvedVoucherNumber = importedVoucher
    ? explicitVoucherNumberEdit
      ? (args.requestedVoucherNumber ?? existingStoredVoucherNumber ?? canonicalNumber)
      : existingVoucherWasEdited && existingStoredVoucherNumber
        ? existingStoredVoucherNumber
        : canonicalNumber || args.requestedVoucherNumber || existingStoredVoucherNumber
    : args.requestedVoucherNumber || existingStoredVoucherNumber;
  const nextPayload = {
    ...(args.existingPayload ?? {}),
    ...stripVoucherNumberControlFields(args.incomingPayload),
  };
  if (resolvedVoucherNumber) nextPayload.voucherNumber = resolvedVoucherNumber;
  if (canonicalNumber) {
    nextPayload.originalVoucherNumber = clean(nextPayload.originalVoucherNumber) || canonicalNumber;
    nextPayload.legacyVoucherNumber = clean(nextPayload.legacyVoucherNumber) || canonicalNumber;
  }
  if (importedVoucher) {
    nextPayload.voucherNumberEdited = explicitVoucherNumberEdit || existingVoucherWasEdited;
  }
  return {
    explicitVoucherNumberEdit,
    importedVoucher,
    canonicalNumber,
    resolvedVoucherNumber,
    nextPayload,
  };
}
