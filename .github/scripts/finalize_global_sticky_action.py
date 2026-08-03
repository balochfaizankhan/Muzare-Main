from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
path = ROOT / "web/src/components/StickyActionBar.tsx"
text = path.read_text(encoding="utf-8")

text = text.replace(
'''const actionNamePattern = /(action|footer|submit|save|complete|settle|toolbar|button)/i;
const dialogSelector = "[role='dialog'],dialog,.modal,.dialog,.drawer,.bottom-sheet,.sheet";
''',
'''const actionNamePattern = /(action|footer|submit|save|complete|settle|toolbar|button)/i;
const excludedFormPattern = /(search|filter|query|pagination|quick-find|toolbar-form)/i;
const dialogSelector = "[role='dialog'],dialog,.modal,.dialog,.drawer,.bottom-sheet,.sheet";
''')

text = text.replace(
'''function resolveControlForm(control: HTMLElement) {
  const closest = control.closest<HTMLFormElement>("form");
  if (closest) return closest;
  const formId = control.getAttribute("form");
  const associated = formId ? document.getElementById(formId) : null;
  return associated instanceof HTMLFormElement ? associated : null;
}

function collectActions(root: HTMLElement) {
''',
'''function resolveControlForm(control: HTMLElement) {
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
''')

text = text.replace(
'''    if (!form || !bar.querySelector("button,input[type='submit']")) return;
''',
'''    if (!form || !shouldEnhanceForm(form) || !bar.querySelector("button,input[type='submit']")) return;
''', 1)

text = text.replace(
'''    if (!form || form.dataset.stickyActionDisabled === "true") return;
''',
'''    if (!form || !shouldEnhanceForm(form)) return;
''', 1)

text = text.replace(
'''        item.form.classList.add("muzare-sticky-action-form");
''',
'''        item.form.classList.add("muzare-sticky-action-form");
        item.form.dataset.stickyActionVariant = item.variant;
''')

text = text.replace(
'''        form.classList.remove("muzare-sticky-action-form");
        delete form.dataset.stickyActionState;
''',
'''        form.classList.remove("muzare-sticky-action-form");
        delete form.dataset.stickyActionState;
        delete form.dataset.stickyActionVariant;
''')

for marker in ["excludedFormPattern", "function shouldEnhanceForm", "stickyActionVariant = item.variant"]:
    if marker not in text:
        raise SystemExit(f"Missing final scope marker: {marker}")
path.write_text(text, encoding="utf-8")

css_path = ROOT / "web/src/components/StickyActionBar.css"
css = css_path.read_text(encoding="utf-8")
css = css.replace(
'''.muzare-sticky-action-form[data-sticky-action-state="active"] {
    padding-block-end: calc(var(--muzare-sticky-action-height) + var(--muzare-mobile-nav-height) + 28px) !important;
  }

  body.muzare-keyboard-open .muzare-sticky-action-form[data-sticky-action-state="active"] {
    padding-block-end: calc(var(--muzare-sticky-action-height) + 24px) !important;
  }
''',
'''.muzare-sticky-action-form[data-sticky-action-state="active"][data-sticky-action-variant="viewport"] {
    padding-block-end: calc(var(--muzare-sticky-action-height) + var(--muzare-mobile-nav-height) + 28px) !important;
  }

  .muzare-sticky-action-form[data-sticky-action-state="active"][data-sticky-action-variant="container"] {
    padding-block-end: calc(var(--muzare-sticky-action-height) + 16px) !important;
  }

  body.muzare-keyboard-open .muzare-sticky-action-form[data-sticky-action-state="active"][data-sticky-action-variant="viewport"] {
    padding-block-end: calc(var(--muzare-sticky-action-height) + 24px) !important;
  }
''')
css = css.replace(
'''  .muzare-sticky-action-form[data-sticky-action-state="active"] {
    padding-block-end: calc(var(--muzare-sticky-action-height) + 28px) !important;
  }
''',
'''  .muzare-sticky-action-form[data-sticky-action-state="active"] {
    padding-block-end: calc(var(--muzare-sticky-action-height) + 28px) !important;
  }
''')
if 'data-sticky-action-variant="container"' not in css:
    raise SystemExit("Container-specific form padding was not generated")
css_path.write_text(css, encoding="utf-8")
