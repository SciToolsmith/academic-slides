#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const DEFAULT_AUTO_LIMIT = 12;
const DEFAULT_DPI = 180;
const CAPTION_GAP_PT = 5;
const MIN_CROP_HEIGHT_PT = 54;

function usage() {
  return [
    "Usage: node extract-paper-assets.mjs <paper.pdf> [output-directory] [options]",
    "",
    "Options:",
    "  --materialize <mode>  auto (default), all, selected, or none",
    "  --select <ids>         Comma-separated asset IDs to crop; may be repeated",
    "  --auto-limit <n>       In auto mode, crop all when detected assets <= n (default: 12)",
    "  --dpi <n>              Crop rasterization resolution (default: 180)",
    "  --force                Replace this script's manifest, guide, and matching crops",
    "  --json                 Print a machine-readable operation summary",
    "  -h, --help             Show this help",
    "",
    "For papers above the auto limit, the default run creates a complete caption index",
    "without rasterizing every item. Re-run with --select figure-1,table-2 --force to",
    "materialize only core assets. Tables remain faithful image crops; no bulk OCR/CSV",
    "conversion is attempted.",
  ].join("\n");
}

function parsePositiveInteger(value, option, minimum = 1, maximum = 1200) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${option} must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

function parseArgs(argv) {
  const result = {
    materialize: "auto",
    selectedIds: [],
    autoLimit: DEFAULT_AUTO_LIMIT,
    dpi: DEFAULT_DPI,
    force: false,
    json: false,
    positional: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--materialize") {
      const value = argv[++index];
      if (!value || !["auto", "all", "selected", "none"].includes(value)) {
        throw new Error("--materialize must be auto, all, selected, or none.");
      }
      result.materialize = value;
    } else if (token === "--select") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error("--select requires one or more comma-separated asset IDs.");
      result.selectedIds.push(...value.split(",").map((item) => item.trim()).filter(Boolean));
    } else if (token === "--auto-limit") {
      result.autoLimit = parsePositiveInteger(argv[++index], "--auto-limit", 1, 1000);
    } else if (token === "--dpi") {
      result.dpi = parsePositiveInteger(argv[++index], "--dpi", 72, 600);
    } else if (token === "--force") result.force = true;
    else if (token === "--json") result.json = true;
    else if (token === "-h" || token === "--help") result.help = true;
    else if (token.startsWith("-")) throw new Error(`Unknown option: ${token}`);
    else result.positional.push(token);
  }
  if (result.positional.length > 2) throw new Error("Provide a PDF and optional output directory.");
  result.selectedIds = [...new Set(result.selectedIds)];
  return result;
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function round(value, digits = 3) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function xmlDecode(value) {
  return String(value ?? "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function attributes(source) {
  const result = {};
  for (const match of source.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*["']([^"']*)["']/g)) {
    result[match[1]] = xmlDecode(match[2]);
  }
  return result;
}

function numberAttribute(attrs, key) {
  const value = Number(attrs[key]);
  return Number.isFinite(value) ? value : null;
}

