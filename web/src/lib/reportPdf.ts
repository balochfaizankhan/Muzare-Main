type ReportPdfContext = {
  workspace: string;
  farm: string;
  season: string;
  generatedAt: string;
  generatedBy: string;
};

type ReportPdfSpec = {
  title: string;
  filename: string;
  rangeLabel: string;
  context?: ReportPdfContext | null;
  orientation?: "portrait" | "landscape";
  rows: unknown[][];
  language?: string;
  direction?: "ltr" | "rtl";
};

type NormalizedRow = string[];

type MetricsBlock = {
  kind: "metrics";
  title?: string;
  rows: Array<[string, string]>;
};

type TableBlock = {
  kind: "table";
  title?: string;
  headers: string[];
  rows: string[][];
};

type ReportBlock = MetricsBlock | TableBlock;

type PdfColor = [number, number, number];

const BRAND = "Muzare";
const GREEN: PdfColor = [35, 109, 55];
const GREEN_DARK: PdfColor = [28, 83, 44];
const GREEN_SOFT: PdfColor = [239, 247, 241];
const BORDER: PdfColor = [207, 220, 211];
const TEXT: PdfColor = [38, 55, 44];
const MUTED: PdfColor = [99, 116, 104];
const ARABIC_FONT_URL = new URL("../assets/fonts/NotoSansArabic-Regular.ttf", import.meta.url).href;
const ARABIC_FONT_FILE = "NotoSansArabic.ttf";
const ARABIC_FONT_FAMILY = "NotoSansArabic";

let arabicFontBase64Promise: Promise<string | null> | null = null;

const normalizeFilename = (filename: string) => {
  const base = filename.replace(/\.csv$/i, "").replace(/\.pdf$/i, "");
  const safe = base
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `${safe || "muzare-report"}.pdf`;
};

const normalizeValue = (value: unknown) => {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value).replace(/\s+/g, " ").trim();
};

const normalizeRows = (rows: unknown[][]): NormalizedRow[] => rows.map((row) => row.map(normalizeValue));
const rowIsBlank = (row: NormalizedRow) => row.every((cell) => !cell);
const trimTrailingEmptyCells = (row: NormalizedRow) => {
  const next = [...row];
  while (next.length > 0 && !next[next.length - 1]) next.pop();
  return next;
};

const splitIntoBlocks = (rows: NormalizedRow[]) => {
  const blocks: NormalizedRow[][] = [];
  let current: NormalizedRow[] = [];
  for (const sourceRow of rows) {
    const row = trimTrailingEmptyCells(sourceRow);
    if (rowIsBlank(row)) {
      if (current.length > 0) blocks.push(current);
      current = [];
      continue;
    }
    current.push(row);
  }
  if (current.length > 0) blocks.push(current);
  return blocks;
};

const looksLikeExportHeader = (block: NormalizedRow[]) => {
  if (block.length < 2) return false;
  const first = block[0]?.[0]?.toLocaleLowerCase() ?? "";
  return first === BRAND.toLocaleLowerCase() && block.every((row) => row.length <= 2);
};

const parseBlocks = (rows: unknown[][]): ReportBlock[] => {
  const rawBlocks = splitIntoBlocks(normalizeRows(rows));
  return rawBlocks.flatMap<ReportBlock>((block, blockIndex) => {
    if (blockIndex === 0 && looksLikeExportHeader(block)) return [];
    const maxColumns = Math.max(...block.map((row) => row.length));
    if (maxColumns <= 2) {
      const firstRowIsTitle = block.length > 1 && block[0].length <= 2 && !block[0][1];
      const title = firstRowIsTitle ? block[0][0] : undefined;
      const sourceRows = firstRowIsTitle ? block.slice(1) : block;
      const metricRows = sourceRows
        .filter((row) => row.some(Boolean))
        .map((row) => [row[0] || "—", row[1] || "—"] as [string, string]);
      return metricRows.length > 0 ? [{ kind: "metrics", title, rows: metricRows }] : [];
    }

    let title: string | undefined;
    let tableRows = block;
    if (block.length > 1 && block[0].length < maxColumns) {
      title = block[0].filter(Boolean).join(" • ");
      tableRows = block.slice(1);
    }
    if (tableRows.length === 0) return [];
    const headers = Array.from({ length: maxColumns }, (_, index) => tableRows[0]?.[index] || `Column ${index + 1}`);
    const body = tableRows.slice(1).map((row) => Array.from({ length: maxColumns }, (_, index) => row[index] || ""));
    return [{ kind: "table", title, headers, rows: body }];
  });
};

