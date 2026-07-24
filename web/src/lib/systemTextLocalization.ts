import i18n from "../i18n";

const dashboardPageTranslations = {
  ar: {
    operationsOverview: "نظرة عامة على العمليات",
    welcome: "مرحباً، {{name}}",
    noFarmAvailable: "لا توجد مزرعة متاحة",
    noFarmAvailableMessage: "لا توجد مزرعة متاحة. أنشئ مزرعة أو استعدها.",
    noFarmVisibleReadOnly: "لا توجد مزرعة متاحة للعرض حالياً. تواصل مع مالك مساحة العمل إذا كنت بحاجة إلى صلاحية.",
    noAccessibleFarmMessage: "ليس لديك حالياً صلاحية للوصول إلى أي مزرعة نشطة في مساحة العمل هذه.",
    emptyWorkspaceSwitchHint: "لا توجد مزارع في مساحة العمل هذه. انتقل إلى مساحة عمل أخرى للمتابعة.",
    noSeasonUntilFarm: "أنشئ مزرعة أولاً",
    noActiveSeason: "لا يوجد موسم نشط. أنشئ موسماً أو اختر موسماً لبدء العمليات.",
    createNewFarm: "إنشاء مزرعة جديدة",
    restoreSoftDeletedFarm: "استعادة المزرعة المحذوفة",
    moduleLockedUntilFarmSeason: "أنشئ مزرعة وموسماً لتفعيل هذه الوحدة.",
    todayAtGlance: "لمحة عن اليوم",
    localFigures: "أرقام مباشرة من هذا الجهاز",
    quickActions: "إجراءات سريعة",
    dailyEntries: "الإدخالات اليومية الشائعة",
    todayFarmPulse: "نبض المزرعة اليوم",
    farmOverview: "نظرة عامة على المزرعة",
    operationsHealth: "سلامة العمليات: {{status}}",
    thisSeason: "هذا الموسم",
    outstandingBalance: "الرصيد المستحق",
    viewAll: "عرض الكل",
    loadingActivity: "جارٍ تحميل نشاط مساحة العمل الأخير...",
    recentActivityDescription: "السجلات التشغيلية الأخيرة من مساحة العمل الحالية.",
    activityWillAppear: "سيظهر النشاط هنا فور حفظ السجلات.",
    workspaceContextRefreshFailed: "تعذر تحديث سياق مساحة العمل. يرجى إعادة المحاولة.",
    dashboardDataLoadFailedForContext: "تعذر تحميل بيانات لوحة التحكم للمزرعة والموسم الحاليين.",
    loadingWorkspaceEllipsis: "جارٍ تحميل مساحة العمل...",
    preparingWorkspaceDataShort: "جارٍ تجهيز بيانات مساحة العمل",
    requiresFarmAndSeason: "يتطلب مزرعة وموسماً",
    notificationsAria: "الإشعارات",
    profileAria: "الملف الشخصي",
    currentWorkspaceContextAria: "سياق مساحة العمل الحالي",
    kpiGridAria: "مؤشرات الأداء الرئيسية",
    dispatchLoadFailedRetry: "تعذر تحميل الشحنات. أعد المحاولة.",
    loadingDispatches: "جارٍ تحميل شحنات اليوم",
    openModuleNamed: "فتح {{module}}",
    labourTodayCount_one: "{{count}} عامل اليوم",
    labourTodayCount_other: "{{count}} عمال اليوم",
    dispatchesTodayCount_one: "{{count}} شحنة اليوم",
    dispatchesTodayCount_other: "{{count}} شحنات اليوم",
    cartonsTodayCount_one: "{{count}} كرتون اليوم",
    cartonsTodayCount_other: "{{count}} كرتون اليوم",
  },
  ur: {
    operationsOverview: "عملیات کا جائزہ",
    welcome: "خوش آمدید، {{name}}",
    noFarmAvailable: "کوئی فارم دستیاب نہیں",
    noFarmAvailableMessage: "کوئی فارم دستیاب نہیں۔ نیا فارم بنائیں یا بحال کریں۔",
    noFarmVisibleReadOnly: "اس وقت دیکھنے کے لیے کوئی فارم دستیاب نہیں۔ رسائی کے لیے ورک اسپیس مالک سے رابطہ کریں۔",
    noAccessibleFarmMessage: "اس ورک اسپیس میں آپ کو کسی فعال فارم تک رسائی حاصل نہیں۔",
    emptyWorkspaceSwitchHint: "اس ورک اسپیس میں کوئی فارم نہیں۔ جاری رکھنے کے لیے دوسری ورک اسپیس منتخب کریں۔",
    noSeasonUntilFarm: "پہلے فارم بنائیں",
    noActiveSeason: "کوئی فعال سیزن نہیں۔ کام شروع کرنے کے لیے سیزن بنائیں یا منتخب کریں۔",
    createNewFarm: "نیا فارم بنائیں",
    restoreSoftDeletedFarm: "حذف شدہ فارم بحال کریں",
    moduleLockedUntilFarmSeason: "اس ماڈیول کو فعال کرنے کے لیے فارم اور سیزن بنائیں۔",
    todayAtGlance: "آج کا مختصر جائزہ",
    localFigures: "اس ڈیوائس کے براہِ راست اعداد",
    quickActions: "فوری اقدامات",
    dailyEntries: "روزمرہ کی عام اندراجات",
    todayFarmPulse: "آج فارم کی صورتحال",
    farmOverview: "فارم کا عمومی جائزہ",
    operationsHealth: "عملیات کی حالت: {{status}}",
    thisSeason: "اس سیزن میں",
    outstandingBalance: "واجب الادا بیلنس",
    viewAll: "سب دیکھیں",
    loadingActivity: "حالیہ ورک اسپیس سرگرمی لوڈ ہو رہی ہے...",
    recentActivityDescription: "موجودہ ورک اسپیس کے حالیہ عملی ریکارڈز۔",
    activityWillAppear: "ریکارڈ محفوظ ہوتے ہی سرگرمی یہاں ظاہر ہوگی۔",
    workspaceContextRefreshFailed: "ورک اسپیس کا سیاق تازہ نہیں ہو سکا۔ دوبارہ کوشش کریں۔",
    dashboardDataLoadFailedForContext: "موجودہ فارم اور سیزن کے لیے ڈیش بورڈ ڈیٹا لوڈ نہیں ہو سکا۔",
    loadingWorkspaceEllipsis: "ورک اسپیس لوڈ ہو رہی ہے...",
    preparingWorkspaceDataShort: "ورک اسپیس ڈیٹا تیار ہو رہا ہے",
    requiresFarmAndSeason: "فارم اور سیزن درکار ہیں",
    notificationsAria: "اطلاعات",
    profileAria: "پروفائل",
    currentWorkspaceContextAria: "موجودہ ورک اسپیس سیاق",
    kpiGridAria: "اہم کارکردگی اشاریے",
    dispatchLoadFailedRetry: "شپمنٹس لوڈ نہیں ہو سکیں۔ دوبارہ کوشش کریں۔",
    loadingDispatches: "آج کی شپمنٹس لوڈ ہو رہی ہیں",
    openModuleNamed: "{{module}} کھولیں",
    labourTodayCount_one: "آج {{count}} مزدور",
    labourTodayCount_other: "آج {{count}} مزدور",
    dispatchesTodayCount_one: "آج {{count}} شپمنٹ",
    dispatchesTodayCount_other: "آج {{count}} شپمنٹس",
    cartonsTodayCount_one: "آج {{count}} کارٹن",
    cartonsTodayCount_other: "آج {{count}} کارٹن",
  },
} as const;

