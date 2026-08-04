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

function removeManagedActionDecorations(element: HTMLElement) {
  element.classList.remove(...managedBarClasses);
  managedDataAttributes.forEach((attribute) => element.removeAttribute(attribute));
}

function restoreAdvanceDialogFooter(form: HTMLFormElement) {
  const isQuickAdvanceForm = Boolean(
    form.matches(".worker-action-dialog form.worker-action-form")
    && form.querySelector(".labour-combobox"),
  );
  if (!isQuickAdvanceForm) return;

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

  let summary = actions.querySelector<HTMLElement>("[data-runtime-sales-carton-summary='true']");
  if (!summary) {
    summary = document.createElement("div");
    summary.className = "sales-form__runtime-summary";
    summary.dataset.runtimeSalesCartonSummary = "true";
    summary.dataset.stickyActionSummary = "true";
    summary.setAttribute("aria-live", "polite");
    summary.innerHTML = "<span></span><strong class=\"bidi-isolate\">0</strong>";
    actions.insertBefore(summary, actions.firstChild);
  }

  const quantityLabel = quantityInput.closest("label")?.querySelector<HTMLElement>(":scope > span")?.textContent?.trim()
    || quantityInput.getAttribute("aria-label")
    || "Cartons";
  const quantityValue = quantityInput.value.trim() || "0";
  const labelNode = summary.querySelector("span");
  const valueNode = summary.querySelector("strong");
  if (labelNode && labelNode.textContent !== quantityLabel) labelNode.textContent = quantityLabel;
  if (valueNode && valueNode.textContent !== quantityValue) valueNode.textContent = quantityValue;
}

function scanForms(root: ParentNode) {
  root.querySelectorAll<HTMLFormElement>("form.worker-action-form").forEach(restoreAdvanceDialogFooter);
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
  observer.observe(root, { childList: true, subtree: true });
  root.addEventListener("input", updateFromInput, true);
  root.addEventListener("change", updateFromInput, true);
  scan();

  return () => {
    observer.disconnect();
    if (frame) window.cancelAnimationFrame(frame);
    root.removeEventListener("input", updateFromInput, true);
    root.removeEventListener("change", updateFromInput, true);
    root.querySelectorAll("[data-runtime-sales-carton-summary='true']").forEach((summary) => summary.remove());
  };
}
