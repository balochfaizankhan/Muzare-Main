const MASTER_DIALOG_SELECTOR = ".dispatch-master-dialog";
const MASTER_FORM_SELECTOR = ".dispatch-master-form";
const MASTER_BODY_SELECTOR = ".worker-dialog__body";
const RECORD_SELECTOR = ".record-card, .dispatch-master-record, .master-record-card, .worker-card, article, li";

const focusMasterForm = (dialog: HTMLElement) => {
  window.setTimeout(() => {
    requestAnimationFrame(() => {
      const body = dialog.querySelector<HTMLElement>(MASTER_BODY_SELECTOR);
      const form = dialog.querySelector<HTMLElement>(MASTER_FORM_SELECTOR);
      if (!form) return;

      if (body) body.scrollTo({ top: 0, behavior: "smooth" });
      else form.scrollIntoView({ behavior: "smooth", block: "start", inline: "nearest" });

      window.setTimeout(() => {
        const firstField = form.querySelector<HTMLInputElement>("input:not([type='checkbox']):not([disabled])");
        firstField?.focus({ preventScroll: true });
        firstField?.select();
      }, 220);
    });
  }, 0);
};

/**
 * Mobile usability enhancement for Manage Types / Manage Vehicles.
 * The first action in each record card is Edit. After React fills the form,
 * scroll the dialog body itself back to the entry form and focus its first
 * editable field so the user never has to manually scroll upward.
 */
export function installDispatchMasterDialogEnhancements() {
  const handleClick = (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const dialog = target.closest<HTMLElement>(MASTER_DIALOG_SELECTOR);
    if (!dialog) return;

    const button = target.closest<HTMLButtonElement>("button");
    if (!button) return;
    const record = button.closest<HTMLElement>(RECORD_SELECTOR);
    if (!record || !dialog.contains(record)) return;

    const actionContainer = button.closest<HTMLElement>("footer, .card-actions, .record-actions") ?? record;
    const firstAction = actionContainer.querySelector<HTMLButtonElement>("button");
    if (!firstAction || firstAction !== button) return;

    focusMasterForm(dialog);
  };

  document.addEventListener("click", handleClick, true);
  return () => document.removeEventListener("click", handleClick, true);
}