function joinWords(words) {
  return words
    .join(" ")
    .replace(/([\p{Script=Han}])\s+(?=[\p{Script=Han}])/gu, "$1")
    .replace(/\s+([,.;:!?%\]\)\}，。；：！？、）】])/g, "$1")
    .replace(/([\[\(\{（【])\s+/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function parseLineElements(source, blockIndex, lineIndexStart) {
  const lines = [];
  let lineIndex = lineIndexStart;
  for (const match of source.matchAll(/<line\b([^>]*)>([\s\S]*?)<\/line>/gi)) {
    const attrs = attributes(match[1]);
    const words = [...match[2].matchAll(/<word\b[^>]*>([\s\S]*?)<\/word>/gi)]
      .map((word) => xmlDecode(word[1].replace(/<[^>]+>/g, "")))
      .filter(Boolean);
    const xMin = numberAttribute(attrs, "xMin");
    const yMin = numberAttribute(attrs, "yMin");
    const xMax = numberAttribute(attrs, "xMax");
    const yMax = numberAttribute(attrs, "yMax");
    if (![xMin, yMin, xMax, yMax].every(Number.isFinite) || xMax <= xMin || yMax <= yMin) continue;
    const text = joinWords(words);
    if (!text) continue;
    lines.push({ blockIndex, lineIndex: lineIndex++, text, xMin, yMin, xMax, yMax });
  }
  return lines;
}

function parseBboxLayout(source) {
  const pages = [];
  let pageNumber = 0;
  for (const pageMatch of source.matchAll(/<page\b([^>]*)>([\s\S]*?)<\/page>/gi)) {
    pageNumber += 1;
    const attrs = attributes(pageMatch[1]);
    const width = numberAttribute(attrs, "width");
    const height = numberAttribute(attrs, "height");
    if (!(width > 0 && height > 0)) throw new Error(`pdftotext returned invalid geometry for PDF page ${pageNumber}.`);
    const lines = [];
    let blockIndex = 0;
    let lineIndex = 0;
    for (const blockMatch of pageMatch[2].matchAll(/<block\b[^>]*>([\s\S]*?)<\/block>/gi)) {
      const blockLines = parseLineElements(blockMatch[1], blockIndex++, lineIndex);
      for (const line of blockLines) line.blockLineCount = blockLines.length;
      lines.push(...blockLines);
      lineIndex += blockLines.length;
    }
    if (!lines.length) {
      const fallbackLines = parseLineElements(pageMatch[2], 0, 0);
      for (const line of fallbackLines) line.blockLineCount = fallbackLines.length;
      lines.push(...fallbackLines);
    }
    lines.sort((left, right) => left.yMin - right.yMin || left.xMin - right.xMin);
    pages.push({ number: pageNumber, width, height, lines });
  }
  if (!pages.length) throw new Error("pdftotext did not return any page geometry. The PDF may be empty, encrypted, or image-only.");
  return pages;
}

const NUMBER_PATTERN = "([A-Za-z]?\\d+(?:[.\\-\u2013]\\d+)*(?:[A-Za-z])?(?:\\([A-Za-z0-9]+\\))?|[IVXLCDM]+)";
const ENGLISH_CAPTION = new RegExp(`^(Figure|Fig\\.?|Table)\\s*${NUMBER_PATTERN}\\s*([:.\\-\u2013\u2014]?)\\s*(.*)$`, "iu");
const CHINESE_CAPTION = new RegExp(`^(图|表)\\s*${NUMBER_PATTERN}\\s*([：:.\\-\u2013\u2014]?)\\s*(.*)$`, "u");

function captionMatch(text) {
  const match = text.match(ENGLISH_CAPTION) ?? text.match(CHINESE_CAPTION);
  if (!match) return null;
  const prefix = match[1];
  const kind = /^(?:table|表)$/iu.test(prefix) ? "table" : "figure";
  return {
    kind,
    number: match[2].replace(/\s+/g, ""),
    title: match[4].trim(),
    prefix,
    separator: match[3],
  };
}

function aggregateBbox(lines) {
  return {
    x: Math.min(...lines.map((line) => line.xMin)),
    y: Math.min(...lines.map((line) => line.yMin)),
    width: Math.max(...lines.map((line) => line.xMax)) - Math.min(...lines.map((line) => line.xMin)),
    height: Math.max(...lines.map((line) => line.yMax)) - Math.min(...lines.map((line) => line.yMin)),
    unit: "pdf_point",
  };
}

function shorten(value, maximum, fallback) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").replace(/^[\s:.。：–—-]+/, "").trim();
  if (!normalized) return fallback;
  const firstSentence = normalized.split(/(?<=[.!?。！？])\s+/u)[0];
  const characters = [...firstSentence];
  return characters.length <= maximum ? firstSentence : `${characters.slice(0, maximum - 1).join("")}…`;
}

function normalizeExtractedTitle(value) {
  const input = String(value ?? "").trim();
  const letters = [...input].filter((character) => /[A-Za-z]/.test(character));
  if (!letters.length || letters.filter((character) => character === character.toUpperCase()).length / letters.length < 0.8) return input;
  return input.replace(/\b([A-Z])\s+(?=[A-Z]{2,}\b)/g, "$1");
}

function detectCaptions(pages) {
  const detections = [];
  for (const page of pages) {
    for (let index = 0; index < page.lines.length; index += 1) {
      const line = page.lines[index];
      const parsed = captionMatch(line.text);
      if (!parsed) continue;
      const captionLines = [line];
      if (!parsed.title) {
        const lineCenter = (line.yMin + line.yMax) / 2;
        const splitTitle = page.lines
          .filter((candidate) => candidate !== line && candidate.blockIndex !== line.blockIndex && !captionMatch(candidate.text))
          .filter((candidate) => Math.abs((candidate.yMin + candidate.yMax) / 2 - lineCenter) <= 3)
          .filter((candidate) => candidate.xMin >= line.xMax - 1 && candidate.xMin - line.xMax <= 32)
          .sort((left, right) => left.xMin - right.xMin)[0];
        if (splitTitle) captionLines.push(splitTitle);
      }
      let previous = line;
      for (let cursor = index + 1; cursor < page.lines.length && captionLines.length < 3; cursor += 1) {
        const candidate = page.lines[cursor];
        if (captionLines.includes(candidate)) continue;
        if (captionMatch(candidate.text)) break;
        const gap = candidate.yMin - previous.yMax;
        const labelCenter = (line.xMin + line.xMax) / 2;
        const candidateCenter = (candidate.xMin + candidate.xMax) / 2;
        const sameBlockContinuation = candidate.blockIndex === line.blockIndex
          && gap >= -1
          && gap <= Math.max(8, (previous.yMax - previous.yMin) * 1.35)
          && (Math.abs(candidate.xMin - line.xMin) <= 42 || Math.abs(candidateCenter - labelCenter) <= 42);
        if (!sameBlockContinuation) break;
        captionLines.push(candidate);
        previous = candidate;
      }
      const continuation = captionLines.slice(1).map((item) => item.text).join(" ");
      const rawTitle = normalizeExtractedTitle([parsed.title, continuation].filter(Boolean).join(" "));
      const fallbackTitle = parsed.kind === "figure" ? "Untitled figure" : "Untitled table";
      detections.push({
        kind: parsed.kind,
        number: parsed.number,
        label: `${parsed.kind === "figure" ? "Figure" : "Table"} ${parsed.number}`,
        title: shorten(rawTitle, 72, fallbackTitle),
        captionText: captionLines.map((item) => item.text).join(" "),
        briefDescription: shorten(rawTitle, 180, `${parsed.kind === "figure" ? "Figure" : "Table"} ${parsed.number} from the source paper.`),
        page,
        captionBbox: aggregateBbox(captionLines),
        prefix: parsed.prefix,
        separator: parsed.separator,
        blockLineCount: line.blockLineCount ?? 99,
      });
    }
  }
  const proseReference = /^(?:shows?|presents?|depicts?|plots?|provides?|illustrates?|demonstrates?|reports?|gives?)\b/iu;
  const candidateScore = (item) => {
    let score = item.separator ? 4 : 0;
    if (item.kind === "table" && item.prefix === item.prefix.toUpperCase()) score += 4;
    score += item.blockLineCount <= 3 ? 3 : -Math.min(4, Math.ceil(item.blockLineCount / 5));
    if (item.title) score += 1;
    if (proseReference.test(item.title)) score -= 6;
    return score;
  };
  const bestByNumber = new Map();
  for (const detection of detections) {
    const key = `${detection.kind}:${detection.number.toUpperCase()}`;
    const current = bestByNumber.get(key);
    if (!current || candidateScore(detection) > candidateScore(current)) bestByNumber.set(key, detection);
  }
  return [...bestByNumber.values()].sort((left, right) => left.page.number - right.page.number || left.captionBbox.y - right.captionBbox.y);
}

function asciiIdPart(value) {
  const normalized = String(value).normalize("NFKD").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || createHash("sha256").update(String(value)).digest("hex").slice(0, 8);
}

function safeFilePart(value, fallback, maximum = 52) {
  const cleaned = String(value ?? "")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}._-]+/gu, "_")
    .replace(/_+/g, "_")
    .replace(/^[_.-]+|[_.-]+$/g, "");
  const characters = [...(cleaned || fallback)];
  return characters.slice(0, maximum).join("").replace(/[_.-]+$/g, "") || fallback;
}

