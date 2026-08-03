from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
path = ROOT / "web/src/components/StickyActionBar.tsx"
text = path.read_text(encoding="utf-8")

text = text.replace(
'''function collectActions(root: HTMLElement) {
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
''',
'''function resolveControlForm(control: HTMLElement) {
  const closest = control.closest<HTMLFormElement>("form");
  if (closest) return closest;
  const formId = control.getAttribute("form");
  const associated = formId ? document.getElementById(formId) : null;
  return associated instanceof HTMLFormElement ? associated : null;
}

function collectActions(root: HTMLElement) {
  const found = new Map<HTMLElement, EnhancedAction>();

  root.querySelectorAll<HTMLElement>(explicitActionSelectors).forEach((bar) => {
    const submitControl = bar.querySelector<HTMLElement>("button[type='submit'],button:not([type]),input[type='submit']");
    const form = bar.closest<HTMLFormElement>("form") ?? (submitControl ? resolveControlForm(submitControl) : null);
    if (!form || !bar.querySelector("button,input[type='submit']")) return;
    found.set(bar, { bar, form, variant: bar.closest(dialogSelector) ? "container" : "viewport" });
  });

  root.querySelectorAll<HTMLElement>("form button[type='submit'],form button:not([type]),input[type='submit'],button[form][type='submit']").forEach((button) => {
    const form = resolveControlForm(button);
    if (!form || form.dataset.stickyActionDisabled === "true") return;
    const bar = findActionContainer(button, form);
    if (!bar) return;
    found.set(bar, { bar, form, variant: bar.closest(dialogSelector) ? "container" : "viewport" });
  });

  return [...found.values()].filter(({ bar }) => isVisible(bar));
}
''')

text = text.replace(
'''function chooseInitialAction(actions: EnhancedAction[]) {
  const activeElement = document.activeElement;
''',
'''function chooseInitialAction(actions: EnhancedAction[]) {
  if (actions.some(({ variant }) => variant === "container")) return null;
  const activeElement = document.activeElement;
''')

text = text.replace(
'''    const activate = (next: EnhancedAction | null) => {
      active = next;
      actions.forEach((item) => {
        const isActive = item.variant === "container" || item === next;
        item.bar.dataset.stickyActionState = isActive ? "active" : "inactive";
        item.form.dataset.stickyActionState = isActive ? "active" : "inactive";
      });
      document.body.classList.toggle("has-muzare-sticky-action-bar", Boolean(next));
''',
'''    const activate = (next: EnhancedAction | null) => {
      const containerOpen = actions.some(({ variant }) => variant === "container");
      active = containerOpen ? null : next;
      actions.forEach((item) => {
        const isActive = item.variant === "container" || (!containerOpen && item === next);
        item.bar.dataset.stickyActionState = isActive ? "active" : "inactive";
        item.form.dataset.stickyActionState = isActive ? "active" : "inactive";
      });
      document.body.classList.toggle("has-muzare-sticky-action-bar", Boolean(active));
''')

text = text.replace(
'''      actions.forEach((item) => {
        item.bar.classList.add("muzare-sticky-action-bar");
        item.bar.dataset.stickyActionManaged = "true";
        item.bar.dataset.stickyActionVariant = item.variant;
        item.form.classList.add("muzare-sticky-action-form");
      });
''',
'''      actions.forEach((item) => {
        const isNativeComponent = item.bar.dataset.stickyActionBar === "true";
        item.bar.classList.add("muzare-sticky-action-bar");
        if (!isNativeComponent) item.bar.dataset.stickyActionManaged = "true";
        item.bar.dataset.stickyActionVariant = item.variant;
        item.form.classList.add("muzare-sticky-action-form");
      });
''')

text = text.replace(
'''    const observer = new MutationObserver(scheduleScan);
    observer.observe(root, { childList: true, subtree: true });
''',
'''    const observer = new MutationObserver(scheduleScan);
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["hidden", "aria-hidden", "data-dispatch-tab", "data-tab", "data-state"],
    });
''')

required = [
    "function resolveControlForm",
    "form button:not([type])",
    "containerOpen",
    'attributeFilter: ["hidden", "aria-hidden", "data-dispatch-tab", "data-tab", "data-state"]',
]
for marker in required:
    if marker not in text:
        raise SystemExit(f"Missing refined marker: {marker}")
path.write_text(text, encoding="utf-8")

css_path = ROOT / "web/src/components/StickyActionBar.css"
css = css_path.read_text(encoding="utf-8")
css = css.replace(
'''.muzare-sticky-action-bar[data-sticky-action-variant="container"],
.muzare-sticky-action-bar[data-sticky-action-variant="container"] {''',
'''.muzare-sticky-action-bar[data-sticky-action-variant="container"] {''')
css = css.replace(
'''  .muzare-sticky-action-bar[data-sticky-action-variant="viewport"],
  .muzare-sticky-action-bar[data-sticky-action-variant="viewport"] {''',
'''  .muzare-sticky-action-bar[data-sticky-action-variant="viewport"] {''')
css = css.replace(
'''  body.muzare-keyboard-open .muzare-sticky-action-bar[data-sticky-action-variant="viewport"],
  body.muzare-keyboard-open .muzare-sticky-action-bar[data-sticky-action-variant="viewport"] {''',
'''  body.muzare-keyboard-open .muzare-sticky-action-bar[data-sticky-action-variant="viewport"] {''')
css += '''\n.muzare-sticky-action-bar[data-safe-area="false"][data-sticky-action-variant="viewport"] {\n  padding-block-end: 10px !important;\n}\n\n@media (max-width: 900px) {\n  .muzare-sticky-action-bar[data-safe-area="false"][data-sticky-action-variant="viewport"] {\n    bottom: var(--muzare-mobile-nav-height) !important;\n  }\n  body.muzare-keyboard-open .muzare-sticky-action-bar[data-safe-area="false"][data-sticky-action-variant="viewport"] {\n    bottom: 0 !important;\n  }\n}\n'''
css_path.write_text(css, encoding="utf-8")
