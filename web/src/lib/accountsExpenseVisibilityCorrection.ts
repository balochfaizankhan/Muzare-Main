import i18n from "../i18n";
import { formatMoney } from "./format";

const copy = {
  en: {
    section: "Expenses & labour balances",
    wages: "Recognized labour wages",
    advances: "Outstanding labour advances",
    due: "Labour payments due",
    total: "Total recognized expenses",
  },
  ur: {
    section: "اخراجات اور مزدوری کے بیلنس",
    wages: "تسلیم شدہ مزدوری کے اخراجات",
    advances: "بقایا مزدوری ایڈوانس",
    due: "واجب الادا مزدوری کی ادائیگیاں",
    total: "کل تسلیم شدہ اخراجات",
  },
  ar: {
    section: "المصروفات وأرصدة العمالة",
    wages: "أجور العمالة المعترف بها",
    advances: "سلف العمالة القائمة",
    due: "مدفوعات العمالة المستحقة",
    total: "إجمالي المصروفات المعترف بها",
  },
} as const;

type Copy = (typeof copy)[keyof typeof copy];

function currentCopy(): Copy {
  const language = (i18n.resolvedLanguage ?? i18n.language ?? "en").slice(0, 2) as keyof typeof copy;
  return copy[language] ?? copy.en;
}

function normalizeDigits(value: string) {
  const arabicIndic = "٠١٢٣٤٥٦٧٨٩";
  const easternArabic = "۰۱۲۳۴۵۶۷۸۹";
  return value
    .replace(/[٠-٩]/g, (digit) => String(arabicIndic.indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String(easternArabic.indexOf(digit)));
}

function parseMoney(value: string | null | undefined) {
  if (!value) return null;
  const normalized = normalizeDigits(value)
    .replace(/[٬,\s]/g, "")
    .replace(/٫/g, ".")
    .replace(/[^0-9.+-]/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function setLabel(card: HTMLElement, label: string) {
  const strong = card.querySelector<HTMLElement>(":scope > strong");
  if (strong && strong.textContent !== label) strong.textContent = label;
}

function findExpenseSection() {
  const panels = Array.from(document.querySelectorAll<HTMLElement>("section.record-panel"));
  return panels.find((panel) => {
    const list = panel.querySelector<HTMLElement>(":scope > .record-list");
    return Boolean(list && list.querySelectorAll(":scope > article.account-card-clickable").length === 5);
  }) ?? null;
}

function assignRoles(list: HTMLElement) {
  const cards = Array.from(list.querySelectorAll<HTMLElement>(":scope > article.account-card-clickable"));
  if (cards.length !== 5) return null;

  const existing = new Map(cards.map((card) => [card.dataset.accountsExpenseRole, card]));
  if (existing.has("voucher") && existing.has("wages") && existing.has("advances") && existing.has("due") && existing.has("total")) {
    return {
      voucher: existing.get("voucher")!,
      wages: existing.get("wages")!,
      advances: existing.get("advances")!,
      due: existing.get("due")!,
      total: existing.get("total")!,
    };
  }

  const [voucher, wages, advances, due, total] = cards;
  voucher.dataset.accountsExpenseRole = "voucher";
  wages.dataset.accountsExpenseRole = "wages";
  advances.dataset.accountsExpenseRole = "advances";
  due.dataset.accountsExpenseRole = "due";
  total.dataset.accountsExpenseRole = "total";
  return { voucher, wages, advances, due, total };
}

function correctNetOperatingPosition(section: HTMLElement, outstandingAdvance: number) {
  const summaries = Array.from(document.querySelectorAll<HTMLElement>(".summary-card"));
  const summary = summaries.find((candidate) => Boolean(section.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING));
  if (!summary) return;

  const value = summary.querySelector<HTMLElement>("strong");
  if (!value) return;

  const currentText = value.textContent ?? "";
  const lastCorrectedText = summary.dataset.accountsCorrectedNetText;
  if (!lastCorrectedText || currentText !== lastCorrectedText) {
    const base = parseMoney(currentText);
    if (base == null) return;
    summary.dataset.accountsOriginalNet = String(base);
  }

  const base = Number(summary.dataset.accountsOriginalNet);
  if (!Number.isFinite(base)) return;
  const corrected = base + outstandingAdvance;
  const correctedText = formatMoney(corrected);
  summary.dataset.accountsCorrectedNetText = correctedText;
  if (value.textContent !== correctedText) value.textContent = correctedText;
}

function applyCorrection() {
  if (!window.location.pathname.startsWith("/workspace/accounts")) return;

  const section = findExpenseSection();
  if (!section) return;
  const list = section.querySelector<HTMLElement>(":scope > .record-list");
  if (!list) return;
  const cards = assignRoles(list);
  if (!cards) return;

  const voucherAmount = parseMoney(cards.voucher.querySelector<HTMLElement>(":scope > span")?.textContent);
  const wageAmount = parseMoney(cards.wages.querySelector<HTMLElement>(":scope > span")?.textContent);
  const outstandingAdvance = parseMoney(cards.advances.querySelector<HTMLElement>(":scope > span")?.textContent);
  if (voucherAmount == null || wageAmount == null || outstandingAdvance == null) return;

  const labels = currentCopy();
  const heading = section.querySelector<HTMLElement>(":scope > h2");
  if (heading && heading.textContent !== labels.section) heading.textContent = labels.section;
  setLabel(cards.wages, labels.wages);
  setLabel(cards.advances, labels.advances);
  setLabel(cards.due, labels.due);
  setLabel(cards.total, labels.total);

  // Recognized expenses belong together. Advances and payments due remain visible as
  // balance/liability information, but neither is added again to recognized expenses.
  if (cards.total.nextElementSibling !== cards.advances) list.insertBefore(cards.total, cards.advances);

  const correctedTotal = voucherAmount + wageAmount;
  const totalValue = cards.total.querySelector<HTMLElement>(":scope > span");
  const correctedTotalText = formatMoney(correctedTotal);
  if (totalValue && totalValue.textContent !== correctedTotalText) totalValue.textContent = correctedTotalText;

  correctNetOperatingPosition(section, outstandingAdvance);
  section.dataset.accountsExpenseSemantics = "recognized-expense-v2";
}

export function installAccountsExpenseVisibilityCorrection() {
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      applyCorrection();
    });
  };

  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  window.addEventListener("popstate", schedule);
  window.addEventListener("muzare-data-refresh", schedule);
  window.addEventListener("muzare-local-data-change", schedule);
  i18n.on("languageChanged", schedule);
  schedule();

  return () => {
    observer.disconnect();
    window.removeEventListener("popstate", schedule);
    window.removeEventListener("muzare-data-refresh", schedule);
    window.removeEventListener("muzare-local-data-change", schedule);
    i18n.off("languageChanged", schedule);
  };
}
