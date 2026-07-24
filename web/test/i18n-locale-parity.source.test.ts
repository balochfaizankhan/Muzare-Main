import assert from "node:assert/strict";
import test from "node:test";
import { resources } from "../src/i18n";

type TranslationTree = Record<string, unknown>;

function flattenKeys(node: TranslationTree, prefix = ""): Map<string, unknown> {
  const flat = new Map<string, unknown>();
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [nestedPath, nestedValue] of flattenKeys(value as TranslationTree, path)) {
        flat.set(nestedPath, nestedValue);
      }
    } else {
      flat.set(path, value);
    }
  }
  return flat;
}

function interpolationVars(value: string): string[] {
  return [...value.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map((match) => match[1]).sort();
}

const languages = Object.keys(resources).sort();
const flatByLanguage = new Map(languages.map((language) => [
  language,
  flattenKeys((resources as Record<string, { translation: TranslationTree }>)[language].translation),
]));

test("the supported language set is exactly en/ar/ur (update this test deliberately when adding a language)", () => {
  assert.deepEqual(languages, ["ar", "en", "ur"]);
});

test("every non-English locale has exactly the same translation keys as English (no missing, no orphaned keys)", () => {
  const enKeys = new Set(flatByLanguage.get("en")!.keys());
  for (const language of languages) {
    if (language === "en") continue;
    const keys = new Set(flatByLanguage.get(language)!.keys());
    const missing = [...enKeys].filter((key) => !keys.has(key)).sort();
    const extra = [...keys].filter((key) => !enKeys.has(key)).sort();
    assert.deepEqual(
      missing,
      [],
      `locale "${language}" is missing ${missing.length} key(s) present in "en": ${missing.slice(0, 25).join(", ")}${missing.length > 25 ? ` (+${missing.length - 25} more)` : ""}`,
    );
    assert.deepEqual(
      extra,
      [],
      `locale "${language}" has ${extra.length} key(s) not present in "en" (orphaned/renamed keys): ${extra.slice(0, 25).join(", ")}`,
    );
  }
});

test("no locale contains an empty, undefined, or non-string leaf value for a key English defines as a string", () => {
  const enFlat = flatByLanguage.get("en")!;
  for (const language of languages) {
    const flat = flatByLanguage.get(language)!;
    for (const [key, enValue] of enFlat) {
      if (typeof enValue !== "string") continue;
      const value = flat.get(key);
      assert.equal(typeof value, "string", `locale "${language}" key "${key}" must be a string`);
      assert.notEqual((value as string).trim(), "", `locale "${language}" key "${key}" must not be an empty string`);
    }
  }
});

test("Arabic has every CLDR plural form for every plural key (missing forms would fall back to English)", () => {
  // i18next does not fall back from a missing plural form (e.g. _few) to _other within the
  // same language — it falls through to English. The runtime autofill in src/i18n.ts must
  // therefore leave no gaps for Arabic's six plural categories.
  const suffixes = ["zero", "one", "two", "few", "many", "other"];
  const arKeys = new Set(flatByLanguage.get("ar")!.keys());
  const bases = new Set<string>();
  for (const key of arKeys) {
    const match = key.match(/^(.*)_(zero|one|two|few|many|other)$/);
    if (match) bases.add(match[1]);
  }
  const gaps: string[] = [];
  for (const base of bases) {
    for (const suffix of suffixes) {
      if (!arKeys.has(`${base}_${suffix}`)) gaps.push(`${base}_${suffix}`);
    }
  }
  assert.deepEqual(gaps.sort(), [], `Arabic is missing plural forms (English would leak for some counts): ${gaps.slice(0, 20).join(", ")}`);
});

// Latin-script fragments allowed inside Urdu/Arabic values: brand names, file formats,
// protocol/technology names, literal typed-confirmation phrases, and interpolation slots.
const latinAllowedTerms =
  /\{\{[^}]*\}\}|Muzare|SAR|CSV|KML|KMZ|PDF|GPS|API|URL|JSON|GeoJSON|PostgreSQL|HTTP|JPG|PNG|WEBP|Google Earth|Polygon|LineString|Point|DELETE LABOUR DATA|DELETE FINANCIAL HISTORY|CANCEL AND CLEAN IMPORT|DEACTIVATE|DELETE|IndexedDB|ID\b|Wi-?Fi|OK/g;
// Keys whose value is intentionally Latin script in every language.
const latinAllowedKeys = new Set([
  "auth.emailPlaceholder", // literal example address
  "language.english", // language autonym
  "modulePageExtra.csvExpenseReportExpectedColumns", // literal CSV column headers of the file format
]);

test("Urdu and Arabic values contain no embedded English sentences (system text must not leak)", () => {
  const offenders: string[] = [];
  for (const language of ["ar", "ur"]) {
    for (const [key, value] of flatByLanguage.get(language)!) {
      if (typeof value !== "string" || latinAllowedKeys.has(key)) continue;
      const cleaned = value.replace(latinAllowedTerms, " ");
      // Two or more consecutive Latin words is an English phrase, not a technical term.
      if (/[A-Za-z]{2,}[ .,:]+[A-Za-z]{2,}/.test(cleaned)) {
        offenders.push(`${language}.${key} :: ${value}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `English text embedded in non-English locale values:\n${offenders.slice(0, 25).join("\n")}`);
});

test("interpolation variables match exactly across all locales for every shared key", () => {
  const enFlat = flatByLanguage.get("en")!;
  const mismatches: string[] = [];
  for (const language of languages) {
    if (language === "en") continue;
    const flat = flatByLanguage.get(language)!;
    for (const [key, enValue] of enFlat) {
      if (typeof enValue !== "string") continue;
      const value = flat.get(key);
      if (typeof value !== "string") continue; // already reported by the previous test
      const enVars = interpolationVars(enValue);
      const localeVars = interpolationVars(value);
      if (JSON.stringify(enVars) !== JSON.stringify(localeVars)) {
        mismatches.push(`${language}.${key}: en=[${enVars.join(",")}] ${language}=[${localeVars.join(",")}]`);
      }
    }
  }
  assert.deepEqual(mismatches, [], `interpolation variable mismatches found:\n${mismatches.slice(0, 25).join("\n")}`);
});
