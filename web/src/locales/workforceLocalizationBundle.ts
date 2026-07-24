// Translation keys added by the 2026-07 full-localization pass for the workforce/labour pages
// (WorkforcePayments, LabourEarnings, LabourGroups, LabourReconciliation, WageRates, Seasons,
// WorkforceHub) and their display helpers. Merged into the main resources in ../i18n.ts.
// Every key MUST exist in all three languages — the locale-parity test enforces this.
export const workforceLocalizationBundle = {
  en: { translation: {
    labourEarningsLabels: {
      scopeGroup: "Group",
      scopeIndividual: "Individual",
      labourGroupFallback: "Labour group",
      labourerFallback: "Labourer",
      typeAdjustment: "Adjustment",
      typeBonus: "Bonus",
      typeIncentive: "Incentive",
      typeLumpSum: "Lump sum",
      typeOther: "Other",
      typeTask: "Task",
    },
    dispatchSales: {
      dispatchSale: "Dispatch sale",
      unlinkedSale: "Unlinked sale",
      unknownType: "Unknown type",
    },
    workforceHubPage: {
      overviewAria: "{{title}} overview",
      navigationAria: "{{title}} navigation",
    },
  } },
  ar: { translation: {
    labourEarningsLabels: {
      scopeGroup: "مجموعة",
      scopeIndividual: "فردي",
      labourGroupFallback: "مجموعة العمالة",
      labourerFallback: "عامل",
      typeAdjustment: "تعديل",
      typeBonus: "مكافأة",
      typeIncentive: "حافز",
      typeLumpSum: "مبلغ مقطوع",
      typeOther: "أخرى",
      typeTask: "مهمة",
    },
    dispatchSales: {
      dispatchSale: "بيع إرسالية",
      unlinkedSale: "بيع غير مرتبط",
      unknownType: "نوع غير معروف",
    },
    workforceHubPage: {
      overviewAria: "نظرة عامة على {{title}}",
      navigationAria: "التنقل في {{title}}",
    },
  } },
  ur: { translation: {
    labourEarningsLabels: {
      scopeGroup: "گروپ",
      scopeIndividual: "انفرادی",
      labourGroupFallback: "مزدور گروپ",
      labourerFallback: "مزدور",
      typeAdjustment: "ایڈجسٹمنٹ",
      typeBonus: "بونس",
      typeIncentive: "ترغیبی رقم",
      typeLumpSum: "یکمشت رقم",
      typeOther: "دیگر",
      typeTask: "ٹاسک",
    },
    dispatchSales: {
      dispatchSale: "ڈسپیچ فروخت",
      unlinkedSale: "غیر منسلک فروخت",
      unknownType: "نامعلوم قسم",
    },
    workforceHubPage: {
      overviewAria: "{{title}} کا جائزہ",
      navigationAria: "{{title}} نیویگیشن",
    },
  } },
} as const;