function assignStableNames(detections) {
  const ids = new Set();
  const filenames = new Set();
  for (const detection of detections) {
    const idBase = `${detection.kind}-${asciiIdPart(detection.number)}`;
    const digest = createHash("sha256")
      .update(`${detection.kind}\0${detection.number}\0${detection.page.number}\0${detection.captionText}`)
      .digest("hex")
      .slice(0, 8);
    detection.id = ids.has(idBase) ? `${idBase}-${digest}` : idBase;
    ids.add(detection.id);
    const prefix = detection.kind === "figure" ? "Figure" : "Table";
    const base = `${prefix}_${safeFilePart(detection.number, "Unknown", 20)}_${safeFilePart(detection.title, "Untitled")}`;
    detection.filename = filenames.has(`${base}.png`) ? `${base}_${digest}.png` : `${base}.png`;
    filenames.add(detection.filename);
  }
}

function verticalCandidate(detection, detectionsOnPage, side, horizontal) {
  const { page, captionBbox } = detection;
  const margin = Math.max(50, page.height * 0.07);
  const captionTop = captionBbox.y;
  const captionBottom = captionBbox.y + captionBbox.height;
  const sameLane = (item) => {
    const center = item.captionBbox.x + item.captionBbox.width / 2;
    return center >= horizontal.left - 4 && center <= horizontal.right + 4;
  };
  const localDetections = detectionsOnPage.filter((item) => item === detection || sameLane(item));
  const previous = [...localDetections]
    .filter((item) => item !== detection && item.captionBbox.y + item.captionBbox.height < captionTop)
    .sort((left, right) => right.captionBbox.y - left.captionBbox.y)[0];
  const next = [...localDetections]
    .filter((item) => item !== detection && item.captionBbox.y > captionBottom)
    .sort((left, right) => left.captionBbox.y - right.captionBbox.y)[0];
  let top;
  let bottom;
  if (side === "above") {
    top = previous ? previous.captionBbox.y + previous.captionBbox.height + 8 : margin;
    bottom = captionTop - CAPTION_GAP_PT;
  } else {
    top = captionBottom + CAPTION_GAP_PT;
    bottom = next ? next.captionBbox.y - 8 : page.height - margin;
  }
  const maximumHeight = Math.min(page.height * 0.58, 460);
  if (bottom - top > maximumHeight) {
    if (side === "above") top = bottom - maximumHeight;
    else bottom = top + maximumHeight;
  }
  return { top, bottom, height: bottom - top };
}

