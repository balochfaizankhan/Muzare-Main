const REPORTS_ROUTE = "/workspace/reports";
const REPORT_SECTION_SELECTOR = ".reports-print-section--document[data-print-title]";
const REPORT_DATE_SELECTOR = ".reports-date-field input[type=\"date\"]";

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

const isReportsRoute = () => typeof window !== "undefined" && window.location.pathname.startsWith(REPORTS_ROUTE);

const activeReportTitle = () => {
  const sections = Array.from(document.querySelectorAll<HTMLElement>(REPORT_SECTION_SELECTOR));
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
 * Standardize only Reports-module exports at the instant a file is downloaded.
 * This has no network, IndexedDB, polling, observer, or report-render work.
 * CSV and generated PDF exports both use temporary download anchors, so one
 * capture listener covers every current report view without touching report data.
 *
 * Browser print/save-as-PDF uses document.title as its suggested filename on
 * supported platforms. The print wrapper sets that title before delegating to
 * Muzare's existing print bridge and restores it after the dialog closes.
 */
export function installReportExportFilenameGuard() {
  if (typeof document === "undefined" || typeof window === "undefined") return () => undefined;

  const onClickCapture = (event: MouseEvent) => {
    if (!isReportsRoute()) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const link = target.closest<HTMLAnchorElement>("a[download]");
    if (!link?.download || !/\.(csv|pdf)$/i.test(link.download)) return;
    link.download = buildCurrentReportExportFilename(link.download);
  };

  const previousPrint = window.print.bind(window);
  let originalDocumentTitle: string | null = null;
  let restoreTimer = 0;

  const restoreTitle = () => {
    if (restoreTimer) window.clearTimeout(restoreTimer);
    restoreTimer = 0;
    if (originalDocumentTitle !== null) {
      document.title = originalDocumentTitle;
      originalDocumentTitle = null;
    }
  };

  window.print = () => {
    if (!isReportsRoute()) {
      previousPrint();
      return;
    }
    restoreTitle();
    originalDocumentTitle = document.title;
    document.title = buildCurrentReportPrintTitle();
    window.addEventListener("afterprint", restoreTitle, { once: true });
    restoreTimer = window.setTimeout(restoreTitle, 120_000);
    previousPrint();
  };

  document.addEventListener("click", onClickCapture, true);

  return () => {
    document.removeEventListener("click", onClickCapture, true);
    restoreTitle();
    window.removeEventListener("afterprint", restoreTitle);
    window.print = previousPrint;
  };
}
