#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  NORMALIZER_VERSION,
  computeCacheKey,
  normalizeMineruDirectory,
  prepareSourceMineru,
} from "../scripts/prepare-source-mineru.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(TEST_DIR, "fixtures", "mineru-v1-v2");

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function testNormalization() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "academic-slides-mineru-normalize-"));
  try {
    const outputDir = path.join(temporary, "normalized");
    const result = await prepareSourceMineru({
      normalizeOnly: FIXTURE_DIR,
      outputDir,
      modelVersion: "vlm",
      language: "ch",
      enableFormula: true,
      enableTable: true,
    });
    assert.equal(result.cached, false);
    const expectedFiles = [
      "document-index.json",
      "blocks.ndjson",
      "page-map.json",
      "figure-candidates.json",
      "table-candidates.json",
      "formula-candidates.json",
      "extraction-record.json",
    ];
    for (const filename of expectedFiles) assert.equal((await fs.stat(path.join(outputDir, filename))).isFile(), true);

    const document = await readJson(path.join(outputDir, "document-index.json"));
    assert.equal(document.normalizer_version, NORMALIZER_VERSION);
    assert.equal("path" in document.source, false, "the compact model-facing index must not persist a local absolute source path");
    assert.equal(document.source.page_count, 3);
    assert.equal(document.counts.blocks, 9);
    assert.equal(document.counts.figures, 2);
    assert.equal(document.counts.tables, 1);
    assert.equal(document.counts.formulas, 1);
    assert.ok(document.headings.some((heading) => heading.page === 1 && heading.level === 1 && heading.source === "content_list_v2"));
    assert.ok(document.headings.some((heading) => heading.page === 2 && heading.level === 2));

    const blocks = (await fs.readFile(path.join(outputDir, "blocks.ndjson"), "utf8"))
      .trim().split("\n").map(JSON.parse);
    assert.equal(blocks[0].page, blocks[0].page_idx + 1);
    assert.equal(blocks.find((block) => block.type === "formula").asset_ref, "images/formula.jpg");
    assert.equal(blocks.find((block) => block.type === "formula").latex, String.raw`G(s)=\frac{1}{s+1}\tag{2.1}`);
    const pageMap = await readJson(path.join(outputDir, "page-map.json"));
    assert.equal(pageMap.pages[2].printed_page_label, "3");

    const figures = (await readJson(path.join(outputDir, "figure-candidates.json"))).candidates;
    assert.deepEqual(figures[0].bbox, [100, 250, 470, 600]);
    assert.equal(figures[0].panel_group_id, figures[1].panel_group_id);
    assert.ok(figures[0].panel_group_id);
    assert.equal(figures[0].adjacent[0].candidate_id, figures[1].candidate_id);
    assert.equal(figures[0].adjacent[0].relation, "right");
    const formulas = (await readJson(path.join(outputDir, "formula-candidates.json"))).candidates;
    assert.equal(formulas[0].equation_label, "2.1");

    const record = await readJson(path.join(outputDir, "extraction-record.json"));
    assert.equal(record.status, "complete");
    assert.deepEqual(record.parameters.extra_formats, []);
    assert.equal(record.mineru_inputs.v1_is_authoritative, true);
    assert.equal(record.mineru_inputs.v2_is_optional_enhancement, true);
    assert.equal(record.cache_key, result.cacheKey);

    const second = await prepareSourceMineru({ normalizeOnly: FIXTURE_DIR, outputDir, modelVersion: "vlm" });
    assert.equal(second.cached, true);
    await fs.writeFile(path.join(outputDir, "blocks.ndjson"), "", "utf8");
    const repaired = await prepareSourceMineru({ normalizeOnly: FIXTURE_DIR, outputDir, modelVersion: "vlm" });
    assert.equal(repaired.cached, false);
    assert.ok((await fs.stat(path.join(outputDir, "blocks.ndjson"))).size > 0);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

async function testV2Tolerance() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "academic-slides-mineru-v2-tolerance-"));
  try {
    const rawDir = path.join(temporary, "raw");
    const outputDir = path.join(temporary, "normalized");
    await fs.cp(FIXTURE_DIR, rawDir, { recursive: true });
    await fs.writeFile(path.join(rawDir, "fixture_content_list_v2.json"), "{ malformed", "utf8");
    const result = await normalizeMineruDirectory({ inputDir: rawDir, outputDir, modelVersion: "vlm" });
    assert.ok(result.warnings.some((warning) => warning.includes("content_list_v2")));
    const document = await readJson(path.join(outputDir, "document-index.json"));
    assert.equal(document.counts.blocks, 9);
    assert.equal(document.counts.formulas, 1);
    assert.ok(document.headings.some((heading) => heading.text === "2.1 控制模型" && heading.source === "v1_heuristic"));
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

function testCacheIdentity() {
  const common = {
    sourceSha256: "a".repeat(64),
    modelVersion: "vlm",
    language: "ch",
    isOcr: false,
    enableFormula: true,
    enableTable: true,
    pageRanges: null,
  };
  const baseline = computeCacheKey(common);
  assert.notEqual(computeCacheKey({ ...common, modelVersion: "pipeline" }), baseline);
  assert.notEqual(computeCacheKey({ ...common, enableFormula: false }), baseline);
  assert.notEqual(computeCacheKey({ ...common, pageRanges: "1-2" }), baseline);
  assert.notEqual(computeCacheKey({ ...common, normalizerVersion: "different" }), baseline);
}

await testNormalization();
await testV2Tolerance();
testCacheIdentity();
console.log("PASS mineru-normalization: v1 normalization, v2 enhancement tolerance, page mapping, candidates, adjacency, and cache identity are deterministic.");
