const settleDueLabels: Record<string, string> = {
  en: "Settle due",
  ar: "تسوية المستحق",
  ur: "واجب الادا رقم تصفیہ کریں",
};

const postingPattern = /posting|saving|جار|جاري|ترحيل|محفوظ|پوسٹ|محفوظ ہو/i;

function currentSettleDueLabel() {
  const language = document.documentElement.lang?.slice(0, 2).toLowerCase() || "en";
  return settleDueLabels[language] ?? settleDueLabels.en;
}

function enhanceSettlementFooter(dialog: Element) {
  const footer = Array.from(dialog.children).find(
    (child) => child instanceof HTMLElement && child.tagName === "FOOTER",
  );
  if (!(footer instanceof HTMLElement)) return;

  const preview = footer.querySelector<HTMLElement>(".workforce-payment-review__preview");
  const actions = footer.querySelector<HTMLElement>(".workforce-payment-review__actions");
  if (!preview || !actions) return;

  footer.classList.add("workforce-payment-review__settlement-footer");
  preview.classList.add("workforce-payment-review__settlement-summary");
  actions.classList.add("workforce-payment-review__actions--settlement");

  const secondaryButtons = Array.from(
    actions.querySelectorAll<HTMLButtonElement>(":scope > button.secondary-action"),
  );
  secondaryButtons.forEach((button) => {
    button.classList.add("workforce-payment-review__secondary-action");
    const isHoldAction = Boolean(button.querySelector("svg"));
    button.classList.toggle("is-hold", isHoldAction);
    button.classList.toggle("is-danger", !isHoldAction);
  });

  const primary = actions.querySelector<HTMLButtonElement>(":scope > button.primary-action");
  if (!primary) return;
  primary.classList.add("workforce-payment-review__settle-action");

  const currentText = primary.textContent?.trim() ?? "";
  if (!postingPattern.test(currentText)) {
    const nextLabel = currentSettleDueLabel();
    if (currentText !== nextLabel) primary.textContent = nextLabel;
  }
}

function enhanceLabourPaymentBottomActions() {
  document
    .querySelectorAll(".workforce-payment-review")
    .forEach((dialog) => enhanceSettlementFooter(dialog));
}

export function installLabourPaymentBottomActions() {
  let frame = 0;
  const schedule = () => {
    if (frame) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      enhanceLabourPaymentBottomActions();
    });
  };

  schedule();
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  return () => {
    observer.disconnect();
    if (frame) window.cancelAnimationFrame(frame);
  };
}
