import { Check, ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { SearchInput } from "./SearchInput";
import { compareLabourers, type Labourer } from "../lib/offline-db";

type LabourSelectComboboxProps = {
  options: Labourer[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  allOptionLabel?: string;
  includeAllOption?: boolean;
  ariaLabel?: string;
  disabled?: boolean;
  clearValue?: string;
  noResultsLabel?: string;
  inputRef?: RefObject<HTMLInputElement | null>;
  maxSuggestions?: number;
  renderOption?: (option: Labourer, state: { selected: boolean; active: boolean }) => ReactNode;
  renderSelectedValue?: (option: Labourer, actions: { change: () => void; clear: () => void }) => ReactNode;
};

type LabourOption = {
  id: string;
  name: string;
  phone: string;
  searchText: string;
  normalizedName: string;
  words: string[];
};

const normalize = (value: string) => value.trim().toLowerCase();

const isSubsequenceMatch = (text: string, term: string) => {
  if (!term) return true;
  let cursor = 0;
  for (const character of text) {
    if (character === term[cursor]) cursor += 1;
    if (cursor === term.length) return true;
  }
  return false;
};

const scoreLabourOption = (option: LabourOption, rawTerm: string) => {
  const term = normalize(rawTerm);
  if (!term) return 0;

  const compactName = option.normalizedName.replace(/\s+/g, " ").trim();
  if (compactName === term) return 5000;

  const terms = term.split(/\s+/).filter(Boolean);
  const firstWord = option.words[0] ?? "";
  const joinedWords = option.words.join(" ");

  if (terms.length === 1) {
    const [single] = terms;
    if (firstWord.startsWith(single)) return 4200 - Math.min(firstWord.length, 80);
    if (option.words.some((word) => word.startsWith(single))) return 3600 - Math.min(joinedWords.indexOf(single), 500);
    if (compactName.includes(single)) return 2800 - Math.min(compactName.indexOf(single), 500);
    if (option.phone.includes(single)) return 2200;
    if (isSubsequenceMatch(compactName.replace(/\s+/g, ""), single.replace(/\s+/g, ""))) return 1200;
    return -1;
  }

  const allTermsMatch = terms.every((part) => option.words.some((word) => word.startsWith(part)) || compactName.includes(part) || option.phone.includes(part));
  if (allTermsMatch) {
    const startsCount = terms.filter((part) => option.words.some((word) => word.startsWith(part))).length;
    return 3400 + startsCount * 120 - terms.join(" ").length;
  }

  const compactJoined = compactName.replace(/\s+/g, "");
  const compactTerm = terms.join("");
  if (compactTerm && isSubsequenceMatch(compactJoined, compactTerm)) return 1100;
  return -1;
};

export function LabourSelectCombobox({
  options,
  value,
  onChange,
  placeholder,
  allOptionLabel,
  includeAllOption = false,
  ariaLabel,
  disabled = false,
  clearValue = "",
  noResultsLabel,
  inputRef,
  maxSuggestions = 8,
  renderOption,
  renderSelectedValue,
}: LabourSelectComboboxProps) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const deferredQuery = useDeferredValue(query);
  const resolvedPlaceholder = placeholder ?? t("workforcePage.searchLabour");
  const resolvedAllOptionLabel = allOptionLabel ?? t("workforcePage.allLabour");
  const resolvedAriaLabel = ariaLabel ?? t("reports.labour");
  const resolvedNoResultsLabel = noResultsLabel ?? t("advancesPage.noLabourResults");

  const labourOptions = useMemo<LabourOption[]>(() => options.map((option) => {
    const phone = option.mobile ?? option.phone ?? "";
    const normalizedName = normalize(option.name);
    return {
      id: option.id,
      name: option.name,
      phone,
      searchText: normalize(`${option.name} ${phone}`),
      normalizedName,
      words: normalizedName.split(/\s+/).filter(Boolean),
    };
  }), [options]);

  const selected = useMemo(() => labourOptions.find((option) => option.id === value), [labourOptions, value]);
  const selectedLabel = value === "all" ? resolvedAllOptionLabel : (selected?.name ?? "");
  const isDefaultSelection = value === clearValue || (!value && !clearValue);
  const showClear = Boolean(query) && !(isDefaultSelection && query === selectedLabel);

  useEffect(() => {
    if (!open) setQuery(selectedLabel);
  }, [open, selectedLabel]);

  const filtered = useMemo(() => {
    const term = normalize(deferredQuery);
    if (!term) return labourOptions;
    return labourOptions
      .map((option) => ({ option, score: scoreLabourOption(option, term) }))
      .filter((entry) => entry.score >= 0)
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        return compareLabourers(
          options.find((item) => item.id === left.option.id) ?? { id: left.option.id, name: left.option.name, createdAt: "" },
          options.find((item) => item.id === right.option.id) ?? { id: right.option.id, name: right.option.name, createdAt: "" },
        );
      })
      .map((entry) => entry.option);
  }, [deferredQuery, labourOptions, options]);

  const items = useMemo(
    () => (includeAllOption && !normalize(deferredQuery) ? [{ id: "all", name: resolvedAllOptionLabel, phone: "", searchText: "" }, ...filtered] : filtered).slice(0, maxSuggestions),
    [resolvedAllOptionLabel, deferredQuery, filtered, includeAllOption, maxSuggestions],
  );

  useEffect(() => {
    if (activeIndex >= items.length) setActiveIndex(0);
  }, [activeIndex, items.length]);

  useEffect(() => {
    if (!open) return;
    optionRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  const select = (nextValue: string) => {
    const nextLabel = nextValue === "all"
      ? resolvedAllOptionLabel
      : labourOptions.find((option) => option.id === nextValue)?.name ?? "";
    onChange(nextValue);
    setQuery(nextLabel);
    setOpen(false);
    setActiveIndex(0);
  };

  const openMenu = () => {
    if (disabled) return;
    setOpen(true);
    setActiveIndex(0);
    if (query === selectedLabel) setQuery("");
  };

  const closeMenu = () => {
    setOpen(false);
    setQuery(selectedLabel);
    setActiveIndex(0);
  };

  const clear = () => {
    onChange(clearValue);
    setQuery("");
    setOpen(false);
    setActiveIndex(0);
  };

  const beginChange = () => {
    clear();
    setOpen(true);
    window.requestAnimationFrame(() => inputRef?.current?.focus());
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) closeMenu();
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open, selectedLabel]);

  const selectedLabour = value && value !== "all" ? options.find((option) => option.id === value) : undefined;

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) {
        openMenu();
        return;
      }
      setActiveIndex((index) => (index + 1) % Math.max(items.length, 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        openMenu();
        return;
      }
      setActiveIndex((index) => (index - 1 + Math.max(items.length, 1)) % Math.max(items.length, 1));
      return;
    }
    if (event.key === "Enter") {
      if (!open) return;
      event.preventDefault();
      const item = items[activeIndex];
      if (item) select(item.id);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      if (open) {
        closeMenu();
      } else if (query) {
        clear();
      }
    }
  };

  return (
    <div className="labour-combobox" ref={rootRef}>
      {selectedLabour && !open && renderSelectedValue ? renderSelectedValue(selectedLabour, { change: beginChange, clear }) : null}
      <SearchInput
        aria-label={resolvedAriaLabel}
        className={`labour-combobox__input${selectedLabour && !open && renderSelectedValue ? " labour-combobox__input--hidden" : ""}`}
        disabled={disabled}
        ref={inputRef}
        onChange={(nextValue) => {
          if (value && nextValue !== selectedLabel) onChange(clearValue);
          setQuery(nextValue);
          setOpen(true);
          setActiveIndex(0);
        }}
        onClear={clear}
        onFocus={openMenu}
        onClick={openMenu}
        onKeyDown={onInputKeyDown}
        placeholder={resolvedPlaceholder}
        role="combobox"
        autoComplete="off"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls="labour-combobox-options"
        showClear={showClear}
        value={query}
      />
      <ChevronDown className={`labour-combobox__chevron${open ? " is-open" : ""}`} size={16} aria-hidden="true" />
      {open ? (
        <div className="labour-combobox__menu" id="labour-combobox-options" role="listbox" aria-label={resolvedAriaLabel}>
          <div className="labour-combobox__options">
            {items.length === 0 ? <p className="empty-records labour-combobox__empty">{resolvedNoResultsLabel}</p> : items.map((option, index) => {
              const isActive = activeIndex === index;
              const isSelected = value === option.id;
              const fullOption = option.id === "all" ? undefined : options.find((item) => item.id === option.id);
              return (
                <button
                  ref={(node) => { optionRefs.current[index] = node; }}
                  type="button"
                  key={option.id}
                  className={`labour-combobox__option${isActive ? " is-active" : ""}${isSelected ? " is-selected" : ""}`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => select(option.id)}
                >
                  {fullOption && renderOption ? renderOption(fullOption, { selected: isSelected, active: isActive }) : <>
                    <span>{option.name}</span>
                    {option.phone ? <small>{option.phone}</small> : null}
                  </>}
                  {isSelected ? <Check size={14} /> : null}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
