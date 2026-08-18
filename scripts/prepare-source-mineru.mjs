#!/usr/bin/env node

import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const OUTPUT_FILENAMES = [
  "document-index.json",
  "blocks.ndjson",
  "page-map.json",
  "figure-candidates.json",
  "table-candidates.json",
  "formula-candidates.json",
  "extraction-record.json",
];
const RETAINED_IMAGE_EXTENSIONS = new Set([
  ".bmp", ".gif", ".jpeg", ".jpg", ".jp2", ".png", ".svg", ".tif", ".tiff", ".webp",
]);

export const NORMALIZER_VERSION = "1.1.0";
export const DEFAULT_TOKEN_ENV = "MINERU_API_TOKEN";
export const DEFAULT_API_BASE = "https://mineru.net";

function usage() {
  return [
    "Usage:",
    "  node prepare-source-mineru.mjs --normalize-only <unpacked-dir> --output-dir <dir> [options]",
    "  node prepare-source-mineru.mjs --source <paper.pdf> --output-dir <dir> --confirm-upload [options]",
    "",
    "Options:",
    "  --source <pdf>             Source PDF. In normalize-only mode an *_origin.pdf file may be inferred.",
    "  --normalize-only <dir>     Normalize an already unpacked MinerU result without network access.",
    "  --output-dir <dir>         Directory for the seven normalized evidence files.",
    "  --cache-dir <dir>          Managed raw/cache root (default: a hidden sibling directory).",
    "  --model-version <name>     vlm (default) or pipeline.",
    "  --language <code>          MinerU language hint (default: ch).",
    "  --page-ranges <ranges>     Optional MinerU page-range string.",
    "  --ocr                      Enable OCR. Default is false.",
    "  --disable-formula          Disable formula recognition.",
    "  --disable-table            Disable table recognition.",
    "  --retain-full-raw          Opt in to retaining the complete MinerU raw result.",
    "  --token-env <NAME>         Environment variable holding the token (default: MINERU_API_TOKEN).",
    "  --confirm-upload           Required acknowledgement before a local file is uploaded.",
    "  --poll-ms <number>         Poll interval in milliseconds (default: 5000).",
    "  --max-wait-ms <number>     Maximum polling time (default: 7200000).",
    "  --force                    Ignore a matching normalized-output cache record.",
    "  --json                     Emit a machine-readable summary.",
    "  -h, --help                 Show this help.",
    "",
    "The CLI never accepts a token value. Default extra_formats is an empty array.",
    "Only the seven normalized evidence files are model-facing; raw files remain normalizer-only.",
  ].join("\n");
}

function optionValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value.`);
  return value;
}

export function parseArgs(argv) {
  const result = {
    modelVersion: "vlm",
    language: "ch",
    isOcr: false,
    enableFormula: true,
    enableTable: true,
    tokenEnv: DEFAULT_TOKEN_ENV,
    pollMs: 5_000,
    maxWaitMs: 2 * 60 * 60 * 1_000,
    confirmUpload: false,
    retainFullRaw: false,
    force: false,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "-h" || token === "--help") result.help = true;
    else if (token === "--confirm-upload") result.confirmUpload = true;
    else if (token === "--ocr") result.isOcr = true;
    else if (token === "--disable-formula") result.enableFormula = false;
    else if (token === "--disable-table") result.enableTable = false;
    else if (token === "--retain-full-raw") result.retainFullRaw = true;
    else if (token === "--force") result.force = true;
    else if (token === "--json") result.json = true;
    else if (["--source", "--normalize-only", "--output-dir", "--cache-dir", "--model-version", "--language", "--page-ranges", "--token-env", "--poll-ms", "--max-wait-ms"].includes(token)) {
      const value = optionValue(argv, index, token);
      index += 1;
      const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      result[key] = value;
    } else if (/token/i.test(token)) {
      throw new Error("Token values are not accepted. Use --token-env <NAME>.");
    } else throw new Error(`Unknown option: ${token}`);
  }
  for (const key of ["pollMs", "maxWaitMs"]) {
    result[key] = Number(result[key]);
    if (!Number.isInteger(result[key]) || result[key] <= 0) throw new Error(`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} must be a positive integer.`);
  }
  return result;
}

async function pathIsFile(filePath) {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function pathIsNonemptyFile(filePath) {
  try {
    const info = await fs.stat(filePath);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

async function pathIsDirectory(directoryPath) {
  try {
    return (await fs.stat(directoryPath)).isDirectory();
  } catch {
    return false;
  }
}

async function listFilesRecursively(root) {
  const files = [];
  async function visit(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) files.push(full);
    }
  }
  await visit(root);
  return files.sort((left, right) => left.localeCompare(right, "en"));
}

export async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort((left, right) => left.localeCompare(right, "en"))
    .map((key) => [key, canonicalize(value[key])]));
}

export function computeCacheKey(input) {
  const canonical = JSON.stringify(canonicalize({
    source_sha256: input.sourceSha256,
    model_version: input.modelVersion,
    language: input.language,
    is_ocr: Boolean(input.isOcr),
    enable_formula: Boolean(input.enableFormula),
    enable_table: Boolean(input.enableTable),
    page_ranges: input.pageRanges || null,
    extra_formats: [],
    retain_full_raw: Boolean(input.retainFullRaw),
    normalizer_version: input.normalizerVersion ?? NORMALIZER_VERSION,
  }));
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

function normalizeTextList(value) {
  const output = [];
  function visit(item) {
    if (typeof item === "string") {
      if (item.trim()) output.push(item.trim());
    } else if (Array.isArray(item)) item.forEach(visit);
    else if (item && typeof item === "object") {
      if (typeof item.content === "string") visit(item.content);
      else if (typeof item.text === "string") visit(item.text);
      else Object.values(item).forEach(visit);
    }
  }
  visit(value);
  return [...new Set(output)];
}

function normalizeBbox(value) {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const bbox = value.map(Number);
  return bbox.every(Number.isFinite) ? bbox : null;
}

function bboxIou(left, right) {
  if (!left || !right) return 0;
  const intersectionWidth = Math.max(0, Math.min(left[2], right[2]) - Math.max(left[0], right[0]));
  const intersectionHeight = Math.max(0, Math.min(left[3], right[3]) - Math.max(left[1], right[1]));
  const intersection = intersectionWidth * intersectionHeight;
  const leftArea = Math.max(0, left[2] - left[0]) * Math.max(0, left[3] - left[1]);
  const rightArea = Math.max(0, right[2] - right[0]) * Math.max(0, right[3] - right[1]);
  const union = leftArea + rightArea - intersection;
  return union > 0 ? intersection / union : 0;
}

function v2Compatible(v1Type, v2Type) {
  const compatible = {
    text: new Set(["paragraph", "title"]),
    ref_text: new Set(["list", "paragraph"]),
    image: new Set(["image"]),
    chart: new Set(["chart", "image"]),
    equation: new Set(["equation_interline", "equation"]),
    table: new Set(["table"]),
    header: new Set(["page_header", "header"]),
    footer: new Set(["page_footer", "footer"]),
    page_number: new Set(["page_number"]),
  };
  return compatible[v1Type]?.has(v2Type) ?? true;
}

function indexV2(raw) {
  if (!Array.isArray(raw)) return new Map();
  const pages = new Map();
  raw.forEach((pageOrBlock, outerIndex) => {
    const pageBlocks = Array.isArray(pageOrBlock) ? pageOrBlock : [pageOrBlock];
    for (const block of pageBlocks) {
      if (!block || typeof block !== "object") continue;
      const pageIdx = Number.isInteger(block.page_idx) ? block.page_idx : outerIndex;
      if (!pages.has(pageIdx)) pages.set(pageIdx, []);
      pages.get(pageIdx).push(block);
    }
  });
  return pages;
}

function findV2Enhancement(v1, pageV2, used) {
  if (!pageV2?.length) return null;
  const bbox = normalizeBbox(v1.bbox);
  let best = null;
  let bestScore = 0;
  pageV2.forEach((candidate, index) => {
    if (used.has(index) || !v2Compatible(v1.type, candidate.type)) return;
    const score = bboxIou(bbox, normalizeBbox(candidate.bbox));
    if (score > bestScore) {
      bestScore = score;
      best = { candidate, index };
    }
  });
  if (!best || bestScore < 0.72) return null;
  used.add(best.index);
  return best.candidate;
}

function v2AssetRef(block) {
  const candidate = block?.content?.image_source?.path ?? block?.image_source?.path;
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
}

function cleanLatex(value) {
  const text = String(value ?? "").trim();
  return text.replace(/^\$\$\s*/, "").replace(/\s*\$\$$/, "").trim() || null;
}

function v2Latex(block) {
  return cleanLatex(block?.content?.math_content ?? block?.math_content);
}

function v2HeadingLevel(block) {
  const value = Number(block?.content?.level ?? block?.level);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function classifyBlock(sourceType, enhancement) {
  if (enhancement?.type === "title") return "title";
  if (["image", "chart"].includes(sourceType)) return "figure";
  if (sourceType === "equation") return "formula";
  if (sourceType === "table") return "table";
  if (sourceType === "ref_text") return "reference";
  if (["header", "footer", "page_number"].includes(sourceType)) return sourceType;
  if (sourceType === "text") return "text";
  return "other";
}

function likelyHeading(text) {
  const compact = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!compact || compact.length > 90) return false;
  return /^(?:摘\s*要|ABSTRACT|Abstract|目\s*录|参考文献|致\s*谢|第\s*[一二三四五六七八九十百0-9]+\s*章\b|\d+(?:\.\d+){0,3}\s+\S)/u.test(compact);
}

function resolveAsset(rawBaseDir, assetRef, warnings) {
  if (!assetRef) return null;
  const resolved = path.resolve(rawBaseDir, assetRef);
  const relative = path.relative(rawBaseDir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    warnings.push("Ignored an asset reference outside the MinerU result root.");
    return null;
  }
  return resolved;
}

function normalizeV1Blocks(v1, v2Pages, rawBaseDir, warnings) {
  const pageCounters = new Map();
  const usedV2ByPage = new Map();
  return v1.map((raw, globalIndex) => {
    const pageIdx = Number.isInteger(raw?.page_idx) && raw.page_idx >= 0 ? raw.page_idx : 0;
    const order = pageCounters.get(pageIdx) ?? 0;
    pageCounters.set(pageIdx, order + 1);
    const pageV2 = v2Pages.get(pageIdx) ?? [];
    if (!usedV2ByPage.has(pageIdx)) usedV2ByPage.set(pageIdx, new Set());
    const enhancement = findV2Enhancement(raw, pageV2, usedV2ByPage.get(pageIdx));
    const sourceType = String(raw?.type ?? "other");
    let type = classifyBlock(sourceType, enhancement);
    const rawText = raw?.text ?? raw?.content ?? "";
    const text = String(rawText ?? "").trim();
    if (type === "text" && likelyHeading(text)) type = "title";
    const caption = normalizeTextList(raw?.image_caption ?? raw?.chart_caption ?? raw?.table_caption
      ?? enhancement?.content?.image_caption ?? enhancement?.content?.chart_caption ?? enhancement?.content?.table_caption);
    const footnote = normalizeTextList(raw?.image_footnote ?? raw?.chart_footnote ?? raw?.table_footnote
      ?? enhancement?.content?.image_footnote ?? enhancement?.content?.chart_footnote ?? enhancement?.content?.table_footnote);
    const assetRef = String(raw?.img_path ?? v2AssetRef(enhancement) ?? "").trim() || null;
    const tableHtml = sourceType === "table"
      ? String(raw?.table_body ?? enhancement?.content?.html ?? "").trim() || null
      : null;
    const latex = sourceType === "equation" ? cleanLatex(raw?.text) ?? v2Latex(enhancement) : null;
    const inferredHeading = type === "title" && enhancement?.type !== "title";
    return {
      block_id: `p${String(pageIdx + 1).padStart(4, "0")}-b${String(order + 1).padStart(4, "0")}`,
      page: pageIdx + 1,
      page_idx: pageIdx,
      order,
      global_order: globalIndex,
      type,
      source_type: sourceType,
      v2_type: enhancement?.type ?? null,
      bbox: normalizeBbox(raw?.bbox),
      bbox_coordinate_space: "mineru_content_list",
      text: type === "formula" ? "" : text,
      caption,
      footnote,
      asset_ref: assetRef,
      asset_path: resolveAsset(rawBaseDir, assetRef, warnings),
      latex,
      table_html: tableHtml,
      heading_level: type === "title" ? (v2HeadingLevel(enhancement) ?? (inferredHeading ? 2 : 1)) : null,
      heading_source: type === "title" ? (enhancement?.type === "title" ? "content_list_v2" : "v1_heuristic") : null,
    };
  });
}

function pageSizeIndex(layout) {
  const index = new Map();
  const pages = Array.isArray(layout?.pdf_info) ? layout.pdf_info : [];
  pages.forEach((page, arrayIndex) => {
    const pageIdx = Number.isInteger(page?.page_idx) ? page.page_idx : arrayIndex;
    const size = Array.isArray(page?.page_size) && page.page_size.length === 2 ? page.page_size.map(Number) : null;
    if (size?.every(Number.isFinite)) index.set(pageIdx, size);
  });
  return index;
}

function edgeRelation(left, right) {
  if (!left.bbox || !right.bbox) return null;
  const [lx0, ly0, lx1, ly1] = left.bbox;
  const [rx0, ry0, rx1, ry1] = right.bbox;
  const horizontalGap = Math.max(0, Math.max(lx0, rx0) - Math.min(lx1, rx1));
  const verticalGap = Math.max(0, Math.max(ly0, ry0) - Math.min(ly1, ry1));
  const leftWidth = Math.max(1, lx1 - lx0);
  const rightWidth = Math.max(1, rx1 - rx0);
  const leftHeight = Math.max(1, ly1 - ly0);
  const rightHeight = Math.max(1, ry1 - ry0);
  const xOverlap = Math.max(0, Math.min(lx1, rx1) - Math.max(lx0, rx0)) / Math.min(leftWidth, rightWidth);
  const yOverlap = Math.max(0, Math.min(ly1, ry1) - Math.max(ly0, ry0)) / Math.min(leftHeight, rightHeight);
  const leftCenter = [(lx0 + lx1) / 2, (ly0 + ly1) / 2];
  const rightCenter = [(rx0 + rx1) / 2, (ry0 + ry1) / 2];
  const dx = rightCenter[0] - leftCenter[0];
  const dy = rightCenter[1] - leftCenter[1];
  let relation;
  if (horizontalGap === 0 && verticalGap === 0) relation = "overlap";
  else if (Math.abs(dx) >= Math.abs(dy)) relation = dx >= 0 ? "right" : "left";
  else relation = dy >= 0 ? "below" : "above";
  return {
    relation,
    edge_gap: Math.round(Math.hypot(horizontalGap, verticalGap) * 100) / 100,
    orthogonal_overlap: Math.round((Math.abs(dx) >= Math.abs(dy) ? yOverlap : xOverlap) * 1000) / 1000,
  };
}

function attachFigureAdjacency(candidates) {
  const byPage = new Map();
  for (const candidate of candidates) {
    if (!byPage.has(candidate.page)) byPage.set(candidate.page, []);
    byPage.get(candidate.page).push(candidate);
    candidate.adjacent = [];
    candidate.panel_group_id = null;
  }
  for (const [page, pageCandidates] of byPage) {
    const edges = [];
    for (let leftIndex = 0; leftIndex < pageCandidates.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < pageCandidates.length; rightIndex += 1) {
        const left = pageCandidates[leftIndex];
        const right = pageCandidates[rightIndex];
        const geometry = edgeRelation(left, right);
        if (!geometry) continue;
        const captionCompatible = left.caption.length === 0 || right.caption.length === 0
          || left.caption.some((item) => right.caption.includes(item));
        if (geometry.edge_gap <= 120 && geometry.orthogonal_overlap >= 0.15 && captionCompatible) {
          edges.push([leftIndex, rightIndex]);
          left.adjacent.push({ candidate_id: right.candidate_id, ...geometry });
          const reverse = edgeRelation(right, left);
          right.adjacent.push({ candidate_id: left.candidate_id, ...reverse });
        }
      }
    }
    const parent = pageCandidates.map((_, index) => index);
    const find = (index) => {
      while (parent[index] !== index) {
        parent[index] = parent[parent[index]];
        index = parent[index];
      }
      return index;
    };
    for (const [left, right] of edges) {
      const leftRoot = find(left);
      const rightRoot = find(right);
      if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
    }
    const groups = new Map();
    pageCandidates.forEach((_, index) => {
      const root = find(index);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(index);
    });
    let groupCounter = 0;
    for (const indices of groups.values()) {
      if (indices.length < 2) continue;
      groupCounter += 1;
      const groupId = `panel-p${String(page).padStart(4, "0")}-g${String(groupCounter).padStart(2, "0")}`;
      indices.forEach((index) => { pageCandidates[index].panel_group_id = groupId; });
    }
    pageCandidates.forEach((candidate) => candidate.adjacent.sort((left, right) => left.edge_gap - right.edge_gap || left.candidate_id.localeCompare(right.candidate_id, "en")));
  }
}

function candidateFromBlock(block, prefix) {
  return {
    candidate_id: `${prefix}-${block.block_id}`,
    block_id: block.block_id,
    page: block.page,
    page_idx: block.page_idx,
    bbox: block.bbox,
    bbox_coordinate_space: block.bbox_coordinate_space,
    asset_ref: block.asset_ref,
    asset_path: block.asset_path,
    caption: block.caption,
    footnote: block.footnote,
    source_type: block.source_type,
  };
}

function buildCandidates(blocks) {
  const figures = blocks.filter((block) => block.type === "figure").map((block) => candidateFromBlock(block, "fig"));
  attachFigureAdjacency(figures);
  const tables = blocks.filter((block) => block.type === "table").map((block) => ({
    ...candidateFromBlock(block, "tbl"),
    table_html: block.table_html,
  }));
  const formulas = blocks.filter((block) => block.type === "formula").map((block) => ({
    ...candidateFromBlock(block, "eq"),
    latex: block.latex,
    equation_label: /\\tag\s*\{([^}]+)\}/.exec(block.latex ?? "")?.[1]?.trim() ?? null,
  }));
  return { figures, tables, formulas };
}

function buildPageMap(blocks, pageSizes) {
  const pages = new Map();
  for (const pageIdx of pageSizes.keys()) pages.set(pageIdx + 1, []);
  for (const block of blocks) {
    if (!pages.has(block.page)) pages.set(block.page, []);
    pages.get(block.page).push(block);
  }
  return [...pages.entries()].sort(([left], [right]) => left - right).map(([page, pageBlocks]) => {
    const bodyText = pageBlocks
      .filter((block) => ["title", "text"].includes(block.type))
      .map((block) => block.text)
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    const counts = {};
    for (const block of pageBlocks) counts[block.type] = (counts[block.type] ?? 0) + 1;
    return {
      page,
      page_idx: page - 1,
      page_size: pageSizes.get(page - 1) ?? null,
      printed_page_label: pageBlocks.find((block) => block.type === "page_number" && block.text)?.text ?? null,
      block_ids: pageBlocks.map((block) => block.block_id),
      heading_ids: pageBlocks.filter((block) => block.type === "title").map((block) => block.block_id),
      candidate_ids: pageBlocks.filter((block) => ["figure", "table", "formula"].includes(block.type)).map((block) => {
        const prefix = block.type === "figure" ? "fig" : block.type === "table" ? "tbl" : "eq";
        return `${prefix}-${block.block_id}`;
      }),
      counts,
      excerpt: bodyText.slice(0, 360),
    };
  });
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function discoverInput(inputDir) {
  if (!(await pathIsDirectory(inputDir))) throw new Error(`MinerU result directory does not exist: ${inputDir}`);
  const files = await listFilesRecursively(inputDir);
  const v1Path = files.find((filePath) => /_content_list\.json$/i.test(filePath) && !/_content_list_v2\.json$/i.test(filePath));
  if (!v1Path) throw new Error("MinerU v1 *_content_list.json was not found. It is the required stable normalization input.");
  const layoutPaths = files.filter((filePath) => /(?:^|\/)(?:layout|[^/]+_middle)\.json$/i.test(filePath.split(path.sep).join("/")));
  return {
    files,
    v1Path,
    v2Path: files.find((filePath) => /_content_list_v2\.json$/i.test(filePath)) ?? null,
    layoutPath: layoutPaths[0] ?? null,
    layoutPaths,
    markdownPath: files.find((filePath) => path.basename(filePath).toLowerCase() === "full.md") ?? null,
    originPdfPath: files.find((filePath) => /_origin\.pdf$/i.test(filePath)) ?? null,
  };
}

function isPathWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function collectReferencedAssetStrings(value, output = new Set(), parentKey = "") {
  if (Array.isArray(value)) {
    value.forEach((item) => collectReferencedAssetStrings(item, output, parentKey));
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if ((key === "img_path" || key === "image_path" || (key === "path" && parentKey === "image_source")) && typeof item === "string" && item.trim()) {
        output.add(item.trim());
      } else collectReferencedAssetStrings(item, output, key);
    }
  }
  return output;
}

async function usableJson(filePath, predicate = () => true) {
  if (!filePath) return null;
  try {
    const parsed = await readJson(filePath);
    return predicate(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function summarizeFiles(files) {
  let bytes = 0;
  for (const filePath of files) bytes += (await fs.stat(filePath)).size;
  return { files: files.length, bytes };
}

function retentionCategories({ hasV1, hasV2, layoutCount, imageCount, otherCount = 0 }) {
  return {
    content_list_v1: hasV1 ? 1 : 0,
    content_list_v2: hasV2 ? 1 : 0,
    layout_or_middle: layoutCount,
    referenced_images: imageCount,
    other: otherCount,
  };
}

export async function buildRawRetentionPlan(inputDir, options = {}) {
  const root = path.resolve(inputDir);
  const discovered = await discoverInput(root);
  const before = await summarizeFiles(discovered.files);
  if (options.retainFullRaw) {
    return {
      retainedFilePaths: new Set(discovered.files),
      record: {
        policy: "full_raw_opt_in",
        full_raw_opt_in: true,
        standardized_outputs_only_for_model: true,
        counts: {
          before_files: before.files,
          before_bytes: before.bytes,
          retained_files: before.files,
          retained_bytes: before.bytes,
          removed_files: 0,
          removed_bytes: 0,
          missing_referenced_images: 0,
        },
        categories: retentionCategories({ hasV1: true, hasV2: Boolean(discovered.v2Path), layoutCount: discovered.layoutPaths.length, imageCount: 0, otherCount: Math.max(0, discovered.files.length - 1 - Number(Boolean(discovered.v2Path)) - discovered.layoutPaths.length) }),
      },
    };
  }

  const retained = new Set([discovered.v1Path]);
  const v1 = await usableJson(discovered.v1Path, Array.isArray);
  if (!v1) throw new Error("MinerU v1 content_list is not usable JSON.");
  const references = [{ baseDir: path.dirname(discovered.v1Path), values: collectReferencedAssetStrings(v1) }];
  const v2 = await usableJson(discovered.v2Path, Array.isArray);
  if (v2) {
    retained.add(discovered.v2Path);
    references.push({ baseDir: path.dirname(discovered.v2Path), values: collectReferencedAssetStrings(v2) });
  }
  let retainedLayoutCount = 0;
  for (const layoutPath of discovered.layoutPaths) {
    const layout = await usableJson(layoutPath, (value) => value && typeof value === "object");
    if (layout) {
      retained.add(layoutPath);
      retainedLayoutCount += 1;
      references.push({ baseDir: path.dirname(layoutPath), values: collectReferencedAssetStrings(layout) });
    }
  }
  const missingReferencedImages = new Set();
  const retainedImages = new Set();
  for (const referenceSet of references) {
    for (const assetRef of referenceSet.values) {
      let candidate = path.resolve(referenceSet.baseDir, assetRef);
      if (isPathWithin(root, candidate) && !(await pathIsFile(candidate)) && path.basename(assetRef) === assetRef) {
        const imageDirectoryCandidate = path.resolve(referenceSet.baseDir, "images", assetRef);
        if (isPathWithin(root, imageDirectoryCandidate) && await pathIsFile(imageDirectoryCandidate)) candidate = imageDirectoryCandidate;
      }
      if (!isPathWithin(root, candidate) || !(await pathIsFile(candidate))) {
        missingReferencedImages.add(`${referenceSet.baseDir}\0${assetRef}`);
        continue;
      }
      if (!RETAINED_IMAGE_EXTENSIONS.has(path.extname(candidate).toLowerCase())) {
        missingReferencedImages.add(`${referenceSet.baseDir}\0${assetRef}`);
        continue;
      }
      retained.add(candidate);
      retainedImages.add(candidate);
    }
  }
  const retainedStats = await summarizeFiles([...retained]);
  return {
    retainedFilePaths: retained,
    record: {
      policy: "minimal_required",
      full_raw_opt_in: false,
      standardized_outputs_only_for_model: true,
      counts: {
        before_files: before.files,
        before_bytes: before.bytes,
        retained_files: retainedStats.files,
        retained_bytes: retainedStats.bytes,
        removed_files: before.files - retainedStats.files,
        removed_bytes: before.bytes - retainedStats.bytes,
        missing_referenced_images: missingReferencedImages.size,
      },
      categories: retentionCategories({ hasV1: true, hasV2: Boolean(v2), layoutCount: retainedLayoutCount, imageCount: retainedImages.size }),
    },
  };
}

async function removeEmptyDirectories(root) {
  const directories = [];
  async function collect(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const child = path.join(current, entry.name);
      await collect(child);
      directories.push(child);
    }
  }
  await collect(root);
  for (const directory of directories) {
    try {
      if ((await fs.readdir(directory)).length === 0) await fs.rmdir(directory);
    } catch {
      // A concurrently created or non-empty directory remains untouched.
    }
  }
}

export async function pruneManagedRawDirectory(inputDir, plan) {
  const root = path.resolve(inputDir);
  const retained = plan.retainedFilePaths;
  for (const filePath of await listFilesRecursively(root)) {
    if (!retained.has(filePath)) await fs.rm(filePath, { force: true });
  }
  await removeEmptyDirectories(root);
  return { ...plan.record, scope: "managed_cache_pruned", source_input_modified: false };
}

export async function createMinimalRawSnapshot(inputDir, destinationDir, plan) {
  const root = path.resolve(inputDir);
  const destination = path.resolve(destinationDir);
  if (isPathWithin(root, destination)) throw new Error("Managed MinerU raw cache must be outside the normalize-only input directory.");
  await fs.rm(destination, { recursive: true, force: true });
  await fs.mkdir(destination, { recursive: true });
  for (const sourcePath of plan.retainedFilePaths) {
    const relative = path.relative(root, sourcePath);
    const target = path.join(destination, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(sourcePath, target);
  }
  return { ...plan.record, scope: "managed_cache_snapshot", source_input_modified: false };
}

async function rawFilesMatchRetention(rawDir, retention) {
  if (!retention?.counts || !(await pathIsDirectory(rawDir))) return false;
  try {
    const summary = await summarizeFiles(await listFilesRecursively(rawDir));
    return summary.files === retention.counts.retained_files && summary.bytes === retention.counts.retained_bytes;
  } catch {
    return false;
  }
}

async function readRetentionManifest(filePath, cacheKey, rawDir) {
  try {
    const manifest = await readJson(filePath);
    if (manifest.cache_key !== cacheKey || !(await rawFilesMatchRetention(rawDir, manifest.retention))) return null;
    return manifest.retention;
  } catch {
    return null;
  }
}

async function writeRetentionManifest(filePath, cacheKey, retention) {
  await writeJson(filePath, { schema_version: "1.0", cache_key: cacheKey, retention });
}

async function atomicWrite(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  await fs.writeFile(temporary, content);
  await fs.rename(temporary, filePath);
}

async function writeJson(filePath, value) {
  await atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function countTypes(blocks) {
  const counts = {};
  for (const block of blocks) counts[block.type] = (counts[block.type] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right, "en")));
}

export async function normalizeMineruDirectory(options) {
  const inputDir = path.resolve(options.inputDir);
  const outputDir = path.resolve(options.outputDir);
  const discovered = await discoverInput(inputDir);
  const warnings = [];
  const v1 = await readJson(discovered.v1Path);
  if (!Array.isArray(v1)) throw new Error("MinerU v1 content_list must be a JSON array.");
  let v2 = null;
  if (discovered.v2Path) {
    try {
      v2 = await readJson(discovered.v2Path);
      if (!Array.isArray(v2)) throw new Error("root is not an array");
    } catch (error) {
      warnings.push(`Ignored malformed content_list_v2 enhancement: ${error.message}`);
      v2 = null;
    }
  }
  let layout = null;
  if (discovered.layoutPath) {
    try {
      layout = await readJson(discovered.layoutPath);
    } catch (error) {
      warnings.push(`Ignored malformed layout metadata: ${error.message}`);
    }
  }
  const rawBaseDir = path.dirname(discovered.v1Path);
  const blocks = normalizeV1Blocks(v1, indexV2(v2), rawBaseDir, warnings);
  const candidates = buildCandidates(blocks);
  const pages = buildPageMap(blocks, pageSizeIndex(layout));
  const sourcePath = path.resolve(options.sourcePath ?? discovered.originPdfPath ?? "");
  if (!sourcePath || !(await pathIsFile(sourcePath))) {
    throw new Error("A source PDF is required for the cache identity. Pass --source or include an *_origin.pdf file in the unpacked result.");
  }
  const sourceInfo = await fs.stat(sourcePath);
  const sourceSha256 = options.sourceSha256 ?? await sha256File(sourcePath);
  const parameters = {
    model_version: options.modelVersion ?? "vlm",
    language: options.language ?? "ch",
    is_ocr: Boolean(options.isOcr),
    enable_formula: options.enableFormula !== false,
    enable_table: options.enableTable !== false,
    page_ranges: options.pageRanges || null,
    extra_formats: [],
  };
  const cacheKey = options.cacheKey ?? computeCacheKey({
    sourceSha256,
    modelVersion: parameters.model_version,
    language: parameters.language,
    isOcr: parameters.is_ocr,
    enableFormula: parameters.enable_formula,
    enableTable: parameters.enable_table,
    pageRanges: parameters.page_ranges,
  });
  const headings = blocks.filter((block) => block.type === "title").map((block) => ({
    block_id: block.block_id,
    page: block.page,
    level: block.heading_level,
    text: block.text,
    source: block.heading_source,
  }));
  const source = {
    filename: path.basename(sourcePath),
    sha256: sourceSha256,
    bytes: sourceInfo.size,
    page_count: pages.at(-1)?.page ?? 0,
  };
  const documentIndex = {
    schema_version: "1.0",
    normalizer_version: NORMALIZER_VERSION,
    source,
    counts: {
      pages: pages.length,
      blocks: blocks.length,
      by_type: countTypes(blocks),
      figures: candidates.figures.length,
      tables: candidates.tables.length,
      formulas: candidates.formulas.length,
      headings: headings.length,
    },
    headings,
    page_overview: pages.map((page) => ({
      page: page.page,
      counts: Object.fromEntries(["title", "text", "figure", "table", "formula", "reference"]
        .filter((type) => page.counts[type])
        .map((type) => [type, page.counts[type]])),
      excerpt: page.excerpt.slice(0, 180),
    })),
    files: {
      blocks: "blocks.ndjson",
      pages: "page-map.json",
      figures: "figure-candidates.json",
      tables: "table-candidates.json",
      formulas: "formula-candidates.json",
      extraction_record: "extraction-record.json",
    },
  };
  const envelope = (items) => ({ schema_version: "1.0", source_sha256: sourceSha256, candidates: items });
  const fallbackRawStats = options.retention ? null : await summarizeFiles(discovered.files);
  const retention = options.retention ?? {
    policy: "external_read_only",
    scope: "external_input",
    full_raw_opt_in: false,
    source_input_modified: false,
    standardized_outputs_only_for_model: true,
    counts: {
      before_files: fallbackRawStats.files,
      before_bytes: fallbackRawStats.bytes,
      retained_files: fallbackRawStats.files,
      retained_bytes: fallbackRawStats.bytes,
      removed_files: 0,
      removed_bytes: 0,
      missing_referenced_images: 0,
    },
    categories: null,
  };
  const record = {
    schema_version: "1.0",
    status: "complete",
    provider: "mineru",
    mode: options.mode ?? "normalize-only",
    normalizer_version: NORMALIZER_VERSION,
    cache_key: cacheKey,
    source,
    parameters,
    mineru_inputs: {
      content_list_v1_present: true,
      content_list_v2_used: Boolean(v2),
      layout_metadata_used: Boolean(layout),
      v1_is_authoritative: true,
      v2_is_optional_enhancement: true,
    },
    api: options.mode === "api" ? {
      batch_id: options.batchId ?? null,
      credential_env: options.tokenEnv ?? DEFAULT_TOKEN_ENV,
      credential_persisted: false,
      signed_urls_persisted: false,
    } : null,
    retention,
    outputs: {
      files: OUTPUT_FILENAMES,
      counts: documentIndex.counts,
    },
    warnings,
    generated_at: new Date().toISOString(),
  };
  await fs.mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeJson(path.join(outputDir, "document-index.json"), documentIndex),
    atomicWrite(path.join(outputDir, "blocks.ndjson"), `${blocks.map((block) => JSON.stringify(block)).join("\n")}\n`),
    writeJson(path.join(outputDir, "page-map.json"), { schema_version: "1.0", source_sha256: sourceSha256, pages }),
    writeJson(path.join(outputDir, "figure-candidates.json"), envelope(candidates.figures)),
    writeJson(path.join(outputDir, "table-candidates.json"), envelope(candidates.tables)),
    writeJson(path.join(outputDir, "formula-candidates.json"), envelope(candidates.formulas)),
    writeJson(path.join(outputDir, "extraction-record.json"), record),
  ]);
  return { outputDir, cacheKey, sourceSha256, counts: documentIndex.counts, warnings, retention, cached: false };
}

async function validNormalizedOutput(directoryPath, cacheKey) {
  try {
    const record = await readJson(path.join(directoryPath, "extraction-record.json"));
    if (record.status !== "complete" || record.cache_key !== cacheKey || record.normalizer_version !== NORMALIZER_VERSION) return false;
    return (await Promise.all(OUTPUT_FILENAMES.map((filename) => pathIsNonemptyFile(path.join(directoryPath, filename))))).every(Boolean);
  } catch {
    return false;
  }
}

async function copyNormalizedOutput(sourceDir, destinationDir) {
  await fs.mkdir(destinationDir, { recursive: true });
  for (const filename of OUTPUT_FILENAMES) {
    const content = await fs.readFile(path.join(sourceDir, filename));
    await atomicWrite(path.join(destinationDir, filename), content);
  }
}

function safeEnvName(value) {
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

async function apiJson(fetchImpl, url, init, label) {
  const response = await fetchImpl(url, init);
  if (!response?.ok) throw new Error(`MinerU ${label} failed with HTTP ${response?.status ?? "unknown"}.`);
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`MinerU ${label} returned invalid JSON.`);
  }
  if (payload?.code !== undefined && Number(payload.code) !== 0) {
    throw new Error(`MinerU ${label} failed with code ${payload.code}.`);
  }
  return payload;
}

function responseData(payload) {
  return payload?.data && typeof payload.data === "object" ? payload.data : payload;
}

function resultEntries(data) {
  const value = data?.extract_result ?? data?.extract_results ?? data?.results ?? data?.files;
  return Array.isArray(value) ? value : value ? [value] : [];
}

async function defaultExtractZip(zipPath, destinationDir) {
  await fs.mkdir(destinationDir, { recursive: true });
  const { stdout } = await execFileAsync("unzip", ["-Z1", zipPath], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const entries = stdout.split(/\r?\n/).filter(Boolean);
  for (const entry of entries) {
    const normalized = entry.replaceAll("\\", "/");
    if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
      throw new Error("MinerU archive contains an unsafe path.");
    }
  }
  await execFileAsync("unzip", ["-q", "-o", zipPath, "-d", destinationDir], { maxBuffer: 16 * 1024 * 1024 });
  async function rejectSymlinks(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const info = await fs.lstat(absolute);
      if (info.isSymbolicLink()) throw new Error("MinerU archive contains a symbolic link, which is not allowed.");
      if (info.isDirectory()) await rejectSymlinks(absolute);
    }
  }
  await rejectSymlinks(destinationDir);
}

async function downloadZip(fetchImpl, url, destinationPath) {
  let response;
  try {
    response = await fetchImpl(url, { method: "GET", redirect: "follow" });
  } catch {
    throw new Error("MinerU result download request failed.");
  }
  if (!response?.ok) throw new Error(`MinerU result download failed with HTTP ${response?.status ?? "unknown"}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) throw new Error("MinerU result download was empty.");
  await atomicWrite(destinationPath, bytes);
}

