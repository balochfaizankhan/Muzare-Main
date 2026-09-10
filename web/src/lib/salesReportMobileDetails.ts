const SALES_REPORT_SELECTOR = '[data-print-section="sales-report"]';
const CARD_SELECTOR = '.report-mobile-cards .report-mobile-card';
const ROW_SELECTOR = '.report-wide-table .report-data-table tbody tr';
const FILTERS_BUTTON_ID = 'sales-report-more-filters';
const FILTERS_READY_CLASS = 'sales-report-mobile-filters-ready';
const ADVANCED_FIELD_CLASS = 'sales-report-mobile-advanced-filter';
const COMPACT_CLASS = 'sales-report-mobile-compact';

function normalizeText(value: string | null | undefined) {
  return value?.replace(/\s+/g, ' ').trim().toLowerCase() ?? '';
}

function findSalesFilterPanel(): HTMLElement | null {
  const heading = Array.from(document.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')).find(
    (element) => normalizeText(element.textContent) === 'report filters',
  );
  if (!heading) return null;

  let current = heading.parentElement;
  for (let depth = 0; current && depth < 7; depth += 1, current = current.parentElement) {
    const text = normalizeText(current.textContent);
    const controls = current.querySelectorAll('input, select, button').length;
    if (text.includes('clear filters') && controls >= 5) return current;
  }
  return null;
}

function findGridField(control: HTMLElement, panel: HTMLElement): HTMLElement | null {
  let current: HTMLElement | null = control;
  while (current && current !== panel) {
    const parent = current.parentElement;
    if (parent && window.getComputedStyle(parent).display === 'grid') return current;
    current = parent;
  }
  return control.parentElement;
}

function markAdvancedField(control: HTMLElement, panel: HTMLElement) {
  const field = findGridField(control, panel);
  if (field && field !== panel) field.classList.add(ADVANCED_FIELD_CLASS);
}

function setupSalesReportFilters() {
  const panel = findSalesFilterPanel();
  if (!panel || window.matchMedia('(min-width: 768px)').matches) return;

  panel.classList.add(FILTERS_READY_CLASS);

  const optionalInputs = Array.from(panel.querySelectorAll<HTMLInputElement>('input')).filter((input) => {
    const placeholder = normalizeText(input.getAttribute('placeholder'));
    if (placeholder.includes('invoice') || placeholder.includes('buyer name') || placeholder.includes('reference')) return true;
    if (placeholder === 'buyer') return true;
    if (placeholder.includes('product') || placeholder.includes('variety')) return true;
    if (placeholder.includes('minimum amount') || placeholder.includes('maximum amount')) return true;
    return false;
  });
  optionalInputs.forEach((input) => markAdvancedField(input, panel));

  const advancedSelects = Array.from(panel.querySelectorAll<HTMLElement>('button')).filter((button) => {
    const text = normalizeText(button.textContent);
    return text.startsWith('all sale') || text.startsWith('all pay') || text === 'sale date';
  });
  advancedSelects.forEach((button) => markAdvancedField(button, panel));

  let toggle = panel.querySelector<HTMLButtonElement>(`#${FILTERS_BUTTON_ID}`);
  if (!toggle) {
    const clearButton = Array.from(panel.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => normalizeText(button.textContent) === 'clear filters',
    );
    if (!clearButton) return;

    toggle = document.createElement('button');
    toggle.id = FILTERS_BUTTON_ID;
    toggle.type = 'button';
    toggle.className = clearButton.className;
    toggle.textContent = 'More filters';
    toggle.setAttribute('aria-expanded', 'false');
    clearButton.insertAdjacentElement('beforebegin', toggle);

    toggle.addEventListener('click', () => {
      const expanded = panel.classList.toggle('sales-report-mobile-filters-expanded');
      toggle?.setAttribute('aria-expanded', String(expanded));
      if (toggle) toggle.textContent = expanded ? 'Hide filters' : 'More filters';
    });
  }
}

function compactSalesReport(root: HTMLElement) {
  if (!window.matchMedia('(min-width: 768px)').matches) root.classList.add(COMPACT_CLASS);
}

function enhanceSalesReportCards(root: ParentNode) {
  const rows = Array.from(root.querySelectorAll<HTMLTableRowElement>(ROW_SELECTOR));
  const cards = Array.from(root.querySelectorAll<HTMLElement>(CARD_SELECTOR));
  if (!rows.length || !cards.length) return;

  cards.forEach((card, index) => {
    const row = rows[index];
    if (!row) return;
    const meta = card.querySelector<HTMLElement>('header + span');
    if (!meta || meta.querySelector('.sales-report-mobile-unit-price')) return;

    const metaText = meta.textContent?.trim() ?? '';
    const dateOnly = metaText.split('|')[0]?.trim() ?? '';
    if (dateOnly) meta.textContent = dateOnly;

    const cells = Array.from(row.cells);
    const quantity = cells[7]?.textContent?.trim() ?? '';
    const unit = cells[8]?.textContent?.trim() ?? '';
    const rate = cells[9]?.textContent?.trim() ?? '';
    if (!quantity || !rate) return;

    const detail = document.createElement('span');
    detail.className = 'sales-report-mobile-unit-price';
    detail.textContent = `${quantity}${unit ? ` ${unit}` : ''} × ${rate}`;
    meta.insertAdjacentElement('afterend', detail);
  });
}

function installMobileSalesReportStyles() {
  const styleId = 'sales-report-mobile-refinement-styles';
  if (document.getElementById(styleId)) return;

  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = `
    @media (max-width: 767px) {
      .sales-report-mobile-filters-ready .${ADVANCED_FIELD_CLASS} { display: none !important; }
      .sales-report-mobile-filters-ready.sales-report-mobile-filters-expanded .${ADVANCED_FIELD_CLASS} { display: block !important; }
      #${FILTERS_BUTTON_ID} { display: inline-flex; }
      .sales-report-mobile-compact { padding: 16px !important; }
      .sales-report-mobile-compact .report-mobile-cards { gap: 8px !important; }
      .sales-report-mobile-compact .report-mobile-card { padding: 12px !important; }
      .sales-report-mobile-compact .sales-report-mobile-unit-price { margin-top: 1px; font-size: 0.82rem; }
      .sales-report-mobile-compact h2 { margin-bottom: 4px !important; }
      .sales-report-mobile-compact .report-mobile-card + .report-mobile-card { margin-top: 0 !important; }
    }
    @media (min-width: 768px) { #${FILTERS_BUTTON_ID} { display: none !important; } }
  `;
  document.head.appendChild(style);
}

export function installSalesReportMobileDetails() {
  installMobileSalesReportStyles();

  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      const root = document.querySelector<HTMLElement>(SALES_REPORT_SELECTOR);
      if (root) {
        compactSalesReport(root);
        enhanceSalesReportCards(root);
      }
      setupSalesReportFilters();
    });
  };

  schedule();
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true });
  return () => observer.disconnect();
}
