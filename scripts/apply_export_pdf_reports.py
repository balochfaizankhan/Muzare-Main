from pathlib import Path

pdf_path = Path("web/src/lib/reportPdf.ts")
pdf_text = pdf_path.read_text(encoding="utf-8")
if "type PdfColor = [number, number, number];" not in pdf_text:
    pdf_text = pdf_text.replace(
        'const BRAND = "Muzare";\n',
        'type PdfColor = [number, number, number];\n\nconst BRAND = "Muzare";\n',
        1,
    )
    for name, value in [
        ("GREEN", "[35, 109, 55]"),
        ("GREEN_DARK", "[28, 83, 44]"),
        ("GREEN_SOFT", "[239, 247, 241]"),
        ("BORDER", "[207, 220, 211]"),
        ("TEXT", "[38, 55, 44]"),
        ("MUTED", "[99, 116, 104]"),
    ]:
        pdf_text = pdf_text.replace(
            f"const {name} = {value} as const;",
            f"const {name}: PdfColor = {value};",
            1,
        )
    pdf_path.write_text(pdf_text, encoding="utf-8")

path = Path("web/src/pages/workspace/Reports.tsx")
text = path.read_text(encoding="utf-8")

if 'from "../../lib/reportPdf"' in text:
    print("Structured PDF report integration already applied; verified PDF generator types.")
    raise SystemExit(0)

replacements = [
    (
        'import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";',
        'import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";',
    ),
    (
        'import { useSyncState } from "../../hooks/useSyncState";\n',
        'import { useSyncState } from "../../hooks/useSyncState";\nimport { exportReportPdf } from "../../lib/reportPdf";\n',
    ),
    (
        'type ReportPrintDensity = "normal" | "wide";\n',
        'type ReportPrintDensity = "normal" | "wide";\n'
        'type CapturedCsvExport = { filename: string; rows: unknown[][] };\n'
        'const ReportPdfExportContext = createContext<ReportPrintContext | null>(null);\n'
        'let csvExportCapture: ((capture: CapturedCsvExport) => void) | null = null;\n',
    ),
    (
        'function downloadCsv(filename: string, rows: unknown[][]) {\n  const csv = rows.map((row) => row.map(csvCell).join(",")).join("\\n");',
        'function downloadCsv(filename: string, rows: unknown[][]) {\n'
        '  if (csvExportCapture) {\n'
        '    csvExportCapture({ filename, rows });\n'
        '    return;\n'
        '  }\n'
        '  const csv = rows.map((row) => row.map(csvCell).join(",")).join("\\n");',
    ),
    (
        '  onPrint: () => void;\n',
        '  onPrint?: () => void;\n',
    ),
]

for old, new in replacements:
    if old not in text:
        raise RuntimeError(f"Required source marker not found: {old[:120]!r}")
    text = text.replace(old, new, 1)

shell_marker = '  const { t } = useTranslation();\n  return <section\n'
shell_replacement = '''  const { t } = useTranslation();
  const inheritedPrintContext = useContext(ReportPdfExportContext);
  const resolvedPrintContext = printContext ?? inheritedPrintContext;
  const [pdfExporting, setPdfExporting] = useState(false);
  const isAttendanceReport = sectionId.startsWith("attendance");
  const handleStructuredPdfExport = async () => {
    if (pdfExporting) return;
    setPdfExporting(true);
    try {
      const captureHolder: { current?: CapturedCsvExport } = {};
      const previousCapture = csvExportCapture;
      csvExportCapture = (nextCapture) => { captureHolder.current = nextCapture; };
      try {
        onExport();
      } finally {
        csvExportCapture = previousCapture;
      }
      const captured = captureHolder.current;
      if (!captured) throw new Error("The report did not provide structured export rows.");
      await exportReportPdf({
        title,
        filename: captured.filename,
        rangeLabel,
        context: resolvedPrintContext,
        orientation: printLayout,
        rows: captured.rows,
        language: document.documentElement.lang || i18n.language,
        direction: document.documentElement.dir === "rtl" ? "rtl" : "ltr",
      });
    } catch (error) {
      console.error("Report PDF export failed", error);
      window.dispatchEvent(new CustomEvent("muzare-toast", {
        detail: t("reportsPage.pdfExportFailed", { defaultValue: "PDF export failed. Please try again." }),
      }));
    } finally {
      setPdfExporting(false);
    }
  };
  return <section
'''
if shell_marker not in text:
    raise RuntimeError("ReportShell body marker not found")
text = text.replace(shell_marker, shell_replacement, 1)

actions_old = '''      <div className="reports-actions">
        <button type="button" onClick={onExport}>{exportLabel ?? t("reportsPage.exportCsv")}</button>
        {onPdfExport ? <button type="button" onClick={onPdfExport}>{pdfLabel ?? t("reportsPage.exportPdf")}</button> : null}
        <button type="button" onClick={onPrint}>{printLabel ?? t("reportsPage.print")}</button>
      </div>'''
actions_new = '''      <div className="reports-actions">
        <button type="button" onClick={onExport}>{exportLabel ?? t("reportsPage.exportCsv")}</button>
        {isAttendanceReport ? <>
          {onPdfExport ? <button type="button" onClick={onPdfExport}>{pdfLabel ?? t("reportsPage.exportPdf")}</button> : null}
          {onPrint ? <button type="button" onClick={onPrint}>{printLabel ?? t("reportsPage.print")}</button> : null}
        </> : <button type="button" disabled={pdfExporting} onClick={() => void handleStructuredPdfExport()}>
          {pdfExporting
            ? t("reportsPage.generatingPdf", { defaultValue: "Generating PDF…" })
            : pdfLabel ?? t("reportsPage.exportPdf")}
        </button>}
      </div>'''
if actions_old not in text:
    raise RuntimeError("Report actions marker not found")
text = text.replace(actions_old, actions_new, 1)

return_marker = '  return <div className="dashboard-page">\n'
if return_marker not in text:
    raise RuntimeError("Reports return marker not found")
text = text.replace(return_marker, '  return <ReportPdfExportContext.Provider value={reportPrintContext}><div className="dashboard-page">\n', 1)

closing_marker = '    </main>\n  </div>;\n}\n'
if closing_marker not in text:
    raise RuntimeError("Reports closing marker not found")
text = text.replace(closing_marker, '    </main>\n  </div></ReportPdfExportContext.Provider>;\n}\n', 1)

path.write_text(text, encoding="utf-8")
print("Applied structured PDF export integration to Reports.tsx.")