async function runApi(options, context) {
  const {
    fetchImpl,
    sleep,
    now,
    logger,
    extractZip,
    token,
    rawDir,
    archivePath,
    sourcePath,
    apiBase,
  } = context;
  const createBody = {
    files: [{
      name: path.basename(sourcePath),
      data_id: options.sourceSha256.slice(0, 32),
      is_ocr: Boolean(options.isOcr),
      ...(options.pageRanges ? { page_ranges: options.pageRanges } : {}),
    }],
    model_version: options.modelVersion,
    language: options.language,
    enable_formula: Boolean(options.enableFormula),
    enable_table: Boolean(options.enableTable),
    extra_formats: [],
  };
  logger("Creating MinerU batch upload task.");
  const created = responseData(await apiJson(fetchImpl, `${apiBase}/api/v4/file-urls/batch`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(createBody),
  }, "batch creation"));
  const batchId = String(created?.batch_id ?? "").trim();
  const rawUpload = Array.isArray(created?.file_urls) ? created.file_urls[0] : created?.file_url;
  const uploadUrl = typeof rawUpload === "string" ? rawUpload : rawUpload?.url ?? rawUpload?.file_url;
  if (!batchId || typeof uploadUrl !== "string" || !uploadUrl) throw new Error("MinerU batch creation did not return a batch id and signed upload URL.");
  logger("Uploading source PDF to the signed batch URL.");
  const uploadBytes = (await fs.stat(sourcePath)).size;
  let uploadResponse;
  try {
    uploadResponse = await fetchImpl(uploadUrl, {
      method: "PUT",
      headers: { "Content-Length": String(uploadBytes) },
      body: createReadStream(sourcePath),
      duplex: "half",
    });
  } catch {
    throw new Error("MinerU signed upload request failed.");
  }
  if (!uploadResponse?.ok) throw new Error(`MinerU signed upload failed with HTTP ${uploadResponse?.status ?? "unknown"}.`);
  const deadline = now() + options.maxWaitMs;
  let zipUrl = null;
  while (now() <= deadline) {
    const polled = responseData(await apiJson(fetchImpl, `${apiBase}/api/v4/extract-results/batch/${encodeURIComponent(batchId)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    }, "batch polling"));
    const entries = resultEntries(polled);
    const target = entries.find((entry) => entry?.data_id === createBody.files[0].data_id)
      ?? entries.find((entry) => entry?.file_name === createBody.files[0].name)
      ?? entries[0];
    const state = String(target?.state ?? polled?.state ?? "").toLowerCase();
    const candidateUrl = target?.full_zip_url ?? target?.zip_url ?? polled?.full_zip_url ?? polled?.zip_url;
    if (["done", "success", "completed"].includes(state) && typeof candidateUrl === "string" && candidateUrl) {
      zipUrl = candidateUrl;
      break;
    }
    if (["failed", "fail", "error"].includes(state)) throw new Error("MinerU extraction task failed.");
    await sleep(options.pollMs);
  }
  if (!zipUrl) throw new Error("MinerU extraction timed out before a downloadable result was ready.");
  logger("Downloading and unpacking MinerU result.");
  await downloadZip(fetchImpl, zipUrl, archivePath);
  await extractZip(archivePath, rawDir);
  await fs.rm(archivePath, { force: true });
  return { batchId };
}

export async function prepareSourceMineru(options, dependencies = {}) {
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  const sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const now = dependencies.now ?? Date.now;
  const logger = dependencies.logger ?? (() => {});
  const extractZip = dependencies.extractZip ?? defaultExtractZip;
  const env = dependencies.env ?? process.env;
  const outputDir = path.resolve(options.outputDir ?? "");
  if (!options.outputDir) throw new Error("--output-dir is required.");
  const normalizeOnly = options.normalizeOnly ? path.resolve(options.normalizeOnly) : null;
  let sourcePath = options.source ? path.resolve(options.source) : null;
  let discovered = null;
  if (normalizeOnly) {
    discovered = await discoverInput(normalizeOnly);
    sourcePath ??= discovered.originPdfPath;
  }
  if (!sourcePath || !(await pathIsFile(sourcePath))) throw new Error("--source must identify an existing PDF, unless normalize-only can infer *_origin.pdf.");
  if (path.extname(sourcePath).toLowerCase() !== ".pdf") throw new Error("MinerU source must be a PDF.");
  const sourceInfo = await fs.stat(sourcePath);
  if (sourceInfo.size > 200 * 1024 * 1024) throw new Error("MinerU precise parsing accepts files up to 200 MB.");
  const sourceSha256 = await sha256File(sourcePath);
  const normalizedOptions = {
    ...options,
    outputDir,
    sourcePath,
    sourceSha256,
    modelVersion: options.modelVersion ?? "vlm",
    language: options.language ?? "ch",
    isOcr: Boolean(options.isOcr),
    enableFormula: options.enableFormula !== false,
    enableTable: options.enableTable !== false,
    pageRanges: options.pageRanges || null,
    pollMs: Number(options.pollMs ?? 5_000),
    maxWaitMs: Number(options.maxWaitMs ?? 2 * 60 * 60 * 1_000),
  };
  if (!new Set(["vlm", "pipeline"]).has(normalizedOptions.modelVersion)) throw new Error("--model-version must be vlm or pipeline.");
  const cacheKey = computeCacheKey(normalizedOptions);
  normalizedOptions.cacheKey = cacheKey;
  if (!normalizeOnly && !options.confirmUpload) throw new Error("API upload requires explicit --confirm-upload acknowledgement.");

  let defaultCacheRoot = path.join(path.dirname(outputDir), ".academic-slides-mineru-cache");
  if (normalizeOnly && isPathWithin(normalizeOnly, defaultCacheRoot)) {
    defaultCacheRoot = path.join(path.dirname(normalizeOnly), ".academic-slides-mineru-cache");
  }
  const cacheRoot = path.resolve(options.cacheDir ?? defaultCacheRoot);
  const cacheEntry = path.join(cacheRoot, cacheKey);
  const rawDir = path.join(cacheEntry, "raw");
  const normalizedDir = path.join(cacheEntry, "normalized");
  const retentionManifestPath = path.join(cacheEntry, "raw-retention.json");

  if (normalizeOnly) {
    const plan = await buildRawRetentionPlan(normalizeOnly, { retainFullRaw: Boolean(options.retainFullRaw) });
    if (options.retainFullRaw) {
      const retention = {
        ...plan.record,
        scope: "external_full_raw_opt_in",
        source_input_modified: false,
      };
      if (!options.force && await validNormalizedOutput(outputDir, cacheKey)) {
        return { outputDir, cacheKey, sourceSha256, cached: true, retention };
      }
      return normalizeMineruDirectory({
        ...normalizedOptions,
        inputDir: normalizeOnly,
        mode: "normalize-only",
        retention,
      });
    }
    if (isPathWithin(normalizeOnly, cacheRoot)) {
      throw new Error("--cache-dir for normalize-only must be outside the unpacked MinerU input directory.");
    }
    await fs.mkdir(cacheEntry, { recursive: true });
    let retention = options.force ? null : await readRetentionManifest(retentionManifestPath, cacheKey, rawDir);
    if (!retention) {
      retention = await createMinimalRawSnapshot(normalizeOnly, rawDir, plan);
      await writeRetentionManifest(retentionManifestPath, cacheKey, retention);
    }
    if (!options.force && await validNormalizedOutput(outputDir, cacheKey)) {
      return { outputDir, cacheKey, sourceSha256, cached: true, retention };
    }
    if (!options.force && await validNormalizedOutput(normalizedDir, cacheKey)) {
      await copyNormalizedOutput(normalizedDir, outputDir);
      return { outputDir, cacheKey, sourceSha256, cached: true, retention };
    }
    const result = await normalizeMineruDirectory({
      ...normalizedOptions,
      inputDir: rawDir,
      outputDir: normalizedDir,
      mode: "normalize-only",
      retention,
    });
    await copyNormalizedOutput(normalizedDir, outputDir);
    return { ...result, outputDir, cached: false };
  }

  let retention = options.force ? null : await readRetentionManifest(retentionManifestPath, cacheKey, rawDir);
  if (retention && !options.force && await validNormalizedOutput(outputDir, cacheKey)) {
    return { outputDir, cacheKey, sourceSha256, cached: true, retention };
  }
  if (retention && !options.force && await validNormalizedOutput(normalizedDir, cacheKey)) {
    await copyNormalizedOutput(normalizedDir, outputDir);
    return { outputDir, cacheKey, sourceSha256, cached: true, retention };
  }

  let rawAvailable = false;
  try {
    await discoverInput(rawDir);
    rawAvailable = true;
  } catch {
    rawAvailable = false;
  }
  if (rawAvailable && !retention) {
    const plan = await buildRawRetentionPlan(rawDir, { retainFullRaw: Boolean(options.retainFullRaw) });
    retention = options.retainFullRaw
      ? { ...plan.record, scope: "managed_cache_full_raw_opt_in", source_input_modified: false }
      : await pruneManagedRawDirectory(rawDir, plan);
    await writeRetentionManifest(retentionManifestPath, cacheKey, retention);
  }

  let batchId = null;
  if (!rawAvailable) {
    const tokenEnv = options.tokenEnv ?? DEFAULT_TOKEN_ENV;
    if (!safeEnvName(tokenEnv)) throw new Error("--token-env must be a valid environment variable name.");
    const token = env[tokenEnv];
    if (typeof token !== "string" || !token.trim()) throw new Error(`MinerU credential environment variable ${tokenEnv} is not set.`);
    if (typeof fetchImpl !== "function") throw new Error("This Node.js runtime does not provide fetch.");
    await fs.mkdir(cacheEntry, { recursive: true });
    await fs.rm(rawDir, { recursive: true, force: true });
    await fs.mkdir(rawDir, { recursive: true });
    const apiResult = await runApi(normalizedOptions, {
      fetchImpl,
      sleep,
      now,
      logger,
      extractZip,
      token: token.trim(),
      rawDir,
      archivePath: path.join(cacheEntry, "result.zip"),
      sourcePath,
      apiBase: String(options.apiBase ?? DEFAULT_API_BASE).replace(/\/$/, ""),
    });
    batchId = apiResult.batchId;
    const plan = await buildRawRetentionPlan(rawDir, { retainFullRaw: Boolean(options.retainFullRaw) });
    retention = options.retainFullRaw
      ? { ...plan.record, scope: "managed_cache_full_raw_opt_in", source_input_modified: false }
      : await pruneManagedRawDirectory(rawDir, plan);
    await writeRetentionManifest(retentionManifestPath, cacheKey, retention);
  }

  const tokenEnv = options.tokenEnv ?? DEFAULT_TOKEN_ENV;
  const result = await normalizeMineruDirectory({
    ...normalizedOptions,
    inputDir: rawDir,
    outputDir: normalizedDir,
    mode: "api",
    batchId,
    tokenEnv,
    retention,
  });
  await copyNormalizedOutput(normalizedDir, outputDir);
  return { ...result, outputDir, cached: false };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const result = await prepareSourceMineru(options, {
    logger: options.json ? () => {} : (message) => console.error(message),
  });
  const summary = {
    ok: true,
    cached: Boolean(result.cached),
    output_dir: result.outputDir,
    cache_key: result.cacheKey,
    counts: result.counts ?? null,
    retention: result.retention ?? null,
    warnings: result.warnings ?? [],
  };
  console.log(options.json ? JSON.stringify(summary) : [
    `MinerU evidence preparation ${summary.cached ? "reused cached output" : "completed"}.`,
    `Output: ${summary.output_dir}`,
    `Cache key: ${summary.cache_key}`,
  ].join("\n"));
}

if (path.resolve(process.argv[1] ?? "") === path.resolve(SCRIPT_PATH)) {
  main().catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  });
}
