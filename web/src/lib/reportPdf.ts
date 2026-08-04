import {
  createReportPdf as createBaseReportPdf,
  exportReportPdf as exportBaseReportPdf,
} from "./reportPdfBase";
import type { ReportPdfContext, ReportPdfSpec } from "./reportPdfBase";
import type { BootstrapData } from "./api";
import { getActiveFarmId, getActiveSeasonId } from "./offline-db";
import { queryClient } from "./query-client";

type ReportRow = unknown[];

type SalesPdfLabels = {
  dateType: string;
  cartons: string;
  rate: string;
};

const text = (value: unknown) => String(value ?? "").trim();
const blank = (row: ReportRow) => row.length === 0 || row.every((value) => !text(value));
const numberValue = (value: unknown) => {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = Number(String(value ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
};
const pick = (row: ReportRow, indexes: number[]) => indexes.map((index) => row[index] ?? "");
const pdfFilename = (filename: string) => {
  if (/\.pdf$/i.test(filename)) return filename;
  return `${filename.replace(/\.csv$/i, "")}.pdf`;
};

function firstTable(rows: ReportRow[], minimumColumns: number) {
  const headerIndex = rows.findIndex((row) => row.length >= minimumColumns && !blank(row));
  if (headerIndex < 0) return null;
  const header = rows[headerIndex];
  const data: ReportRow[] = [];
  for (let index = headerIndex + 1; index < rows.length; index += 1) {
    if (blank(rows[index])) break;
    if (rows[index].length < minimumColumns) break;
    data.push(rows[index]);
  }
  return { headerIndex, header, data };
}

function reportMetrics(rows: ReportRow[], tableHeaderIndex: number) {
  const preamble = rows.slice(0, tableHeaderIndex);
  const firstDivider = preamble.findIndex(blank);
  const reportBody = firstDivider >= 0 ? preamble.slice(firstDivider + 1) : preamble;
  return reportBody.filter((row) => row.length <= 2 && !blank(row));
}

function compactAdvanceSummary(rows: ReportRow[]) {
  const table = firstTable(rows, 11);
  if (!table) return rows;
  const columns = [1, 3, 5, 6, 7, 8, 10];
  const total = table.data.reduce((sum, row) => sum + numberValue(row[5]), 0);
  const adjusted = table.data.reduce((sum, row) => sum + numberValue(row[6]), 0);
  const outstanding = table.data.reduce((sum, row) => sum + numberValue(row[8]), 0);
  return [
    [table.header[9], table.data.reduce((sum, row) => sum + numberValue(row[9]), 0)],
    [table.header[5], total],
    [table.header[6], adjusted],
    [table.header[8], outstanding],
    [],
    pick(table.header, columns),
    ...table.data.map((row) => pick(row, columns)),
    [],
    [table.header[5], total],
  ];
}

function compactAdvanceDetail(rows: ReportRow[]) {
  const table = firstTable(rows, 11);
  if (!table) return rows;
  const columns = [4, 1, 5, 7, 8, 9, 10];
  const total = table.data.reduce((sum, row) => sum + numberValue(row[7]), 0);
  const recovered = table.data.reduce((sum, row) => sum + numberValue(row[8]), 0);
  return [
    [table.header[7], total],
    [table.header[8], recovered],
    [],
    pick(table.header, columns),
    ...table.data.map((row) => pick(row, columns)),
    [],
    [table.header[7], total],
  ];
}

function compactWageRates(rows: ReportRow[]) {
  const table = firstTable(rows, 6);
  if (!table) return rows;
  const columns = [0, 1, 2, 3, 5];
  return [pick(table.header, columns), ...table.data.map((row) => pick(row, columns))];
}

function salesPdfLabels(language?: string): SalesPdfLabels {
  const normalized = (language ?? "en").toLowerCase();
  if (normalized.startsWith("ar")) {
    return {
      dateType: "نوع التمر",
      cartons: "عدد الكراتين",
      rate: "السعر",
    };
  }
  if (normalized.startsWith("ur")) {
    return {
      dateType: "کھجور کی قسم",
      cartons: "کارٹنوں کی تعداد",
      rate: "ریٹ / قیمت",
    };
  }
  return {
    dateType: "Type of date",
    cartons: "Number of cartons",
    rate: "Rate / price",
  };
}

function compactSales(rows: ReportRow[], language?: string) {
  const table = firstTable(rows, 15);
  if (!table) return rows;

  // The PDF is intentionally ordered by operational importance:
  // sale date, invoice, date variety, carton count, price, amount, then buyer.
  // Payment status is omitted from the printable sales ledger.
  const columns = [1, 2, 6, 7, 9, 10, 3];
  const headers = pick(table.header, columns);
  const labels = salesPdfLabels(language);
  headers[2] = labels.dateType;
  headers[3] = labels.cartons;
  headers[4] = labels.rate;

  const total = table.data.reduce((sum, row) => sum + numberValue(row[10]), 0);
  return [
    ...reportMetrics(rows, table.headerIndex),
    [],
    headers,
    ...table.data.map((row) => pick(row, columns)),
    [],
    [table.header[10], total],
  ];
}

function compactDispatch(rows: ReportRow[]) {
  const table = firstTable(rows, 11);
  if (!table) return rows;
  const columns = [0, 1, 2, 3, 5, 8, 9];
  const total = table.data.reduce((sum, row) => sum + numberValue(row[3]), 0);
  return [
    ...reportMetrics(rows, table.headerIndex),
    [],
    pick(table.header, columns),
    ...table.data.map((row) => pick(row, columns)),
    [],
    [table.header[3], total],
  ];
}

function compactPartnerPosition(rows: ReportRow[]) {
  const table = firstTable(rows, 13);
  if (!table) return rows;
  const columns = [0, 3, 4, 7, 8, 9, 12];
  return [pick(table.header, columns), ...table.data.map((row) => pick(row, columns))];
}

function compactAccountBalances(rows: ReportRow[]) {
  const table = firstTable(rows, 6);
  if (!table) return rows;
  const columns = [0, 1, 3, 4, 5];
  return [pick(table.header, columns), ...table.data.map((row) => pick(row, columns))];
}

function compactAccountLedger(rows: ReportRow[]) {
  let inTable = false;
  return rows.map((row) => {
    if (blank(row)) {
      inTable = false;
      return row;
    }
    if (row.length >= 8) inTable = true;
    return inTable && row.length >= 8 ? pick(row, [0, 2, 3, 4, 5, 6, 7]) : row;
  });
}

function compactExpenseSummary(rows: ReportRow[]) {
  const fiveColumnHeader = rows.findIndex((row) => row.length === 5 && !blank(row));
  if (fiveColumnHeader < 0) return rows;
  let start = fiveColumnHeader;
  while (start > 0 && !blank(rows[start - 1])) start -= 1;
  let end = fiveColumnHeader + 1;
  while (end < rows.length && !blank(rows[end])) end += 1;
  return [...rows.slice(0, start), ...rows.slice(Math.min(end + 1, rows.length))];
}

function professionalRows(filename: string, rows: ReportRow[], language?: string) {
  const name = filename.toLowerCase();
  if (name.includes("labour-advances-summary")) return compactAdvanceSummary(rows);
  if (name.includes("labour-advances-detail")) return compactAdvanceDetail(rows);
  if (name.includes("wage-rates")) return compactWageRates(rows);
  if (name.includes("sales-report")) return compactSales(rows, language);
  if (name.includes("dispatch-report")) return compactDispatch(rows);
  if (name.includes("partner-position")) return compactPartnerPosition(rows);
  if (name.includes("account-balances")) return compactAccountBalances(rows);
  if (name.includes("account-ledger")) return compactAccountLedger(rows);
  if (name.includes("expense-summary")) return compactExpenseSummary(rows);
  return rows;
}

function professionalOrientation(filename: string, fallback: ReportPdfSpec["orientation"]) {
  const name = filename.toLowerCase();
  if (name.includes("sales-report")) return "portrait" as const;
  if (name.includes("dispatch-report") || name.includes("partner-position") || name.includes("account-ledger")) return "landscape" as const;
  if (name.includes("expense") || name.includes("advance") || name.includes("wage-rate") || name.includes("partner-ledger") || name.includes("account-balances")) return "portrait" as const;
  return fallback;
}

function currentBootstrapData(): BootstrapData | null {
  const activeFarmId = getActiveFarmId();
  const activeSeasonId = getActiveSeasonId();
  const reportCandidates = queryClient.getQueriesData<BootstrapData>({ queryKey: ["reports-bootstrap"] });

  const exactReport = reportCandidates.find(([queryKey]) => (
    Array.isArray(queryKey)
    && queryKey[2] === activeFarmId
    && queryKey[3] === activeSeasonId
  ))?.[1];
  if (exactReport) return exactReport;

  const reportMatch = reportCandidates
    .map(([, data]) => data)
    .find((data): data is BootstrapData => Boolean(
      data
      && (!activeFarmId || data.farms.some((farm) => farm.id === activeFarmId))
      && (!activeSeasonId || data.seasons.some((season) => season.id === activeSeasonId)),
    ));
  if (reportMatch) return reportMatch;

  const workspaceCandidates = queryClient.getQueriesData<BootstrapData>({ queryKey: ["workspace-bootstrap"] });
  return workspaceCandidates
    .map(([, data]) => data)
    .find((data): data is BootstrapData => Boolean(
      data
      && (!activeFarmId || data.farms.some((farm) => farm.id === activeFarmId))
      && (!activeSeasonId || data.seasons.some((season) => season.id === activeSeasonId)),
    )) ?? null;
}

function resolveScopedContext(context?: ReportPdfContext | null): ReportPdfContext | null | undefined {
  if (!context) return context;
  const bootstrap = currentBootstrapData();
  if (!bootstrap) return context;

  const activeFarmId = getActiveFarmId() ?? bootstrap.activeFarmId;
  const activeSeasonId = getActiveSeasonId() ?? bootstrap.activeSeasonId;
  const farmName = activeFarmId
    ? bootstrap.farms.find((farm) => farm.id === activeFarmId)?.name
    : undefined;
  const seasonName = activeSeasonId
    ? bootstrap.seasons.find((season) => season.id === activeSeasonId)?.name
    : undefined;

  return {
    ...context,
    farm: farmName?.trim() || context.farm,
    season: seasonName?.trim() || context.season,
  };
}

function professionalSpec(spec: ReportPdfSpec): ReportPdfSpec {
  return {
    ...spec,
    filename: pdfFilename(spec.filename),
    context: resolveScopedContext(spec.context),
    orientation: professionalOrientation(spec.filename, spec.orientation),
    variant: "minimal",
    rows: professionalRows(spec.filename, spec.rows, spec.language),
  };
}

export async function createReportPdf(spec: ReportPdfSpec): Promise<ArrayBuffer> {
  return createBaseReportPdf(professionalSpec(spec));
}

export async function exportReportPdf(spec: ReportPdfSpec): Promise<void> {
  return exportBaseReportPdf(professionalSpec(spec));
}

export type { ReportPdfContext, ReportPdfSpec };