function horizontalCandidate(detection) {
  const { page, captionBbox } = detection;
  const margin = Math.max(22, page.width * 0.045);
  const ratio = captionBbox.width / page.width;
  const center = captionBbox.x + captionBbox.width / 2;
  if (ratio >= 0.24 && ratio < 0.5 && center < page.width * 0.46) {
    return { left: margin, right: page.width * 0.49, inferredColumn: true };
  }
  if (ratio >= 0.24 && ratio < 0.5 && center > page.width * 0.54) {
    return { left: page.width * 0.51, right: page.width - margin, inferredColumn: true };
  }
  return { left: margin, right: page.width - margin, inferredColumn: false };
}

function planCrop(detection, detectionsOnPage) {
  const expectedSide = detection.kind === "figure" ? "above" : "below";
  const alternateSide = expectedSide === "above" ? "below" : "above";
  const horizontal = horizontalCandidate(detection);
  let vertical = verticalCandidate(detection, detectionsOnPage, expectedSide, horizontal);
  let side = expectedSide;
  let degradedOnce = false;
  const warnings = [];
  if (vertical.height < MIN_CROP_HEIGHT_PT) {
    vertical = verticalCandidate(detection, detectionsOnPage, alternateSide, horizontal);
    side = alternateSide;
    degradedOnce = true;
    warnings.push(`Expected ${expectedSide}-caption body region was too small; used the opposite side once without iterative repair.`);
  }
  if (vertical.height < MIN_CROP_HEIGHT_PT) {
    return {
      bbox: null,
      captionExcluded: false,
      confidence: "low",
      degradedOnce: true,
      method: "caption_spatial_fallback",
      warnings: [...warnings, "No safe caption-free body region met the minimum crop height."],
    };
  }
  const bbox = {
    x: round(horizontal.left),
    y: round(vertical.top),
    width: round(horizontal.right - horizontal.left),
    height: round(vertical.bottom - vertical.top),
    unit: "pdf_point",
  };
  const captionTop = detection.captionBbox.y;
  const captionBottom = detection.captionBbox.y + detection.captionBbox.height;
  const captionExcluded = side === "above"
    ? bbox.y + bbox.height <= captionTop - CAPTION_GAP_PT + 0.01
    : bbox.y >= captionBottom + CAPTION_GAP_PT - 0.01;
  let confidence = degradedOnce ? "low" : "high";
  if (!degradedOnce && (horizontal.inferredColumn || bbox.height > detection.page.height * 0.5)) confidence = "medium";
  if (horizontal.inferredColumn) warnings.push("A two-column crop was inferred from caption geometry; verify only if this asset becomes presentation-critical.");
  if (!captionExcluded) warnings.push("Computed crop geometry may intersect the caption.");
  return {
    bbox,
    captionExcluded,
    confidence,
    degradedOnce,
    method: degradedOnce ? "caption_spatial_fallback" : "caption_spatial_crop",
    warnings,
  };
}

async function loadSharp() {
  const resolvers = [require];
  if (process.env.RUNTIME_NODE_MODULES) {
    resolvers.push(createRequire(path.join(path.resolve(process.env.RUNTIME_NODE_MODULES), "__paper_club_ppt_runtime__.cjs")));
  }
  for (const resolver of resolvers) {
    try {
      const loaded = resolver("sharp");
      return loaded.default ?? loaded;
    } catch {
      // The Poppler-only fallback below avoids introducing another mandatory dependency.
    }
  }
  return null;
}

function bboxToPixels(bbox, dpi) {
  const scale = dpi / 72;
  const left = Math.max(0, Math.floor(bbox.x * scale));
  const top = Math.max(0, Math.floor(bbox.y * scale));
  const right = Math.max(left + 1, Math.ceil((bbox.x + bbox.width) * scale));
  const bottom = Math.max(top + 1, Math.ceil((bbox.y + bbox.height) * scale));
  return { left, top, width: right - left, height: bottom - top };
}

