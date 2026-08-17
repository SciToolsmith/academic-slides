#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildProject } from "../scripts/build-project.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(TEST_DIR, "..");
const SAMPLE_SPEC = path.join(SKILL_DIR, "assets", "final-defense-universal", "sample-deck-spec.json");

function galleryFixture(sample) {
  const slides = sample.slides.slice(0, 3).map((slide, index) => ({ ...structuredClone(slide), order: index + 1 }));
  const estimatedSeconds = slides.reduce((sum, slide) => sum + Number(slide.speaker_notes?.estimated_seconds ?? 0), 0);
  return {
    ...sample,
    artifact_purpose: "layout_gallery",
    project_id: "build-project-layout-gallery",
    title: "内部构建器布局库",
    timing: {
      ...sample.timing,
      estimated_seconds: estimatedSeconds,
      target_seconds: estimatedSeconds,
      target_slide_count: 3,
    },
    assets: [{ id: "cache-fixture", path: "assets/figure.png", type: "figure", alt_text: "缓存签名测试素材" }],
    slides,
    claim_evidence_map: [],
  };
}

async function main() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "academic-slides-project-cache-"));
  try {
    const inputDir = path.join(temporary, "input");
    const outputDir = path.join(temporary, "output");
    await fs.mkdir(path.join(inputDir, "assets"), { recursive: true });
    await fs.writeFile(path.join(inputDir, "assets", "figure.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const sample = JSON.parse(await fs.readFile(SAMPLE_SPEC, "utf8"));
    const specPath = path.join(inputDir, "deck-spec.json");
    const fixture = galleryFixture(sample);
    await fs.writeFile(specPath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");

    const calls = { deck: 0, word: 0, builder: 0 };
    const builders = {
      async buildDeck(args) {
        calls.deck += 1;
        await fs.writeFile(args.output, `pptx-${calls.deck}`);
        if (args.previewDir) {
          await fs.mkdir(args.previewDir, { recursive: true });
          await fs.writeFile(path.join(args.previewDir, "slide-01.png"), `preview-${calls.deck}`);
        }
        return { output: args.output, slideCount: 3 };
      },
      async buildSpeakerScriptFromFile(_spec, output) {
        calls.word += 1;
        await fs.writeFile(output, `docx-${calls.word}`);
        return { output, slideCount: 3 };
      },
      async createProjectBuilder(args) {
        calls.builder += 1;
        await fs.writeFile(args.output, `mjs-${calls.builder}`);
        return { output: args.output };
      },
    };
    const options = { spec: specPath, outputDir, stem: "缓存测试_毕业答辩", theme: "blue" };

    const first = await buildProject(options, builders);
    assert.equal(first.cached, false);
    assert.deepEqual(calls, { deck: 1, word: 1, builder: 1 });
    const firstMtimes = Object.fromEntries(await Promise.all(Object.entries(first.outputs).map(async ([key, filePath]) => [key, (await fs.stat(filePath)).mtimeMs])));

    const second = await buildProject(options, builders);
    assert.equal(second.cached, true);
    assert.equal(second.signature, first.signature);
    assert.deepEqual(calls, { deck: 1, word: 1, builder: 1 });
    const secondMtimes = Object.fromEntries(await Promise.all(Object.entries(second.outputs).map(async ([key, filePath]) => [key, (await fs.stat(filePath)).mtimeMs])));
    assert.deepEqual(secondMtimes, firstMtimes);

    const rendered = await buildProject({ ...options, render: true }, builders);
    assert.equal(rendered.cached, false);
    assert.deepEqual(calls, { deck: 2, word: 2, builder: 2 });
    assert.ok((await fs.readdir(rendered.previewDir)).includes("slide-01.png"));
    const renderedAgain = await buildProject({ ...options, render: true }, builders);
    assert.equal(renderedAgain.cached, true);
    assert.deepEqual(calls, { deck: 2, word: 2, builder: 2 });

    fixture.title = "修改后的内部构建器布局库";
    await fs.writeFile(specPath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
    const publishedBeforeFailure = Object.fromEntries(await Promise.all(Object.entries(rendered.outputs).map(async ([key, filePath]) => [key, await fs.readFile(filePath, "utf8")])));
    await assert.rejects(() => buildProject(options, {
      async createProjectBuilder(args) {
        await fs.writeFile(args.output, "candidate-mjs");
        return { output: args.output };
      },
      async buildDeck() {
        throw new Error("intentional build failure");
      },
      async buildSpeakerScriptFromFile() {
        throw new Error("word builder must not run after a deck failure");
      },
    }), /intentional build failure/);
    for (const [key, filePath] of Object.entries(rendered.outputs)) {
      assert.equal(await fs.readFile(filePath, "utf8"), publishedBeforeFailure[key]);
    }
    assert.equal(JSON.parse(await fs.readFile(path.join(outputDir, ".academic-slides-build-state.json"), "utf8")).signature, first.signature);
    assert.equal((await fs.readdir(outputDir)).some((name) => /^\.academic-slides-build-\d+-/.test(name)), false);

    const third = await buildProject(options, builders);
    assert.equal(third.cached, false);
    assert.notEqual(third.signature, first.signature);
    assert.deepEqual(calls, { deck: 3, word: 3, builder: 3 });
    assert.equal(await fs.access(rendered.previewDir).then(() => true).catch(() => false), false);
    assert.ok(JSON.parse(await fs.readFile(path.join(outputDir, ".academic-slides-build-state.json"), "utf8")).signature);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
  console.log("build-project-cache.test.mjs: PASS");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
