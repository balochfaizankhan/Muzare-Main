from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ts_path = ROOT / "web/src/components/StickyActionBar.tsx"
css_path = ROOT / "web/src/components/StickyActionBar.css"
text = ts_path.read_text(encoding="utf-8")

old_find = '''  return compactFallback ?? button.parentElement;
}
'''
new_find = '''  if (compactFallback) return compactFallback;
  return button.parentElement === form ? button : button.parentElement;
}
'''
if old_find not in text:
    raise SystemExit("findActionContainer fallback anchor missing")
text = text.replace(old_find, new_find, 1)

old_collect_start = '''function collectActions(root: HTMLElement) {
  const found = new Map<HTMLElement, EnhancedAction>();

  root.querySelectorAll<HTMLElement>(explicitActionSelectors).forEach((bar) => {
'''
new_collect_start = '''function collectActions(root: HTMLElement) {
  const found = new Map<HTMLElement, EnhancedAction>();
  const explicitBars = Array.from(root.querySelectorAll<HTMLElement>(explicitActionSelectors));
  const standaloneByForm = new Map<HTMLFormElement, EnhancedAction>();

  explicitBars.forEach((bar) => {
'''
if old_collect_start not in text:
    raise SystemExit("collectActions start anchor missing")
text = text.replace(old_collect_start, new_collect_start, 1)

old_generic = '''  root.querySelectorAll<HTMLElement>("form button[type='submit'],form button:not([type]),input[type='submit'],button[form][type='submit']").forEach((button) => {
    const form = resolveControlForm(button);
    if (!form || !shouldEnhanceForm(form)) return;
    const bar = findActionContainer(button, form);
    if (!bar) return;
    found.set(bar, { bar, form, variant: bar.closest(dialogSelector) ? "container" : "viewport" });
  });

  return [...found.values()].filter(({ bar }) => isVisible(bar));
}
'''
new_generic = '''  root.querySelectorAll<HTMLElement>("form button[type='submit'],form button:not([type]),input[type='submit'],button[form][type='submit']").forEach((button) => {
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
'''
if old_generic not in text:
    raise SystemExit("generic action collection anchor missing")
text = text.replace(old_generic, new_generic, 1)

for marker in [
    "explicitBars.some((bar) => bar.contains(button))",
    "button.parentElement === form ? button",
    "standaloneByForm",
]:
    if marker not in text:
        raise SystemExit(f"missing TypeScript review fix marker: {marker}")
ts_path.write_text(text, encoding="utf-8")

css = css_path.read_text(encoding="utf-8")
css = css.replace("  --muzare-mobile-nav-height: 64px;", "  --muzare-mobile-nav-height: 0px;", 1)

nav_scope = '''
@media (max-width: 767px) {
  .app-shell:not(.app-shell--admin) {
    --muzare-mobile-nav-height: 64px;
  }
}
'''
if nav_scope.strip() not in css:
    css = css.replace("}\n\n.muzare-sticky-action-bar {", "}\n" + nav_scope + "\n.muzare-sticky-action-bar {", 1)

standalone_css = '''
.muzare-sticky-action-bar:is(button, input[type="submit"]) {
  background: var(--brand-primary, #2e7d32) !important;
  border-color: var(--brand-primary, #2e7d32) !important;
  color: #fff !important;
  font-size: 0.94rem;
  font-weight: 800;
  justify-content: center;
  width: auto;
}
'''
if standalone_css.strip() not in css:
    anchor = '''.muzare-sticky-action-bar[data-sticky-action-state="inactive"] {
  display: none !important;
}
'''
    if anchor not in css:
        raise SystemExit("standalone CSS anchor missing")
    css = css.replace(anchor, anchor + standalone_css, 1)

for marker in [
    "--muzare-mobile-nav-height: 0px",
    ".app-shell:not(.app-shell--admin)",
    ".muzare-sticky-action-bar:is(button, input[type=\"submit\"])",
]:
    if marker not in css:
        raise SystemExit(f"missing CSS review fix marker: {marker}")
css_path.write_text(css, encoding="utf-8")
