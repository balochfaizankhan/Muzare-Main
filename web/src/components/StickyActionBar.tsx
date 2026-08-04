import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type PropsWithChildren,
  type ReactNode,
} from "react";
import { LoaderCircle } from "lucide-react";
import { useLocation } from "react-router-dom";
import "./StickyActionBar.css";

export type StickyActionBarSummary = ReactNode | {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
};

export type StickyActionBarProps = {
  primaryLabel: ReactNode;
  primaryAction?: () => void | Promise<void>;
  primaryType?: "button" | "submit";
  secondaryLabel?: ReactNode;
  secondaryAction?: () => void | Promise<void>;
  secondaryType?: "button" | "submit";
  loading?: boolean;
  disabled?: boolean;
  secondaryDisabled?: boolean;
  summary?: StickyActionBarSummary;
  showSummary?: boolean;
  safeArea?: boolean;
  children?: ReactNode;
  className?: string;
  formId?: string;
  loadingLabel?: ReactNode;
  variant?: "viewport" | "container";
  primaryTone?: "primary" | "danger";
  secondaryTone?: "secondary" | "danger";
};

const isStructuredSummary = (
  summary: StickyActionBarSummary,
): summary is Exclude<StickyActionBarSummary, ReactNode> =>
  Boolean(summary && typeof summary === "object" && "label" in summary && "value" in summary);

export function StickyActionBar({
  primaryLabel,
  primaryAction,
  primaryType = "button",
  secondaryLabel,
  secondaryAction,
  secondaryType = "button",
  loading = false,
  disabled = false,
  secondaryDisabled = false,
  summary,
  showSummary = true,
  safeArea = true,
  children,
  className,
  formId,
  loadingLabel,
  variant = "viewport",
  primaryTone = "primary",
  secondaryTone = "secondary",
}: StickyActionBarProps) {
  const [internalBusy, setInternalBusy] = useState(false);
  const actionLock = useRef(false);
  const busy = loading || internalBusy;

  const runAction = useCallback(async (
    event: MouseEvent<HTMLButtonElement>,
    action: (() => void | Promise<void>) | undefined,
    blocked: boolean,
  ) => {
    if (blocked || actionLock.current) {
      event.preventDefault();
      return;
    }
    if (!action) return;
    event.preventDefault();
    actionLock.current = true;
    setInternalBusy(true);
    try {
      await action();
    } finally {
      actionLock.current = false;
      setInternalBusy(false);
    }
  }, []);

  return (
    <aside
      className={["muzare-sticky-action-bar", className].filter(Boolean).join(" ")}
      data-sticky-action-bar="true"
      data-sticky-action-variant={variant}
      data-safe-area={safeArea ? "true" : "false"}
      role="region"
      aria-label={typeof primaryLabel === "string" ? primaryLabel : "Form actions"}
      aria-busy={busy}
    >
      {showSummary && summary ? (
        isStructuredSummary(summary) ? (
          <div className="muzare-sticky-action-bar__summary" data-sticky-action-summary="true">
            <span>{summary.label}</span>
            <strong>{summary.value}</strong>
            {summary.hint ? <small>{summary.hint}</small> : null}
          </div>
        ) : (
          <div className="muzare-sticky-action-bar__summary" data-sticky-action-summary="true">{summary}</div>
        )
      ) : null}
      {children}
      <div className="muzare-sticky-action-bar__actions">
        {secondaryLabel ? (
          <button
            type={secondaryType}
            form={formId}
            className={`muzare-sticky-action-bar__secondary muzare-sticky-action-bar__secondary--${secondaryTone}`}
            disabled={busy || secondaryDisabled}
            onClick={(event) => void runAction(event, secondaryAction, busy || secondaryDisabled)}
          >
            {secondaryLabel}
          </button>
        ) : null}
        <button
          type={primaryType}
          form={formId}
          className={`muzare-sticky-action-bar__primary muzare-sticky-action-bar__primary--${primaryTone}`}
          disabled={busy || disabled}
          onClick={(event) => void runAction(event, primaryAction, busy || disabled)}
        >
          {busy ? <LoaderCircle className="muzare-sticky-action-bar__spinner" size={18} aria-hidden="true" /> : null}
          <span>{busy && loadingLabel ? loadingLabel : primaryLabel}</span>
        </button>
      </div>
      <span className="sr-only" aria-live="polite">{busy ? (loadingLabel ?? primaryLabel) : ""}</span>
    </aside>
  );
}

type EnhancedAction = {
  bar: HTMLElement;
  form: HTMLFormElement;
  variant: "viewport" | "container";
};

