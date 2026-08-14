import i18n from "../i18n";
import { buildDispatchAvailability } from "./dispatch-sales";
import { formatNumber } from "./format";
import { offlineDb, workspaceConfigRecords, workspaceRecords } from "./offline-db";

type SummaryMode = "vehicle" | "type";
type PeriodMode = "season" | "today" | "last7" | "custom";
type MovementTotals = {
  dispatched: number;
  sold: number;
  returned: number;
  remaining: number;
};

type SummaryLabels = {
  period: string;
  thisSeason: string;
  today: string;
  last7: string;
  custom: string;
  from: string;
  to: string;
  dispatched: string;
  sold: string;
  returned: string;
  remaining: string;
  byVehicle: string;
  byType: string;
  completed: string;
  noRows: string;
};

const labelsFor = (): SummaryLabels => {
  const language = document.documentElement.lang.slice(0, 2).toLowerCase();
  if (language === "ur") return {
    period: "مدت",
    thisSeason: "یہ سیزن",
    today: "آج",
    last7: "گزشتہ 7 دن",
    custom: "مخصوص مدت",
    from: "تاریخ سے",
    to: "تاریخ تک",
    dispatched: "ڈسپیچ",
    sold: "فروخت",
    returned: "فارم واپسی",
    remaining: "باقی",
    byVehicle: "گاڑی کے لحاظ سے",
    byType: "قسم کے لحاظ سے",
    completed: "مکمل",
    noRows: "منتخب مدت میں کوئی ڈسپیچ نہیں۔",
  };
  if (language === "ar") return {
    period: "الفترة",
    thisSeason: "هذا الموسم",
    today: "اليوم",
    last7: "آخر 7 أيام",
    custom: "فترة مخصصة",
    from: "من تاريخ",
    to: "إلى تاريخ",
    dispatched: "مرسل",
    sold: "مباع",
    returned: "مرتجع للمزرعة",
    remaining: "متبقي",
    byVehicle: "حسب المركبة",
    byType: "حسب النوع",
    completed: "مكتمل",
    noRows: "لا توجد إرساليات في الفترة المحددة.",
  };
  return {
    period: "Period",
    thisSeason: "This season",
    today: "Today",
    last7: "Last 7 days",
    custom: "Custom range",
    from: "From",
    to: "To",
    dispatched: "Dispatched",
    sold: "Sold",
    returned: "Returned to farm",
    remaining: "Remaining",
    byVehicle: "By vehicle",
    byType: "By type",
    completed: "Completed",
    noRows: "No dispatches in the selected period.",
  };
};

const localDateKey = (date = new Date()) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const lastSevenStartKey = () => {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() - 6);
  return localDateKey(date);
};

const addTotals = (target: MovementTotals, row: { dispatchedCartons: number; soldCartons: number; returnedCartons: number; remainingCartons: number }) => {
  target.dispatched += row.dispatchedCartons;
  target.sold += row.soldCartons;
  target.returned += row.returnedCartons;
  target.remaining += row.remainingCartons;
};

const emptyTotals = (): MovementTotals => ({ dispatched: 0, sold: 0, returned: 0, remaining: 0 });

const setNativeInputValue = (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
};

async function loadAvailability() {
  const [dispatches, sales, vehicles, dateTypes] = await Promise.all([
    workspaceRecords(offlineDb.dispatches),
    workspaceRecords(offlineDb.sales),
    workspaceRecords(offlineDb.vehicles),
    workspaceConfigRecords(offlineDb.dateTypes),
  ]);
  const vehicleMap = new Map(vehicles.map((vehicle) => [vehicle.id, vehicle.number]));
  return buildDispatchAvailability(
    dispatches,
    sales,
    dateTypes,
    (dispatch) => (dispatch.vehicleId ? vehicleMap.get(dispatch.vehicleId) : undefined) ?? dispatch.vehicleNumber ?? "-",
  );
}

