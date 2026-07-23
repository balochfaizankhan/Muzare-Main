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
