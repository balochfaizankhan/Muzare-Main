import { Check, ChevronDown, X } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { SearchInput } from "./SearchInput";

type PickerOption = {
  value: string;
  label: string;
  secondary?: ReactNode;
};

type ResponsiveSelectFieldProps = {
  value: string;
  onChange: (value: string) => void;
  options: PickerOption[];
  title: string;
  ariaLabel?: string;
  placeholder?: string;
  allLabel?: string;
  searchPlaceholder?: string;
  clearValue?: string;
  allowClear?: boolean;
};

type ResponsiveMultiSelectFieldProps = {
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  options: PickerOption[];
  title: string;
  ariaLabel?: string;
  placeholder?: string;
  allLabel?: string;
  searchPlaceholder?: string;
  noResultsLabel?: string;
};

const normalize = (value: string) => value.trim().toLowerCase();

function sheetLabel(option: PickerOption | undefined, allLabel: string, placeholder: string) {
  if (!option) return placeholder || allLabel;
  return option.label || placeholder || allLabel;
}

function matchOption(option: PickerOption, term: string) {
  if (!term) return true;
  const label = normalize(option.label);
  const secondary = typeof option.secondary === "string" ? normalize(option.secondary) : "";
  return label.includes(term) || secondary.includes(term);
}

function MobilePickerShell({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const sheetRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  useEffect(() => {
    if (!open) return;
    window.requestAnimationFrame(() => {
      const firstInput = sheetRef.current?.querySelector<HTMLInputElement>("input");
      firstInput?.focus();
    });
  }, [open]);

  if (!open) return null;

  return (
    <div className="report-picker-backdrop" role="presentation" onClick={onClose}>
      <section
        ref={sheetRef}
        className="report-picker-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </section>
    </div>
  );
}

export function ResponsiveSelectField({
  value,
  onChange,
  options,
  title,
  ariaLabel,
  placeholder,
  allLabel,
  searchPlaceholder,
  clearValue = "",
  allowClear = true,
}: ResponsiveSelectFieldProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const resolvedAllLabel = allLabel ?? "All";
  const resolvedPlaceholder = placeholder ?? resolvedAllLabel;
  const resolvedAriaLabel = ariaLabel ?? title;
  const selected = useMemo(() => options.find((option) => option.value === value), [options, value]);
  const filtered = useMemo(
    () => options.filter((option) => matchOption(option, deferredQuery)),
    [deferredQuery, options],
  );
  const canClear = allowClear && Boolean(value) && value !== clearValue;

  const close = () => {
    setOpen(false);
    setQuery("");
  };

  const choose = (nextValue: string) => {
    onChange(nextValue);
    close();
  };

  return (
    <div className="report-picker">
      <button
        type="button"
        className="report-picker__trigger"
        aria-label={resolvedAriaLabel}
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <span className={`report-picker__trigger-text${selected ? " is-filled" : ""}`}>{sheetLabel(selected, resolvedAllLabel, resolvedPlaceholder)}</span>
        <span className="report-picker__trigger-actions">
          {canClear ? (
            <button
              type="button"
              className="report-picker__clear"
              aria-label={t("common.clearSelection")}
              onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onChange(clearValue);
              }}
            >
              <X size={14} />
            </button>
          ) : null}
          <ChevronDown size={16} aria-hidden="true" />
        </span>
      </button>

      <MobilePickerShell open={open} title={title} onClose={close}>
        <header className="report-picker-sheet__header">
          <div>
            <h3>{title}</h3>
            <p>{resolvedAriaLabel}</p>
          </div>
          <button type="button" className="report-picker-sheet__close" aria-label={t("common.close")} onClick={close}>
            <X size={18} />
          </button>
        </header>
        <div className="report-picker-sheet__search">
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder={searchPlaceholder ?? t("common.search")}
            aria-label={`${title} search`}
          />
        </div>
        <div className="report-picker-sheet__body">
          <button type="button" className={`report-picker-sheet__option${value === clearValue ? " is-selected" : ""}`} onClick={() => choose(clearValue)}>
            <span className="report-picker-sheet__checkbox">{value === clearValue ? <Check size={13} /> : null}</span>
            <span className="report-picker-sheet__option-text">
              <strong>{resolvedAllLabel}</strong>
            </span>
          </button>
          {filtered.map((option) => {
            const selectedState = option.value === value;
            return (
              <button
                type="button"
                key={option.value}
                className={`report-picker-sheet__option${selectedState ? " is-selected" : ""}`}
                onClick={() => choose(option.value)}
              >
                <span className="report-picker-sheet__checkbox">{selectedState ? <Check size={13} /> : null}</span>
                <span className="report-picker-sheet__option-text">
                  <strong>{option.label}</strong>
                  {option.secondary ? <small>{option.secondary}</small> : null}
                </span>
              </button>
            );
          })}
        </div>
      </MobilePickerShell>
    </div>
  );
}