const inferPeriodMode = (from: string, to: string): PeriodMode => {
  const today = localDateKey();
  if (!from && !to) return "season";
  if (from === today && to === today) return "today";
  if (from === lastSevenStartKey() && to === today) return "last7";
  return "custom";
};

const createMetric = (label: string, value: number, className = "") => {
  const article = document.createElement("article");
  article.className = `dispatch-summary-modern__metric ${className}`.trim();
  const span = document.createElement("span");
  span.textContent = label;
  const strong = document.createElement("strong");
  strong.className = "bidi-isolate";
  strong.textContent = formatNumber(value);
  article.append(span, strong);
  return article;
};

const createGroupRows = (
  grouped: Map<string, MovementTotals>,
  labels: SummaryLabels,
  mode: SummaryMode,
) => {
  const section = document.createElement("section");
  section.className = "dispatch-summary-modern__group";
  section.dataset.summaryGroup = mode;

  const rows = [...grouped.entries()].sort((a, b) => b[1].dispatched - a[1].dispatched || a[0].localeCompare(b[0]));
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "dispatch-summary-modern__empty";
    empty.textContent = labels.noRows;
    section.append(empty);
    return section;
  }

  rows.forEach(([name, totals]) => {
    const row = document.createElement("article");
    row.className = "dispatch-summary-modern__row";
    if (totals.remaining === 0) row.classList.add("is-complete");

    const head = document.createElement("div");
    head.className = "dispatch-summary-modern__row-head";
    const title = document.createElement("strong");
    title.textContent = name;
    const dispatched = document.createElement("b");
    dispatched.className = "bidi-isolate";
    dispatched.textContent = formatNumber(totals.dispatched);
    head.append(title, dispatched);

    const movement = document.createElement("div");
    movement.className = "dispatch-summary-modern__row-movement";
    const sold = document.createElement("span");
    sold.textContent = `${labels.sold} ${formatNumber(totals.sold)}`;
    movement.append(sold);
    if (totals.returned > 0) {
      const returned = document.createElement("span");
      returned.className = "is-returned";
      returned.textContent = `${labels.returned} ${formatNumber(totals.returned)}`;
      movement.append(returned);
    }
    const remaining = document.createElement("span");
    remaining.className = "is-remaining";
    remaining.textContent = `${labels.remaining} ${formatNumber(totals.remaining)}`;
    movement.append(remaining);
    if (totals.remaining === 0) {
      const completed = document.createElement("small");
      completed.className = "dispatch-summary-modern__complete";
      completed.textContent = labels.completed;
      movement.append(completed);
    }

    row.append(head, movement);
    section.append(row);
  });
  return section;
};