for (const language of ["ar", "ur"] as const) {
  i18n.addResourceBundle(language, "translation", { dashboardPage: dashboardPageTranslations[language] }, true, true);
}

const exactSystemText: Record<"ar" | "ur", Record<string, string>> = {
  ar: {
    "advance application": "تطبيق السلفة",
    "Advance application": "تطبيق السلفة",
    "Applied": "مُطبّق",
    "due recognition": "إثبات الاستحقاق",
    "Due recognition": "إثبات الاستحقاق",
    "advance payment": "صرف سلفة",
    "Advance payment": "صرف سلفة",
    "payments due": "دفعات مستحقة",
    "payment due": "دفعة مستحقة",
    "labour today": "عمال اليوم",
    "cartons today": "كرتون اليوم",
    "today": "اليوم",
    "Cash": "نقد",
    "Posted": "مُرحّل",
    "Unpaid": "غير مدفوع",
  },
  ur: {
    "advance application": "ایڈوانس کا اطلاق",
    "Advance application": "ایڈوانس کا اطلاق",
    "Applied": "لاگو شدہ",
    "due recognition": "واجب الادا اندراج",
    "Due recognition": "واجب الادا اندراج",
    "advance payment": "ایڈوانس ادائیگی",
    "Advance payment": "ایڈوانس ادائیگی",
    "payments due": "واجب الادا ادائیگیاں",
    "payment due": "واجب الادا ادائیگی",
    "labour today": "آج کے مزدور",
    "cartons today": "آج کے کارٹن",
    "today": "آج",
    "Cash": "نقد",
    "Posted": "پوسٹ شدہ",
    "Unpaid": "غیر ادا شدہ",
  },
};

