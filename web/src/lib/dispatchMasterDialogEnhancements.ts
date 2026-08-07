const MASTER_DIALOG_SELECTOR = ".dispatch-master-dialog";
const MASTER_FORM_SELECTOR = ".dispatch-master-form";
const RECORD_SELECTOR = ".record-card, .dispatch-master-record, .master-record-card, .worker-card, article, li";

const focusMasterForm = (dialog: HTMLElement) => {
  window.setTimeout(() => {
    requestAnimationFrame(() => {
      const form = dialog.querySelector<HTMLElement>(MASTER_FORM_SELECTOR);
      if (!form) return;
      form.scrollIntoView({ behavior: "smooth", block: "start" });
      requestAnimationFrame(() => {
        const firstField = form.querySelector<HTMLInputElement>("input:not([type='checkbox']):not([disabled])");
        firstField?.focus({ preventScroll: true });
        firstField?.select();
      });
    });
  }, 0);
};

/**
 * Mobile usability enhancement for Manage Types / Manage Vehicles.
 * The first record action is Edit in both master lists. After React fills the
 * form with that record, move the user directly to the form and focus its
 * first field so no manual upward scrolling is required.
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
    const actions = Array.from(actionContainer.querySelectorAll<HTMLButtonElement>(":scope > button"));
    if (actions.length === 0 || actions[0] !== button) return;

    focusMasterForm(dialog);
  };

  document.addEventListener("click", handleClick, true);
  return () => document.removeEventListener("click", handleClick, true);
}
