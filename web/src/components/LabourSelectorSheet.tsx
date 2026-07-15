import { Search, X } from "lucide-react";
import { useEffect, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

type LabourSelectorSheetProps = {
  open: boolean;
  title: string;
  subtitle: string;
  query: string;
  onQueryChange: (value: string) => void;
  onClose: () => void;
  searchPlaceholder: string;
  clearSearchLabel: string;
  summary: string;
  cancelLabel: string;
  applyLabel?: string;
  onApply?: () => void;
  toolbar?: ReactNode;
  children: ReactNode;
  searchInputRef?: RefObject<HTMLInputElement | null>;
};

export function LabourSelectorSheet({
  open,
  title,
  subtitle,
  query,
  onQueryChange,
  onClose,
  searchPlaceholder,
  clearSearchLabel,
  summary,
  cancelLabel,
  applyLabel,
  onApply,
  toolbar,
  children,
  searchInputRef,
}: LabourSelectorSheetProps) {
  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose, open]);

  if (!open) return null;

  return createPortal(
    <div className="labour-selector-sheet-backdrop" role="presentation" onPointerDown={onClose}>
      <section className="labour-selector-sheet" role="dialog" aria-modal="true" aria-label={title} onPointerDown={(event) => event.stopPropagation()}>
        <header className="labour-selector-sheet__header">
          <div><h2>{title}</h2><p>{subtitle}</p></div>
          <button type="button" className="labour-selector-sheet__close" aria-label={cancelLabel} onClick={onClose}><X size={19} /></button>
        </header>
        <div className="labour-selector-sheet__controls">
          <label className="labour-selector-sheet__search">
            <Search size={17} aria-hidden="true" />
            <input ref={searchInputRef} value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder={searchPlaceholder} autoComplete="off" />
            {query ? <button type="button" aria-label={clearSearchLabel} onClick={() => onQueryChange("")}><X size={16} /></button> : null}
          </label>
          {toolbar}
        </div>
        <div className="labour-selector-sheet__list" role="listbox">{children}</div>
        <footer className="labour-selector-sheet__footer">
          <span>{summary}</span>
          <div className="labour-selector-sheet__footer-actions">
            <button type="button" className="labour-selector-sheet__cancel" onClick={onClose}>{cancelLabel}</button>
            {onApply && applyLabel ? <button type="button" className="labour-selector-sheet__apply" onClick={onApply}>{applyLabel}</button> : null}
          </div>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

export function useMobileLabourSelector() {
  const query = "(max-width: 767px)";
  const getMatches = () => typeof window !== "undefined" && window.matchMedia(query).matches;
  const [matches, setMatches] = useState(getMatches);

  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = () => setMatches(media.matches);
    onChange();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  return matches;
}
