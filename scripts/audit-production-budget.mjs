#!/usr/bin/env node

import { access, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  buildDeckMapFile,
  collectSelectedAssetOccurrences,
  serializeDeckMap,
} from "./build-deck-map.mjs";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".svg", ".pdf", ".emf", ".wmf", ".tif", ".tiff", ".gif"]);
const DEFAULT_POLICY = Object.freeze({
  assets: {
    missing_selected_severity: "fail",
    unresolved_selected_severity: "warn",
    fallback_used_severity: "pass",
    missing_unselected_ready_severity: "warn",
    unselected_ready_severity: "warn",
    untracked_ready_severity: "warn",
    raw_selected_severity: "pass",
    max_unselected_ready_count: 3,
    max_unselected_ready_ratio: 0.25,
    max_untracked_ready_count: 3,
    max_raw_selected_count: null,
    allowed_missing_refs: [],
    allowed_unresolved_refs: [],
    allowed_raw_refs: [],
    allowed_unselected_ready: [],
    ignored_ready_paths: [],
  },
  previews: {
    duplicate_severity: "warn",
    max_full_deck_sets: 1,
    min_coverage_ratio: 0.8,
    min_slide_count: 3,
    ignore_dirs: [],
  },
  context: {
    oversize_severity: "warn",
    stale_map_severity: "warn",
    forbidden_field_severity: "fail",
    max_deck_map_ratio: 0.35,
    max_deck_map_bytes: 131_072,
    min_spec_bytes_for_ratio: 10_240,
  },
  word_qa: {
    duplicate_severity: "warn",
    max_full_sets: 1,
    min_page_count: 2,
    ignore_dirs: [],
  },
  scan: {
    max_depth: 8,
    max_entries: 50_000,
    ignore_dirs: [".git", "node_modules", "delivery", "staging"],
  },
});

function usage() {
  return [
    "Usage: node audit-production-budget.mjs --project-dir <dir> [options]",
    "",
    "Options:",
    "  --project-dir <dir>          Project root containing deck-spec.json",
    "  --spec <deck-spec.json>      Override the standard project deck-spec path",
    "  --deck-map <file>            Audit an existing deck map (default: build in memory)",
    "  --figures-manifest <file>    Figure manifest; repeat for multi-paper projects",
    "  --config <file>              JSON policy overriding the documented defaults",
    "  --max-full-preview-sets <n>  Override the retained full-deck preview budget",
    "  --max-word-qa-sets <n>       Override the retained full Word-QA render budget",
    "  --max-map-ratio <n>          Override deck-map/spec byte ratio",
    "  --max-map-bytes <n>          Override absolute deck-map byte budget",
    "  --strict                     Promote every warning gate to fail",
    "  --json                       Emit machine-readable JSON",
    "  -h, --help                   Show this help",
    "",
    "This command is read-only: it never deletes, rewrites, or creates project files.",
  ].join("\n");
}

