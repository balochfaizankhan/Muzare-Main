const SALES_FORM_SELECTOR = ".sales-form";
const HIDDEN_PAYMENT_DATE_CLASS = "sales-payment-date-field--hidden";

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
  if (form instanceof HTMLFormElement && form.matches(SALES_FORM_SELECTOR)) synchronizeSalesDates(form);
}, true);

synchronizeVisibleSalesForms();