const arrayBufferToBase64 = (buffer: ArrayBuffer) => {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, Math.min(index + chunkSize, bytes.length)));
  }
  return btoa(binary);
};

const loadArabicFontBase64 = () => {
  if (!arabicFontBase64Promise) {
    arabicFontBase64Promise = fetch(ARABIC_FONT_URL, { cache: "force-cache" })
      .then((response) => {
        if (!response.ok) throw new Error(`Unable to load PDF font (${response.status})`);
        return response.arrayBuffer();
      })
      .then(arrayBufferToBase64)
      .catch(() => null);
  }
  return arabicFontBase64Promise;
};

const containsArabicScript = (value: string) => /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/u.test(value);

export async function createReportPdf(spec: ReportPdfSpec): Promise<ArrayBuffer> {
  const [{ jsPDF }, autoTableModule] = await Promise.all([
    import("jspdf"),
    import("jspdf-autotable"),
  ]);
  const autoTable = autoTableModule.default;
  const orientation = spec.orientation ?? "landscape";
  const rtl = spec.direction === "rtl" || /^(ar|ur)(-|$)/i.test(spec.language ?? "");
  const doc = new jsPDF({ orientation, unit: "pt", format: "a4", compress: true, putOnlyUsedFonts: true });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = orientation === "landscape" ? 34 : 32;
  const usableWidth = pageWidth - margin * 2;
  const blocks = parseBlocks(spec.rows);
  const allText = [
    spec.title,
    spec.rangeLabel,
    spec.context?.workspace,
    spec.context?.farm,
    spec.context?.season,
    spec.context?.generatedAt,
    spec.context?.generatedBy,
    ...blocks.flatMap((block) => block.kind === "metrics"
      ? block.rows.flatMap((row) => row)
      : [block.title ?? "", ...block.headers, ...block.rows.flat()]),
  ].filter(Boolean).join(" ");

  let fontFamily = "helvetica";
  if (rtl || containsArabicScript(allText)) {
    const fontBase64 = typeof fetch === "function" ? await loadArabicFontBase64() : null;
    if (fontBase64) {
      doc.addFileToVFS(ARABIC_FONT_FILE, fontBase64);
      doc.addFont(ARABIC_FONT_FILE, ARABIC_FONT_FAMILY, "normal");
      doc.addFont(ARABIC_FONT_FILE, ARABIC_FONT_FAMILY, "bold");
      fontFamily = ARABIC_FONT_FAMILY;
    }
  }
  doc.setFont(fontFamily, "normal");
  (doc as unknown as { setR2L?: (enabled: boolean) => void }).setR2L?.(rtl);

  const shapeText = (value: string) => {
    if (!containsArabicScript(value)) return value;
    const processor = (doc as unknown as { processArabic?: (text: string) => string }).processArabic;
    return processor ? processor(value) : value;
  };
  const align = rtl ? "right" : "left";
  const alignX = rtl ? pageWidth - margin : margin;
  const drawnHeaderPages = new Set<number>();

  const drawMiniHeader = () => {
    const pageNumber = doc.getCurrentPageInfo().pageNumber;
    if (drawnHeaderPages.has(pageNumber)) return;
    drawnHeaderPages.add(pageNumber);
    doc.setFillColor(...GREEN_DARK);
    doc.rect(0, 0, pageWidth, 36, "F");
    doc.setFont(fontFamily, "bold");
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(9);
    doc.text(shapeText(BRAND), rtl ? pageWidth - margin : margin, 22, { align });
    doc.setFont(fontFamily, "normal");
    doc.setFontSize(8);
    doc.text(shapeText(spec.title), rtl ? margin : pageWidth - margin, 22, { align: rtl ? "left" : "right" });
  };

  const drawCoverHeader = () => {
    drawnHeaderPages.add(1);
    doc.setFillColor(...GREEN_DARK);
    doc.roundedRect(margin, 24, usableWidth, 62, 8, 8, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFont(fontFamily, "bold");
    doc.setFontSize(11);
    doc.text(shapeText(BRAND.toUpperCase()), alignX, 45, { align });
    doc.setFontSize(20);
    doc.text(shapeText(spec.title), alignX, 69, { align, maxWidth: usableWidth - 20 });
    doc.setFont(fontFamily, "normal");
    doc.setFontSize(8.5);
    doc.text(shapeText(spec.rangeLabel), rtl ? margin + 10 : pageWidth - margin - 10, 45, { align: rtl ? "left" : "right" });
  };

  drawCoverHeader();
  let cursorY = 100;

  const contextRows: Array<[string, string]> = spec.context ? [
    ["Workspace", spec.context.workspace],
    ["Farm", spec.context.farm],
    ["Season", spec.context.season],
    ["Generated", spec.context.generatedAt],
    ["Generated by", spec.context.generatedBy],
  ] : [];

  if (contextRows.length > 0) {
    const columns = orientation === "landscape" ? 5 : 2;
    const gap = 6;
    const cardWidth = (usableWidth - gap * (columns - 1)) / columns;
    const cardHeight = 38;
    contextRows.forEach(([label, value], index) => {
      const row = Math.floor(index / columns);
      const column = index % columns;
      const logicalColumn = rtl ? columns - column - 1 : column;
      const x = margin + logicalColumn * (cardWidth + gap);
      const y = cursorY + row * (cardHeight + gap);
      doc.setFillColor(...GREEN_SOFT);
      doc.setDrawColor(...BORDER);
      doc.roundedRect(x, y, cardWidth, cardHeight, 4, 4, "FD");
      doc.setFont(fontFamily, "normal");
      doc.setTextColor(...MUTED);
      doc.setFontSize(6.5);
      doc.text(shapeText(label.toUpperCase()), rtl ? x + cardWidth - 7 : x + 7, y + 12, { align });
      doc.setFont(fontFamily, "bold");
      doc.setTextColor(...TEXT);
      doc.setFontSize(8);
      doc.text(shapeText(value || "—"), rtl ? x + cardWidth - 7 : x + 7, y + 27, { align, maxWidth: cardWidth - 14 });
    });
    cursorY += Math.ceil(contextRows.length / columns) * (cardHeight + gap) + 8;
  }

  const addPage = () => {
    doc.addPage();
    drawMiniHeader();
    cursorY = 52;
  };

  const ensureSpace = (required: number) => {
    if (cursorY + required > pageHeight - 38) addPage();
  };

  const drawSectionTitle = (title?: string) => {
    if (!title) return;
    ensureSpace(28);
    doc.setFillColor(...GREEN_SOFT);
    doc.setDrawColor(...BORDER);
    doc.roundedRect(margin, cursorY, usableWidth, 24, 4, 4, "FD");
    doc.setFont(fontFamily, "bold");
    doc.setTextColor(...GREEN_DARK);
    doc.setFontSize(9);
    doc.text(shapeText(title), rtl ? pageWidth - margin - 8 : margin + 8, cursorY + 16, { align, maxWidth: usableWidth - 16 });
    cursorY += 31;
  };

  const drawMetrics = (block: MetricsBlock) => {
    drawSectionTitle(block.title);
    const columns = orientation === "landscape" ? 4 : 2;
    const gap = 7;
    const cardWidth = (usableWidth - gap * (columns - 1)) / columns;
    const cardHeight = 46;
    for (let index = 0; index < block.rows.length; index += columns) {
      ensureSpace(cardHeight + gap);
      block.rows.slice(index, index + columns).forEach(([label, value], offset) => {
        const logicalOffset = rtl ? columns - offset - 1 : offset;
        const x = margin + logicalOffset * (cardWidth + gap);
        doc.setFillColor(250, 252, 250);
        doc.setDrawColor(...BORDER);
        doc.roundedRect(x, cursorY, cardWidth, cardHeight, 5, 5, "FD");
        doc.setFont(fontFamily, "normal");
        doc.setTextColor(...MUTED);
        doc.setFontSize(7);
        doc.text(shapeText(label), rtl ? x + cardWidth - 8 : x + 8, cursorY + 15, { align, maxWidth: cardWidth - 16 });
        doc.setFont(fontFamily, "bold");
        doc.setTextColor(...TEXT);
        doc.setFontSize(10);
        doc.text(shapeText(value || "—"), rtl ? x + cardWidth - 8 : x + 8, cursorY + 34, { align, maxWidth: cardWidth - 16 });
      });
      cursorY += cardHeight + gap;
    }
    cursorY += 4;
  };

  const drawTable = (block: TableBlock) => {
    drawSectionTitle(block.title);
    if (block.rows.length === 0) {
      ensureSpace(28);
      doc.setFont(fontFamily, "normal");
      doc.setTextColor(...MUTED);
      doc.setFontSize(8);
      doc.text("No records", alignX, cursorY + 14, { align });
      cursorY += 28;
      return;
    }
    autoTable(doc, {
      startY: cursorY,
      head: [block.headers.map(shapeText)],
      body: block.rows.map((row) => row.map(shapeText)),
      theme: "grid",
      margin: { left: margin, right: margin, top: 52, bottom: 34 },
      styles: {
        font: fontFamily,
        fontSize: orientation === "landscape" ? 6.6 : 7,
        cellPadding: 3.5,
        lineColor: BORDER,
        lineWidth: 0.35,
        textColor: TEXT,
        overflow: "linebreak",
        halign: align,
        valign: "middle",
      },
      headStyles: {
        fillColor: GREEN,
        textColor: [255, 255, 255],
        font: fontFamily,
        fontStyle: "bold",
        halign: align,
        lineColor: GREEN_DARK,
      },
      alternateRowStyles: { fillColor: [248, 251, 249] },
      didDrawPage: () => {
        if (doc.getCurrentPageInfo().pageNumber > 1) drawMiniHeader();
      },
    });
    cursorY = ((doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY ?? cursorY) + 12;
  };

  blocks.forEach((block) => {
    if (block.kind === "metrics") drawMetrics(block);
    else drawTable(block);
  });

  const totalPages = doc.getNumberOfPages();
  for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
    doc.setPage(pageNumber);
    doc.setDrawColor(...BORDER);
    doc.line(margin, pageHeight - 25, pageWidth - margin, pageHeight - 25);
    doc.setFont(fontFamily, "normal");
    doc.setFontSize(7);
    doc.setTextColor(...MUTED);
    doc.text(shapeText(BRAND), rtl ? pageWidth - margin : margin, pageHeight - 12, { align });
    doc.text(`${pageNumber} / ${totalPages}`, rtl ? margin : pageWidth - margin, pageHeight - 12, { align: rtl ? "left" : "right" });
  }

  return doc.output("arraybuffer");
}

export async function exportReportPdf(spec: ReportPdfSpec): Promise<void> {
  const buffer = await createReportPdf(spec);
  const blob = new Blob([buffer], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = normalizeFilename(spec.filename);
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export type { ReportPdfContext, ReportPdfSpec };