const explicitActionSelectors = [
  "[data-sticky-action-bar]",
  ".expense-voucher-form__sticky-footer",
  ".dispatch-submit-footer",
  ".sticky-action-bar",
  ".form-sticky-footer",
  ".settlement-action-bar",
  ".attendance-action-bar",
  ".harvest-action-bar",
].join(",");

const actionNamePattern = /(action|footer|submit|save|complete|settle|toolbar|button)/i;
const excludedFormPattern = /(search|filter|query|pagination|quick-find|toolbar-form)/i;
const dialogSelector = "[role='dialog'],dialog,.modal,.dialog,.drawer,.bottom-sheet,.sheet";

function isVisible(element: HTMLElement) {
  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
}

function findActionContainer(button: HTMLElement, form: HTMLFormElement) {
  let node = button.parentElement;
  let compactFallback: HTMLElement | null = null;
  while (node && node !== form) {
    const nonButtonControls = node.querySelectorAll("input:not([type='hidden']):not([type='submit']):not([type='button']),select,textarea").length;
    const buttons = node.querySelectorAll("button,input[type='submit'],input[type='button']").length;
    const name = `${node.className || ""} ${node.id || ""}`;
    if (!nonButtonControls && buttons > 0 && actionNamePattern.test(name)) return node;
    if (!compactFallback && !nonButtonControls && buttons > 0 && buttons <= 3 && node.children.length <= 5) compactFallback = node;
    node = node.parentElement;
  }
  if (compactFallback) return compactFallback;
  return button.parentElement === form ? button : button.parentElement;
}

function resolveControlForm(control: HTMLElement) {
  const closest = control.closest<HTMLFormElement>("form");
  if (closest) return closest;
  const formId = control.getAttribute("form");
  const associated = formId ? document.getElementById(formId) : null;
  return associated instanceof HTMLFormElement ? associated : null;
}

function shouldEnhanceForm(form: HTMLFormElement) {
  if (form.dataset.stickyActionDisabled === "true" || form.getAttribute("role") === "search") return false;
  const identity = `${form.className || ""} ${form.id || ""}`;
  if (excludedFormPattern.test(identity)) return false;
  if ((form.getAttribute("method") ?? "").toLowerCase() === "get") return false;
  return true;
}

function collectActions(root: HTMLElement) {
  const found = new Map<HTMLElement, EnhancedAction>();
  const explicitBars = Array.from(root.querySelectorAll<HTMLElement>(explicitActionSelectors));
  const standaloneByForm = new Map<HTMLFormElement, EnhancedAction>();

  explicitBars.forEach((bar) => {
    const submitControl = bar.querySelector<HTMLElement>("button[type='submit'],button:not([type]),input[type='submit']");
    const form = bar.closest<HTMLFormElement>("form") ?? (submitControl ? resolveControlForm(submitControl) : null);
    if (!form || !shouldEnhanceForm(form) || !bar.querySelector("button,input[type='submit']")) return;
    found.set(bar, { bar, form, variant: bar.closest(dialogSelector) ? "container" : "viewport" });
  });

  root.querySelectorAll<HTMLElement>("form button[type='submit'],form button:not([type]),input[type='submit'],button[form][type='submit']").forEach((button) => {
    if (explicitBars.some((bar) => bar.contains(button))) return;
    const form = resolveControlForm(button);
    if (!form || !shouldEnhanceForm(form)) return;
    const bar = findActionContainer(button, form);
    if (!bar) return;
    const action = { bar, form, variant: bar.closest(dialogSelector) ? "container" : "viewport" } as const;
    if (bar === button) {
      if (!standaloneByForm.has(form)) standaloneByForm.set(form, action);
      return;
    }
    found.set(bar, action);
  });

  standaloneByForm.forEach((action) => found.set(action.bar, action));
  return [...found.values()].filter(({ bar }) => isVisible(bar));
}

function chooseInitialAction(actions: EnhancedAction[]) {
  if (actions.some(({ variant }) => variant === "container")) return null;
  const activeElement = document.activeElement;
  if (activeElement instanceof Element) {
    const focused = actions.find(({ form }) => form.contains(activeElement));
    if (focused) return focused;
  }
  return actions
    .filter(({ variant }) => variant === "viewport")
    .sort((left, right) => Math.abs(left.form.getBoundingClientRect().top) - Math.abs(right.form.getBoundingClientRect().top))[0] ?? null;
}