function parseArgs(argv) {
  const result = { manifests: [], json: false, strict: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--json") result.json = true;
    else if (token === "--strict") result.strict = true;
    else if (token === "-h" || token === "--help") result.help = true;
    else if ([
      "--spec", "--project-dir", "--deck-map", "--figures-manifest", "--config",
      "--max-full-preview-sets", "--max-word-qa-sets", "--max-map-ratio", "--max-map-bytes",
    ].includes(token)) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${token} requires a value.`);
      if (token === "--figures-manifest") result.manifests.push(value);
      else result[token.slice(2).replaceAll("-", "_")] = value;
    } else throw new Error(`Unknown option: ${token}`);
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

async function isDirectory(filePath) {
  try {
    return (await stat(filePath)).isDirectory();
  } catch {
    return false;
  }
}

async function readJson(filePath, label = "JSON") {
  const source = await readFile(filePath, "utf8");
  try {
    return { value: JSON.parse(source), source, bytes: Buffer.byteLength(source) };
  } catch (error) {
    throw new Error(`Invalid ${label} at ${filePath}: ${error.message}`);
  }
}

function deepMerge(base, override) {
  if (!override || typeof override !== "object" || Array.isArray(override)) return structuredClone(base);
  const output = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === "object" && !Array.isArray(value) && output[key] && typeof output[key] === "object" && !Array.isArray(output[key])) {
      output[key] = deepMerge(output[key], value);
    } else output[key] = structuredClone(value);
  }
  return output;
}

function normalizeSeverity(value, label) {
  if (!["pass", "warn", "fail"].includes(value)) throw new Error(`${label} must be pass, warn, or fail.`);
  return value;
}

function finiteRange(value, label, { minimum = 0, maximum = Number.POSITIVE_INFINITY, integer = false, nullable = false } = {}) {
  if (value == null && nullable) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum || (integer && !Number.isInteger(number))) {
    throw new Error(`${label} must be ${integer ? "an integer" : "a number"} in [${minimum}, ${maximum}].`);
  }
  return number;
}

function normalizeStringArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) throw new Error(`${label} must be an array of non-empty strings.`);
  return [...new Set(value.map((item) => item.trim()))];
}

function validatePolicy(policy) {
  for (const [section, keys] of Object.entries({
    assets: [
      "missing_selected_severity", "unresolved_selected_severity", "fallback_used_severity",
      "missing_unselected_ready_severity", "unselected_ready_severity", "untracked_ready_severity", "raw_selected_severity",
    ],
    previews: ["duplicate_severity"],
    context: ["oversize_severity", "stale_map_severity", "forbidden_field_severity"],
    word_qa: ["duplicate_severity"],
  })) for (const key of keys) policy[section][key] = normalizeSeverity(policy[section][key], `${section}.${key}`);

  policy.assets.max_unselected_ready_count = finiteRange(policy.assets.max_unselected_ready_count, "assets.max_unselected_ready_count", { integer: true });
  policy.assets.max_unselected_ready_ratio = finiteRange(policy.assets.max_unselected_ready_ratio, "assets.max_unselected_ready_ratio", { maximum: 1 });
  policy.assets.max_untracked_ready_count = finiteRange(policy.assets.max_untracked_ready_count, "assets.max_untracked_ready_count", { integer: true });
  policy.assets.max_raw_selected_count = finiteRange(policy.assets.max_raw_selected_count, "assets.max_raw_selected_count", { integer: true, nullable: true });
  for (const key of ["allowed_missing_refs", "allowed_unresolved_refs", "allowed_raw_refs", "allowed_unselected_ready", "ignored_ready_paths"]) {
    policy.assets[key] = normalizeStringArray(policy.assets[key], `assets.${key}`);
  }
  policy.previews.max_full_deck_sets = finiteRange(policy.previews.max_full_deck_sets, "previews.max_full_deck_sets", { integer: true });
  policy.previews.min_coverage_ratio = finiteRange(policy.previews.min_coverage_ratio, "previews.min_coverage_ratio", { maximum: 1 });
  policy.previews.min_slide_count = finiteRange(policy.previews.min_slide_count, "previews.min_slide_count", { integer: true, minimum: 1 });
  policy.previews.ignore_dirs = normalizeStringArray(policy.previews.ignore_dirs, "previews.ignore_dirs");
  policy.context.max_deck_map_ratio = finiteRange(policy.context.max_deck_map_ratio, "context.max_deck_map_ratio", { maximum: 1 });
  policy.context.max_deck_map_bytes = finiteRange(policy.context.max_deck_map_bytes, "context.max_deck_map_bytes", { integer: true, minimum: 1 });
  policy.context.min_spec_bytes_for_ratio = finiteRange(policy.context.min_spec_bytes_for_ratio, "context.min_spec_bytes_for_ratio", { integer: true });
  policy.word_qa.max_full_sets = finiteRange(policy.word_qa.max_full_sets, "word_qa.max_full_sets", { integer: true });
  policy.word_qa.min_page_count = finiteRange(policy.word_qa.min_page_count, "word_qa.min_page_count", { integer: true, minimum: 1 });
  policy.word_qa.ignore_dirs = normalizeStringArray(policy.word_qa.ignore_dirs, "word_qa.ignore_dirs");
  policy.scan.max_depth = finiteRange(policy.scan.max_depth, "scan.max_depth", { integer: true, minimum: 1, maximum: 32 });
  policy.scan.max_entries = finiteRange(policy.scan.max_entries, "scan.max_entries", { integer: true, minimum: 100 });
  policy.scan.ignore_dirs = normalizeStringArray(policy.scan.ignore_dirs, "scan.ignore_dirs");
  return policy;
}

async function loadPolicy(options) {
  let override = options.policy ?? {};
  if (options.config) override = deepMerge(override, (await readJson(path.resolve(options.config), "production budget config")).value);
  const policy = deepMerge(DEFAULT_POLICY, override);
  if (options.max_full_preview_sets != null) policy.previews.max_full_deck_sets = Number(options.max_full_preview_sets);
  if (options.max_word_qa_sets != null) policy.word_qa.max_full_sets = Number(options.max_word_qa_sets);
  if (options.max_map_ratio != null) policy.context.max_deck_map_ratio = Number(options.max_map_ratio);
  if (options.max_map_bytes != null) policy.context.max_deck_map_bytes = Number(options.max_map_bytes);
  if (options.strict === true) {
    const promote = (object) => {
      for (const [key, value] of Object.entries(object)) {
        if (key.endsWith("_severity") && value === "warn") object[key] = "fail";
        else if (value && typeof value === "object" && !Array.isArray(value)) promote(value);
      }
    };
    promote(policy);
  }
  return validatePolicy(policy);
}

function normalizedRelative(root, target) {
  const relative = path.relative(root, target).replaceAll(path.sep, "/");
  return relative || ".";
}

function globRegex(pattern) {
  const normalized = pattern.replaceAll("\\", "/");
  let source = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === "*" && normalized[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (character === "*") source += "[^/]*";
    else if (character === "?") source += "[^/]";
    else source += /[|\\{}()[\]^$+?.]/.test(character) ? `\\${character}` : character;
  }
  return new RegExp(`${source}$`);
}

function matchesPattern(value, pattern) {
  const normalized = String(value ?? "").replaceAll("\\", "/");
  const target = String(pattern ?? "").replaceAll("\\", "/").replace(/^\.\//, "");
  if (!target) return false;
  return normalized === target || normalized.startsWith(`${target}/`) || globRegex(target).test(normalized);
}

function matchesAny(values, patterns) {
  return patterns.some((pattern) => values.some((value) => matchesPattern(value, pattern)));
}

function severityRank(value) {
  return { pass: 0, warn: 1, fail: 2 }[value] ?? 0;
}

function checkRecord(id, title, metrics = {}) {
  return { id, title, status: "pass", metrics, findings: [] };
}

function addFinding(check, severity, code, message, details = {}) {
  if (severity === "pass") return;
  check.findings.push({ severity, code, message, ...details });
  if (severityRank(severity) > severityRank(check.status)) check.status = severity;
}

function pathCandidates(rawPath, bases) {
  if (!rawPath || typeof rawPath !== "string") return [];
  if (path.isAbsolute(rawPath)) return [path.normalize(rawPath)];
  return [...new Set(bases.map((base) => path.resolve(base, rawPath)))];
}

async function firstExisting(candidates) {
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  return null;
}

function manifestEntries(manifest) {
  if (Array.isArray(manifest)) return manifest;
  for (const key of ["figures", "items", "assets"]) if (Array.isArray(manifest?.[key])) return manifest[key];
  return [];
}

async function discoverManifests(projectDir, explicit, scan) {
  if (explicit.length > 0) return [...new Set(explicit.map((item) => path.resolve(item)))];
  return scan.files.filter((file) => path.basename(file).toLowerCase() === "figures.manifest.json");
}

async function loadAssetRegistry(deck, specDir, projectDir, manifestPaths) {
  const byId = new Map();
  const manifestReady = [];
  const manifestOriginals = [];
  const add = (id, record) => {
    if (!id) return;
    const current = byId.get(id) ?? [];
    current.push(record);
    byId.set(id, current);
  };
  for (const asset of Array.isArray(deck?.assets) ? deck.assets : []) {
    add(asset?.id ?? asset?.asset_id, { source: "deck", rawPath: asset?.path ?? asset?.file ?? asset?.src, bases: [specDir, projectDir], ready: /(?:^|[\\/])ready(?:[\\/]|$)/i.test(String(asset?.path ?? "")) });
  }
  for (const source of Array.isArray(deck?.sources) ? deck.sources : []) {
    if (source?.path) add(source?.id, { source: "deck-source", rawPath: source.path, bases: [specDir, projectDir], ready: /(?:^|[\\/])ready(?:[\\/]|$)/i.test(source.path) });
  }
  const manifests = [];
  for (const manifestPath of manifestPaths) {
    const parsed = await readJson(manifestPath, "figures manifest");
    manifests.push({ path: manifestPath, value: parsed.value });
    const manifestDir = path.dirname(manifestPath);
    for (const item of manifestEntries(parsed.value)) {
      const figureId = item?.id ?? item?.figure_id ?? item?.figure_number;
      const original = item?.file?.original ?? (typeof item?.file === "object" && !Array.isArray(item.file) ? item.file : null);
      const legacyPath = item?.file_path ?? item?.path ?? item?.original_path ?? (typeof item?.file === "string" ? item.file : null);
      const originalPath = original?.path ?? legacyPath;
      if (originalPath) {
        const record = { id: figureId, figure_id: figureId, source: "manifest-original", rawPath: originalPath, bases: [projectDir, manifestDir], ready: false, manifest: manifestPath };
        manifestOriginals.push(record);
        add(figureId, record);
      }
      for (const ready of item?.file?.ready_variants ?? item?.ready_variants ?? []) {
        if (!ready?.path) continue;
        const record = { id: ready.id, figure_id: figureId, source: "manifest-ready", rawPath: ready.path, bases: [projectDir, manifestDir], ready: true, manifest: manifestPath };
        manifestReady.push(record);
        add(ready.id, record);
      }
    }
  }
  return { byId, manifestReady, manifestOriginals, manifests };
}

function looksLikePath(ref) {
  return /[\\/]/.test(ref) || /\.[A-Za-z0-9]{2,8}(?:[?#].*)?$/.test(ref);
}

async function resolveReference(ref, registry, specDir, projectDir) {
  if (/^https?:\/\//i.test(ref)) return { ref, state: "external", exists: true, ready: false, path: null, source: "url" };
  if (ref.startsWith("sample:")) return { ref, state: "placeholder", exists: true, ready: false, path: null, source: "sample" };
  const records = registry.byId.get(ref) ?? [];
  if (records.length > 0) {
    for (const record of records) {
      const candidates = pathCandidates(record.rawPath, record.bases);
      const found = await firstExisting(candidates);
      if (found) return { ref, state: "available", exists: true, ready: record.ready || /(?:^|[\\/])ready(?:[\\/]|$)/i.test(found), path: found, source: record.source };
    }
    const record = records[0];
    return { ref, state: "missing", exists: false, ready: record.ready, path: pathCandidates(record.rawPath, record.bases)[0] ?? null, source: record.source };
  }
  if (looksLikePath(ref)) {
    const candidates = pathCandidates(ref, [specDir, projectDir]);
    const found = await firstExisting(candidates);
    return {
      ref,
      state: found ? "available" : "missing",
      exists: Boolean(found),
      ready: /(?:^|[\\/])ready(?:[\\/]|$)/i.test(found ?? ref),
      path: found ?? candidates[0] ?? null,
      source: "direct",
    };
  }
  return { ref, state: "unresolved", exists: false, ready: false, path: null, source: "unknown-id" };
}

async function scanProject(projectDir, policy) {
  const files = [];
  const directories = [];
  let entries = 0;
  let truncated = false;
  const walk = async (directory, depth) => {
    if (truncated || depth > policy.max_depth) return;
    const relative = normalizedRelative(projectDir, directory);
    if (relative !== "." && matchesAny([relative, path.basename(directory)], policy.ignore_dirs)) return;
    const children = await readdir(directory, { withFileTypes: true }).catch(() => []);
    directories.push({ path: directory, relative, entries: children });
    for (const child of children) {
      entries += 1;
      if (entries > policy.max_entries) {
        truncated = true;
        return;
      }
      const full = path.join(directory, child.name);
      if (child.isDirectory()) await walk(full, depth + 1);
      else if (child.isFile()) files.push(full);
    }
  };
  await walk(projectDir, 0);
  return { files, directories, entryCount: entries, truncated };
}

function imageOrdinal(name, allowBareNumber = false) {
  const named = name.match(/(?:^|[^A-Za-z])(?:slide|page)[-_ ]?0*(\d{1,4})(?:[^0-9]|$)/i);
  if (named) return Number(named[1]);
  if (allowBareNumber) {
    const bare = path.basename(name, path.extname(name)).match(/^0*(\d{1,4})$/);
    if (bare) return Number(bare[1]);
  }
  return null;
}

function directoryImageSet(directory, slideCount, options) {
  const name = path.basename(directory.path);
  const isWordNamed = /(?:word.*qa|qa.*word|发言稿|speaker.*qa|script.*qa)/i.test(name);
  const hasWordPdf = directory.entries.some((entry) => entry.isFile() && /(?:发言稿|speaker|script).*\.pdf$/i.test(entry.name));
  const wordQa = isWordNamed || hasWordPdf;
  const previewNamed = /(?:preview|render|slides?|montage|qa)/i.test(name);
  const entries = directory.entries.filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()));
  const ordinals = [...new Set(entries.map((entry) => imageOrdinal(entry.name, previewNamed)).filter((value) => Number.isInteger(value) && value > 0))].sort((a, b) => a - b);
  const coverage = slideCount > 0 ? Math.min(1, ordinals.filter((value) => value <= slideCount).length / slideCount) : 0;
  return { wordQa, previewNamed, ordinals, coverage, imageCount: entries.length };
}

function scanPreviewSets(scan, projectDir, slideCount, policy) {
  return scan.directories.flatMap((directory) => {
    if (matchesAny([directory.relative], policy.ignore_dirs)) return [];
    const summary = directoryImageSet(directory, slideCount, policy);
    if (summary.wordQa || !summary.previewNamed) return [];
    if (summary.ordinals.length < policy.min_slide_count || summary.coverage < policy.min_coverage_ratio) return [];
    return [{ directory: directory.relative, slide_count: summary.ordinals.length, coverage_ratio: summary.coverage }];
  });
}

function scanWordQaSets(scan, projectDir, policy) {
  return scan.directories.flatMap((directory) => {
    if (matchesAny([directory.relative], policy.ignore_dirs)) return [];
    const summary = directoryImageSet(directory, 0, policy);
    if (!summary.wordQa) return [];
    if (summary.ordinals.length < policy.min_page_count) return [];
    return [{ directory: directory.relative, page_count: summary.ordinals.length }];
  });
}

function forbiddenMapKeys(value, pointer = "$", output = []) {
  if (!value || typeof value !== "object") return output;
  if (Array.isArray(value)) {
    value.forEach((item, index) => forbiddenMapKeys(item, `${pointer}/${index}`, output));
    return output;
  }
  for (const [key, item] of Object.entries(value)) {
    const next = `${pointer}/${key}`;
    if (["render_data", "renderData", "speaker_notes", "speakerNotes"].includes(key)) output.push(next);
    forbiddenMapKeys(item, next, output);
  }
  return output;
}

async function readyInventory(scan, projectDir, registry, selectedPaths, selectedRefs, policy) {
  const readyRoot = (filePath) => {
    const parsed = path.parse(path.resolve(filePath));
    const segments = path.resolve(filePath).slice(parsed.root.length).split(path.sep);
    const index = segments.findIndex((segment) => segment.toLowerCase() === "ready");
    return index < 0 ? null : path.join(parsed.root, ...segments.slice(0, index + 1));
  };
  const canonicalRoots = new Set([path.resolve(projectDir, "assets")]);
  for (const selected of selectedPaths) {
    const root = readyRoot(selected);
    if (root) canonicalRoots.add(root);
  }
  for (const record of registry.manifestReady) {
    for (const candidate of pathCandidates(record.rawPath, record.bases)) {
      const root = readyRoot(candidate);
      if (root) canonicalRoots.add(root);
    }
  }
  const isWithin = (root, target) => {
    const relative = path.relative(root, target);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };
  const filesystemReady = scan.files.filter((file) => {
    const relative = normalizedRelative(projectDir, file);
    return IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase())
      && /(?:^|\/)ready(?:\/|$)/i.test(relative)
      && [...canonicalRoots].some((root) => isWithin(root, file))
      && !matchesAny([relative], policy.ignored_ready_paths);
  });
  const manifestRecords = await Promise.all(registry.manifestReady.map(async (record) => {
    const candidates = pathCandidates(record.rawPath, record.bases);
    const found = await firstExisting(candidates);
    return { ...record, path: found ?? candidates[0] ?? null, exists: Boolean(found) };
  }));
  const union = new Map();
  for (const record of manifestRecords) {
    if (!record.path) continue;
    const resolved = path.resolve(record.path);
    const current = union.get(resolved) ?? { path: resolved, ids: [], manifest: false, exists: false };
    if (record.id && !current.ids.includes(record.id)) current.ids.push(record.id);
    current.manifest = true;
    current.exists ||= record.exists;
    union.set(resolved, current);
  }
  for (const file of filesystemReady) {
    const resolved = path.resolve(file);
    const current = union.get(resolved) ?? { path: resolved, ids: [], manifest: false, exists: true };
    current.exists = true;
    union.set(resolved, current);
  }
  const records = [...union.values()].map((record) => {
    const relative = normalizedRelative(projectDir, record.path);
    const selected = selectedPaths.has(path.resolve(record.path)) || record.ids.some((id) => selectedRefs.has(id));
    const allowed = matchesAny([relative, ...record.ids], policy.allowed_unselected_ready);
    return { ...record, relative, selected, allowed };
  });
  return {
    records,
    manifestRecords,
    unselected: records.filter((record) => !record.selected && !record.allowed),
    untracked: records.filter((record) => !record.manifest && !record.selected && !record.allowed),
    missingManifest: manifestRecords.filter((record) => !record.exists),
  };
}

async function assetCheck(deck, occurrences, registry, scan, context) {
  const { projectDir, specDir, policy } = context;
  const check = checkRecord("selected-assets", "Selected assets and produced ready variants");
  const uniqueRefs = [...new Set(occurrences.map((item) => item.ref))];
  const resolutions = new Map();
  await Promise.all(uniqueRefs.map(async (ref) => resolutions.set(ref, await resolveReference(ref, registry, specDir, projectDir))));
  const groups = new Map();
  for (const occurrence of occurrences) {
    const values = groups.get(occurrence.group) ?? [];
    values.push(occurrence);
    groups.set(occurrence.group, values);
  }
  const selectedPaths = new Set([...resolutions.values()].map((item) => item.exists && item.path ? path.resolve(item.path) : null).filter(Boolean));
  const selectedRefs = new Set(uniqueRefs);
  const missing = [];
  const unresolved = [];
  const fallbackSatisfied = [];
  const rawSelected = [];
  for (const occurrence of occurrences) {
    const resolved = resolutions.get(occurrence.ref);
    const alternatives = groups.get(occurrence.group) ?? [];
    const primaryAvailable = alternatives.some((item) => item.role === "primary" && resolutions.get(item.ref)?.exists);
    const fallbackAvailable = alternatives.some((item) => item.role === "fallback" && resolutions.get(item.ref)?.exists);
    const valuesForPattern = [occurrence.ref, resolved?.path ? normalizedRelative(projectDir, resolved.path) : ""].filter(Boolean);
    if (resolved?.exists) {
      if (occurrence.role === "fallback" && primaryAvailable) continue;
      if (!resolved.ready && !["external", "placeholder"].includes(resolved.state) && !matchesAny(valuesForPattern, policy.allowed_raw_refs)) rawSelected.push({ occurrence, resolved });
      continue;
    }
    if (occurrence.role === "fallback" && primaryAvailable) continue;
    if (occurrence.role === "primary" && fallbackAvailable) {
      fallbackSatisfied.push({ occurrence, resolved });
      continue;
    }
    if (resolved?.state === "unresolved") {
      if (!matchesAny(valuesForPattern, policy.allowed_unresolved_refs)) unresolved.push({ occurrence, resolved });
    } else if (!matchesAny(valuesForPattern, policy.allowed_missing_refs)) missing.push({ occurrence, resolved });
  }

  for (const item of missing) addFinding(check, policy.missing_selected_severity, "assets.selected.missing", `Selected asset is missing: ${item.occurrence.ref}`, { ref: item.occurrence.ref, pointer: item.occurrence.pointer, path: item.resolved.path ? normalizedRelative(projectDir, item.resolved.path) : null });
  for (const item of unresolved) addFinding(check, policy.unresolved_selected_severity, "assets.selected.unresolved", `Selected semantic asset id cannot be resolved: ${item.occurrence.ref}`, { ref: item.occurrence.ref, pointer: item.occurrence.pointer });
  for (const item of fallbackSatisfied) addFinding(check, policy.fallback_used_severity, "assets.selected.fallback-used", `Primary asset ${item.occurrence.ref} is unavailable, but its declared fallback is available.`, { ref: item.occurrence.ref, pointer: item.occurrence.pointer });
  if (policy.max_raw_selected_count != null && rawSelected.length > policy.max_raw_selected_count) {
    addFinding(check, policy.raw_selected_severity, "assets.selected.raw-budget", `${rawSelected.length} selected asset(s) use non-ready files; budget is ${policy.max_raw_selected_count}.`, { refs: [...new Set(rawSelected.map((item) => item.occurrence.ref))] });
  }

  const inventory = await readyInventory(scan, projectDir, registry, selectedPaths, selectedRefs, policy);
  const readyCount = inventory.records.length;
  const unselectedRatio = readyCount === 0 ? 0 : inventory.unselected.length / readyCount;
  const exceedsUnusedBudget = inventory.unselected.length > policy.max_unselected_ready_count && unselectedRatio > policy.max_unselected_ready_ratio;
  if (exceedsUnusedBudget) addFinding(check, policy.unselected_ready_severity, "assets.ready.unselected-budget", `${inventory.unselected.length}/${readyCount} ready asset file(s) are not selected; budget is count<=${policy.max_unselected_ready_count} or ratio<=${policy.max_unselected_ready_ratio}.`, { paths: inventory.unselected.map((item) => item.relative) });
  if (inventory.untracked.length > policy.max_untracked_ready_count) addFinding(check, policy.untracked_ready_severity, "assets.ready.untracked", `${inventory.untracked.length} unselected ready file(s) are not represented by a figures manifest; budget is ${policy.max_untracked_ready_count}.`, { paths: inventory.untracked.map((item) => item.relative) });
  for (const record of inventory.missingManifest) {
    const values = [record.id, record.path ? normalizedRelative(projectDir, record.path) : ""].filter(Boolean);
    if (matchesAny(values, policy.allowed_unselected_ready)) continue;
    addFinding(check, policy.missing_unselected_ready_severity, "assets.ready.manifest-file-missing", `Manifest ready variant is missing on disk: ${record.id ?? record.rawPath}`, { ref: record.id ?? null, path: record.path ? normalizedRelative(projectDir, record.path) : null });
  }
  check.metrics = {
    selected_occurrence_count: occurrences.length,
    selected_ref_count: uniqueRefs.length,
    selected_ready_ref_count: [...resolutions.values()].filter((item) => item.exists && item.ready).length,
    selected_raw_ref_count: [...new Set(rawSelected.map((item) => item.occurrence.ref))].length,
    fallback_satisfied_count: fallbackSatisfied.length,
    missing_selected_count: missing.length,
    unresolved_selected_count: unresolved.length,
    ready_file_count: readyCount,
    selected_ready_file_count: inventory.records.filter((item) => item.selected).length,
    unselected_ready_file_count: inventory.unselected.length,
    unselected_ready_ratio: unselectedRatio,
    untracked_ready_file_count: inventory.untracked.length,
    missing_manifest_ready_file_count: inventory.missingManifest.length,
  };
  return check;
}

async function contextCheck(specInput, mapInput, policy) {
  const ratio = specInput.bytes === 0 ? null : mapInput.bytes / specInput.bytes;
  const reduction = ratio == null ? null : 1 - ratio;
  const check = checkRecord("context-size", "Full deck spec versus navigation deck map", {
    spec_bytes: specInput.bytes,
    deck_map_bytes: mapInput.bytes,
    deck_map_to_spec_ratio: ratio,
    reduction_ratio: reduction,
    map_source: mapInput.source,
  });
  if (mapInput.bytes > policy.max_deck_map_bytes || (specInput.bytes >= policy.min_spec_bytes_for_ratio && ratio > policy.max_deck_map_ratio)) {
    addFinding(check, policy.oversize_severity, "context.deck-map.oversize", `Deck map is ${mapInput.bytes} bytes (${ratio == null ? "n/a" : ratio.toFixed(3)} of the full spec); budget is ${policy.max_deck_map_bytes} bytes and ratio<=${policy.max_deck_map_ratio}.`);
  }
  const forbidden = forbiddenMapKeys(mapInput.value);
  if (forbidden.length > 0) addFinding(check, policy.forbidden_field_severity, "context.deck-map.verbose-fields", "Deck map contains full render_data or speaker_notes fields.", { pointers: forbidden });
  const declaredHash = mapInput.value?.source_spec?.sha256;
  if (mapInput.source === "file" && declaredHash && declaredHash !== specInput.sha256) {
    addFinding(check, policy.stale_map_severity, "context.deck-map.stale", "Deck map source hash does not match the current deck spec.");
  }
  return check;
}

function previewCheck(scan, projectDir, slideCount, policy) {
  const sets = scanPreviewSets(scan, projectDir, slideCount, policy);
  const check = checkRecord("full-deck-previews", "Retained complete slide preview sets", {
    full_deck_set_count: sets.length,
    max_full_deck_sets: policy.max_full_deck_sets,
    sets,
  });
  if (sets.length > policy.max_full_deck_sets) addFinding(check, policy.duplicate_severity, "previews.full-deck.duplicate", `${sets.length} complete slide preview sets are retained; budget is ${policy.max_full_deck_sets}.`, { directories: sets.map((item) => item.directory) });
  return check;
}

function wordQaCheck(scan, projectDir, policy) {
  const sets = scanWordQaSets(scan, projectDir, policy);
  const check = checkRecord("word-qa-renders", "Retained complete Word QA render sets", {
    full_word_qa_set_count: sets.length,
    max_full_word_qa_sets: policy.max_full_sets,
    sets,
  });
  if (sets.length > policy.max_full_sets) addFinding(check, policy.duplicate_severity, "word-qa.full-render.duplicate", `${sets.length} complete Word QA render sets are retained; budget is ${policy.max_full_sets}.`, { directories: sets.map((item) => item.directory) });
  return check;
}

export async function auditProductionBudget(options = {}) {
  if (!options.spec && !options.projectDir && !options.project_dir) throw new Error("projectDir or spec is required.");
  const requestedProject = options.projectDir ?? options.project_dir;
  const projectDir = path.resolve(requestedProject ?? path.dirname(path.resolve(options.spec)));
  const specPath = path.resolve(options.spec ?? path.join(projectDir, "deck-spec.json"));
  const specDir = path.dirname(specPath);
  if (!(await isDirectory(projectDir))) throw new Error(`Project directory does not exist: ${projectDir}`);
  const policy = await loadPolicy(options);
  const parsedSpec = await readJson(specPath, "deck spec");
  const specBuild = await buildDeckMapFile(specPath, { maxTextChars: options.maxTextChars });
  const specInput = { value: parsedSpec.value, bytes: parsedSpec.bytes, sha256: specBuild.specSha256 };

  let mapInput;
  if (options.deckMap ?? options.deck_map) {
    const parsedMap = await readJson(path.resolve(options.deckMap ?? options.deck_map), "deck map");
    mapInput = { value: parsedMap.value, bytes: parsedMap.bytes, source: "file", path: path.resolve(options.deckMap ?? options.deck_map) };
  } else {
    const serialized = serializeDeckMap(specBuild.deckMap);
    mapInput = { value: specBuild.deckMap, bytes: Buffer.byteLength(serialized), source: "generated-in-memory", path: null };
  }

  const scan = await scanProject(projectDir, policy.scan);
  const explicitManifests = options.manifests ?? options.figuresManifests ?? options.figures_manifests ?? [];
  const manifestPaths = await discoverManifests(projectDir, explicitManifests, scan);
  for (const manifest of manifestPaths) if (!(await exists(manifest))) throw new Error(`Figures manifest does not exist: ${manifest}`);
  const registry = await loadAssetRegistry(parsedSpec.value, specDir, projectDir, manifestPaths);
  const occurrences = collectSelectedAssetOccurrences(parsedSpec.value);
  const slideCount = parsedSpec.value.slides.length;
  const checks = [
    await assetCheck(parsedSpec.value, occurrences, registry, scan, { projectDir, specDir, policy: policy.assets }),
    await contextCheck(specInput, mapInput, policy.context),
    previewCheck(scan, projectDir, slideCount, policy.previews),
    wordQaCheck(scan, projectDir, policy.word_qa),
  ];
  if (scan.truncated) {
    const scanCheck = checkRecord("scan-completeness", "Read-only project scan", { scanned_entries: scan.entryCount, max_entries: policy.scan.max_entries });
    addFinding(scanCheck, "warn", "scan.entry-budget.exceeded", "The read-only filesystem scan reached max_entries; preview and ready-file counts may be incomplete.");
    checks.push(scanCheck);
  }
  const status = checks.reduce((current, check) => severityRank(check.status) > severityRank(current) ? check.status : current, "pass");
  const findings = checks.flatMap((check) => check.findings.map((finding) => ({ check_id: check.id, ...finding })));
  return {
    schema_version: "1.0",
    tool: "academic-slides/audit-production-budget",
    status,
    ok: status !== "fail",
    read_only: true,
    inputs: {
      project_dir: projectDir,
      deck_spec: specPath,
      deck_map: mapInput.path,
      figures_manifests: manifestPaths,
    },
    policy,
    summary: {
      check_count: checks.length,
      pass: checks.filter((check) => check.status === "pass").length,
      warn: checks.filter((check) => check.status === "warn").length,
      fail: checks.filter((check) => check.status === "fail").length,
      finding_count: findings.length,
    },
    checks,
    findings,
  };
}

function printHuman(result) {
  console.log(`${result.status.toUpperCase()}: production budget audit (read-only)`);
  for (const check of result.checks) {
    console.log(`- ${check.status.toUpperCase()} ${check.id}: ${check.title}`);
    for (const finding of check.findings) console.log(`  - ${finding.severity.toUpperCase()} ${finding.code}: ${finding.message}`);
  }
  console.log(`${result.summary.fail} fail, ${result.summary.warn} warn, ${result.summary.pass} pass`);
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
  if (!args.spec && !args.project_dir) {
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  try {
    const result = await auditProductionBudget({
      spec: args.spec,
      projectDir: args.project_dir,
      deckMap: args.deck_map,
      manifests: args.manifests,
      config: args.config,
      max_full_preview_sets: args.max_full_preview_sets,
      max_word_qa_sets: args.max_word_qa_sets,
      max_map_ratio: args.max_map_ratio,
      max_map_bytes: args.max_map_bytes,
      strict: args.strict,
    });
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else printHuman(result);
    if (result.status === "fail") process.exitCode = 1;
  } catch (error) {
    if (args.json) console.log(JSON.stringify({ status: "fail", ok: false, read_only: true, error: error.message }, null, 2));
    else console.error(`PRODUCTION BUDGET AUDIT FAILED: ${error.message}`);
    process.exitCode = 2;
  }
}

const invokedDirectly = process.argv[1]
  && await realpath(process.argv[1]).catch(() => null) === await realpath(fileURLToPath(import.meta.url)).catch(() => null);
if (invokedDirectly) await main();
