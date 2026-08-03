const PRINT_ROOT_ID = "muzare-detached-print-root";
const DETACHED_PRINT_ATTRIBUTE = "data-muzare-detached-print";

let installed = false;
let activeCleanup: (() => void) | null = null;

function removeDetachedPrintRoot() {
  document.getElementById(PRINT_ROOT_ID)?.remove();
  document.documentElement.removeAttribute(DETACHED_PRINT_ATTRIBUTE);
}

/**
 * Android print services can produce a blank document when the printable report remains
 * beneath ancestors hidden by the legacy `body * { visibility: hidden }` print rule.
 *
 * This bridge leaves attendance on its dedicated print implementation. For every other
 * report it clones the selected report into a direct child of <body>, prints that detached
 * document, and removes it after the print dialog closes.
 */
export function installDetachedReportPrintBridge() {
  if (installed || typeof window === "undefined") return;
  installed = true;

  const nativePrint = window.print.bind(window);

  window.print = () => {
    const sectionId = document.documentElement.getAttribute("data-muzare-print-section") ?? "";
    const target = document.querySelector<HTMLElement>(".reports-print-section.is-print-target");

    if (!target || sectionId.startsWith("attendance")) {
      nativePrint();
      return;
    }

    activeCleanup?.();
    removeDetachedPrintRoot();

    const printRoot = document.createElement("div");
    printRoot.id = PRINT_ROOT_ID;
    printRoot.setAttribute("data-print-section", sectionId);

    const printableClone = target.cloneNode(true) as HTMLElement;
    printableClone.classList.add("is-print-target");
    printableClone.removeAttribute("aria-hidden");
    printRoot.appendChild(printableClone);
    document.body.appendChild(printRoot);
    document.documentElement.setAttribute(DETACHED_PRINT_ATTRIBUTE, "true");

    let fallbackTimer = 0;
    const cleanup = () => {
      window.removeEventListener("afterprint", cleanup);
      if (fallbackTimer) window.clearTimeout(fallbackTimer);
      removeDetachedPrintRoot();
      if (activeCleanup === cleanup) activeCleanup = null;
    };

    activeCleanup = cleanup;
    window.addEventListener("afterprint", cleanup, { once: true });
    fallbackTimer = window.setTimeout(cleanup, 120_000);

    requestAnimationFrame(() => requestAnimationFrame(nativePrint));
  };
}
