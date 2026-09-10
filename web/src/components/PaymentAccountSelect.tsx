import { ChevronDown, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { localizeSystemPlaceholder } from "../lib/statusLabels";

export type PaymentAccountOption = {
  id: string;
  name: string;
  type?: string;
  deletedAt?: string | null;
};

const ACCOUNT_TYPE_LABEL_KEYS: Record<string, string> = {
  cash: "paymentAccountSelect.typeAccount",
  bank: "paymentAccountSelect.typeAccount",
  partner: "paymentAccountSelect.typePartner",
  liability: "paymentAccountSelect.typeLiability",
};

export function isSyntheticLocalAccount(accountId: string | null | undefined) {
  return Boolean(accountId?.includes(":local-"));
}

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
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

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

  return createPortal(
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
    </div>,
    document.body,
  );
}

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
  const lastFormSubmitAtRef = useRef(0);
  const resolvedLabel = label ?? t("paymentAccountSelect.label");
  const resolvedPlaceholder = placeholder ?? t("paymentAccountSelect.placeholder");
  const options = useMemo<SheetOption[]>(() => {
    const rows = accounts.map((account) => ({
      value: account.id,
      label: localizeSystemPlaceholder(t, account.name),
      secondary: account.type && ACCOUNT_TYPE_LABEL_KEYS[account.type]
        ? t(ACCOUNT_TYPE_LABEL_KEYS[account.type]) + (account.deletedAt ? ` · ${t("paymentAccountSelect.inactive")}` : "")
        : account.deletedAt ? t("paymentAccountSelect.inactive") : undefined,
    }));
    return clearOptionLabel === undefined ? rows : [{ value: "", label: clearOptionLabel }, ...rows];
  }, [accounts, clearOptionLabel, t]);
  const selected = accounts.find((account) => account.id === value);

  useEffect(() => {
    const form = triggerRef.current?.form;
    if (!form) return;

    const isSalesForm = form.classList.contains("sales-form");
    const onSubmit = () => {
      lastFormSubmitAtRef.current = performance.now();
      setOpen(false);
      if (!isSalesForm) return;

      const dateInputs = Array.from(form.querySelectorAll<HTMLInputElement>('input[type="date"]'));
      const textInputs = Array.from(form.querySelectorAll<HTMLInputElement>('input[type="text"]'));
      const saleTypeButtons = Array.from(form.querySelectorAll<HTMLButtonElement>(".sales-type-toggle button"));
      const session = {
        saleDate: dateInputs[0]?.value ?? "",
        deliveryDate: dateInputs[1]?.value ?? "",
        paymentDate: dateInputs[2]?.value ?? "",
        buyerName: textInputs[1]?.value ?? "",
        saleTypeIndex: saleTypeButtons.findIndex((button) => button.classList.contains("is-active")),
        accountId: value,
        createdAt: Date.now(),
      };
      try {
        sessionStorage.setItem("muzare.sales.session", JSON.stringify(session));
      } catch {
        // Session storage is only a UX cache; never block a sale if unavailable.
      }

      const restore = () => {
        let stored: typeof session | null = null;
        try {
          const raw = sessionStorage.getItem("muzare.sales.session");
          stored = raw ? JSON.parse(raw) as typeof session : null;
        } catch {
          stored = null;
        }
        if (!stored || Date.now() - stored.createdAt > 5000) return true;

        const quantityInputs = Array.from(form.querySelectorAll<HTMLInputElement>('input[type="number"]'));
        const quantityAndPriceCleared = quantityInputs.length >= 2 && quantityInputs[0]?.value === "" && quantityInputs[1]?.value === "";
        if (!quantityAndPriceCleared) return false;

        const setInputValue = (input: HTMLInputElement | undefined, nextValue: string) => {
          if (!input || !nextValue) return;
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
          setter?.call(input, nextValue);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        };
        setInputValue(dateInputs[0], stored.saleDate);
        setInputValue(dateInputs[1], stored.deliveryDate);
        setInputValue(dateInputs[2], stored.paymentDate);
        setInputValue(textInputs[1], stored.buyerName);

        if (stored.saleTypeIndex >= 0 && saleTypeButtons[stored.saleTypeIndex]) {
          const currentIndex = saleTypeButtons.findIndex((button) => button.classList.contains("is-active"));
          if (currentIndex !== stored.saleTypeIndex) saleTypeButtons[stored.saleTypeIndex]?.click();
        }

        if (stored.accountId) onChange(stored.accountId);
        try {
          sessionStorage.removeItem("muzare.sales.session");
        } catch {
          // Ignore storage cleanup failures.
        }
        return true;
      };

      let attempts = 0;
      const timer = window.setInterval(() => {
        attempts += 1;
        if (restore() || attempts >= 100) window.clearInterval(timer);
      }, 50);
    };

    form.addEventListener("submit", onSubmit, true);
    return () => form.removeEventListener("submit", onSubmit, true);
  }, [onChange, value]);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const handleTriggerClick = () => {
    if (performance.now() - lastFormSubmitAtRef.current < 750) return;
    setOpen(true);
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
          onClick={handleTriggerClick}
        >
          <span className={`report-picker__trigger-text${selected ? " is-filled" : ""}`}>
            {selected ? localizeSystemPlaceholder(t, selected.name) : resolvedPlaceholder}
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
