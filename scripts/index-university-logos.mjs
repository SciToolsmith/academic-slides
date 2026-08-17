#!/usr/bin/env node

import { access, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, "../assets/branding/university-logos");
const SUPPORTED = new Set([".svg", ".png", ".jpg", ".jpeg", ".webp", ".pdf"]);
const GENERIC_STEMS = new Set(["logo", "seal", "mark", "emblem", "校徽", "标志", "标准标志"]);

function usage() {
  return [
    "Usage: node index-university-logos.mjs [logos-directory] [options]",
    "",
    "Options:",
    "  -o, --output <file>  Catalog path (default: <logos-directory>/catalog.json)",
    "  --stdout             Print the catalog without writing it",
    "  --check              Exit non-zero when catalog.json is missing or stale",
    "  --strict             Fail on unsafe SVGs, duplicate names, or duplicate content",
    "  --allow-empty        Permit a catalog with no logo files",
    "  --json               Emit a machine-readable operation summary",
    "  -h, --help           Show this help",
  ].join("\n");
}

function parseArgs(argv) {
  const result = { stdout: false, check: false, strict: false, allowEmpty: false, json: false };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--stdout") result.stdout = true;
    else if (arg === "--check") result.check = true;
    else if (arg === "--strict") result.strict = true;
    else if (arg === "--allow-empty") result.allowEmpty = true;
    else if (arg === "--json") result.json = true;
    else if (arg === "--output" || arg === "-o") {
      if (!argv[index + 1]) throw new Error(`${arg} requires a file path.`);
      result.output = argv[++index];
    } else if (arg === "-h" || arg === "--help") result.help = true;
    else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else positional.push(arg);
  }
  if (positional.length > 1) throw new Error("Provide at most one logos directory.");
  result.root = positional[0];
  if (result.stdout && result.check) throw new Error("--stdout cannot be combined with --check.");
  return result;
}

function normalizeName(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\s·•・—–_()（）\[\]【】{}<>《》“”'"，,。.、:：;；/\\|-]+/g, "");
}

function cleanStem(value) {
  return String(value)
    .normalize("NFKC")
    .replace(/(?:[_\s-]*(?:校徽|logo|seal|emblem|mark|标志|标准标志|图形标志|透明背景|透明底|白底|蓝底|反白|彩色|黑白|横版|竖版|svg|png))+$/gi, "")
    .replace(/^[_\s-]+|[_\s-]+$/g, "")
    .trim();
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values.flat(Infinity)) {
    if (typeof value !== "string" || !value.trim()) continue;
    const trimmed = value.trim();
    const normalized = normalizeName(trimmed);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(trimmed);
  }
  return result;
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function walk(directory, outputPath) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = path.join(directory, entry.name);
    if (outputPath && path.resolve(fullPath) === path.resolve(outputPath)) continue;
    if (entry.isDirectory()) files.push(...(await walk(fullPath, outputPath)));
    else if (entry.isFile() && SUPPORTED.has(path.extname(entry.name).toLowerCase())) files.push(fullPath);
  }
  return files;
}