function renderModernSummary(
  panel: HTMLElement,
  availability: Awaited<ReturnType<typeof loadAvailability>>,
  schedule: () => void,
) {
  const labels = labelsFor();
  const legacyFilters = panel.querySelector<HTMLElement>(".dispatch-summary__filters");
  const dateInputs = Array.from(legacyFilters?.querySelectorAll<HTMLInputElement>('input[type="date"]') ?? []);
  const from = dateInputs[0]?.value ?? "";
  const to = dateInputs[1]?.value ?? "";
  const inferredPeriod = inferPeriodMode(from, to);
  const explicitPeriod = panel.dataset.dispatchSummaryPeriod as PeriodMode | undefined;
  const period = explicitPeriod === "custom" ? "custom" : inferredPeriod;
  panel.classList.add("dispatch-summary-panel--modern");

  const filtered = availability.filter((row) => (!from || row.dispatch.date >= from) && (!to || row.dispatch.date <= to));
  const overall = emptyTotals();
  const byVehicle = new Map<string, MovementTotals>();
  const byType = new Map<string, MovementTotals>();

  filtered.forEach((row) => {
    addTotals(overall, row);
    const vehicle = byVehicle.get(row.vehicleLabel) ?? emptyTotals();
    addTotals(vehicle, row);
    byVehicle.set(row.vehicleLabel, vehicle);
    const type = byType.get(row.dateTypeName) ?? emptyTotals();
    addTotals(type, row);
    byType.set(row.dateTypeName, type);
  });

  let host = panel.querySelector<HTMLElement>("[data-dispatch-summary-modern]");
  if (!host) {
    host = document.createElement("div");
    host.dataset.dispatchSummaryModern = "true";
    const heading = panel.querySelector<HTMLElement>(".dispatch-section-heading");
    heading?.after(host);
  }
  host.replaceChildren();

  const periodBar = document.createElement("div");
  periodBar.className = "dispatch-summary-modern__period";
  const periodLabel = document.createElement("label");
  const periodText = document.createElement("span");
  periodText.textContent = labels.period;
  const periodSelect = document.createElement("select");
  periodSelect.setAttribute("aria-label", labels.period);
  ([
    ["season", labels.thisSeason],
    ["today", labels.today],
    ["last7", labels.last7],
    ["custom", labels.custom],
  ] as const).forEach(([value, text]) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    periodSelect.append(option);
  });
  periodSelect.value = period;
  periodLabel.append(periodText, periodSelect);
  periodBar.append(periodLabel);
  host.append(periodBar);

  periodSelect.addEventListener("change", () => {
    const next = periodSelect.value as PeriodMode;
    panel.dataset.dispatchSummaryPeriod = next;
    if (next === "custom") {
      schedule();
      return;
    }
    if (dateInputs.length >= 2) {
      if (next === "season") {
        setNativeInputValue(dateInputs[0], "");
        setNativeInputValue(dateInputs[1], "");
      } else if (next === "today") {
        const today = localDateKey();
        setNativeInputValue(dateInputs[0], today);
        setNativeInputValue(dateInputs[1], today);
      } else {
        setNativeInputValue(dateInputs[0], lastSevenStartKey());
        setNativeInputValue(dateInputs[1], localDateKey());
      }
    }
    window.setTimeout(schedule, 0);
  });

  if (period === "custom") {
    const customRange = document.createElement("div");
    customRange.className = "dispatch-summary-modern__custom-range";
    const makeDateField = (label: string, value: string, source: HTMLInputElement | undefined) => {
      const field = document.createElement("label");
      const fieldLabel = document.createElement("span");
      fieldLabel.textContent = label;
      const input = document.createElement("input");
      input.type = "date";
      input.value = value;
      input.addEventListener("change", () => {
        panel.dataset.dispatchSummaryPeriod = "custom";
        if (source) setNativeInputValue(source, input.value);
        window.setTimeout(schedule, 0);
      });
      field.append(fieldLabel, input);
      return field;
    };
    customRange.append(
      makeDateField(labels.from, from, dateInputs[0]),
      makeDateField(labels.to, to, dateInputs[1]),
    );
    host.append(customRange);
  }

  const metrics = document.createElement("div");
  metrics.className = "dispatch-summary-modern__metrics";
  metrics.append(
    createMetric(labels.dispatched, overall.dispatched),
    createMetric(labels.sold, overall.sold),
    createMetric(labels.returned, overall.returned, "is-returned"),
    createMetric(labels.remaining, overall.remaining, "is-remaining"),
  );
  host.append(metrics);

  const mode = (panel.dataset.dispatchSummaryMode as SummaryMode | undefined) ?? "vehicle";
  const switcher = document.createElement("div");
  switcher.className = "dispatch-summary-modern__switcher";
  switcher.setAttribute("role", "tablist");

  const makeModeButton = (nextMode: SummaryMode, label: string, count: number) => {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "tab");
    button.dataset.summaryMode = nextMode;
    button.setAttribute("aria-selected", String(mode === nextMode));
    if (mode === nextMode) button.classList.add("is-active");
    const text = document.createElement("span");
    text.textContent = label;
    const badge = document.createElement("small");
    badge.className = "bidi-isolate";
    badge.textContent = String(count);
    button.append(text, badge);
    button.addEventListener("click", () => {
      panel.dataset.dispatchSummaryMode = nextMode;
      host?.querySelectorAll<HTMLButtonElement>("[data-summary-mode]").forEach((candidate) => {
        const active = candidate.dataset.summaryMode === nextMode;
        candidate.classList.toggle("is-active", active);
        candidate.setAttribute("aria-selected", String(active));
      });
      host?.querySelectorAll<HTMLElement>("[data-summary-group]").forEach((group) => {
        group.hidden = group.dataset.summaryGroup !== nextMode;
      });
    });
    return button;
  };

  switcher.append(
    makeModeButton("vehicle", labels.byVehicle, byVehicle.size),
    makeModeButton("type", labels.byType, byType.size),
  );
  host.append(switcher);

  const vehicleGroup = createGroupRows(byVehicle, labels, "vehicle");
  const typeGroup = createGroupRows(byType, labels, "type");
  vehicleGroup.hidden = mode !== "vehicle";
  typeGroup.hidden = mode !== "type";
  host.append(vehicleGroup, typeGroup);
}

