const SALES_FORM_SELECTOR = ".sales-form";
const HIDDEN_PAYMENT_DATE_CLASS = "sales-payment-date-field--hidden";
const CONTEXT_RESTORE_TIMEOUT_MS = 15_000;

type SalesEntryContext = {
  submittedAt: number;
  saleTypeIndex: number;
  sharedFieldValues: string[];
  accountLabel: string | null;
};

let pendingSalesEntryContext: SalesEntryContext | null = null;

const normalizeText = (value: string | null | undefined) => value?.replace(/\s+/g, " ").trim() ?? "";

const setReactInputValue = (input: HTMLInputElement, value: string) => {
  if (input.value === value) return;
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  descriptor?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
};

const synchronizeSalesDates = (form: HTMLFormElement) => {
  const dateInputs = Array.from(form.querySelectorAll<HTMLInputElement>('input[type="date"]'));
  if (dateInputs.length < 2) return;

  const saleDateInput = dateInputs[0];
  const paymentDateInput = dateInputs[dateInputs.length - 1];
  const paymentDateLabel = paymentDateInput.closest("label");

  paymentDateLabel?.classList.add(HIDDEN_PAYMENT_DATE_CLASS);
  paymentDateInput.tabIndex = -1;
  paymentDateInput.setAttribute("aria-hidden", "true");

  if (saleDateInput.value) setReactInputValue(paymentDateInput, saleDateInput.value);
};

const synchronizeVisibleSalesForms = () => {
  document.querySelectorAll<HTMLFormElement>(SALES_FORM_SELECTOR).forEach(synchronizeSalesDates);
};

// These are the shared/context fields that should carry into the next sale while the user
// remains on this page. Numeric fields (cartons/rate) are intentionally excluded, as is the
// required direct-product fallback input. Product/variety selection is also excluded because it
// is rendered as a select and must start blank for each new sale.
const sharedSalesInputs = (form: HTMLFormElement) => Array.from(
  form.querySelectorAll<HTMLInputElement>(":scope > label > input"),
).filter((input) => input.type !== "number" && !input.readOnly && !input.required);

const captureSalesEntryContext = (form: HTMLFormElement): SalesEntryContext => {
  const saleTypeButtons = Array.from(form.querySelectorAll<HTMLButtonElement>(".sales-type-toggle > button"));
  const activeSaleTypeIndex = Math.max(saleTypeButtons.findIndex((button) => button.classList.contains("is-active")), 0);
  const accountText = form.querySelector<HTMLElement>(".payment-account-select .report-picker__trigger-text");
  const hasSelectedAccount = accountText?.classList.contains("is-filled") ?? false;

  return {
    submittedAt: Date.now(),
    saleTypeIndex: activeSaleTypeIndex,
    sharedFieldValues: sharedSalesInputs(form).map((input) => input.value),
    accountLabel: hasSelectedAccount ? normalizeText(accountText?.textContent) : null,
  };
};

const restorePaymentAccount = (form: HTMLFormElement, accountLabel: string | null) => {
  if (!accountLabel) return;

  const trigger = form.querySelector<HTMLButtonElement>(".payment-account-select .report-picker__trigger");
  const currentLabel = normalizeText(form.querySelector<HTMLElement>(".payment-account-select .report-picker__trigger-text")?.textContent);
  if (!trigger || currentLabel === accountLabel) return;

  trigger.click();
  let attempts = 0;
  const chooseAccount = () => {
    const options = Array.from(document.querySelectorAll<HTMLElement>(".account-sheet__option-name"));
    const match = options.find((option) => normalizeText(option.textContent) === accountLabel);
    const button = match?.closest<HTMLButtonElement>("button.account-sheet__option");
    if (button) {
      button.click();
      return;
    }
    attempts += 1;
    if (attempts < 8) requestAnimationFrame(chooseAccount);
  };
  requestAnimationFrame(chooseAccount);
};

const restoreSalesEntryContext = (context: SalesEntryContext) => {
  const form = document.querySelector<HTMLFormElement>(SALES_FORM_SELECTOR);
  if (!form) return;

  const saleTypeButtons = Array.from(form.querySelectorAll<HTMLButtonElement>(".sales-type-toggle > button"));
  const targetSaleTypeButton = saleTypeButtons[context.saleTypeIndex];
  const activeSaleTypeIndex = saleTypeButtons.findIndex((button) => button.classList.contains("is-active"));

  // resetForm() returns the form to From Dispatch after a save. Restore the user's working mode
  // first, then restore the shared fields after React has rendered that mode.
  if (targetSaleTypeButton && activeSaleTypeIndex !== context.saleTypeIndex) targetSaleTypeButton.click();

  requestAnimationFrame(() => {
    const currentForm = document.querySelector<HTMLFormElement>(SALES_FORM_SELECTOR);
    if (!currentForm) return;

    const inputs = sharedSalesInputs(currentForm);
    context.sharedFieldValues.forEach((value, index) => {
      const input = inputs[index];
      if (input) setReactInputValue(input, value);
    });

    // Product/variety, cartons and rate remain blank from resetForm(); total therefore remains 0.
    restorePaymentAccount(currentForm, context.accountLabel);
    synchronizeSalesDates(currentForm);
  });
};

const observer = new MutationObserver(synchronizeVisibleSalesForms);
observer.observe(document.documentElement, { childList: true, subtree: true });

document.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || target.type !== "date") return;
  const form = target.closest<HTMLFormElement>(SALES_FORM_SELECTOR);
  if (form) synchronizeSalesDates(form);
}, true);

document.addEventListener("submit", (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !form.matches(SALES_FORM_SELECTOR)) return;

  synchronizeSalesDates(form);

  // Editing an old sale keeps the existing full reset/cancel behaviour. Context carry-forward is
  // only for consecutive new entries made without leaving the Record Sale page.
  const isEditing = Boolean(form.querySelector(".sales-form__actions .secondary-action"));
  pendingSalesEntryContext = isEditing ? null : captureSalesEntryContext(form);
}, true);

window.addEventListener("muzare-toast", () => {
  const context = pendingSalesEntryContext;
  if (!context) return;
  pendingSalesEntryContext = null;

  // A successful sale emits its toast only after persistOperationalRecord(), resetForm() and the
  // sales refresh have completed, so restoring here avoids fighting the normal React reset.
  if (Date.now() - context.submittedAt > CONTEXT_RESTORE_TIMEOUT_MS) return;
  requestAnimationFrame(() => requestAnimationFrame(() => restoreSalesEntryContext(context)));
});

synchronizeVisibleSalesForms();
