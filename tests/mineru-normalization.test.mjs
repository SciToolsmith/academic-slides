#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  NORMALIZER_VERSION,
  buildRawRetentionPlan,
  computeCacheKey,
  normalizeMineruDirectory,
  prepareSourceMineru,
} from "../scripts/prepare-source-mineru.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(TEST_DIR, "fixtures", "mineru-v1-v2");

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function testNonImageReferenceCannotPreserveRawText() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "academic-slides-mineru-retention-type-"));
  try {
    await fs.writeFile(path.join(temporary, "fixture_content_list.json"), JSON.stringify([{
      type: "image",
      img_path: "full.md",
      page_idx: 0,
    }]), "utf8");
    const rawTextPath = path.join(temporary, "full.md");
    await fs.writeFile(rawTextPath, "raw text must not survive through an image reference", "utf8");
    const plan = await buildRawRetentionPlan(temporary);
    assert.equal(plan.retainedFilePaths.has(rawTextPath), false);
    assert.equal(plan.record.counts.missing_referenced_images, 1);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

async function relativeFiles(root) {
  const output = [];
  async function visit(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) output.push(path.relative(root, full).split(path.sep).join("/"));
    }
  }
  await visit(root);
  return output.sort();
}

async function testNormalization() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "academic-slides-mineru-normalize-"));
  try {
    const outputDir = path.join(temporary, "normalized");
    const cacheDir = path.join(temporary, "cache");
    const result = await prepareSourceMineru({
      normalizeOnly: FIXTURE_DIR,
      outputDir,
      cacheDir,
      modelVersion: "vlm",
      language: "ch",
      enableFormula: true,
      enableTable: true,
    });
    assert.equal(result.cached, false);
    assert.equal(result.retention.policy, "minimal_required");
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
    assert.equal(record.retention.policy, "minimal_required");
    assert.equal(record.retention.scope, "managed_cache_snapshot");
    assert.equal(record.retention.full_raw_opt_in, false);
    assert.equal(record.retention.source_input_modified, false);
    assert.equal(record.retention.standardized_outputs_only_for_model, true);
    assert.ok(record.retention.counts.removed_files > 0);
    assert.equal(JSON.stringify(record).includes(FIXTURE_DIR), false);
    assert.equal(JSON.stringify(record).includes(temporary), false);
    assert.equal("root" in record.mineru_inputs, false);
    assert.equal("content_list_v1" in record.mineru_inputs, false);

    const managedRawDir = path.join(cacheDir, result.cacheKey, "raw");
    assert.deepEqual(await relativeFiles(managedRawDir), [
      "fixture_content_list.json",
      "fixture_content_list_v2.json",
      "images/formula.jpg",
      "images/panel-left.jpg",
      "images/panel-right.jpg",
      "images/parameters.jpg",
      "layout.json",
    ]);
    assert.equal(await fs.access(path.join(FIXTURE_DIR, "full.md")).then(() => true).catch(() => false), true, "normalize-only input must remain untouched");

    const second = await prepareSourceMineru({ normalizeOnly: FIXTURE_DIR, outputDir, cacheDir, modelVersion: "vlm" });
    assert.equal(second.cached, true);
    await fs.writeFile(path.join(outputDir, "blocks.ndjson"), "", "utf8");
    const repaired = await prepareSourceMineru({ normalizeOnly: FIXTURE_DIR, outputDir, cacheDir, modelVersion: "vlm" });
    assert.equal(repaired.cached, true);
    assert.ok((await fs.stat(path.join(outputDir, "blocks.ndjson"))).size > 0);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

async function testFullRawOptIn() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "academic-slides-mineru-full-raw-"));
  try {
    const outputDir = path.join(temporary, "normalized");
    const result = await prepareSourceMineru({
      normalizeOnly: FIXTURE_DIR,
      outputDir,
      modelVersion: "vlm",
      retainFullRaw: true,
    });
    const record = await readJson(path.join(outputDir, "extraction-record.json"));
    assert.equal(record.retention.policy, "full_raw_opt_in");
    assert.equal(record.retention.scope, "external_full_raw_opt_in");
    assert.equal(record.retention.full_raw_opt_in, true);
    assert.equal(record.retention.counts.removed_files, 0);
    assert.equal(record.retention.counts.before_files, record.retention.counts.retained_files);
    assert.equal(result.cacheKey, record.cache_key);
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

    const retainedOutput = path.join(temporary, "retained-normalized");
    const cacheDir = path.join(temporary, "cache");
    const retained = await prepareSourceMineru({
      normalizeOnly: rawDir,
      source: path.join(rawDir, "sample_origin.pdf"),
      outputDir: retainedOutput,
      cacheDir,
      modelVersion: "vlm",
    });
    const managedFiles = await relativeFiles(path.join(cacheDir, retained.cacheKey, "raw"));
    assert.equal(managedFiles.includes("fixture_content_list_v2.json"), false, "malformed optional v2 must not enter the minimal raw snapshot");
    const retainedRecord = await readJson(path.join(retainedOutput, "extraction-record.json"));
    assert.equal(retainedRecord.mineru_inputs.content_list_v2_used, false);
    assert.equal(retainedRecord.retention.categories.content_list_v2, 0);
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
  assert.notEqual(computeCacheKey({ ...common, retainFullRaw: true }), baseline);
  assert.notEqual(computeCacheKey({ ...common, normalizerVersion: "different" }), baseline);
}

await testNormalization();
await testV2Tolerance();
await testFullRawOptIn();
await testNonImageReferenceCannotPreserveRawText();
testCacheIdentity();
console.log("PASS mineru-normalization: v1 normalization, v2 enhancement tolerance, page mapping, candidates, adjacency, and cache identity are deterministic.");
