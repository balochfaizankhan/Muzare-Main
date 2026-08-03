import {
  createReportPdf as createBaseReportPdf,
  exportReportPdf as exportBaseReportPdf,
} from "./reportPdfBase";
import type { ReportPdfContext, ReportPdfSpec } from "./reportPdfBase";

type ReportRow = unknown[];

const text = (value: unknown) => String(value ?? "").trim();
const blank = (row: ReportRow) => row.length === 0 || row.every((value) => !text(value));
const numberValue = (value: unknown) => {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = Number(String(value ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
};
const pick = (row: ReportRow, indexes: number[]) => indexes.map((index) => row[index] ?? "");
const pdfFilename = (filename: string) => filename.replace(/\.csv$/i, ".pdf").replace(/(?<!\.pdf)$/i, ".pdf");

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

function compactSales(rows: ReportRow[]) {
  const table = firstTable(rows, 15);
  if (!table) return rows;
  const columns = [1, 2, 3, 6, 7, 10, 13];
  const metrics = rows
    .slice(0, table.headerIndex)
    .filter((row, index) => row.length === 2 && !blank(row) && index >= 3);
  const total = table.data.reduce((sum, row) => sum + numberValue(row[10]), 0);
  return [
    ...metrics,
    [],
    pick(table.header, columns),
    ...table.data.map((row) => pick(row, columns)),
    [],
    [table.header[10], total],
  ];
}

function compactDispatch(rows: ReportRow[]) {
  const table = firstTable(rows, 11);
  if (!table) return rows;
  const columns = [0, 1, 2, 3, 5, 8, 9];
  const metrics = rows
    .slice(0, table.headerIndex)
    .filter((row, index) => row.length === 2 && !blank(row) && index >= 3);
  const total = table.data.reduce((sum, row) => sum + numberValue(row[3]), 0);
  return [
    ...metrics,
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

function professionalRows(filename: string, rows: ReportRow[]) {
  const name = filename.toLowerCase();
  if (name.includes("labour-advances-summary")) return compactAdvanceSummary(rows);
  if (name.includes("labour-advances-detail")) return compactAdvanceDetail(rows);
  if (name.includes("wage-rates")) return compactWageRates(rows);
  if (name.includes("sales-report")) return compactSales(rows);
  if (name.includes("dispatch-report")) return compactDispatch(rows);
  if (name.includes("partner-position")) return compactPartnerPosition(rows);
  if (name.includes("account-balances")) return compactAccountBalances(rows);
  if (name.includes("account-ledger")) return compactAccountLedger(rows);
  if (name.includes("expense-summary")) return compactExpenseSummary(rows);
  return rows;
}

function professionalOrientation(filename: string, fallback: ReportPdfSpec["orientation"]) {
  const name = filename.toLowerCase();
  if (name.includes("sales-report") || name.includes("dispatch-report") || name.includes("partner-position") || name.includes("account-ledger")) return "landscape" as const;
  if (name.includes("expense") || name.includes("advance") || name.includes("wage-rate") || name.includes("partner-ledger") || name.includes("account-balances")) return "portrait" as const;
  return fallback;
}

function professionalSpec(spec: ReportPdfSpec): ReportPdfSpec {
  return {
    ...spec,
    filename: pdfFilename(spec.filename),
    orientation: professionalOrientation(spec.filename, spec.orientation),
    variant: "minimal",
    rows: professionalRows(spec.filename, spec.rows),
  };
}

export async function createReportPdf(spec: ReportPdfSpec): Promise<ArrayBuffer> {
  return createBaseReportPdf(professionalSpec(spec));
}

export async function exportReportPdf(spec: ReportPdfSpec): Promise<void> {
  return exportBaseReportPdf(professionalSpec(spec));
}

export type { ReportPdfContext, ReportPdfSpec };
