const managedBarClasses = [
  "muzare-sticky-action-bar",
  "muzare-sticky-action-bar__primary",
  "muzare-sticky-action-bar__secondary",
  "muzare-sticky-action-bar__primary--danger",
  "muzare-sticky-action-bar__secondary--danger",
];

const managedDataAttributes = [
  "data-sticky-action-managed",
  "data-sticky-action-variant",
  "data-sticky-action-state",
  "data-sticky-action-busy",
  "data-sticky-action-untouched",
  "data-safe-area",
];

const currentQuickAdvanceSelector = ".workforce-advance-entry-sheet > form";
const legacyQuickAdvanceSelector = ".worker-action-dialog form.worker-action-form";
const quickAdvanceFormSelector = `${currentQuickAdvanceSelector}, ${legacyQuickAdvanceSelector}`;

function removeManagedActionDecorations(element: HTMLElement) {
  element.classList.remove(...managedBarClasses);
  managedDataAttributes.forEach((attribute) => element.removeAttribute(attribute));
}

function restoreAdvanceDialogFooter(form: HTMLFormElement) {
  const isCurrentQuickAdvanceForm = form.matches(currentQuickAdvanceSelector);
  const isLegacyQuickAdvanceForm = Boolean(
    form.matches(legacyQuickAdvanceSelector)
    && form.querySelector(".labour-combobox")
    && form.querySelector('input[type="date"]')
    && form.querySelector('input[type="number"]')
    && form.querySelector(".payment-account-select"),
  );
  if (!isCurrentQuickAdvanceForm && !isLegacyQuickAdvanceForm) return;

  const newlyDisabled = form.dataset.stickyActionDisabled !== "true";
  form.dataset.stickyActionDisabled = "true";
  form.classList.remove("muzare-sticky-action-form");
  form.removeAttribute("data-sticky-action-state");
  form.removeAttribute("data-sticky-action-variant");

  const footer = Array.from(form.children).find((child): child is HTMLElement =>
    child instanceof HTMLElement && child.tagName === "FOOTER"
  );
  if (footer) removeManagedActionDecorations(footer);

  if (newlyDisabled) {
    // The shared provider observes child-list changes. This one-time marker asks it
    // to rescan immediately, where it now sees the explicit opt-out above.
    const marker = document.createComment("advance-sticky-action-opt-out");
    form.appendChild(marker);
    marker.remove();
  }
}

function visibleSalesQuantityInput(form: HTMLFormElement) {
  return Array.from(form.querySelectorAll<HTMLInputElement>('input[type="number"]'))
    .find((input) => !input.readOnly && !input.disabled) ?? null;
}

function updateSalesCartonSummary(form: HTMLFormElement) {
  const actions = form.querySelector<HTMLElement>(".sales-form__actions");
  const quantityInput = visibleSalesQuantityInput(form);
  if (!actions || !quantityInput) return;

  const quantityLabel = quantityInput.closest("label")?.querySelector<HTMLElement>(":scope > span")?.textContent?.trim()
    || quantityInput.getAttribute("aria-label")
    || "Cartons";
  const quantityValue = quantityInput.value.trim() || "0";
  if (actions.dataset.salesCartonLabel !== quantityLabel) actions.dataset.salesCartonLabel = quantityLabel;
  if (actions.dataset.salesCartonCount !== quantityValue) actions.dataset.salesCartonCount = quantityValue;
  actions.setAttribute("aria-label", `${quantityLabel}: ${quantityValue}`);
}

function scanForms(root: ParentNode) {
  root.querySelectorAll<HTMLFormElement>(quickAdvanceFormSelector).forEach(restoreAdvanceDialogFooter);
  root.querySelectorAll<HTMLFormElement>("form.sales-form").forEach(updateSalesCartonSummary);
}

export function installSalesAdvanceMobileRefinements() {
  const root = document.querySelector<HTMLElement>(".app-shell__body") ?? document.body;
  let frame = 0;

  const scan = () => {
    frame = 0;
    scanForms(root);
  };

  const scheduleScan = () => {
    if (frame) return;
    frame = window.requestAnimationFrame(scan);
  };

  const updateFromInput = (event: Event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.type !== "number") return;
    const form = target.closest<HTMLFormElement>("form.sales-form");
    if (form) updateSalesCartonSummary(form);
  };

  const observer = new MutationObserver(scheduleScan);
  observer.observe(root, { childList: true, subtree: true, characterData: true });
  root.addEventListener("input", updateFromInput, true);
  root.addEventListener("change", updateFromInput, true);
  scan();

  return () => {
    observer.disconnect();
    if (frame) window.cancelAnimationFrame(frame);
    root.removeEventListener("input", updateFromInput, true);
    root.removeEventListener("change", updateFromInput, true);
    root.querySelectorAll<HTMLElement>(".sales-form__actions[data-sales-carton-count]").forEach((actions) => {
      delete actions.dataset.salesCartonLabel;
      delete actions.dataset.salesCartonCount;
      actions.removeAttribute("aria-label");
    });
  };
}
