from pathlib import Path

path = Path("web/src/lib/reportPdf.ts")
text = path.read_text(encoding="utf-8")

font_guard = '      if (document.fonts.check(`12px "${REPORT_FONT_FAMILY}"`)) return true;\n'
if font_guard in text:
    text = text.replace(font_guard, "", 1)

old = '''  block.rows.forEach((row, rowIndex) => {
    setCanvasFont(activeSurface.context, fontSize, 400);
    const wrappedCells = block.headers.map((_, columnIndex) => {
      const raw = row[columnIndex] || "—";
      const display = percentColumns[columnIndex] && valueLooksNumeric(raw) && !raw.includes("%") ? `${raw}%` : raw;
      return wrapText(activeSurface.context, display, widths[columnIndex] - TABLE_CELL_PADDING_X * 2, dense ? 2 : 3);
    });
    const maximumLines = Math.max(...wrappedCells.map((lines) => lines.length));
    const rowHeight = clamp(maximumLines * (fontSize + 2.2) + TABLE_CELL_PADDING_Y * 2, dense ? 20 : 23, dense ? 42 : 52);

    if (activeSurface.cursorY + rowHeight > pageHeight - PAGE_BOTTOM) {
      activeSurface = requestNewPage();
      drawSectionAndHeader(true);
    }

    let x = PAGE_MARGIN;
    for (const logicalIndex of visualIndices) {
      const width = widths[logicalIndex];
      const cellY = activeSurface.cursorY;
      activeSurface.context.fillStyle = rowIndex % 2 === 0 ? rgb(WHITE) : rgb(GREEN_FAINT);
      activeSurface.context.fillRect(x, cellY, width, rowHeight);

      if (percentColumns[logicalIndex]) {
        const numericValue = Number((row[logicalIndex] || "").replace(/[^\\d.-]/g, ""));
        if (Number.isFinite(numericValue) && numericValue > 0) {
          const barWidth = (width - 4) * clamp(numericValue / 100, 0, 1);
          activeSurface.context.fillStyle = rgb(GREEN, 0.1);
          activeSurface.context.fillRect(rtl ? x + width - 2 - barWidth : x + 2, cellY + 2, barWidth, rowHeight - 4);
        }
      }

      activeSurface.context.strokeStyle = rgb(BORDER);
      activeSurface.context.lineWidth = 0.55;
      activeSurface.context.strokeRect(x, cellY, width, rowHeight);

      const raw = row[logicalIndex] || "—";
      const numeric = valueLooksNumeric(raw);
      const align: TextAlign = numeric ? "right" : rtl ? "right" : "left";
      const textX = align === "right" ? x + width - TABLE_CELL_PADDING_X : x + TABLE_CELL_PADDING_X;
      const lines = wrappedCells[logicalIndex];
      const totalTextHeight = (lines.length - 1) * (fontSize + 2.2);
      const baseline = cellY + (rowHeight - totalTextHeight) / 2 + fontSize * 0.36;
      setCanvasFont(activeSurface.context, fontSize, numeric ? 600 : 430);
      drawTextLines(activeSurface.context, lines, textX, baseline, fontSize + 2.2, align, rtl ? "rtl" : "ltr", TEXT);
      x += width;
    }
    activeSurface.cursorY += rowHeight;
  });'''

new = '''  block.rows.forEach((row, rowIndex) => {
    setCanvasFont(activeSurface.context, fontSize, 400);
    const wrappedCells = block.headers.map((_, columnIndex) => {
      const raw = row[columnIndex] || "—";
      const display = percentColumns[columnIndex] && valueLooksNumeric(raw) && !raw.includes("%") ? `${raw}%` : raw;
      return wrapText(activeSurface.context, display, widths[columnIndex] - TABLE_CELL_PADDING_X * 2);
    });
    const maximumLines = Math.max(...wrappedCells.map((lines) => lines.length));
    const lineHeight = fontSize + 2.2;
    let lineOffset = 0;

    while (lineOffset < maximumLines) {
      let availableHeight = pageHeight - PAGE_BOTTOM - activeSurface.cursorY;
      let linesThatFit = Math.floor((availableHeight - TABLE_CELL_PADDING_Y * 2) / lineHeight);
      if (linesThatFit < 1) {
        activeSurface = requestNewPage();
        drawSectionAndHeader(true);
        availableHeight = pageHeight - PAGE_BOTTOM - activeSurface.cursorY;
        linesThatFit = Math.max(1, Math.floor((availableHeight - TABLE_CELL_PADDING_Y * 2) / lineHeight));
      }

      const chunkLineCount = Math.min(linesThatFit, maximumLines - lineOffset);
      const rowHeight = Math.max(dense ? 20 : 23, chunkLineCount * lineHeight + TABLE_CELL_PADDING_Y * 2);
      let x = PAGE_MARGIN;

      for (const logicalIndex of visualIndices) {
        const width = widths[logicalIndex];
        const cellY = activeSurface.cursorY;
        activeSurface.context.fillStyle = rowIndex % 2 === 0 ? rgb(WHITE) : rgb(GREEN_FAINT);
        activeSurface.context.fillRect(x, cellY, width, rowHeight);

        if (lineOffset === 0 && percentColumns[logicalIndex]) {
          const numericValue = Number((row[logicalIndex] || "").replace(/[^\\d.-]/g, ""));
          if (Number.isFinite(numericValue) && numericValue > 0) {
            const barWidth = (width - 4) * clamp(numericValue / 100, 0, 1);
            activeSurface.context.fillStyle = rgb(GREEN, 0.1);
            activeSurface.context.fillRect(rtl ? x + width - 2 - barWidth : x + 2, cellY + 2, barWidth, rowHeight - 4);
          }
        }

        activeSurface.context.strokeStyle = rgb(BORDER);
        activeSurface.context.lineWidth = 0.55;
        activeSurface.context.strokeRect(x, cellY, width, rowHeight);

        const raw = row[logicalIndex] || "—";
        const numeric = valueLooksNumeric(raw);
        const align: TextAlign = numeric ? "right" : rtl ? "right" : "left";
        const textX = align === "right" ? x + width - TABLE_CELL_PADDING_X : x + TABLE_CELL_PADDING_X;
        const lines = wrappedCells[logicalIndex].slice(lineOffset, lineOffset + chunkLineCount);
        if (lines.length > 0) {
          const totalTextHeight = (lines.length - 1) * lineHeight;
          const baseline = cellY + (rowHeight - totalTextHeight) / 2 + fontSize * 0.36;
          setCanvasFont(activeSurface.context, fontSize, numeric ? 600 : 430);
          drawTextLines(activeSurface.context, lines, textX, baseline, lineHeight, align, rtl ? "rtl" : "ltr", TEXT);
        }
        x += width;
      }

      activeSurface.cursorY += rowHeight;
      lineOffset += chunkLineCount;
      if (lineOffset < maximumLines) {
        activeSurface = requestNewPage();
        drawSectionAndHeader(true);
      }
    }
  });'''

if old in text:
    text = text.replace(old, new, 1)
elif "let lineOffset = 0;" not in text:
    raise SystemExit("Expected table rendering block was not found")

path.write_text(text, encoding="utf-8")
print("Applied report PDF review fixes.")