export function installDispatchSummaryEnhancements() {
  let stopped = false;
  let scheduled = false;
  let dataDirty = true;
  let availabilityCache: Awaited<ReturnType<typeof loadAvailability>> | null = null;
  let sequence = 0;

  const run = async () => {
    scheduled = false;
    if (stopped || !location.pathname.startsWith("/workspace/dispatch")) return;
    const panel = document.querySelector<HTMLElement>(".dispatch-summary-panel");
    const workspace = panel?.closest<HTMLElement>(".dispatch-compact-workspace");
    if (!panel || !workspace || workspace.dataset.dispatchTab !== "records") return;

    const currentSequence = ++sequence;
    if (dataDirty || !availabilityCache) {
      availabilityCache = await loadAvailability();
      dataDirty = false;
    }
    if (stopped || currentSequence !== sequence || !availabilityCache) return;
    renderModernSummary(panel, availabilityCache, schedule);
  };

  const schedule = () => {
    if (scheduled || stopped) return;
    scheduled = true;
    requestAnimationFrame(() => void run());
  };

  const waitForDispatchSummary = (frames = 0) => {
    if (stopped || !location.pathname.startsWith("/workspace/dispatch")) return;
    const panel = document.querySelector(".dispatch-summary-panel");
    if (panel) {
      schedule();
      return;
    }
    if (frames < 120) requestAnimationFrame(() => waitForDispatchSummary(frames + 1));
  };

  const onDataChange = () => {
    dataDirty = true;
    schedule();
  };
  const onPopState = () => waitForDispatchSummary();
  const onLanguageChange = () => schedule();
  const onDocumentClick = (event: Event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const routeLink = target.closest<HTMLAnchorElement>('a[href*="/workspace/dispatch"]');
    const dispatchTab = target.closest<HTMLButtonElement>(".dispatch-compact-tabs button");
    if (routeLink) window.setTimeout(() => waitForDispatchSummary(), 0);
    if (dispatchTab) window.setTimeout(schedule, 0);
  };

  window.addEventListener("popstate", onPopState);
  window.addEventListener("muzare-data-refresh", onDataChange);
  window.addEventListener("muzare-local-data-change", onDataChange);
  document.addEventListener("click", onDocumentClick);
  i18n.on("languageChanged", onLanguageChange);
  waitForDispatchSummary();

  return () => {
    stopped = true;
    sequence += 1;
    window.removeEventListener("popstate", onPopState);
    window.removeEventListener("muzare-data-refresh", onDataChange);
    window.removeEventListener("muzare-local-data-change", onDataChange);
    document.removeEventListener("click", onDocumentClick);
    i18n.off("languageChanged", onLanguageChange);
  };
}
