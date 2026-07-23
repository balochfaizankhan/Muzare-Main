import { ChevronDown, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";

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
  liability: "paymentAccountSelect.typeLiability",
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

type SheetOption = {
  value: string;
  label: string;
  secondary?: string;
};

/**
 * The one selection-only account sheet used everywhere a payment account is picked. No search
 * box, no free text, no confirm step: tapping a row selects it and closes the sheet. Radio
 * semantics (radiogroup/radio + arrow-key navigation) expose exactly one selected row, Escape
 * closes, and the caller restores focus to the trigger via `onClose`.
 */
export function AccountSelectionSheet({
  open,
  title,
  options,
  value,
  onSelect,
  onClose,
  emptyLabel,
}: {
  open: boolean;
  title: string;
  options: SheetOption[];
  value: string;
  onSelect: (value: string) => void;
  onClose: () => void;
  emptyLabel: string;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const sheetRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key === "Tab") {
        const focusables = sheetRef.current?.querySelectorAll<HTMLElement>("button:not([disabled])");
        if (!focusables?.length) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose, open]);

  useEffect(() => {
    if (!open) return;
    window.requestAnimationFrame(() => {
      const sheet = sheetRef.current;
      if (!sheet) return;
      const target = sheet.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')
        ?? sheet.querySelector<HTMLElement>('[role="radio"]')
        ?? sheet.querySelector<HTMLElement>("button");
      target?.focus();
      target?.scrollIntoView({ block: "nearest" });
    });
  }, [open]);

  if (!open) return null;

  const moveFocus = (event: ReactKeyboardEvent) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const radios = Array.from(sheetRef.current?.querySelectorAll<HTMLElement>('[role="radio"]') ?? []);
    if (!radios.length) return;
    const index = radios.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "Home" ? 0
      : event.key === "End" ? radios.length - 1
      : event.key === "ArrowDown" ? (index < 0 ? 0 : (index + 1) % radios.length)
      : index < 0 ? radios.length - 1 : (index - 1 + radios.length) % radios.length;
    event.preventDefault();
    radios[next]?.focus();
    radios[next]?.scrollIntoView({ block: "nearest" });
  };

  return (
    <div className="account-sheet-backdrop" role="presentation" onClick={onClose}>
      <section
        ref={sheetRef}
        className="account-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="account-sheet__header">
          <h3 id={titleId}>{title}</h3>
          <button type="button" className="account-sheet__close" aria-label={t("common.close")} onClick={onClose}>
            <X size={20} aria-hidden="true" />
          </button>
        </header>
        {options.length === 0
          ? <p className="account-sheet__empty" role="status">{emptyLabel}</p>
          : <div className="account-sheet__list" role="radiogroup" aria-labelledby={titleId} onKeyDown={moveFocus}>
              {options.map((option) => {
                const selected = option.value === value;
                return (
                  <button
                    key={option.value || "__all__"}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    className={`account-sheet__option${selected ? " is-selected" : ""}`}
                    onClick={() => onSelect(option.value)}
                  >
                    <span className="account-sheet__radio" aria-hidden="true" />
                    <span className="account-sheet__option-text">
                      <span className="account-sheet__option-name">{option.label}</span>
                      {option.secondary ? <span className="account-sheet__option-type">{option.secondary}</span> : null}
                    </span>
                  </button>
                );
              })}
            </div>}
      </section>
    </div>
  );
}

/**
 * Shared, selection-only payment-account control used everywhere a user picks a funding/payment
 * account (expense vouchers, labour payments/advances, purchase payments, partner-funded
 * payments, funds received/given). The field is a read-only trigger button (no text input, so no
 * mobile keyboard) that opens AccountSelectionSheet; the stored value is always an account's
 * canonical id. Pass accounts already narrowed via `eligiblePaymentAccounts` — the control never
 * widens eligibility and never auto-selects an account. `clearOptionLabel` prepends an
 * "all/none" row for the one filter use-case; form fields must omit it.
 */
export function PaymentAccountSelect({
  accounts,
  value,
  onChange,
  label,
  placeholder,
  invalid,
  errorMessage,
  disabled,
  clearOptionLabel,
}: {
  accounts: PaymentAccountOption[];
  value: string;
  onChange: (accountId: string) => void;
  label?: string;
  placeholder?: string;
  invalid?: boolean;
  errorMessage?: string;
  disabled?: boolean;
  clearOptionLabel?: string;
}) {
  const { t } = useTranslation();
  const errorId = useId();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const resolvedLabel = label ?? t("paymentAccountSelect.label");
  const resolvedPlaceholder = placeholder ?? t("paymentAccountSelect.placeholder");
  const options = useMemo<SheetOption[]>(() => {
    const rows = accounts.map((account) => ({
      value: account.id,
      label: account.name,
      secondary: account.type && ACCOUNT_TYPE_LABEL_KEYS[account.type]
        ? t(ACCOUNT_TYPE_LABEL_KEYS[account.type]) + (account.deletedAt ? ` · ${t("paymentAccountSelect.inactive")}` : "")
        : account.deletedAt ? t("paymentAccountSelect.inactive") : undefined,
    }));
    return clearOptionLabel === undefined ? rows : [{ value: "", label: clearOptionLabel }, ...rows];
  }, [accounts, clearOptionLabel, t]);
  const selected = accounts.find((account) => account.id === value);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <div className={`payment-account-select${invalid ? " payment-account-select--invalid" : ""}`}>
      <div className="report-picker">
        <button
          ref={triggerRef}
          type="button"
          className="report-picker__trigger"
          aria-label={resolvedLabel}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? errorId : undefined}
          disabled={disabled}
          onClick={() => setOpen(true)}
        >
          <span className={`report-picker__trigger-text${selected ? " is-filled" : ""}`}>
            {selected ? selected.name : resolvedPlaceholder}
          </span>
          <span className="report-picker__trigger-actions">
            <ChevronDown size={16} aria-hidden="true" />
          </span>
        </button>
      </div>
      <AccountSelectionSheet
        open={open}
        title={resolvedLabel}
        options={options}
        value={value}
        onSelect={(accountId) => {
          onChange(accountId);
          close();
        }}
        onClose={close}
        emptyLabel={t("paymentAccountSelect.empty")}
      />
      {invalid && <small id={errorId} className="payment-account-select__error" role="alert">{errorMessage ?? t("paymentAccountSelect.required")}</small>}
    </div>
  );
}