const monthNames: Record<"ar" | "ur", Record<string, string>> = {
  ar: { January: "يناير", February: "فبراير", March: "مارس", April: "أبريل", May: "مايو", June: "يونيو", July: "يوليو", August: "أغسطس", September: "سبتمبر", October: "أكتوبر", November: "نوفمبر", December: "ديسمبر" },
  ur: { January: "جنوری", February: "فروری", March: "مارچ", April: "اپریل", May: "مئی", June: "جون", July: "جولائی", August: "اگست", September: "ستمبر", October: "اکتوبر", November: "نومبر", December: "دسمبر" },
};

const excluded = "input, textarea, select, option, [contenteditable='true'], [data-user-content='true']";

function localizeText(value: string, language: "ar" | "ur") {
  const trimmed = value.trim();
  const exact = exactSystemText[language][trimmed];
  if (exact) return value.replace(trimmed, exact);

  let localized = value
    .replace(/\bFrom\b/g, language === "ar" ? "من" : "سے")
    .replace(/\bto\b/g, language === "ar" ? "إلى" : "تک")
    .replace(/\bdays? upto\b/gi, language === "ar" ? "يوماً حتى" : "دن تا")
    .replace(/\bpayments due\b/gi, language === "ar" ? "دفعات مستحقة" : "واجب الادا ادائیگیاں")
    .replace(/\blabour today\b/gi, language === "ar" ? "عمال اليوم" : "آج کے مزدور")
    .replace(/\bcartons? today\b/gi, language === "ar" ? "كرتون اليوم" : "آج کے کارٹن");

  for (const [english, translated] of Object.entries(monthNames[language])) {
    localized = localized.replace(new RegExp(`\\b${english}\\b`, "g"), translated);
  }
  return localized;
}

function translateNode(node: Node, language: "ar" | "ur") {
  if (node.nodeType === Node.TEXT_NODE) {
    const parent = node.parentElement;
    if (!parent || parent.closest(excluded)) return;
    if (!parent.closest(".dashboard-page, .activity-log-page, .dashboard-activity-card, .dashboard-kpi-card, .dashboard-hero-card")) return;
    const current = node.nodeValue ?? "";
    const next = localizeText(current, language);
    if (next !== current) node.nodeValue = next;
    return;
  }
  if (!(node instanceof Element)) return;
  node.childNodes.forEach((child) => translateNode(child, language));
}

export function installSystemTextLocalizationGuard() {
  if (typeof document === "undefined") return () => undefined;
  let observer: MutationObserver | null = null;

  const apply = () => {
    const language = i18n.resolvedLanguage?.split("-")[0];
    if (language !== "ar" && language !== "ur") return;
    translateNode(document.body, language);
  };

  const start = () => {
    observer?.disconnect();
    apply();
    observer = new MutationObserver((mutations) => {
      const language = i18n.resolvedLanguage?.split("-")[0];
      if (language !== "ar" && language !== "ur") return;
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => translateNode(node, language));
        if (mutation.type === "characterData") translateNode(mutation.target, language);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  };

  start();
  i18n.on("languageChanged", start);
  return () => {
    observer?.disconnect();
    i18n.off("languageChanged", start);
  };
}
