import { ChevronDown, Check } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { SearchInput } from "./SearchInput";
import type { Labourer } from "../lib/offline-db";

type LabourSelectComboboxProps = {
  options: Labourer[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  allOptionLabel?: string;
  includeAllOption?: boolean;
  ariaLabel?: string;
  disabled?: boolean;
};
type LabourOption = {
  id: string;
  name: string;
  phone?: string;
};

const normalize = (value: string) => value.trim().toLowerCase();

export function LabourSelectCombobox({
  options,
  value,
  onChange,
  placeholder = "Search labour",
  allOptionLabel = "All labour",
  includeAllOption = false,
  ariaLabel = "Labour",
  disabled = false,
}: LabourSelectComboboxProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const labourOptions = useMemo<LabourOption[]>(() => options.map((option) => ({
    id: option.id,
    name: option.name,
    phone: option.mobile ?? option.phone ?? "",
  })), [options]);
  const selected = useMemo(() => labourOptions.find((option) => option.id === value), [labourOptions, value]);
  const filtered = useMemo(() => {
    const term = normalize(query);
    if (!term) return labourOptions;
    return labourOptions.filter((option) => {
      const phone = option.phone ?? "";
      return normalize(option.name).includes(term) || normalize(phone).includes(term);
    });
  }, [labourOptions, query]);
  const items = useMemo(
    () => includeAllOption ? [{ id: "all", name: allOptionLabel }, ...filtered] : filtered,
    [allOptionLabel, filtered, includeAllOption],
  );
  const selectedLabel = value === "all" ? allOptionLabel : (selected?.name ?? "");

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", onPointerDown);
    return () => window.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (activeIndex >= items.length) setActiveIndex(0);
  }, [activeIndex, items.length]);

  const select = (nextValue: string) => {
    onChange(nextValue);
    setOpen(false);
    setQuery("");
    setActiveIndex(0);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) { setOpen(true); return; }
      setActiveIndex((index) => (index + 1) % Math.max(items.length, 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) { setOpen(true); return; }
      setActiveIndex((index) => (index - 1 + Math.max(items.length, 1)) % Math.max(items.length, 1));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (!open) { setOpen(true); return; }
      const item = items[activeIndex];
      if (item) select(item.id);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      setQuery("");
    }
  };
  const onMenuKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % Math.max(items.length, 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + Math.max(items.length, 1)) % Math.max(items.length, 1));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const item = items[activeIndex];
      if (item) select(item.id);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      setQuery("");
    }
  };

  return (
    <div className="labour-combobox" ref={rootRef}>
      <button
        type="button"
        className="labour-combobox__trigger"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="listbox"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={onKeyDown}
      >
        <span className={selectedLabel ? "" : "labour-combobox__placeholder"}>
          {selectedLabel || placeholder}
        </span>
        <span className="labour-combobox__trigger-actions">
          {value && value !== "all" ? (
            <span
              aria-label="Clear search"
              className="labour-combobox__clear"
              role="button"
              tabIndex={0}
              onClick={(event) => {
                event.stopPropagation();
                onChange("");
                setQuery("");
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  event.stopPropagation();
                  onChange("");
                  setQuery("");
                }
              }}
            >
              ×
            </span>
          ) : null}
          <ChevronDown size={16} />
        </span>
      </button>
      {open ? (
        <div className="labour-combobox__menu" role="listbox" aria-label={ariaLabel}>
          <SearchInput placeholder={placeholder} value={query} onChange={setQuery} onKeyDown={onMenuKeyDown} />
          <div className="labour-combobox__options">
            {items.length === 0 ? <p className="empty-records">No labour found.</p> : items.map((option, index) => {
              const isActive = activeIndex === index;
              const isSelected = value === option.id;
              const phone = option.phone ?? "";
              return (
                <button
                  type="button"
                  key={option.id}
                  className={`labour-combobox__option${isActive ? " is-active" : ""}${isSelected ? " is-selected" : ""}`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => select(option.id)}
                >
                  <span>{option.name}</span>
                  {phone ? <small>{phone}</small> : null}
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
