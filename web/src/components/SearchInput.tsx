import { Search, X } from "lucide-react";
import { forwardRef, useRef, type InputHTMLAttributes, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";

type SearchInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "onChange"> & {
  value: string;
  onChange: (value: string) => void;
  onClear?: () => void;
  showClear?: boolean;
};

export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(function SearchInput({ value, onChange, onClear, showClear, className, ...rest }, forwardedRef) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const setRef = (node: HTMLInputElement | null) => {
    inputRef.current = node;
    if (!forwardedRef) return;
    if (typeof forwardedRef === "function") {
      forwardedRef(node);
      return;
    }
    forwardedRef.current = node;
  };
  const clear = () => {
    if (!value) return;
    onChange("");
    onClear?.();
    window.requestAnimationFrame(() => inputRef.current?.focus());
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape" && value) {
      event.preventDefault();
      clear();
    }
    rest.onKeyDown?.(event);
  };
  return (
    <div className={`search-input ${className ?? ""}`.trim()}>
      <Search size={16} className="search-input__icon" aria-hidden="true" />
      <input
        {...rest}
        ref={setRef}
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {(showClear ?? Boolean(value)) ? (
        <button
          type="button"
          className="search-input__clear"
          aria-label={t("common.clearSearch")}
          title={t("common.clearSearch")}
          onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
          onClick={(event) => { event.preventDefault(); event.stopPropagation(); clear(); }}
        >
          <X size={16} />
        </button>
      ) : null}
    </div>
  );
});

