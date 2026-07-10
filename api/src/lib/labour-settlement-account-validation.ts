export type LabourSettlementAccountValidationReason = "not_mapped" | "inactive" | "wrong_farm" | "account_type";

export type LabourSettlementAccount = {
  id: string;
  farmId: string;
  name: string;
  accountType: string;
  active: boolean;
  oldAndroidId: string | null;
  sourceType: string | null;
};

export type LabourSettlementAccountValidation = {
  valid: boolean;
  reason: LabourSettlementAccountValidationReason | null;
  message: string | null;
};

function normalizeAccountType(value: string | null | undefined) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function validateLabourSettlementPaymentAccount(
  account: LabourSettlementAccount | null,
  selectedFarmId: string,
  allowedAccountTypes: string[] = ["cash", "bank", "partner"],
  options: { allowInactive?: boolean } = {},
): LabourSettlementAccountValidation {
  if (!account) {
    return {
      valid: false,
      reason: "not_mapped",
      message: "Payment account is not mapped. Please repair imported accounts.",
    };
  }
  if (!account.active) {
    if (options.allowInactive) {
      return {
        valid: true,
        reason: null,
        message: null,
      };
    }
    return {
      valid: false,
      reason: "inactive",
      message: "Selected account is inactive.",
    };
  }
  if (account.farmId !== selectedFarmId) {
    return {
      valid: false,
      reason: "wrong_farm",
      message: "Selected account belongs to another farm.",
    };
  }
  const normalizedType = normalizeAccountType(account.accountType);
  if (allowedAccountTypes.length && !allowedAccountTypes.map((type) => type.toLowerCase()).includes(normalizedType)) {
    return {
      valid: false,
      reason: "account_type",
      message: `Selected account type ${account.accountType} is not allowed for this action.`,
    };
  }
  return {
    valid: true,
    reason: null,
    message: null,
  };
}
