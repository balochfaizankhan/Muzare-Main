from __future__ import annotations

from pathlib import Path
import re

path = Path(__file__).resolve().parents[1] / "web/src/locales/reportsLocalizationBundle.ts"
text = path.read_text(encoding="utf-8")

keys = "lineItems|shareOfTotal|bySubcategory|labourDueRecord|attributedAmount|expenseAmount"
text = re.sub(rf"^        (?:{keys}): .*\n", "", text, flags=re.M)

marker = '        halfDayPrintMark: "½",'
parts = text.split(marker)
if len(parts) != 4:
    raise SystemExit(f"expected three reportsPage translation markers, found {len(parts) - 1}")

translations = [
    '''
        lineItems: "Line items",
        shareOfTotal: "Share of total (%)",
        bySubcategory: "By subcategory",
        labourDueRecord: "Labour wage due",
        attributedAmount: "Attributed amount (SAR)",
        expenseAmount: "Expense amount (SAR)",''',
    '''
        lineItems: "بنود المصروفات",
        shareOfTotal: "النسبة من الإجمالي (%)",
        bySubcategory: "حسب الفئة الفرعية",
        labourDueRecord: "استحقاق أجور العمالة",
        attributedAmount: "المبلغ المنسوب (ر.س)",
        expenseAmount: "مبلغ المصروف (ر.س)",''',
    '''
        lineItems: "اخراجات کی لائن آئٹمز",
        shareOfTotal: "کل میں حصہ (%)",
        bySubcategory: "ذیلی زمرے کے لحاظ سے",
        labourDueRecord: "مزدور اجرت واجب الادا",
        attributedAmount: "منسوب رقم (ر.س)",
        expenseAmount: "اخراجات کی رقم (ر.س)",''',
]

text = parts[0]
for index, translation in enumerate(translations):
    text += marker + translation + parts[index + 1]

path.write_text(text, encoding="utf-8")