export function StickyActionBarProvider({ children }: PropsWithChildren) {
  const location = useLocation();

  useEffect(() => {
    const root = document.querySelector<HTMLElement>(".app-shell__body") ?? document.body;
    let frame = 0;
    let resizeObserver: ResizeObserver | null = null;
    let actions: EnhancedAction[] = [];
    let active: EnhancedAction | null = null;

    const updateHeight = () => {
      if (!active || active.variant !== "viewport") return;
      const height = Math.ceil(active.bar.getBoundingClientRect().height);
      document.documentElement.style.setProperty("--muzare-sticky-action-height", `${Math.max(height, 72)}px`);
    };

    const activate = (next: EnhancedAction | null) => {
      const containerOpen = actions.some(({ variant }) => variant === "container");
      active = containerOpen ? null : next;
      actions.forEach((item) => {
        const isActive = item.variant === "container" || (!containerOpen && item === next);
        item.bar.dataset.stickyActionState = isActive ? "active" : "inactive";
        item.form.dataset.stickyActionState = isActive ? "active" : "inactive";
      });
      document.body.classList.toggle("has-muzare-sticky-action-bar", Boolean(active));
      resizeObserver?.disconnect();
      if (next) {
        resizeObserver = new ResizeObserver(updateHeight);
        resizeObserver.observe(next.bar);
        updateHeight();
      }
    };

    const resetDecorations = () => {
      root.querySelectorAll<HTMLElement>(".muzare-sticky-action-bar[data-sticky-action-managed='true']").forEach((bar) => {
        bar.classList.remove("muzare-sticky-action-bar");
        delete bar.dataset.stickyActionManaged;
        delete bar.dataset.stickyActionVariant;
        delete bar.dataset.stickyActionState;
      });
      root.querySelectorAll<HTMLFormElement>("form.muzare-sticky-action-form").forEach((form) => {
        form.classList.remove("muzare-sticky-action-form");
        delete form.dataset.stickyActionState;
        delete form.dataset.stickyActionVariant;
      });
    };

    const scan = () => {
      frame = 0;
      resizeObserver?.disconnect();
      resetDecorations();
      actions = collectActions(root);
      actions.forEach((item) => {
        const isNativeComponent = item.bar.dataset.stickyActionBar === "true";
        item.bar.classList.add("muzare-sticky-action-bar");
        if (!isNativeComponent) item.bar.dataset.stickyActionManaged = "true";
        item.bar.dataset.stickyActionVariant = item.variant;
        item.form.classList.add("muzare-sticky-action-form");
        item.form.dataset.stickyActionVariant = item.variant;
      });
      activate(chooseInitialAction(actions));
    };

    const scheduleScan = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(scan);
    };

    const activateFromEvent = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      const match = actions.find(({ form, bar, variant }) => variant === "viewport" && (form.contains(target) || bar.contains(target)));
      if (match && match !== active) activate(match);
    };

    const keepFocusedControlVisible = (event: Event) => {
      activateFromEvent(event);
      const target = event.target;
      if (!(target instanceof HTMLElement) || !target.matches("input,select,textarea,[contenteditable='true']")) return;
      window.setTimeout(() => {
        const barHeight = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--muzare-sticky-action-height")) || 88;
        const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
        const rect = target.getBoundingClientRect();
        const safeBottom = viewportHeight - barHeight - 82;
        if (rect.bottom > safeBottom || rect.top < 16) target.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 180);
    };

    const updateKeyboardState = () => {
      const viewport = window.visualViewport;
      const keyboardOpen = Boolean(viewport && window.innerHeight - viewport.height > 150);
      document.body.classList.toggle("muzare-keyboard-open", keyboardOpen);
    };

    const observer = new MutationObserver(scheduleScan);
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["hidden", "aria-hidden", "data-dispatch-tab", "data-tab", "data-state"],
    });
    root.addEventListener("pointerdown", activateFromEvent, true);
    root.addEventListener("focusin", keepFocusedControlVisible, true);
    window.visualViewport?.addEventListener("resize", updateKeyboardState);
    window.visualViewport?.addEventListener("scroll", updateKeyboardState);
    window.addEventListener("resize", updateKeyboardState);
    scan();
    updateKeyboardState();

    return () => {
      observer.disconnect();
      resizeObserver?.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
      root.removeEventListener("pointerdown", activateFromEvent, true);
      root.removeEventListener("focusin", keepFocusedControlVisible, true);
      window.visualViewport?.removeEventListener("resize", updateKeyboardState);
      window.visualViewport?.removeEventListener("scroll", updateKeyboardState);
      window.removeEventListener("resize", updateKeyboardState);
      resetDecorations();
      document.body.classList.remove("has-muzare-sticky-action-bar", "muzare-keyboard-open");
      document.documentElement.style.removeProperty("--muzare-sticky-action-height");
    };
  }, [location.key, location.pathname, location.search]);

  return children;
}
