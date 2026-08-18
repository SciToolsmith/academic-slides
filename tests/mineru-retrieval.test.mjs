#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareSourceMineru } from "../scripts/prepare-source-mineru.mjs";
import { parsePageSpec, retrieveEvidence } from "../scripts/retrieve-source-evidence.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(TEST_DIR, "fixtures", "mineru-v1-v2");

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "academic-slides-mineru-retrieve-"));
try {
  const sourceDir = path.join(temporary, "normalized");
  await prepareSourceMineru({ normalizeOnly: FIXTURE_DIR, outputDir: sourceDir, modelVersion: "vlm" });

  assert.deepEqual([...parsePageSpec("1,3-4")], [1, 3, 4]);
  assert.throws(() => parsePageSpec("4-2"), /Invalid page range/);

  const indexOnly = await retrieveEvidence({ sourceDir, maxBlocks: 40, maxChars: 20_000 });
  assert.equal(indexOnly.mode, "index");
  assert.equal("blocks" in indexOnly, false);

  const query = await retrieveEvidence({ sourceDir, query: "稳定性", maxBlocks: 10, maxChars: 20_000, contextPages: 0 });
  assert.equal(query.mode, "evidence");
  assert.equal(query.result.returned_blocks, 2);
  assert.ok(query.blocks.every((block) => block.page === 1));

  const fullWidthQuery = await retrieveEvidence({ sourceDir, query: "式（2.1）", maxBlocks: 10, maxChars: 20_000, contextPages: 0 });
  assert.ok(fullWidthQuery.blocks.some((block) => block.type === "formula"));

  const figures = await retrieveEvidence({ sourceDir, pages: "1", types: "figure", maxBlocks: 10, maxChars: 20_000, contextPages: 0 });
  assert.equal(figures.blocks.length, 2);
  assert.equal(figures.candidates.length, 2);

  const candidateId = figures.candidates[0].candidate_id;
  const candidate = await retrieveEvidence({ sourceDir, candidate: candidateId, maxBlocks: 10, maxChars: 20_000, contextPages: 0 });
  assert.equal(candidate.blocks.length, 2);
  assert.ok(candidate.candidates.some((item) => item.candidate_id === candidateId));
  assert.equal(candidate.candidates.length, 2);

  const withContext = await retrieveEvidence({ sourceDir, pages: "2", contextPages: 1, maxBlocks: 30, maxChars: 20_000 });
  assert.deepEqual(withContext.selection.hydrated_pages, [1, 2, 3]);

  const bounded = await retrieveEvidence({ sourceDir, pages: "1-3", contextPages: 0, maxBlocks: 1, maxChars: 20_000 });
  assert.equal(bounded.blocks.length, 1);
  assert.equal(bounded.result.truncated, true);
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}

console.log("PASS mineru-retrieval: compact index-first and bounded on-demand page/query/candidate hydration work.");