async function readJsonIfPresent(filePath) {
  if (!(await exists(filePath))) return null;
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid metadata JSON ${filePath}: ${error.message}`);
  }
}

async function metadataFor(filePath) {
  const directory = path.dirname(filePath);
  const extension = path.extname(filePath);
  const stem = path.basename(filePath, extension);
  const candidates = [path.join(directory, `${stem}.meta.json`), path.join(directory, "logo.meta.json")];
  for (const candidate of candidates) {
    const metadata = await readJsonIfPresent(candidate);
    if (metadata) return { metadata, path: candidate };
  }
  return { metadata: {}, path: null };
}

function schoolNameFrom(filePath, root, metadata) {
  const explicit = metadata.institution_name ?? metadata.school_name ?? metadata.formal_name ?? metadata.name_zh ?? metadata.university ?? metadata.name;
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  const extension = path.extname(filePath);
  const rawStem = path.basename(filePath, extension);
  const stem = cleanStem(rawStem);
  if (stem && !GENERIC_STEMS.has(stem.toLocaleLowerCase("zh-CN"))) return stem;
  const relativeDirectory = path.relative(root, path.dirname(filePath));
  const parent = relativeDirectory && relativeDirectory !== "." ? path.basename(relativeDirectory) : "";
  return cleanStem(parent) || rawStem;
}

function inspectSvg(source) {
  const getAttribute = (name) => source.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i"))?.[1] ?? null;
  const flags = [];
  if (/<script\b/i.test(source)) flags.push("script-element");
  if (/\bon[a-z]+\s*=/i.test(source)) flags.push("event-handler");
  if (/\b(?:href|xlink:href)\s*=\s*["']\s*(?:https?:|\/\/)/i.test(source)) flags.push("external-reference");
  if (/url\(\s*["']?\s*(?:https?:|\/\/)/i.test(source)) flags.push("external-css-reference");
  if (/<foreignObject\b/i.test(source)) flags.push("foreign-object");
  const viewBox = getAttribute("viewBox");
  return {
    view_box: viewBox,
    width: getAttribute("width"),
    height: getAttribute("height"),
    has_view_box: Boolean(viewBox),
    security_flags: flags,
  };
}

function metadataAliases(metadata, derivedName, rawStem) {
  return uniqueStrings([
    metadata.aliases ?? [],
    metadata.short_names ?? [],
    metadata.short_name,
    metadata.english_name,
    metadata.name_en,
    derivedName,
    cleanStem(rawStem),
  ]);
}

function stableId(schoolName, relativePath) {
  const digest = createHash("sha256").update(`${normalizeName(schoolName)}\0${relativePath}`).digest("hex").slice(0, 12);
  return `logo-${digest}`;
}

async function buildEntry(filePath, root) {
  const relativePath = path.relative(root, filePath).split(path.sep).join("/");
  const extension = path.extname(filePath).toLowerCase();
  const rawStem = path.basename(filePath, extension);
  const { metadata, path: metadataPath } = await metadataFor(filePath);
  const schoolName = schoolNameFrom(filePath, root, metadata);
  const data = await readFile(filePath);
  const fileStat = await stat(filePath);
  const entry = {
    id: metadata.id ?? stableId(schoolName, relativePath),
    school_name: schoolName,
    normalized_name: normalizeName(schoolName),
    aliases: metadataAliases(metadata, schoolName, rawStem),
    file: relativePath,
    format: extension.slice(1),
    bytes: fileStat.size,
    sha256: createHash("sha256").update(data).digest("hex"),
    asset_type: metadata.asset_type ?? "university-logo",
  };
  if (metadata.english_name ?? metadata.name_en) entry.english_name = metadata.english_name ?? metadata.name_en;
  if (metadata.campus) entry.campus = metadata.campus;
  const sourceUrl = metadata.official_url ?? metadata.source_url ?? metadata.url;
  const retrievedAt = metadata.retrieved_at ?? metadata.fetched_at;
  if (sourceUrl || retrievedAt || metadata.license || metadata.usage_notes || metadata.verification_status) {
    entry.source = {
      ...(sourceUrl ? { url: sourceUrl } : {}),
      ...(retrievedAt ? { retrieved_at: retrievedAt } : {}),
      ...(metadata.license ? { license: metadata.license } : {}),
      ...(metadata.usage_notes ? { usage_notes: metadata.usage_notes } : {}),
      ...(metadata.verification_status ? { verification_status: metadata.verification_status } : {}),
    };
  }
  if (Array.isArray(metadata.transformations) && metadata.transformations.length) entry.transformations = metadata.transformations;
  if (metadataPath) entry.metadata_file = path.relative(root, metadataPath).split(path.sep).join("/");
  if (extension === ".svg") entry.svg = inspectSvg(data.toString("utf8"));
  return entry;
}

function catalogProblems(entries) {
  const issues = [];
  const names = new Map();
  const hashes = new Map();
  const ids = new Map();
  entries.forEach((entry, index) => {
    for (const [value, table, code] of [
      [entry.id, ids, "duplicate-id"],
      [entry.normalized_name, names, "duplicate-school-name"],
      [entry.sha256, hashes, "duplicate-content"],
    ]) {
      if (table.has(value)) issues.push({ severity: "warning", code, files: [table.get(value), entry.file], message: `${code}: ${value}` });
      else table.set(value, entry.file);
    }
    if (entry.svg && !entry.svg.has_view_box) issues.push({ severity: "warning", code: "svg-missing-viewbox", files: [entry.file], message: "SVG has no viewBox." });
    if (entry.svg?.security_flags.length) issues.push({ severity: "error", code: "svg-unsafe", files: [entry.file], message: `SVG contains: ${entry.svg.security_flags.join(", ")}` });
    if (!entry.normalized_name) issues.push({ severity: "error", code: "school-name-empty", files: [entry.file], message: "Could not derive a school name." });
    if (!entry.aliases.length) issues.push({ severity: "warning", code: "aliases-empty", files: [entry.file], message: "Logo has no searchable aliases." });
    if (!entry.source?.url) issues.push({ severity: "warning", code: "source-missing", files: [entry.file], message: "Official source URL is not recorded." });
  });
  return issues;
}

export async function buildLogoCatalog(rootPath, outputPath = null) {
  const root = path.resolve(rootPath);
  const files = (await walk(root, outputPath)).sort((left, right) => left.localeCompare(right, "zh-CN"));
  const logos = [];
  for (const file of files) logos.push(await buildEntry(file, root));
  logos.sort((left, right) => left.school_name.localeCompare(right.school_name, "zh-CN") || left.file.localeCompare(right.file, "zh-CN"));
  const issues = catalogProblems(logos);
  return {
    schema_version: "1.0",
    generated_at: new Date().toISOString(),
    root: outputPath ? path.relative(path.dirname(path.resolve(outputPath)), root).split(path.sep).join("/") || "." : ".",
    summary: {
      logo_count: logos.length,
      school_count: new Set(logos.map((item) => item.normalized_name)).size,
      issue_count: issues.length,
    },
    logos,
    issues,
  };
}

function comparableCatalog(catalog) {
  const { generated_at, ...stable } = catalog;
  return stable;
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
  try {
    const root = path.resolve(args.root ?? DEFAULT_ROOT);
    const output = path.resolve(args.output ?? path.join(root, "catalog.json"));
    const catalog = await buildLogoCatalog(root, output);
    if (!args.allowEmpty && catalog.logos.length === 0) throw new Error(`No supported logo files found in ${root}.`);
    const hardIssues = catalog.issues.filter((item) => item.severity === "error" || args.strict);
    if (args.stdout) {
      process.stdout.write(`${JSON.stringify(catalog, null, 2)}\n`);
    } else if (args.check) {
      if (!(await exists(output))) {
        console.error(`STALE: catalog does not exist: ${output}`);
        process.exitCode = 1;
      } else {
        const current = JSON.parse(await readFile(output, "utf8"));
        if (JSON.stringify(comparableCatalog(current)) !== JSON.stringify(comparableCatalog(catalog))) {
          console.error(`STALE: ${output}`);
          process.exitCode = 1;
        } else if (!args.json) console.log(`CURRENT: ${output}`);
      }
    } else {
      await writeFile(output, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
      if (!args.json) console.log(`WROTE: ${output} (${catalog.logos.length} logo file(s), ${catalog.issues.length} review issue(s))`);
    }
    if (args.json && !args.stdout) {
      const issue_counts = catalog.issues.reduce((counts, item) => ({ ...counts, [item.code]: (counts[item.code] ?? 0) + 1 }), {});
      console.log(JSON.stringify({ ok: hardIssues.length === 0 && !process.exitCode, root, output, summary: catalog.summary, issue_counts, hard_issues: hardIssues }, null, 2));
    }
    if (hardIssues.length) {
      if (!args.json) for (const item of hardIssues) console.error(`${item.severity.toUpperCase()} ${item.code}: ${item.message} [${item.files.join(", ")}]`);
      process.exitCode = 1;
    }
  } catch (error) {
    if (args?.json) console.log(JSON.stringify({ ok: false, error: error.message }, null, 2));
    else console.error(`ERROR: ${error.message}`);
    process.exitCode = 2;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) await main();
