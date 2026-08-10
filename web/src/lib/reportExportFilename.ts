const REPORT_SECTION_SELECTOR = ".reports-print-section--document[data-print-title]";
const REPORT_DATE_SELECTOR = ".reports-date-field input[type=\"date\"], .reports-filter-panel input[type=\"date\"]";

const validDateKey = (value: string | null | undefined) => {
  const next = value?.trim() ?? "";
  return /^\d{4}-\d{2}-\d{2}$/.test(next) ? next : "";
};

const todayLocalKey = () => {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const safeFilenamePart = (value: string) => value
  .normalize("NFKC")
  .trim()
  .replace(/[^\p{L}\p{N}]+/gu, "-")
  .replace(/-+/g, "-")
  .replace(/^-|-$/g, "");

const reportSections = () => Array.from(document.querySelectorAll<HTMLElement>(REPORT_SECTION_SELECTOR));
const hasReportContext = () => reportSections().length > 0;

const activeReportTitle = () => {
  const sections = reportSections();
  const visible = sections.find((section) => !section.hasAttribute("aria-hidden") && section.getClientRects().length > 0);
  const section = visible ?? sections.find((candidate) => !candidate.hasAttribute("aria-hidden")) ?? sections[0];
  return section?.dataset.printTitle?.trim() ?? "";
};

const selectedReportRange = () => {
  const inputs = Array.from(document.querySelectorAll<HTMLInputElement>(REPORT_DATE_SELECTOR));
  return {
    from: validDateKey(inputs[0]?.value),
    to: validDateKey(inputs[1]?.value),
  };
};

const rangeSuffix = (from: string, to: string) => {
  if (from && to) return from === to ? from : `${from}_to_${to}`;
  if (from) return `from-${from}`;
  if (to) return `to-${to}`;
  return `Exported-${todayLocalKey()}`;
};

const fallbackTitleFromDownload = (download: string) => download
  .replace(/\.(csv|pdf)$/i, "")
  .replace(/(?:[-_](?:\d{4}-\d{2}-\d{2}|from-\d{4}-\d{2}-\d{2}|to-\d{4}-\d{2}-\d{2}|Exported-\d{4}-\d{2}-\d{2}|all-dates|start|end))+$/i, "")
  .replace(/[-_]+/g, " ")
  .trim();

export function buildCurrentReportExportFilename(download: string) {
  const extensionMatch = download.match(/\.(csv|pdf)$/i);
  if (!extensionMatch) return download;

  const title = activeReportTitle() || fallbackTitleFromDownload(download) || "Muzare Report";
  const safeTitle = safeFilenamePart(title) || "Muzare-Report";
  const { from, to } = selectedReportRange();
  return `${safeTitle}_${rangeSuffix(from, to)}.${extensionMatch[1].toLowerCase()}`;
}

export function buildCurrentReportPrintTitle() {
  const title = activeReportTitle() || "Muzare Report";
  const safeTitle = safeFilenamePart(title) || "Muzare-Report";
  const { from, to } = selectedReportRange();
  return `${safeTitle}_${rangeSuffix(from, to)}`;
}

/**
 * Standardize report filenames only at export/print time. There are no network,
 * IndexedDB, polling, MutationObserver, or report-render operations here.
 *
 * CSV and generated PDF exports use temporary download anchors. The capture
 * listener rewrites those anchors immediately before the browser handles them.
 * Browser print/save-as-PDF uses document.title as its suggested filename on
 * supported platforms, so the print wrapper supplies the same standardized
 * title and restores the app title after existing report cleanup finishes.
 */
export function installReportExportFilenameGuard() {
  if (typeof document === "undefined" || typeof window === "undefined") return () => undefined;

  let stableDocumentTitle = document.title;
  const onClickCapture = (event: MouseEvent) => {
    if (!hasReportContext()) return;
    const target = event.target;
    if (!(target instanceof Element)) return;

    // Capture the normal app title before React report/print handlers have a
    // chance to temporarily replace it. This makes restoration deterministic
    // even for report implementations that already manage document.title.
    if (target.closest("button")) stableDocumentTitle = document.title;

    const link = target.closest<HTMLAnchorElement>("a[download]");
    if (!link?.download || !/\.(csv|pdf)$/i.test(link.download)) return;
    link.download = buildCurrentReportExportFilename(link.download);
  };

  const previousPrint = window.print.bind(window);
  let restoreTimer = 0;
  let fallbackTimer = 0;

  const clearTimers = () => {
    if (restoreTimer) window.clearTimeout(restoreTimer);
    if (fallbackTimer) window.clearTimeout(fallbackTimer);
    restoreTimer = 0;
    fallbackTimer = 0;
  };

  const restoreTitle = (title: string) => {
    clearTimers();
    document.title = title;
    stableDocumentTitle = title;
  };

  window.print = () => {
    if (!hasReportContext()) {
      previousPrint();
      return;
    }

    clearTimers();
    const titleToRestore = stableDocumentTitle || document.title;
    document.title = buildCurrentReportPrintTitle();

    const afterPrint = () => {
      // Existing report print flows may also restore document.title. Run after
      // their cleanup so the final title is always the stable app title.
      restoreTimer = window.setTimeout(() => restoreTitle(titleToRestore), 400);
    };
    window.addEventListener("afterprint", afterPrint, { once: true });
    fallbackTimer = window.setTimeout(() => restoreTitle(titleToRestore), 120_000);
    previousPrint();
  };

  document.addEventListener("click", onClickCapture, true);

  return () => {
    document.removeEventListener("click", onClickCapture, true);
    clearTimers();
    window.print = previousPrint;
  };
}