function tableSegmentHeightFromGray(data, width, height, dpi) {
  const minimumInk = Math.max(2, Math.ceil(width * 0.0025));
  const inkRows = [];
  for (let y = 0; y < height; y += 1) {
    let ink = 0;
    const offset = y * width;
    for (let x = 0; x < width; x += 1) {
      if (data[offset + x] < 246) ink += 1;
    }
    inkRows.push(ink >= minimumInk);
  }
  const firstInk = inkRows.indexOf(true);
  const lastInk = inkRows.lastIndexOf(true);
  if (firstInk < 0 || lastInk <= firstInk) return null;
  const minimumGap = Math.max(14, Math.round(dpi * 0.085));
  const minimumSegment = Math.max(28, Math.round(dpi * 0.18));
  const candidates = [];
  for (let start = firstInk + minimumSegment; start < lastInk; start += 1) {
    if (inkRows[start]) continue;
    let end = start;
    while (end < lastInk && !inkRows[end]) end += 1;
    const laterInkRows = inkRows.slice(end, lastInk + 1).filter(Boolean).length;
    if (end - start >= minimumGap && laterInkRows >= 6) candidates.push({ start, end, length: end - start });
    start = end;
  }
  if (!candidates.length) return null;
  candidates.sort((left, right) => right.length - left.length || left.start - right.start);
  const cutoff = Math.min(height, candidates[0].start + 2);
  return cutoff >= minimumSegment && cutoff <= height * 0.86 ? cutoff : null;
}

async function tableSegmentHeight(cropBuffer, sharp, dpi) {
  const { data, info } = await sharp(cropBuffer)
    .flatten({ background: "#ffffff" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return tableSegmentHeightFromGray(data, info.width, info.height, dpi);
}

function parsePgm(buffer) {
  let offset = 0;
  const tokens = [];
  while (tokens.length < 4) {
    while (offset < buffer.length && /\s/.test(String.fromCharCode(buffer[offset]))) offset += 1;
    if (buffer[offset] === 35) {
      while (offset < buffer.length && buffer[offset] !== 10 && buffer[offset] !== 13) offset += 1;
      continue;
    }
    const start = offset;
    while (offset < buffer.length && !/\s/.test(String.fromCharCode(buffer[offset]))) offset += 1;
    tokens.push(buffer.subarray(start, offset).toString("ascii"));
  }
  if (tokens[0] !== "P5") throw new Error("pdftoppm did not return a binary grayscale PGM.");
  const width = Number(tokens[1]);
  const height = Number(tokens[2]);
  const maximum = Number(tokens[3]);
  if (!(width > 0 && height > 0 && maximum === 255)) throw new Error("pdftoppm returned unsupported PGM geometry.");
  if (buffer[offset] === 13 && buffer[offset + 1] === 10) offset += 2;
  else if (/\s/.test(String.fromCharCode(buffer[offset]))) offset += 1;
  const data = buffer.subarray(offset, offset + width * height);
  if (data.length !== width * height) throw new Error("pdftoppm returned a truncated grayscale PGM.");
  return { data, width, height };
}

async function tableSegmentHeightWithPoppler(pdfPath, detection, dpi, temporary) {
  const pixels = bboxToPixels(detection.cropPlan.bbox, dpi);
  const prefix = path.join(temporary, `table-${detection.page.number}-${safeFilePart(detection.id, "asset")}`);
  await execFileAsync("pdftoppm", [
    "-gray", "-singlefile", "-r", String(dpi),
    "-f", String(detection.page.number), "-l", String(detection.page.number),
    "-x", String(pixels.left), "-y", String(pixels.top),
    "-W", String(pixels.width), "-H", String(pixels.height),
    pdfPath, prefix,
  ], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 120_000 });
  const pgm = parsePgm(await readFile(`${prefix}.pgm`));
  return tableSegmentHeightFromGray(pgm.data, pgm.width, pgm.height, dpi);
}

function applyTableSegment(detection, segmentedHeight, dpi) {
  if (!segmentedHeight) return;
  detection.cropPlan.bbox.height = round(segmentedHeight * 72 / dpi);
  detection.cropPlan.warnings.push("A single large whitespace boundary removed neighboring content from the table crop.");
  if (detection.cropPlan.confidence === "high") detection.cropPlan.confidence = "medium";
}

async function renderPage(pdfPath, pageNumber, dpi, outputPrefix) {
  await execFileAsync("pdftocairo", [
    "-png", "-singlefile", "-r", String(dpi),
    "-f", String(pageNumber), "-l", String(pageNumber),
    pdfPath, outputPrefix,
  ], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 120_000 });
  return `${outputPrefix}.png`;
}

