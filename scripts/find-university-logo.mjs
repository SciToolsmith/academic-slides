#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

function usage() {
  return [
    "Usage: node find-university-logo.mjs <university name> [options]",
    "",
    "Options:",
    "  --catalog <file>  Required project-specific verified catalog; no logo catalog is bundled",
    "  --exact           Require an exact normalized name or alias (default)",
    "  --fuzzy           Return provisional similar-name candidates for manual review",
    "  --limit <n>       Maximum results (default: 5)",
    "  --json            Emit machine-readable JSON",
    "  -h, --help        Show this help",
    "",
    "Exit codes: 0 match, 1 no match, 2 usage/catalog error.",
  ].join("\n");
}

function parseArgs(argv) {
  const result = { exact: true, json: false, limit: 5 };
  const queryParts = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--exact") result.exact = true;
    else if (arg === "--fuzzy") result.exact = false;
    else if (arg === "--json") result.json = true;
    else if (arg === "--catalog") {
      if (!argv[index + 1]) throw new Error("--catalog requires a file path.");
      result.catalog = argv[++index];
    } else if (arg === "--limit") {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || value < 1 || value > 100) throw new Error("--limit must be an integer from 1 to 100.");
      result.limit = value;
    } else if (arg === "-h" || arg === "--help") result.help = true;
    else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else queryParts.push(arg);
  }
  result.query = queryParts.join(" ").trim();
  return result;
}

function normalize(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\s·•・—–_()（）\[\]【】{}<>《》“”'"，,。.、:：;；/\\|-]+/g, "");
}

function levenshtein(left, right) {
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function bigrams(value) {
  if (value.length < 2) return new Set([value]);
  const output = new Set();
  for (let index = 0; index < value.length - 1; index += 1) output.add(value.slice(index, index + 2));
  return output;
}

function diceCoefficient(left, right) {
  const leftSet = bigrams(left);
  const rightSet = bigrams(right);
  let overlap = 0;
  for (const item of leftSet) if (rightSet.has(item)) overlap += 1;
  return (2 * overlap) / (leftSet.size + rightSet.size || 1);
}

function candidateStrings(entry) {
  return [entry.school_name, entry.normalized_name, entry.english_name, entry.campus, ...(entry.aliases ?? [])]
    .map((item) => ({ original: item, normalized: normalize(item) }))
    .filter((item) => item.normalized);
}

function scoreString(query, candidate) {
  if (query === candidate) return { score: 1000, kind: "exact" };
  if (candidate.startsWith(query) || query.startsWith(candidate)) {
    const difference = Math.abs(candidate.length - query.length);
    return { score: 850 - difference, kind: "prefix" };
  }
  if (candidate.includes(query) || query.includes(candidate)) {
    const difference = Math.abs(candidate.length - query.length);
    return { score: 760 - difference, kind: "contains" };
  }
  const distance = levenshtein(query, candidate);
  const similarity = 1 - distance / Math.max(query.length, candidate.length, 1);
  const dice = diceCoefficient(query, candidate);
  const combined = Math.max(similarity, dice * 0.95);
  return { score: Math.round(combined * 600), kind: "fuzzy", similarity: combined };
}

function rankEntries(query, entries, exact) {
  const normalizedQuery = normalize(query);
  const ranked = [];
  for (const entry of entries) {
    let best = { score: -1, kind: "none", matched: null };
    for (const candidate of candidateStrings(entry)) {
      const score = scoreString(normalizedQuery, candidate.normalized);
      if (score.score > best.score) best = { ...score, matched: candidate.original };
    }
    if (exact ? best.kind === "exact" : best.score >= 330) ranked.push({ ...entry, match: best });
  }
  ranked.sort((left, right) => right.match.score - left.match.score || left.school_name.localeCompare(right.school_name, "zh-CN"));
  return ranked.some((item) => item.match.kind === "exact") ? ranked.filter((item) => item.match.kind === "exact") : ranked;
}

function isVerifiedEntry(entry) {
  const status = String(entry?.source?.verification_status ?? entry?.verification_status ?? entry?.status ?? "").toLowerCase();
  return entry?.verified === true || ["verified", "official", "current-official"].includes(status);
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function findUniversityLogos(query, catalogPath, options = {}) {
  if (!catalogPath) throw new Error("No logo catalog is bundled. Provide --catalog with a verified project-specific catalog.");
  const absoluteCatalog = path.resolve(catalogPath);
  const catalog = JSON.parse(await readFile(absoluteCatalog, "utf8"));
  if (!Array.isArray(catalog.logos)) throw new Error(`Catalog has no logos array: ${absoluteCatalog}`);
  const root = path.resolve(path.dirname(absoluteCatalog), catalog.root ?? ".");
  const ranked = rankEntries(query, catalog.logos, options.exact !== false).slice(0, options.limit ?? 5);
  const results = [];
  for (const entry of ranked) {
    const absoluteFile = path.resolve(root, entry.file);
    const verified = isVerifiedEntry(entry);
    results.push({
      id: entry.id,
      school_name: entry.school_name,
      aliases: entry.aliases ?? [],
      campus: entry.campus ?? null,
      file: absoluteFile,
      file_exists: await exists(absoluteFile),
      format: entry.format,
      sha256: entry.sha256,
      source: entry.source ?? null,
      verification: {
        status: verified ? "verified" : "candidate-only",
        usable_without_verification: verified,
        note: verified
          ? "Catalog metadata marks this asset as verified."
          : "Treat as a local candidate only. Verify the current institution, campus, logo variant, and official source before use.",
      },
      match: entry.match,
    });
  }
  return { query, normalized_query: normalize(query), catalog: absoluteCatalog, results };
}

function printHuman(result) {
  if (!result.results.length) {
    console.log(`NO MATCH: ${result.query}`);
    console.log("Search the university's official visual-identity or brand page, then record source metadata before use.");
    return;
  }
  console.log(`MATCHES: ${result.query}`);
  for (const [index, item] of result.results.entries()) {
    console.log(`${index + 1}. ${item.school_name} [${item.match.kind}, ${item.match.score}]`);
    console.log(`   file: ${item.file}${item.file_exists ? "" : " (MISSING)"}`);
    if (item.campus) console.log(`   campus: ${item.campus}`);
    if (item.source?.url) console.log(`   source: ${item.source.url}`);
    console.log(`   verification: ${item.verification.status}`);
    console.log(`   matched: ${item.match.matched}`);
  }
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.query) {
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  if (!args.catalog) {
    console.error("ERROR: No logo catalog is bundled. Provide --catalog with a verified project-specific catalog.");
    process.exitCode = 2;
    return;
  }
  try {
    const result = await findUniversityLogos(args.query, args.catalog, args);
    if (args.json) console.log(JSON.stringify({ ok: result.results.length > 0, ...result }, null, 2));
    else printHuman(result);
    if (result.results.length === 0) process.exitCode = 1;
    else if (result.results.some((item) => !item.file_exists)) process.exitCode = 2;
  } catch (error) {
    if (args.json) console.log(JSON.stringify({ ok: false, error: error.message }, null, 2));
    else console.error(`ERROR: ${error.message}`);
    process.exitCode = 2;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) await main();
