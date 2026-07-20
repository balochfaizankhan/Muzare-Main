export type SarMinorUnitsResult =
  | { success: true; minorUnits: number; normalized: string }
  | { success: false; message: string };

export function parseSarMinorUnits(raw: unknown): SarMinorUnitsResult {
  if (typeof raw !== "string" && typeof raw !== "number")
    return { success: false, message: "Enter a valid SAR amount." };
  const value = typeof raw === "number" ? String(raw) : raw.trim();
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(value))
    return { success: false, message: "Enter a SAR amount with no more than two decimal places." };
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = value.replace("-", "").split(".");
  const minorUnits = (Number(whole) * 100 + Number(fraction.padEnd(2, "0"))) * (negative ? -1 : 1);
  if (!Number.isSafeInteger(minorUnits))
    return { success: false, message: "Enter a valid SAR amount." };
  return { success: true, minorUnits, normalized: `${negative ? "-" : ""}${whole}.${fraction.padEnd(2, "0")}` };
}

export const sarFromMinorUnits = (minorUnits: number) => minorUnits / 100;