async function cropWithPoppler(pdfPath, pageNumber, dpi, bbox, outputPath) {
  const pixels = bboxToPixels(bbox, dpi);
  const prefix = outputPath.slice(0, -path.extname(outputPath).length);
  await execFileAsync("pdftocairo", [
    "-png", "-singlefile", "-r", String(dpi),
    "-f", String(pageNumber), "-l", String(pageNumber),
    "-x", String(pixels.left), "-y", String(pixels.top),
    "-W", String(pixels.width), "-H", String(pixels.height),
    pdfPath, prefix,
  ], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 120_000 });
}

async function materializeCrops(pdfPath, outputDir, detections, dpi) {
  const selected = detections.filter((item) => item.shouldMaterialize && item.cropPlan.bbox);
  if (!selected.length) return;
  const assetDir = path.join(outputDir, "assets");
  await mkdir(assetDir, { recursive: true });
  const sharp = await loadSharp();
  const temporary = await mkdtemp(path.join(os.tmpdir(), "paper-club-ppt-paper-assets-"));
  try {
    const pages = new Map();
    for (const detection of selected) {
      if (!pages.has(detection.page.number)) pages.set(detection.page.number, []);
      pages.get(detection.page.number).push(detection);
    }
    for (const [pageNumber, pageDetections] of pages) {
      let renderedPage = null;
      let metadata = null;
      if (sharp) {
        try {
          renderedPage = await renderPage(pdfPath, pageNumber, dpi, path.join(temporary, `page-${pageNumber}`));
          metadata = await sharp(renderedPage).metadata();
        } catch (error) {
          for (const detection of pageDetections) detection.renderError = `Page render failed: ${error.message}`;
          continue;
        }
      }
      for (const detection of pageDetections) {
        const outputPath = path.join(assetDir, detection.filename);
        try {
          if (sharp) {
            const pixels = bboxToPixels(detection.cropPlan.bbox, dpi);
            const left = Math.min(pixels.left, Math.max(0, metadata.width - 1));
            const top = Math.min(pixels.top, Math.max(0, metadata.height - 1));
            const width = Math.min(pixels.width, metadata.width - left);
            const height = Math.min(pixels.height, metadata.height - top);
            if (width < 2 || height < 2) throw new Error("Computed pixel crop is empty after page-bound clamping.");
            const cropBuffer = await sharp(renderedPage).extract({ left, top, width, height }).png().toBuffer();
            const segmentedHeight = detection.kind === "table" ? await tableSegmentHeight(cropBuffer, sharp, dpi) : null;
            if (segmentedHeight) {
              await sharp(cropBuffer).extract({ left: 0, top: 0, width, height: segmentedHeight }).png().toFile(outputPath);
              applyTableSegment(detection, segmentedHeight, dpi);
            } else {
              await writeFile(outputPath, cropBuffer);
            }
          } else {
            if (detection.kind === "table") {
              const segmentedHeight = await tableSegmentHeightWithPoppler(pdfPath, detection, dpi, temporary);
              applyTableSegment(detection, segmentedHeight, dpi);
            }
            await cropWithPoppler(pdfPath, pageNumber, dpi, detection.cropPlan.bbox, outputPath);
          }
          const outputStat = await stat(outputPath);
          if (outputStat.size < 64) throw new Error("Crop output is unexpectedly small.");
          detection.outputFile = toPosix(path.relative(outputDir, outputPath));
        } catch (error) {
          detection.renderError = `Crop failed after one attempt: ${error.message}`;
        }
      }
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function manifestAsset(detection) {
  let status = "indexed_only";
  if (detection.shouldMaterialize) status = detection.outputFile ? "materialized" : "failed";
  const warnings = [...detection.cropPlan.warnings];
  if (detection.renderError) warnings.push(detection.renderError);
  return {
    id: detection.id,
    group_id: detection.id,
    kind: detection.kind,
    number: detection.number,
    label: detection.label,
    title: detection.title,
    caption_text: detection.captionText,
    brief_description: detection.briefDescription,
    display_requirement: "optional",
    source: {
      pdf_page: detection.page.number,
      page_width: round(detection.page.width),
      page_height: round(detection.page.height),
      caption_bbox: {
        x: round(detection.captionBbox.x),
        y: round(detection.captionBbox.y),
        width: round(detection.captionBbox.width),
        height: round(detection.captionBbox.height),
        unit: "pdf_point",
      },
    },
    selection: {
      priority: detection.explicitlySelected ? "selected" : "unclassified",
      materialize: detection.shouldMaterialize,
    },
    crop: {
      status,
      file: detection.outputFile ?? null,
      bbox: detection.cropPlan.bbox,
      caption_excluded: detection.cropPlan.captionExcluded,
      method: detection.shouldMaterialize ? detection.cropPlan.method : "not_materialized",
      confidence: detection.shouldMaterialize ? detection.cropPlan.confidence : "not_assessed",
      degraded_once: detection.shouldMaterialize ? detection.cropPlan.degradedOnce : false,
      warnings,
    },
  };
}

function markdownFor(manifest) {
  const lines = [
    "# 论文图表资产说明",
    "",
    `- 来源：${manifest.source_document.path}`,
    `- PDF 页数：${manifest.source_document.page_count}`,
    `- 检出：${manifest.summary.detected_count}（图 ${manifest.summary.figure_count}｜表 ${manifest.summary.table_count}）`,
    `- 已物化：${manifest.summary.materialized_count}｜仅索引：${manifest.summary.indexed_only_count}｜失败：${manifest.summary.failed_count}`,
    `- 策略：${manifest.policy.requested_materialization} → ${manifest.policy.effective_materialization}（自动阈值 ${manifest.policy.auto_materialize_limit}）`,
    "",
    "> 本文档由 `paper-assets.json` 生成。JSON 是机器真相；本 MD 只是给后续 PPT 选材的简短阅读层。裁图排除 caption，但仍应在 PPT 备注中保留来源定位。",
    "",
  ];
  if (!manifest.assets.length) {
    lines.push("未从 PDF 文本层检出 Figure/Table caption。图像型 PDF 需要上游 OCR 或人工提供定位。", "");
  }
  if (manifest.assets.length) {
    lines.push("## 全量轻索引", "", "| ID | 图表 | PDF 页 | 短标题 | 状态 |", "|---|---|---:|---|---|");
    for (const asset of manifest.assets) {
      const title = String(asset.title ?? "").replaceAll("|", "\\|").replaceAll(/\s+/g, " ").trim();
      lines.push(`| ${asset.id} | ${asset.label} | ${asset.source.pdf_page} | ${title} | ${asset.crop.status} |`);
    }
    lines.push("");
  }
  const detailedAssets = manifest.assets.filter((asset) => asset.crop.file || asset.selection?.priority === "selected");
  if (detailedAssets.length) lines.push("## 已物化候选资产", "");
  for (const asset of detailedAssets) {
    lines.push(`## ${asset.label} — ${asset.title}`, "");
    if (asset.crop.file) lines.push(`![${asset.label} ${asset.title}](<${asset.crop.file}>)`, "");
    lines.push(
      `- 简介：${asset.brief_description}`,
      `- 位置：PDF 第 ${asset.source.pdf_page} 页`,
      `- 状态：${asset.crop.status}｜置信度 ${asset.crop.confidence}｜已排除标题 ${asset.crop.caption_excluded ? "是" : "否"}`,
      `- 原始 caption：${asset.caption_text}`,
    );
    if (asset.crop.warnings.length) lines.push(`- 提醒：${asset.crop.warnings.join("；")}`);
    lines.push("");
  }
  if (manifest.policy.effective_materialization === "selected" && manifest.summary.indexed_only_count > 0) {
    lines.push("> 该论文资产数超过自动阈值。上表已覆盖全部 caption；请按主张、比较、稳健性和局限选出核心 ID，再用 `--select <asset-id> --force` 只物化候选图表。不要让模型逐张深读全部索引项。", "");
  }
  return `${lines.join("\n").trim()}\n`;
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function operationSummary(manifest, manifestPath, markdownPath) {
  return {
    manifest: manifestPath,
    markdown: markdownPath,
    detected: manifest.summary.detected_count,
    materialized: manifest.summary.materialized_count,
    indexed_only: manifest.summary.indexed_only_count,
    failed: manifest.summary.failed_count,
    low_confidence: manifest.summary.low_confidence_count,
    degraded_once: manifest.summary.degraded_once_count,
    effective_materialization: manifest.policy.effective_materialization,
  };
}

export async function extractPaperAssets(options) {
  const pdfPath = path.resolve(options.pdfPath);
  const extension = path.extname(pdfPath).toLowerCase();
  if (extension !== ".pdf") throw new Error(`Expected a .pdf source, received: ${pdfPath}`);
  const inputStat = await stat(pdfPath);
  if (!inputStat.isFile()) throw new Error(`PDF source is not a file: ${pdfPath}`);
  const outputDir = path.resolve(options.outputDir ?? path.join(path.dirname(pdfPath), `${path.basename(pdfPath, extension)}_paper_assets`));
  const manifestPath = path.join(outputDir, "paper-assets.json");
  const markdownPath = path.join(outputDir, "论文图表资产说明.md");
  if (!options.force && ((await exists(manifestPath)) || (await exists(markdownPath)))) {
    throw new Error(`Output already exists in ${outputDir}. Use --force to replace generated files.`);
  }
  const materialize = options.materialize ?? "auto";
  if (!["auto", "all", "selected", "none"].includes(materialize)) throw new Error(`Unknown materialization mode: ${materialize}`);
  const autoLimit = options.autoLimit ?? DEFAULT_AUTO_LIMIT;
  const dpi = options.dpi ?? DEFAULT_DPI;
  const selectedIds = [...new Set(options.selectedIds ?? [])];
  const pdfBytes = await readFile(pdfPath);
  let bboxXml;
  try {
    const result = await execFileAsync("pdftotext", ["-bbox-layout", "-enc", "UTF-8", pdfPath, "-"], {
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
      timeout: 120_000,
    });
    bboxXml = result.stdout;
  } catch (error) {
    throw new Error(`Cannot build the lightweight caption index with Poppler pdftotext: ${error.message}`);
  }
  const pages = parseBboxLayout(bboxXml);
  const detections = detectCaptions(pages);
  assignStableNames(detections);
  const knownIds = new Set(detections.map((item) => item.id));
  const unknownSelected = selectedIds.filter((id) => !knownIds.has(id));
  if (unknownSelected.length) throw new Error(`Unknown selected asset ID(s): ${unknownSelected.join(", ")}. Run once with --materialize none to inspect stable IDs.`);
  const effectiveMaterialization = materialize === "auto"
    ? (detections.length <= autoLimit ? "all" : "selected")
    : materialize;
  const selectedSet = new Set(selectedIds);
  for (const detection of detections) {
    const onPage = detections.filter((item) => item.page.number === detection.page.number);
    detection.cropPlan = planCrop(detection, onPage);
    detection.explicitlySelected = selectedSet.has(detection.id);
    detection.shouldMaterialize = effectiveMaterialization === "all"
      || (effectiveMaterialization === "selected" && detection.explicitlySelected);
    if (effectiveMaterialization === "none") detection.shouldMaterialize = false;
  }
  await mkdir(outputDir, { recursive: true });
  await materializeCrops(pdfPath, outputDir, detections, dpi);
  const assets = detections.map(manifestAsset);
  const summary = {
    detected_count: assets.length,
    figure_count: assets.filter((item) => item.kind === "figure").length,
    table_count: assets.filter((item) => item.kind === "table").length,
    materialized_count: assets.filter((item) => item.crop.status === "materialized").length,
    indexed_only_count: assets.filter((item) => item.crop.status === "indexed_only").length,
    failed_count: assets.filter((item) => item.crop.status === "failed").length,
    low_confidence_count: assets.filter((item) => item.crop.confidence === "low").length,
    degraded_once_count: assets.filter((item) => item.crop.degraded_once).length,
  };
  const manifest = {
    schema_version: "1.0",
    source_document: {
      path: toPosix(path.relative(outputDir, pdfPath) || path.basename(pdfPath)),
      sha256: createHash("sha256").update(pdfBytes).digest("hex"),
      page_count: pages.length,
    },
    generated_at: options.generatedAt ?? new Date().toISOString(),
    policy: {
      requested_materialization: materialize,
      effective_materialization: effectiveMaterialization,
      auto_materialize_limit: autoLimit,
      eligible_count: detections.length,
      selected_asset_ids: selectedIds,
      table_extraction: "faithful_crop_only",
    },
    summary,
    assets,
    notes: [
      "Captions are indexed from the PDF text layer; image-only papers require upstream OCR or supplied locations.",
      "Figure bodies are expected above captions and table bodies below captions; a too-small region is reversed once and marked low-confidence.",
      "Table assets remain faithful source crops. Bulk OCR and CSV reconstruction are intentionally outside this low-cost pass.",
    ],
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, markdownFor(manifest), "utf8");
  return { manifest, manifestPath, markdownPath };
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
  const [pdfArg, outputArg] = args.positional;
  if (!pdfArg) {
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  try {
    const result = await extractPaperAssets({
      pdfPath: pdfArg,
      outputDir: outputArg,
      materialize: args.materialize,
      selectedIds: args.selectedIds,
      autoLimit: args.autoLimit,
      dpi: args.dpi,
      force: args.force,
    });
    const summary = operationSummary(result.manifest, result.manifestPath, result.markdownPath);
    if (args.json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    else {
      console.log(`WROTE: ${result.manifestPath}`);
      console.log(`WROTE: ${result.markdownPath}`);
      console.log(`Detected ${summary.detected}; materialized ${summary.materialized}; indexed only ${summary.indexed_only}; failed ${summary.failed}.`);
    }
    if (summary.failed > 0) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();

export { detectCaptions, markdownFor, parseBboxLayout, planCrop };
