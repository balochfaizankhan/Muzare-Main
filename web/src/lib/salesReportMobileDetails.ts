const SALES_REPORT_SELECTOR = '[data-print-section="sales-report"]';
const CARD_SELECTOR = '.report-mobile-cards .report-mobile-card';
const ROW_SELECTOR = '.report-wide-table .report-data-table tbody tr';

function enhanceSalesReportCards(root: ParentNode) {
  const rows = Array.from(root.querySelectorAll<HTMLTableRowElement>(ROW_SELECTOR));
  const cards = Array.from(root.querySelectorAll<HTMLElement>(CARD_SELECTOR));
  if (!rows.length || !cards.length) return;

  cards.forEach((card, index) => {
    const row = rows[index];
    if (!row) return;
    if (card.querySelector('.sales-report-mobile-unit-price')) return;

    const meta = card.querySelector<HTMLElement>("header + span");
    if (!meta) return;

    const metaText = meta.textContent?.trim() ?? "";
    const dateOnly = metaText.split("|")[0]?.trim() ?? "";
    if (dateOnly) meta.textContent = dateOnly;

    const cells = Array.from(row.cells);
    const quantity = cells[7]?.textContent?.trim() ?? "";
    const unit = cells[8]?.textContent?.trim() ?? "";
    const rate = cells[9]?.textContent?.trim() ?? "";
    if (!quantity || !rate) return;

    const detail = document.createElement("span");
    detail.className = "sales-report-mobile-unit-price";
    detail.textContent = `${quantity}${unit ? ` ${unit}` : ""} × ${rate}`;
    meta.insertAdjacentElement("afterend", detail);
  });
}

export function installSalesReportMobileDetails() {
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      const root = document.querySelector<HTMLElement>(SALES_REPORT_SELECTOR);
      if (root) enhanceSalesReportCards(root);
    });
  };

  schedule();
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true });
  return () => observer.disconnect();
}
