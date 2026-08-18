#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const CANDIDATE_FILES = ["figure-candidates.json", "table-candidates.json", "formula-candidates.json"];

function usage() {
  return [
    "Usage: node retrieve-source-evidence.mjs --source-dir <normalized-dir> [selectors] [options]",
    "",
    "Selectors:",
    "  --pages <spec>           PDF pages, for example 3,7-10.",
    "  --query <text>           Case-insensitive substring search across text, captions, tables, and formulas.",
    "  --types <csv>            title,text,reference,figure,table,formula,header,footer,page_number,other.",
    "  --candidate <id>         Retrieve one figure/table/formula candidate and its adjacent panels.",
    "",
    "Options:",
    "  --context-pages <n>      Add n PDF pages before and after selected pages (default: 0).",
    "  --max-blocks <n>         Maximum returned blocks (default: 40).",
    "  --max-chars <n>          Approximate JSON character budget for blocks (default: 20000).",
    "  --pretty                 Pretty-print JSON.",
    "  -h, --help               Show this help.",
    "",
    "With no selector the command returns only document-index.json, keeping the first read compact.",
  ].join("\n");
}

function requiredValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value.`);
  return value;
}

export function parseArgs(argv) {
  const result = { contextPages: 0, maxBlocks: 40, maxChars: 20_000, pretty: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "-h" || token === "--help") result.help = true;
    else if (token === "--pretty") result.pretty = true;
    else if (["--source-dir", "--pages", "--query", "--types", "--candidate", "--context-pages", "--max-blocks", "--max-chars"].includes(token)) {
      const value = requiredValue(argv, index, token);
      index += 1;
      result[token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    } else throw new Error(`Unknown option: ${token}`);
  }
  for (const key of ["contextPages", "maxBlocks", "maxChars"]) {
    result[key] = Number(result[key]);
    const minimum = key === "contextPages" ? 0 : 1;
    if (!Number.isInteger(result[key]) || result[key] < minimum) throw new Error(`${key} must be an integer >= ${minimum}.`);
  }
  return result;
}

export function parsePageSpec(value) {
  if (!value) return new Set();
  const pages = new Set();
  for (const raw of String(value).split(",")) {
    const part = raw.trim();
    if (!part) continue;
    const match = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!match) throw new Error(`Invalid page selection: ${part}`);
    const start = Number(match[1]);
    const end = Number(match[2] ?? match[1]);
    if (start < 1 || end < start || end - start > 10_000) throw new Error(`Invalid page range: ${part}`);
    for (let page = start; page <= end; page += 1) pages.add(page);
  }
  return pages;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function readBlocks(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  return text.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`Invalid blocks.ndjson record at line ${index + 1}.`);
    }
  });
}

async function readCandidates(sourceDir) {
  const output = [];
  for (const filename of CANDIDATE_FILES) {
    try {
      const data = await readJson(path.join(sourceDir, filename));
      if (Array.isArray(data?.candidates)) output.push(...data.candidates);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return output;
}

function searchableText(block) {
  return [
    block.text,
    ...(Array.isArray(block.caption) ? block.caption : []),
    ...(Array.isArray(block.footnote) ? block.footnote : []),
    block.table_html,
    block.latex,
  ].filter(Boolean).join("\n");
}

function queryScore(block, query) {
  if (!query) return 0;
  const fold = (value) => String(value).normalize("NFKC").toLocaleLowerCase();
  const haystack = fold(searchableText(block));
  const foldedQuery = fold(query);
  const variants = new Map([[foldedQuery, 4]]);
  const numberedReference = /(?:图|表|式)?\s*\(?\s*(\d+(?:[-.]\d+)+)\s*\)?/u.exec(foldedQuery);
  if (numberedReference?.[1] && numberedReference[1] !== foldedQuery) variants.set(numberedReference[1], 1);
  let score = 0;
  for (const [needle, weight] of variants) {
    let offset = 0;
    while (needle && (offset = haystack.indexOf(needle, offset)) >= 0) {
      score += weight;
      offset += Math.max(1, needle.length);
    }
  }
  return score;
}

function addContextPages(pages, context, maximumPage) {
  if (!context || pages.size === 0) return pages;
  const expanded = new Set(pages);
  for (const page of pages) {
    for (let candidate = Math.max(1, page - context); candidate <= Math.min(maximumPage, page + context); candidate += 1) expanded.add(candidate);
  }
  return expanded;
}

function boundedBlocks(blocks, maxBlocks, maxChars) {
  const selected = [];
  let characters = 2;
  let characterTruncated = false;
  for (const block of blocks) {
    if (selected.length >= maxBlocks) break;
    const encoded = JSON.stringify(block);
    if (characters + encoded.length > maxChars) {
      characterTruncated = true;
      break;
    }
    selected.push(block);
    characters += encoded.length + 1;
  }
  return {
    blocks: selected,
    truncated: selected.length < blocks.length || characterTruncated,
    returned_characters_approx: characters,
  };
}

export async function retrieveEvidence(options) {
  if (!options.sourceDir) throw new Error("--source-dir is required.");
  const sourceDir = path.resolve(options.sourceDir);
  const document = await readJson(path.join(sourceDir, "document-index.json"));
  const hasSelector = Boolean(options.pages || options.query || options.types || options.candidate);
  if (!hasSelector) {
    return {
      schema_version: "1.0",
      mode: "index",
      document,
      guidance: "Select pages, a query, types, or a candidate id to hydrate evidence blocks.",
    };
  }
  const [allBlocks, allCandidates] = await Promise.all([
    readBlocks(path.join(sourceDir, "blocks.ndjson")),
    readCandidates(sourceDir),
  ]);
  const requestedPages = parsePageSpec(options.pages);
  const maximumPage = Number(document?.source?.page_count ?? allBlocks.at(-1)?.page ?? 0);
  let pages = addContextPages(requestedPages, Number(options.contextPages ?? 0), maximumPage);
  const types = new Set(String(options.types ?? "").split(",").map((item) => item.trim()).filter(Boolean));
  const candidate = options.candidate ? allCandidates.find((item) => item.candidate_id === options.candidate) : null;
  if (options.candidate && !candidate) throw new Error(`Unknown candidate id: ${options.candidate}`);
  const candidateIds = new Set();
  const candidateBlockIds = new Set();
  if (candidate) {
    candidateIds.add(candidate.candidate_id);
    candidateBlockIds.add(candidate.block_id);
    for (const adjacent of candidate.adjacent ?? []) {
      candidateIds.add(adjacent.candidate_id);
      const neighbor = allCandidates.find((item) => item.candidate_id === adjacent.candidate_id);
      if (neighbor) candidateBlockIds.add(neighbor.block_id);
    }
    pages = addContextPages(new Set([candidate.page]), Number(options.contextPages ?? 0), maximumPage);
  }
  const scored = [];
  for (const block of allBlocks) {
    if (pages.size && !pages.has(block.page)) continue;
    if (types.size && !types.has(block.type)) continue;
    if (candidate && !candidateBlockIds.has(block.block_id) && Number(options.contextPages ?? 0) === 0) continue;
    const score = queryScore(block, options.query);
    if (options.query && score === 0) continue;
    scored.push({ block, score });
  }
  scored.sort((left, right) => right.score - left.score || left.block.page - right.block.page || left.block.order - right.block.order);
  const bounded = boundedBlocks(scored.map((entry) => entry.block), Number(options.maxBlocks ?? 40), Number(options.maxChars ?? 20_000));
  const returnedBlockIds = new Set(bounded.blocks.map((block) => block.block_id));
  const candidates = allCandidates.filter((item) => candidateIds.has(item.candidate_id) || returnedBlockIds.has(item.block_id));
  return {
    schema_version: "1.0",
    mode: "evidence",
    source: document.source,
    selection: {
      requested_pages: [...requestedPages].sort((left, right) => left - right),
      hydrated_pages: [...pages].sort((left, right) => left - right),
      query: options.query ?? null,
      types: [...types],
      candidate_id: options.candidate ?? null,
      context_pages: Number(options.contextPages ?? 0),
    },
    result: {
      matched_blocks: scored.length,
      returned_blocks: bounded.blocks.length,
      truncated: bounded.truncated,
      returned_characters_approx: bounded.returned_characters_approx,
    },
    blocks: bounded.blocks,
    candidates,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const result = await retrieveEvidence(options);
  console.log(JSON.stringify(result, null, options.pretty ? 2 : 0));
}

if (path.resolve(process.argv[1] ?? "") === path.resolve(SCRIPT_PATH)) {
  main().catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  });
}
