import { offlineDb, workspaceRecords, type Dispatch, type Vehicle } from "./offline-db";
import { type DispatchWithMarketReturns } from "./dispatch-sales";
import { formatDate, formatNumber } from "./format";

type ReturnRow = {
  id: string;
  returnDate: string;
  returnedAt: string;
  dispatchDate: string;
  dispatchNumber: string;
  dateTypeName: string;
  vehicle: string;
  cartons: number;
  note: string;
};

const text = () => {
  const language = document.documentElement.lang.slice(0, 2);
  if (language === "ur") return {
    tab: "فارم واپسی",
    title: "فارم کو واپس کیے گئے کارٹن",
    subtitle: "مارکیٹ سے بغیر فروخت واپس آنے والے کارٹن",
    from: "تاریخ سے",
    to: "تاریخ تک",
    total: "کل واپس کیے گئے کارٹن",
    records: "واپسی کے ریکارڈ",
    returnDate: "واپسی کی تاریخ",
    dispatchDate: "ڈسپیچ کی تاریخ",
    dispatch: "ڈسپیچ",
    type: "کھجور کی قسم",
    vehicle: "گاڑی",
    cartons: "کارٹنوں کی تعداد",
    note: "نوٹ",
    empty: "منتخب مدت میں کوئی کارٹن فارم واپس نہیں کیا گیا۔",
    csv: "CSV برآمد کریں",
    print: "پرنٹ / PDF",
    close: "بند کریں",
  };
  if (language === "ar") return {
    tab: "المرتجع للمزرعة",
    title: "الكرتون المرتجع إلى المزرعة",
    subtitle: "الكرتون غير المباع المعاد من السوق",
    from: "من تاريخ",
    to: "إلى تاريخ",
    total: "إجمالي الكرتون المرتجع",
    records: "سجلات الإرجاع",
    returnDate: "تاريخ الإرجاع",
    dispatchDate: "تاريخ الإرسال",
    dispatch: "الإرسال",
    type: "نوع التمر",
    vehicle: "المركبة",
    cartons: "عدد الكراتين",
    note: "ملاحظة",
    empty: "لا توجد كراتين مرتجعة إلى المزرعة في الفترة المحددة.",
    csv: "تصدير CSV",
    print: "طباعة / PDF",
    close: "إغلاق",
  };
  return {
    tab: "Returned to farm",
    title: "Returned to Farm Report",
    subtitle: "Unsold cartons returned from the market",
    from: "From date",
    to: "To date",
    total: "Total returned cartons",
    records: "Return records",
    returnDate: "Return date",
    dispatchDate: "Dispatch date",
    dispatch: "Dispatch",
    type: "Type of date",
    vehicle: "Vehicle",
    cartons: "Number of cartons",
    note: "Note",
    empty: "No cartons were returned to the farm in the selected period.",
    csv: "Export CSV",
    print: "Print / PDF",
    close: "Close",
  };
};

const dateKey = (value: string) => value.slice(0, 10);
const dispatchReference = (dispatch: Dispatch) =>
  dispatch.serialNumber?.trim()
  || dispatch.dispatchNumber?.trim()
  || `DIS-${dispatch.date.replaceAll("-", "")}-${dispatch.id.slice(0, 3).toUpperCase()}`;

async function loadRows(): Promise<ReturnRow[]> {
  const [dispatches, vehicles] = await Promise.all([
    workspaceRecords(offlineDb.dispatches),
    workspaceRecords(offlineDb.vehicles),
  ]);
  const vehicleMap = new Map((vehicles as Vehicle[]).map((vehicle) => [vehicle.id, vehicle.number]));
  const rows: ReturnRow[] = [];

  for (const dispatch of dispatches as DispatchWithMarketReturns[]) {
    for (const entry of dispatch.marketReturns ?? []) {
      const cartons = Math.max(Number(entry.cartons || 0), 0);
      if (!cartons) continue;
      rows.push({
        id: entry.id,
        returnDate: dateKey(entry.returnedAt),
        returnedAt: entry.returnedAt,
        dispatchDate: dispatch.date,
        dispatchNumber: dispatchReference(dispatch),
        dateTypeName: entry.dateTypeName?.trim() || "-",
        vehicle: (dispatch.vehicleId ? vehicleMap.get(dispatch.vehicleId) : undefined) || dispatch.vehicleNumber || "-",
        cartons,
        note: entry.note?.trim() || "-",
      });
    }
  }

  return rows.sort((a, b) => b.returnedAt.localeCompare(a.returnedAt));
}

