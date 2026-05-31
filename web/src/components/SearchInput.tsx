import { Search, X } from "lucide-react";
import { useRef, type InputHTMLAttributes, type KeyboardEvent } from "react";

type SearchInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "onChange"> & {
  value: string;
  onChange: (value: string) => void;
  onClear?: () => void;
};

export function SearchInput({ value, onChange, onClear, className, ...rest }: SearchInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
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
        ref={inputRef}
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {value ? (
        <button type="button" className="search-input__clear" aria-label="Clear search" onClick={clear}>
          <X size={16} />
        </button>
      ) : null}
    </div>
  );
}

