from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]

component = r'''import {
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
  return compactFallback ?? button.parentElement;
}

function collectActions(root: HTMLElement) {
  const found = new Map<HTMLElement, EnhancedAction>();

  root.querySelectorAll<HTMLElement>(explicitActionSelectors).forEach((bar) => {
    const form = bar.closest("form");
    if (!form || !bar.querySelector("button,input[type='submit']")) return;
    found.set(bar, { bar, form, variant: bar.closest(dialogSelector) ? "container" : "viewport" });
  });

  root.querySelectorAll<HTMLElement>("button[type='submit'],input[type='submit']").forEach((button) => {
    const form = button.closest("form");
    if (!form || form.dataset.stickyActionDisabled === "true") return;
    const bar = findActionContainer(button, form);
    if (!bar) return;
    found.set(bar, { bar, form, variant: bar.closest(dialogSelector) ? "container" : "viewport" });
  });

  return [...found.values()].filter(({ bar }) => isVisible(bar));
}

function chooseInitialAction(actions: EnhancedAction[]) {
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
      active = next;
      actions.forEach((item) => {
        const isActive = item.variant === "container" || item === next;
        item.bar.dataset.stickyActionState = isActive ? "active" : "inactive";
        item.form.dataset.stickyActionState = isActive ? "active" : "inactive";
      });
      document.body.classList.toggle("has-muzare-sticky-action-bar", Boolean(next));
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
      });
    };

    const scan = () => {
      frame = 0;
      resizeObserver?.disconnect();
      resetDecorations();
      actions = collectActions(root);
      actions.forEach((item) => {
        item.bar.classList.add("muzare-sticky-action-bar");
        item.bar.dataset.stickyActionManaged = "true";
        item.bar.dataset.stickyActionVariant = item.variant;
        item.form.classList.add("muzare-sticky-action-form");
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
    observer.observe(root, { childList: true, subtree: true });
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
'''

