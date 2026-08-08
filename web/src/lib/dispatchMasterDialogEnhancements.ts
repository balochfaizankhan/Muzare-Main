const MASTER_DIALOG_SELECTOR = ".dispatch-master-dialog";
const MASTER_FORM_SELECTOR = ".dispatch-master-form";
const MASTER_BODY_SELECTOR = ".worker-dialog__body";
const MASTER_LIST_SELECTOR = ".master-list";

const focusMasterForm = (dialog: HTMLElement) => {
  const run = () => {
    const body = dialog.querySelector<HTMLElement>(MASTER_BODY_SELECTOR);
    const form = dialog.querySelector<HTMLElement>(MASTER_FORM_SELECTOR);
    if (!form) return;

    if (body) {
      body.scrollTo({ top: 0, behavior: "smooth" });
      // Android WebViews can occasionally stop a smooth overflow scroll early
      // while React is repainting. Reassert the destination after the repaint.
      window.setTimeout(() => {
        if (body.scrollTop > 2) body.scrollTo({ top: 0, behavior: "auto" });
      }, 240);
    } else {
      form.scrollIntoView({ behavior: "smooth", block: "start", inline: "nearest" });
    }

    window.setTimeout(() => {
      const firstField = form.querySelector<HTMLInputElement>("input:not([type='checkbox']):not([disabled])");
      if (!firstField) return;
      firstField.focus({ preventScroll: true });
      firstField.select();
    }, 260);
  };

  // Let the React edit handler populate the form first, then move the sheet.
  requestAnimationFrame(() => requestAnimationFrame(run));
};

/**
 * Manage Types / Manage Vehicles edit handoff.
 * Both lists render Edit as the first action button in each master-list card.
 * Listen after React's own click handler has run, then return the dialog's
 * internal scroll container to the form and focus the first editable field.
 */
export function installDispatchMasterDialogEnhancements() {
  const handleClick = (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const button = target.closest<HTMLButtonElement>("button");
    const dialog = target.closest<HTMLElement>(MASTER_DIALOG_SELECTOR);
    if (!button || !dialog) return;

    const list = button.closest<HTMLElement>(MASTER_LIST_SELECTOR);
    const record = button.closest<HTMLElement>("article");
    if (!list || !record || !dialog.contains(list) || !list.contains(record)) return;

    const actions = Array.from(record.querySelectorAll<HTMLButtonElement>("button"));
    if (actions[0] !== button) return;

    focusMasterForm(dialog);
  };

  // Bubble phase is intentional: React's onClick has already loaded the record
  // into state before this handoff schedules scrolling/focus.
  document.addEventListener("click", handleClick, false);
  return () => document.removeEventListener("click", handleClick, false);
}