export function ResponsiveMultiSelectField({
  selectedIds,
  onChange,
  options,
  title,
  ariaLabel,
  placeholder,
  allLabel,
  searchPlaceholder,
  noResultsLabel,
}: ResponsiveMultiSelectFieldProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [draftIds, setDraftIds] = useState<string[]>(selectedIds);
  const deferredQuery = useDeferredValue(query);
  const resolvedAllLabel = allLabel ?? "All";
  const resolvedPlaceholder = placeholder ?? resolvedAllLabel;
  const resolvedAriaLabel = ariaLabel ?? title;
  const resolvedNoResults = noResultsLabel ?? "No results found";
  const selectedSet = useMemo(() => new Set(draftIds), [draftIds]);
  const selectedCount = selectedIds.length;
  const summaryLabel = selectedCount === 0
    ? resolvedPlaceholder
    : selectedCount === 1
      ? (options.find((option) => option.value === selectedIds[0])?.label ?? "1 selected")
      : `${selectedCount} selected`;
  const filtered = useMemo(
    () => options.filter((option) => matchOption(option, deferredQuery)),
    [deferredQuery, options],
  );

  const close = () => {
    setOpen(false);
    setQuery("");
    setDraftIds(selectedIds);
  };

  const apply = () => {
    onChange(draftIds);
    setOpen(false);
    setQuery("");
  };

  const toggle = (value: string) => {
    setDraftIds((current) => current.includes(value) ? current.filter((id) => id !== value) : [...current, value]);
  };

  useEffect(() => {
    if (!open) setDraftIds(selectedIds);
  }, [open, selectedIds]);

  return (
    <div className="report-picker">
      <button
        type="button"
        className="report-picker__trigger"
        aria-label={resolvedAriaLabel}
        aria-expanded={open}
        onClick={() => {
          setDraftIds(selectedIds);
          setOpen(true);
        }}
      >
        <span className={`report-picker__trigger-text${selectedCount > 0 ? " is-filled" : ""}`}>{summaryLabel}</span>
        <span className="report-picker__trigger-actions">
          {selectedCount > 0 ? (
            <button
              type="button"
              className="report-picker__clear"
              aria-label={t("common.clearSelection")}
              onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onChange([]);
              }}
            >
              <X size={14} />
            </button>
          ) : null}
          <ChevronDown size={16} aria-hidden="true" />
        </span>
      </button>

      <MobilePickerShell open={open} title={title} onClose={close}>
        <header className="report-picker-sheet__header">
          <div>
            <h3>{title}</h3>
            <p>{resolvedAriaLabel}</p>
          </div>
          <button type="button" className="report-picker-sheet__close" aria-label={t("common.close")} onClick={close}>
            <X size={18} />
          </button>
        </header>
        <div className="report-picker-sheet__search">
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder={searchPlaceholder ?? t("common.search")}
            aria-label={`${title} search`}
          />
        </div>
        <div className="report-picker-sheet__toolbar">
          <button type="button" onClick={() => setDraftIds(options.map((option) => option.value))}>{t("common.selectAll")}</button>
          <button type="button" onClick={() => setDraftIds([])}>{t("common.clearSelection")}</button>
        </div>
        <div className="report-picker-sheet__body" role="listbox" aria-multiselectable="true">
          <button type="button" className={`report-picker-sheet__option${draftIds.length === 0 ? " is-selected" : ""}`} onClick={() => setDraftIds([])}>
            <span className="report-picker-sheet__checkbox">{draftIds.length === 0 ? <Check size={13} /> : null}</span>
            <span className="report-picker-sheet__option-text">
              <strong>{resolvedAllLabel}</strong>
            </span>
          </button>
          {filtered.length === 0 ? <p className="report-picker-sheet__empty">{resolvedNoResults}</p> : filtered.map((option) => {
            const checked = selectedSet.has(option.value);
            return (
              <button type="button" key={option.value} className={`report-picker-sheet__option${checked ? " is-selected" : ""}`} onClick={() => toggle(option.value)}>
                <span className="report-picker-sheet__checkbox">{checked ? <Check size={13} /> : null}</span>
                <span className="report-picker-sheet__option-text">
                  <strong>{option.label}</strong>
                  {option.secondary ? <small>{option.secondary}</small> : null}
                </span>
              </button>
            );
          })}
        </div>
        <footer className="report-picker-sheet__footer">
          <span className="report-picker-sheet__footer-count">
            {draftIds.length === 0 ? t("common.allLabour") : t("common.labourSelectedCount", { count: draftIds.length })}
          </span>
          <div className="report-picker-sheet__footer-actions">
            <button type="button" onClick={close}>{t("common.cancel")}</button>
            <button type="button" onClick={apply}>{t("common.apply")}</button>
          </div>
        </footer>
      </MobilePickerShell>
    </div>
  );
}