css = r''':root {
  --muzare-sticky-action-height: 88px;
  --muzare-mobile-nav-height: 64px;
}

.muzare-sticky-action-bar {
  align-items: center !important;
  background: color-mix(in srgb, var(--surface, #fff) 96%, transparent) !important;
  border: 1px solid color-mix(in srgb, var(--border, #e5e7eb) 82%, transparent) !important;
  box-shadow: 0 -12px 34px rgba(15, 23, 42, 0.12) !important;
  display: flex !important;
  gap: 12px !important;
  isolation: isolate;
  margin: 0 !important;
  max-width: none;
  min-height: 72px;
  opacity: 1;
  padding: 10px 14px !important;
  transition: opacity 160ms ease, transform 180ms ease, box-shadow 180ms ease;
  width: auto;
}

.muzare-sticky-action-bar[data-sticky-action-state="inactive"] {
  display: none !important;
}

.muzare-sticky-action-bar__summary,
.muzare-sticky-action-bar [data-sticky-action-summary="true"],
.muzare-sticky-action-bar > :first-child:not(:last-child):not(button) {
  display: grid;
  flex: 1 1 auto;
  gap: 2px;
  min-width: 0;
}

.muzare-sticky-action-bar__summary > span,
.muzare-sticky-action-bar [data-sticky-action-summary="true"] > span {
  color: var(--text-secondary, #6b7280);
  font-size: 0.72rem;
  font-weight: 750;
  line-height: 1.2;
}

.muzare-sticky-action-bar__summary > strong,
.muzare-sticky-action-bar [data-sticky-action-summary="true"] > strong {
  color: var(--brand-primary, #2e7d32);
  font-size: 1.08rem;
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
}

.muzare-sticky-action-bar__summary > small,
.muzare-sticky-action-bar [data-sticky-action-summary="true"] > small {
  color: var(--text-secondary, #6b7280);
  font-size: 0.68rem;
  line-height: 1.25;
}

.muzare-sticky-action-bar__actions,
.muzare-sticky-action-bar > [class*="action"],
.muzare-sticky-action-bar > footer {
  align-items: center;
  display: flex !important;
  flex: 1 0 auto;
  gap: 8px !important;
  justify-content: flex-end;
  margin: 0 !important;
  padding: 0 !important;
}

.muzare-sticky-action-bar button,
.muzare-sticky-action-bar input[type="submit"],
.muzare-sticky-action-bar input[type="button"] {
  align-items: center;
  border-radius: 14px !important;
  display: inline-flex;
  font-size: 0.92rem;
  font-weight: 800;
  gap: 7px;
  justify-content: center;
  min-height: 48px !important;
  min-width: 112px;
  padding: 10px 18px !important;
  touch-action: manipulation;
}

.muzare-sticky-action-bar button[type="submit"],
.muzare-sticky-action-bar input[type="submit"],
.muzare-sticky-action-bar__primary {
  background: var(--brand-primary, #2e7d32) !important;
  border-color: var(--brand-primary, #2e7d32) !important;
  color: #fff !important;
  flex: 1 1 180px;
}

.muzare-sticky-action-bar__primary--danger {
  background: var(--danger, #dc2626) !important;
  border-color: var(--danger, #dc2626) !important;
}

.muzare-sticky-action-bar__secondary,
.muzare-sticky-action-bar button:not([type="submit"]),
.muzare-sticky-action-bar input[type="button"] {
  background: var(--surface, #fff);
  border: 1px solid var(--border, #e5e7eb);
  color: var(--text-primary, #1f2937);
}

.muzare-sticky-action-bar__secondary--danger,
.muzare-sticky-action-bar .danger-link {
  background: var(--danger-bg, #fef2f2) !important;
  border-color: color-mix(in srgb, var(--danger, #dc2626) 28%, transparent) !important;
  color: var(--danger, #dc2626) !important;
}

.muzare-sticky-action-bar button:disabled,
.muzare-sticky-action-bar input:disabled {
  cursor: not-allowed;
  opacity: 0.58;
}

.muzare-sticky-action-bar button:focus-visible,
.muzare-sticky-action-bar input:focus-visible {
  outline: 3px solid color-mix(in srgb, var(--brand-primary, #2e7d32) 28%, transparent);
  outline-offset: 2px;
}

.muzare-sticky-action-bar__spinner {
  animation: muzare-sticky-action-spin 800ms linear infinite;
}

.muzare-sticky-action-form input,
.muzare-sticky-action-form select,
.muzare-sticky-action-form textarea,
.muzare-sticky-action-form [contenteditable="true"] {
  scroll-margin-block-end: calc(var(--muzare-sticky-action-height) + var(--muzare-mobile-nav-height) + 32px);
}

.muzare-sticky-action-bar[data-sticky-action-variant="container"],
.muzare-sticky-action-bar[data-sticky-action-variant="container"] {
  border-radius: 18px 18px 0 0 !important;
  bottom: 0 !important;
  position: sticky !important;
  z-index: 20;
}

body.muzare-keyboard-open .app-mobile-bottom-nav {
  opacity: 0;
  pointer-events: none;
  transform: translateY(110%);
}

@media (max-width: 900px) {
  .muzare-sticky-action-bar[data-sticky-action-variant="viewport"],
  .muzare-sticky-action-bar[data-sticky-action-variant="viewport"] {
    animation: muzare-sticky-action-enter 180ms ease-out both;
    backdrop-filter: blur(18px);
    border-bottom: 0 !important;
    border-radius: 20px 20px 0 0 !important;
    bottom: calc(var(--muzare-mobile-nav-height) + env(safe-area-inset-bottom, 0px)) !important;
    inset-inline: 0 !important;
    padding-block-end: 10px !important;
    position: fixed !important;
    z-index: 80 !important;
  }

  body.muzare-keyboard-open .muzare-sticky-action-bar[data-sticky-action-variant="viewport"],
  body.muzare-keyboard-open .muzare-sticky-action-bar[data-sticky-action-variant="viewport"] {
    bottom: env(safe-area-inset-bottom, 0px) !important;
  }

  .muzare-sticky-action-form[data-sticky-action-state="active"] {
    padding-block-end: calc(var(--muzare-sticky-action-height) + var(--muzare-mobile-nav-height) + 28px) !important;
  }

  body.muzare-keyboard-open .muzare-sticky-action-form[data-sticky-action-state="active"] {
    padding-block-end: calc(var(--muzare-sticky-action-height) + 24px) !important;
  }

  .muzare-sticky-action-bar__actions,
  .muzare-sticky-action-bar > [class*="action"],
  .muzare-sticky-action-bar > footer {
    min-width: min(56vw, 320px);
  }

  .muzare-sticky-action-bar button[type="submit"],
  .muzare-sticky-action-bar input[type="submit"],
  .muzare-sticky-action-bar__primary {
    width: 100%;
  }
}

@media (max-width: 520px) {
  .muzare-sticky-action-bar {
    gap: 10px !important;
    padding-inline: 12px !important;
  }

  .muzare-sticky-action-bar__summary > small,
  .muzare-sticky-action-bar [data-sticky-action-summary="true"] > small {
    display: none;
  }

  .muzare-sticky-action-bar__actions,
  .muzare-sticky-action-bar > [class*="action"],
  .muzare-sticky-action-bar > footer {
    min-width: 0;
  }

  .muzare-sticky-action-bar button,
  .muzare-sticky-action-bar input[type="submit"],
  .muzare-sticky-action-bar input[type="button"] {
    min-width: 96px;
    padding-inline: 14px !important;
  }
}

@media (min-width: 901px) {
  .muzare-sticky-action-bar[data-sticky-action-variant="viewport"],
  .muzare-sticky-action-bar[data-sticky-action-variant="viewport"] {
    border-radius: 18px !important;
    bottom: 16px !important;
    margin-block-start: 16px !important;
    position: sticky !important;
    z-index: 30;
  }

  .muzare-sticky-action-form[data-sticky-action-state="active"] {
    padding-block-end: calc(var(--muzare-sticky-action-height) + 28px) !important;
  }
}

@media (prefers-reduced-motion: reduce) {
  .muzare-sticky-action-bar,
  .muzare-sticky-action-bar__spinner {
    animation: none !important;
    transition: none !important;
  }
}

@media (prefers-color-scheme: dark) {
  .muzare-sticky-action-bar {
    background: color-mix(in srgb, var(--surface, #111827) 94%, transparent) !important;
    box-shadow: 0 -14px 36px rgba(0, 0, 0, 0.34) !important;
  }
}

@keyframes muzare-sticky-action-enter {
  from { opacity: 0; transform: translateY(12px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes muzare-sticky-action-spin {
  to { transform: rotate(360deg); }
}
'''

