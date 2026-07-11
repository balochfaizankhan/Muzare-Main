import { Check, ChevronDown, Search, X } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { Labourer } from "../lib/offline-db";

type LabourMultiSelectFilterProps = {
  options: Labourer[];
  selectedIds: string[];
  onChange: (selectedIds: string[]) => void;
  ariaLabel?: string;
  placeholder?: string;
  noResultsLabel?: string;
};

const normalize = (value: string) => value.trim().toLowerCase();

const scoreLabour = (labourer: Labourer, query: string) => {
  const term = normalize(query);
  if (!term) return 1;
  const name = normalize(labourer.name);
  const words = name.split(/\s+/).filter(Boolean);
  if (name === term) return 500;
  if ((words[0] ?? "").startsWith(term)) return 420;
  if (words.some((word) => word.startsWith(term))) return 360;
  if (name.includes(term)) return 280;
  return -1;
};

export function LabourMultiSelectFilter({
  options,
  selectedIds,
  onChange,
  ariaLabel,
  placeholder,
  noResultsLabel,
}: LabourMultiSelectFilterProps) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [draftIds, setDraftIds] = useState<string[]>(selectedIds);
  const deferredQuery = useDeferredValue(query);
  const selectedSet = useMemo(() => new Set(draftIds), [draftIds]);
  const selectedCount = selectedIds.length;
  const label = selectedCount === 0
    ? t("common.allLabour")
    : selectedCount === 1
      ? t("common.oneLabourSelected")
      : t("common.labourSelectedCount", { count: selectedCount });
  const resolvedPlaceholder = placeholder ?? t("common.searchLabour");
  const resolvedAriaLabel = ariaLabel ?? t("common.labour");
  const resolvedNoResults = noResultsLabel ?? t("common.noMatchingLabour");

  const sortedOptions = useMemo(() => options.slice(), [options]);
  const filteredOptions = useMemo(() => {
    const term = normalize(deferredQuery);
    if (!term) return sortedOptions;
    return sortedOptions
      .map((labourer, index) => ({ labourer, score: scoreLabour(labourer, term), index }))
      .filter((item) => item.score >= 0)
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .map((item) => item.labourer);
  }, [deferredQuery, sortedOptions]);

  const openMenu = () => {
    setDraftIds(selectedIds);
    setOpen(true);
    window.requestAnimationFrame(() => inputRef.current?.focus());
  };

  const closeMenu = () => {
    setOpen(false);
    setQuery("");
    setDraftIds(selectedIds);
  };

  const apply = () => {
    onChange(draftIds);
    setOpen(false);
    setQuery("");
  };

  const clear = () => {
    setDraftIds([]);
    onChange([]);
    setOpen(false);
    setQuery("");
  };

  const toggle = (labourerId: string) => {
    setDraftIds((current) => current.includes(labourerId)
      ? current.filter((id) => id !== labourerId)
      : [...current, labourerId]);
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) closeMenu();
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open, selectedIds]);

  useEffect(() => {
    if (!open) setDraftIds(selectedIds);
  }, [open, selectedIds]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      apply();
    }
  };

  return (
    <div className="labour-multiselect" ref={rootRef}>
      <div
        role="combobox"
        tabIndex={0}
        className="labour-multiselect__trigger"
        aria-label={resolvedAriaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={open ? closeMenu : openMenu}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            open ? closeMenu() : openMenu();
          }
        }}
      >
        <span>{label}</span>
        <span className="labour-multiselect__actions">
          {selectedCount > 0 ? (
            <button
              type="button"
              className="labour-multiselect__clear"
              aria-label={t("common.clearSelection")}
              onClick={(event) => { event.preventDefault(); event.stopPropagation(); clear(); }}
            >
              <X size={14} />
            </button>
          ) : null}
          <ChevronDown size={16} className={open ? "is-open" : ""} aria-hidden="true" />
        </span>
      </div>
      {open ? (
        <div className="labour-multiselect__menu">
          <label className="labour-multiselect__search">
            <Search size={15} aria-hidden="true" />
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder={resolvedPlaceholder}
              autoComplete="off"
            />
            {query ? <button type="button" aria-label={t("common.clearSearch")} onClick={() => setQuery("")}><X size={14} /></button> : null}
          </label>
          <div className="labour-multiselect__toolbar">
            <button type="button" onClick={() => setDraftIds(sortedOptions.map((labourer) => labourer.id))}>{t("common.selectAll")}</button>
            <button type="button" onClick={() => setDraftIds([])}>{t("common.clearSelection")}</button>
          </div>
          <div className="labour-multiselect__options" role="listbox" aria-multiselectable="true">
            <button type="button" className={`labour-multiselect__option${draftIds.length === 0 ? " is-selected" : ""}`} onClick={() => setDraftIds([])}>
              <span className="labour-multiselect__checkbox">{draftIds.length === 0 ? <Check size={13} /> : null}</span>
              <strong>{t("common.allLabour")}</strong>
            </button>
            {filteredOptions.length === 0 ? <p className="labour-multiselect__empty">{resolvedNoResults}</p> : filteredOptions.map((labourer) => {
              const checked = selectedSet.has(labourer.id);
              return (
                <button type="button" key={labourer.id} className={`labour-multiselect__option${checked ? " is-selected" : ""}`} onClick={() => toggle(labourer.id)}>
                  <span className="labour-multiselect__checkbox">{checked ? <Check size={13} /> : null}</span>
                  <span className="labour-multiselect__option-text">
                    <strong>{labourer.name}</strong>
                    <small>{labourer.group || t("reportsPage.ungrouped")}</small>
                  </span>
                </button>
              );
            })}
          </div>
          <div className="labour-multiselect__footer">
            <span className="labour-multiselect__footer-count">{draftIds.length === 0 ? t("common.allLabour") : t("common.labourSelectedCount", { count: draftIds.length })}</span>
            <div className="labour-multiselect__footer-actions">
              <button type="button" onClick={closeMenu}>{t("common.cancel")}</button>
              <button type="button" onClick={apply}>{t("common.apply")}</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