function csvEscape(value: unknown) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function downloadCsv(rows: ReturnRow[], labels: ReturnType<typeof text>) {
  const data = [
    [labels.returnDate, labels.dispatchDate, labels.dispatch, labels.type, labels.vehicle, labels.cartons, labels.note],
    ...rows.map((row) => [row.returnDate, row.dispatchDate, row.dispatchNumber, row.dateTypeName, row.vehicle, row.cartons, row.note]),
  ];
  const blob = new Blob([data.map((row) => row.map(csvEscape).join(",")).join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `returned-to-farm-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function openReport() {
  const labels = text();
  const overlay = document.createElement("div");
  overlay.className = "returned-farm-report-overlay";
  overlay.innerHTML = `
    <section class="returned-farm-report" role="dialog" aria-modal="true" aria-label="${labels.title}">
      <header class="returned-farm-report__header">
        <div><h2>${labels.title}</h2><p>${labels.subtitle}</p></div>
        <button type="button" class="returned-farm-report__close" aria-label="${labels.close}">×</button>
      </header>
      <div class="returned-farm-report__filters">
        <label><span>${labels.from}</span><input type="date" data-return-from /></label>
        <label><span>${labels.to}</span><input type="date" data-return-to /></label>
      </div>
      <div class="returned-farm-report__summary"><span>${labels.total}</span><strong data-return-total>0</strong></div>
      <div class="returned-farm-report__actions">
        <button type="button" data-return-csv>${labels.csv}</button>
        <button type="button" data-return-print>${labels.print}</button>
      </div>
      <section class="returned-farm-report__records">
        <h3>${labels.records}</h3>
        <div data-return-table></div>
      </section>
    </section>`;
  document.body.append(overlay);

  const close = () => overlay.remove();
  overlay.addEventListener("click", (event) => { if (event.target === overlay) close(); });
  overlay.querySelector<HTMLButtonElement>(".returned-farm-report__close")?.addEventListener("click", close);

  const fromInput = overlay.querySelector<HTMLInputElement>("[data-return-from]")!;
  const toInput = overlay.querySelector<HTMLInputElement>("[data-return-to]")!;
  const total = overlay.querySelector<HTMLElement>("[data-return-total]")!;
  const table = overlay.querySelector<HTMLElement>("[data-return-table]")!;
  let allRows: ReturnRow[] = [];
  let visibleRows: ReturnRow[] = [];

  const render = () => {
    const from = fromInput.value;
    const to = toInput.value;
    visibleRows = allRows.filter((row) => (!from || row.returnDate >= from) && (!to || row.returnDate <= to));
    total.textContent = formatNumber(visibleRows.reduce((sum, row) => sum + row.cartons, 0));
    if (!visibleRows.length) {
      table.innerHTML = `<p class="returned-farm-report__empty">${labels.empty}</p>`;
      return;
    }
    table.innerHTML = `<div class="returned-farm-report__table-wrap"><table><thead><tr>
      <th>${labels.returnDate}</th><th>${labels.dispatchDate}</th><th>${labels.dispatch}</th><th>${labels.type}</th><th>${labels.vehicle}</th><th>${labels.cartons}</th><th>${labels.note}</th>
    </tr></thead><tbody>${visibleRows.map((row) => `<tr>
      <td>${formatDate(`${row.returnDate}T00:00:00`, { day: "2-digit", month: "short", year: "numeric" })}</td>
      <td>${formatDate(`${row.dispatchDate}T00:00:00`, { day: "2-digit", month: "short", year: "numeric" })}</td>
      <td>${row.dispatchNumber}</td><td>${row.dateTypeName}</td><td>${row.vehicle}</td><td><strong>${formatNumber(row.cartons)}</strong></td><td>${row.note}</td>
    </tr>`).join("")}</tbody></table></div>`;
  };

  fromInput.addEventListener("change", render);
  toInput.addEventListener("change", render);
  overlay.querySelector<HTMLButtonElement>("[data-return-csv]")?.addEventListener("click", () => downloadCsv(visibleRows, labels));
  overlay.querySelector<HTMLButtonElement>("[data-return-print]")?.addEventListener("click", () => {
    overlay.classList.add("is-printing");
    window.print();
    window.setTimeout(() => overlay.classList.remove("is-printing"), 250);
  });

  void loadRows().then((rows) => { allRows = rows; render(); });
}

export function installReturnedToFarmReport() {
  let stopped = false;
  const decorate = () => {
    if (stopped || !location.pathname.startsWith("/workspace/reports")) return;
    const tabs = document.querySelector<HTMLElement>(".reports-tabs");
    if (!tabs || tabs.querySelector("[data-returned-farm-report-tab]")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.returnedFarmReportTab = "true";
    button.textContent = text().tab;
    button.addEventListener("click", openReport);
    tabs.append(button);
  };

  const observer = new MutationObserver(decorate);
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener("popstate", decorate);
  window.addEventListener("muzare-data-refresh", decorate);
  decorate();

  return () => {
    stopped = true;
    observer.disconnect();
    window.removeEventListener("popstate", decorate);
    window.removeEventListener("muzare-data-refresh", decorate);
  };
}
