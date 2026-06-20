import { ChevronDown, X } from "lucide-react";
import { type KeyboardEvent, type SelectHTMLAttributes } from "react";
import { useTranslation } from "react-i18next";

type ClearableSelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, "onChange" | "value"> & {
  value: string;
  onChange: (value: string) => void;
  clearValue?: string;
  onClear?: () => void;
  clearLabel?: string;
  allowClear?: boolean;
};

export function ClearableSelect({
  value,
  onChange,
  clearValue = "",
  onClear,
  clearLabel,
  allowClear = true,
  className,
  children,
  disabled,
  ...rest
}: ClearableSelectProps) {
  const { t } = useTranslation();
  const clear = () => {
    if (!value || disabled) return;
    onChange(clearValue);
    onClear?.();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLSelectElement>) => {
    if (event.key === "Escape" && value) {
      event.preventDefault();
      clear();
    }
    rest.onKeyDown?.(event);
  };

  return (
    <div className={`clearable-select ${className ?? ""}`.trim()}>
      <select
        {...rest}
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
      >
        {children}
      </select>
      <div className="clearable-select__actions">
        {allowClear && value ? (
          <button
            type="button"
            className="clearable-select__clear"
            aria-label={clearLabel || t("common.clearSelection")}
            title={clearLabel || t("common.clearSelection")}
            onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
            onClick={(event) => { event.preventDefault(); event.stopPropagation(); clear(); }}
            disabled={disabled}
          >
            <X size={14} />
          </button>
        ) : null}
        <ChevronDown className="clearable-select__chevron" size={16} aria-hidden="true" />
      </div>
    </div>
  );
}