component_path = ROOT / "web/src/components/StickyActionBar.tsx"
css_path = ROOT / "web/src/components/StickyActionBar.css"
component_path.write_text(component, encoding="utf-8")
css_path.write_text(css, encoding="utf-8")

for relative in ["web/src/layouts/WorkspaceLayout.tsx", "web/src/layouts/AdminLayout.tsx"]:
    path = ROOT / relative
    text = path.read_text(encoding="utf-8")
    if 'from "../components/StickyActionBar"' not in text:
        anchor = 'import { LanguageSwitch } from "../components/LanguageSwitch";'
        if anchor not in text:
            raise SystemExit(f"Missing import anchor in {relative}")
        text = text.replace(anchor, anchor + '\nimport { StickyActionBarProvider } from "../components/StickyActionBar";', 1)
    if "<StickyActionBarProvider><Outlet /></StickyActionBarProvider>" not in text:
        if "<Outlet />" not in text:
            raise SystemExit(f"Missing Outlet anchor in {relative}")
        text = text.replace("<Outlet />", "<StickyActionBarProvider><Outlet /></StickyActionBarProvider>", 1)
    path.write_text(text, encoding="utf-8")

# Static coverage audit: every submit-bearing TSX flow under workspace/admin is handled by a layout provider.
submit_files = []
for path in sorted((ROOT / "web/src").rglob("*.tsx")):
    source = path.read_text(encoding="utf-8")
    if re.search(r'<(?:button|input)[^>]+type=["\']submit["\']', source):
        submit_files.append(path.relative_to(ROOT).as_posix())

workspace_files = [item for item in submit_files if "/pages/workspace/" in item or item.endswith("pages/ModulePage.tsx")]
admin_files = [item for item in submit_files if "/pages/admin/" in item or item.endswith("AdminApprovalsPage.tsx")]
other_files = [item for item in submit_files if item not in workspace_files and item not in admin_files]
print(f"Sticky action audit: {len(submit_files)} submit-bearing TSX files")
print(f"  workspace covered by WorkspaceLayout: {len(workspace_files)}")
print(f"  admin covered by AdminLayout: {len(admin_files)}")
print(f"  auth/onboarding or standalone flows intentionally unchanged: {len(other_files)}")
for item in workspace_files + admin_files:
    print(f"  covered: {item}")

if not workspace_files:
    raise SystemExit("Coverage audit found no workspace submit forms")
if "StickyActionBarProvider" not in (ROOT / "web/src/layouts/WorkspaceLayout.tsx").read_text(encoding="utf-8"):
    raise SystemExit("Workspace provider was not installed")
if "StickyActionBarProvider" not in (ROOT / "web/src/layouts/AdminLayout.tsx").read_text(encoding="utf-8"):
    raise SystemExit("Admin provider was not installed")
