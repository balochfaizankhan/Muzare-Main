import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ResponsiveSelectField } from "./ResponsivePicker";

export type PaymentAccountOption = {
  id: string;
  name: string;
  type?: string;
  deletedAt?: string | null;
};

const ACCOUNT_TYPE_LABEL_KEYS: Record<string, string> = {
  cash: "paymentAccountSelect.typeCash",
  bank: "paymentAccountSelect.typeBank",
  partner: "paymentAccountSelect.typePartner",
};

/** Every seeded/local placeholder account uses this id shape — never a real, selectable account. */
export function isSyntheticLocalAccount(accountId: string | null | undefined) {
  return Boolean(accountId?.includes(":local-"));
}

/**
 * The canonical "which accounts can a user actually pick" rule, shared by every
 * PaymentAccountSelect call site: never a synthetic placeholder, never soft-deleted — except the
 * account a historical record already points at (`alsoIncludeId`), which must stay visible and
 * selectable while editing that one record even if it was deactivated afterwards.
 */
export function eligiblePaymentAccounts<T extends PaymentAccountOption>(
  accounts: T[],
  options?: { types?: string[]; alsoIncludeId?: string | null },
): T[] {
  return accounts.filter((account) =>
    !isSyntheticLocalAccount(account.id)
    && (!account.deletedAt || account.id === options?.alsoIncludeId)
    && (!options?.types || !account.type || options.types.includes(account.type)));
}

/**
 * Shared, selection-only payment-account control used everywhere a user picks a funding/payment
 * account (expense vouchers, labour payments/advances, purchase payments, partner-funded
 * payments, funds received/given). Wraps the existing bottom-sheet ResponsiveSelectField so every
 * caller gets identical behavior: search-only filtering (never a free-text value), the account's
 * canonical id as the stored value, and a consistent "Select a payment account" validation
 * message. Pass accounts already narrowed via `eligiblePaymentAccounts`.
 */
export function PaymentAccountSelect({
  accounts,
  value,
  onChange,
  label,
  placeholder,
  invalid,
}: {
  accounts: PaymentAccountOption[];
  value: string;
  onChange: (accountId: string) => void;
  label?: string;
  placeholder?: string;
  invalid?: boolean;
}) {
  const { t } = useTranslation();
  const resolvedLabel = label ?? t("paymentAccountSelect.label");
  const resolvedPlaceholder = placeholder ?? t("paymentAccountSelect.placeholder");
  const options = useMemo(() => accounts.map((account) => ({
    value: account.id,
    label: account.name,
    secondary: account.type && ACCOUNT_TYPE_LABEL_KEYS[account.type]
      ? t(ACCOUNT_TYPE_LABEL_KEYS[account.type]) + (account.deletedAt ? ` · ${t("paymentAccountSelect.inactive")}` : "")
      : account.deletedAt ? t("paymentAccountSelect.inactive") : undefined,
  })), [accounts, t]);
  return (
    <div className={`payment-account-select${invalid ? " payment-account-select--invalid" : ""}`}>
      <ResponsiveSelectField
        ariaLabel={resolvedLabel}
        title={resolvedLabel}
        placeholder={resolvedPlaceholder}
        allLabel={resolvedPlaceholder}
        allowClear={false}
        options={options}
        value={value}
        onChange={onChange}
        searchPlaceholder={t("paymentAccountSelect.search")}
        autoFocusSearch={false}
      />
      {invalid && <small className="payment-account-select__error" role="alert">{t("paymentAccountSelect.required")}</small>}
    </div>
  );
}
