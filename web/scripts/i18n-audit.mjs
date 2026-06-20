import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../src", import.meta.url));
const exts = new Set([".ts", ".tsx"]);
const ignorePatterns = [
  /import\s+/,
  /from\s+"/,
  /^https?:\/\//,
  /^\//,
  /^[A-Z0-9_ -]+$/,
  /^[a-z0-9_.-]+$/,
];

function walk(dir, output = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      walk(full, output);
      continue;
    }
    if ([...exts].some((ext) => full.endsWith(ext))) output.push(full);
  }
  return output;
}

function shouldIgnore(text) {
  const value = text.trim();
  if (!value) return true;
  if (value.length < 3) return true;
  return ignorePatterns.some((pattern) => pattern.test(value));
}

const stringLiteralRegex = /"([^"\n]*[A-Za-z][^"\n]*)"|'([^'\n]*[A-Za-z][^'\n]*)'/g;
const jsxTextRegex = />([^<>{]*[A-Za-z][^<>{]*)</g;

const files = walk(root);
const findings = [];

for (const file of files) {
  const source = readFileSync(file, "utf8");
  const rel = relative(root, file).replace(/\\/g, "/");

  for (const match of source.matchAll(stringLiteralRegex)) {
    const value = (match[1] ?? match[2] ?? "").trim();
    if (shouldIgnore(value)) continue;
    if (source.slice(Math.max(0, match.index - 12), match.index + 4).includes("t(")) continue;
    findings.push({ file: rel, type: "string", value });
  }

  for (const match of source.matchAll(jsxTextRegex)) {
    const value = (match[1] ?? "").replace(/\s+/g, " ").trim();
    if (shouldIgnore(value)) continue;
    findings.push({ file: rel, type: "jsx", value });
  }
}

const deduped = [];
const seen = new Set();
for (const finding of findings) {
  const key = `${finding.file}:${finding.type}:${finding.value}`;
  if (seen.has(key)) continue;
  seen.add(key);
  deduped.push(finding);
}

if (!deduped.length) {
  console.log("No obvious hardcoded visible strings found.");
  process.exit(0);
}

for (const finding of deduped) {
  console.log(`${finding.file} [${finding.type}] ${finding.value}`);
}
