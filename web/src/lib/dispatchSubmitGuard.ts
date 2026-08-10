const DISPATCH_FORM_SELECTOR = "form.dispatch-form";
const LOCK_ATTRIBUTE = "data-dispatch-submit-locked";
const LOCK_WINDOW_MS = 2_000;

/**
 * Close the tiny same-tick gap before React's `saving` state disables the
 * Dispatch submit button. This guard is intentionally DOM-only and synchronous:
 * it adds no fetch, IndexedDB read, polling, or page-load work.
 *
 * Once the first submit is allowed through, React owns the normal saving state.
 * The short fallback timeout only exists so a local persistence failure never
 * leaves the form permanently locked.
 */
export function installDispatchSubmitGuard() {
  const onSubmit = (event: SubmitEvent) => {
    const form = event.target instanceof HTMLFormElement ? event.target : null;
    if (!form?.matches(DISPATCH_FORM_SELECTOR)) return;

    if (form.getAttribute(LOCK_ATTRIBUTE) === "true") {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }

    form.setAttribute(LOCK_ATTRIBUTE, "true");
    window.setTimeout(() => {
      form.removeAttribute(LOCK_ATTRIBUTE);
    }, LOCK_WINDOW_MS);
  };

  document.addEventListener("submit", onSubmit, true);
  return () => document.removeEventListener("submit", onSubmit, true);
}
