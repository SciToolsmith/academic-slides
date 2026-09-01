#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildProject,
  computeProjectSignature,
  projectLockPath,
  publishArtifactsTransactionally,
} from "../scripts/build-project.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(TEST_DIR, "..");
const SAMPLE_SPEC = path.join(SKILL_DIR, "assets", "group-meeting-literature-universal", "sample-deck-spec.json");

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
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "paper-club-ppt-project-cache-"));
  const originalRuntimeModules = process.env.RUNTIME_NODE_MODULES;
  const originalCjkFont = process.env.PAPER_CLUB_PPT_CJK_FONT;
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
    const options = { spec: specPath, outputDir, stem: "缓存测试_组会汇报", theme: "blue" };

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

    const signatureBeforeAssetEdit = await computeProjectSignature({ spec: specPath, stem: options.stem, theme: options.theme });
    await fs.writeFile(path.join(inputDir, "assets", "figure.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]));
    const signatureAfterAssetEdit = await computeProjectSignature({ spec: specPath, stem: options.stem, theme: options.theme });
    assert.notEqual(signatureAfterAssetEdit.signature, signatureBeforeAssetEdit.signature);

    const directAssetPath = path.join(inputDir, "assets", "direct-formula.svg");
    const directSpecPath = path.join(inputDir, "direct-asset-spec.json");
    await fs.writeFile(directAssetPath, "<svg>one</svg>");
    await fs.writeFile(directSpecPath, JSON.stringify({
      profile: "group_meeting_literature",
      slides: [{ formula: { asset_ref: "assets/direct-formula.svg" } }],
    }));
    const directBefore = await computeProjectSignature({ spec: directSpecPath, stem: options.stem, theme: options.theme });
    await fs.writeFile(directAssetPath, "<svg>two</svg>");
    const directAfter = await computeProjectSignature({ spec: directSpecPath, stem: options.stem, theme: options.theme });
    assert.notEqual(directAfter.signature, directBefore.signature);

    const sourceBackedPath = path.join(inputDir, "assets", "source-backed.png");
    const unusedSourcePath = path.join(inputDir, "assets", "unused-source.pdf");
    const sourceBackedSpecPath = path.join(inputDir, "source-backed-spec.json");
    await fs.writeFile(sourceBackedPath, "source-one");
    await fs.writeFile(unusedSourcePath, "unused-one");
    await fs.writeFile(sourceBackedSpecPath, JSON.stringify({
      profile: "group_meeting_literature",
      sources: [
        { id: "source-figure", type: "paper_figure", path: "assets/source-backed.png" },
        { id: "unused-paper", type: "paper_text", path: "assets/unused-source.pdf" },
      ],
      slides: [{ visuals: [{ asset_ref: "source-figure" }] }],
    }));
    const sourceBackedBefore = await computeProjectSignature({ spec: sourceBackedSpecPath, stem: options.stem, theme: options.theme });
    await fs.writeFile(unusedSourcePath, "unused-two");
    const afterUnusedSourceEdit = await computeProjectSignature({ spec: sourceBackedSpecPath, stem: options.stem, theme: options.theme });
    assert.equal(afterUnusedSourceEdit.signature, sourceBackedBefore.signature);
    await fs.writeFile(sourceBackedPath, "source-two");
    const afterUsedSourceEdit = await computeProjectSignature({ spec: sourceBackedSpecPath, stem: options.stem, theme: options.theme });
    assert.notEqual(afterUsedSourceEdit.signature, afterUnusedSourceEdit.signature);

    const runtimeDir = path.join(temporary, "runtime-node-modules");
    const runtimeDocxDir = path.join(runtimeDir, "docx");
    await fs.mkdir(path.join(runtimeDocxDir, "dist"), { recursive: true });
    await fs.writeFile(path.join(runtimeDocxDir, "package.json"), JSON.stringify({ name: "docx", version: "1.0.0" }));
    await fs.writeFile(path.join(runtimeDocxDir, "dist", "index.mjs"), "export const runtime = 1;\n");
    process.env.RUNTIME_NODE_MODULES = runtimeDir;
    process.env.PAPER_CLUB_PPT_CJK_FONT = "Cache Test Font A";
    const runtimeBefore = await computeProjectSignature({ spec: directSpecPath, stem: options.stem, theme: options.theme });
    await fs.writeFile(path.join(runtimeDocxDir, "package.json"), JSON.stringify({ name: "docx", version: "2.0.0" }));
    const afterRuntimeManifestEdit = await computeProjectSignature({ spec: directSpecPath, stem: options.stem, theme: options.theme });
    assert.notEqual(afterRuntimeManifestEdit.signature, runtimeBefore.signature);
    process.env.PAPER_CLUB_PPT_CJK_FONT = "Cache Test Font B";
    const afterFontEnvironmentEdit = await computeProjectSignature({ spec: directSpecPath, stem: options.stem, theme: options.theme });
    assert.notEqual(afterFontEnvironmentEdit.signature, afterRuntimeManifestEdit.signature);
    if (originalRuntimeModules === undefined) delete process.env.RUNTIME_NODE_MODULES;
    else process.env.RUNTIME_NODE_MODULES = originalRuntimeModules;
    if (originalCjkFont === undefined) delete process.env.PAPER_CLUB_PPT_CJK_FONT;
    else process.env.PAPER_CLUB_PPT_CJK_FONT = originalCjkFont;

    const rendered = await buildProject({ ...options, render: true }, builders);
    assert.equal(rendered.cached, false);
    assert.deepEqual(calls, { deck: 2, word: 2, builder: 2 });
    assert.ok((await fs.readdir(rendered.previewDir)).includes("slide-01.png"));
    const renderedAgain = await buildProject({ ...options, render: true }, builders);
    assert.equal(renderedAgain.cached, true);
    assert.deepEqual(calls, { deck: 2, word: 2, builder: 2 });

    const renderedPptxBytes = await fs.readFile(rendered.outputs.pptx);
    await fs.writeFile(rendered.outputs.pptx, Buffer.alloc(renderedPptxBytes.length, 0x58));
    const repairedOutput = await buildProject({ ...options, render: true }, builders);
    assert.equal(repairedOutput.cached, false);
    assert.deepEqual(calls, { deck: 3, word: 3, builder: 3 });
    assert.notEqual((await fs.stat(repairedOutput.outputs.pptx)).size, 0);

    const previewPath = path.join(repairedOutput.previewDir, "slide-01.png");
    const previewBytes = await fs.readFile(previewPath);
    await fs.writeFile(previewPath, Buffer.alloc(previewBytes.length, 0x59));
    const repairedPreview = await buildProject({ ...options, render: true }, builders);
    assert.equal(repairedPreview.cached, false);
    assert.deepEqual(calls, { deck: 4, word: 4, builder: 4 });
    await fs.rm(path.join(repairedPreview.previewDir, "slide-01.png"));
    await fs.writeFile(path.join(repairedPreview.previewDir, "residual.tmp"), "stale");
    const repairedPreviewManifest = await buildProject({ ...options, render: true }, builders);
    assert.equal(repairedPreviewManifest.cached, false);
    assert.deepEqual(calls, { deck: 5, word: 5, builder: 5 });
    assert.equal((await fs.readdir(repairedPreviewManifest.previewDir)).includes("residual.tmp"), false);

    fixture.title = "修改后的内部构建器布局库";
    await fs.writeFile(specPath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
    const publishedBeforeFailure = Object.fromEntries(await Promise.all(Object.entries(repairedPreviewManifest.outputs).map(async ([key, filePath]) => [key, await fs.readFile(filePath, "utf8")])));
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
    for (const [key, filePath] of Object.entries(repairedPreviewManifest.outputs)) {
      assert.equal(await fs.readFile(filePath, "utf8"), publishedBeforeFailure[key]);
    }
    assert.equal(JSON.parse(await fs.readFile(path.join(outputDir, ".paper-club-ppt-build-state.json"), "utf8")).signature, repairedPreviewManifest.signature);
    assert.equal((await fs.readdir(outputDir)).some((name) => /^\.paper-club-ppt-build-\d+-/.test(name)), false);
    assert.equal(await fs.access(projectLockPath(outputDir, options.stem)).then(() => true).catch(() => false), false);

    const third = await buildProject(options, builders);
    assert.equal(third.cached, false);
    assert.notEqual(third.signature, first.signature);
    assert.deepEqual(calls, { deck: 6, word: 6, builder: 6 });
    assert.equal(await fs.access(repairedPreviewManifest.previewDir).then(() => true).catch(() => false), false);
    assert.ok(JSON.parse(await fs.readFile(path.join(outputDir, ".paper-club-ppt-build-state.json"), "utf8")).signature);

    const concurrentInputDir = path.join(temporary, "concurrent-input");
    const concurrentOutputDir = path.join(temporary, "concurrent-output");
    await fs.mkdir(concurrentInputDir, { recursive: true });
    const concurrentSpecA = path.join(concurrentInputDir, "a.json");
    const concurrentSpecB = path.join(concurrentInputDir, "b.json");
    await fs.writeFile(concurrentSpecA, JSON.stringify({ profile: "group_meeting_literature", tag: "A", slides: [] }));
    await fs.writeFile(concurrentSpecB, JSON.stringify({ profile: "group_meeting_literature", tag: "B", slides: [] }));
    let activeDeckBuilds = 0;
    let maximumActiveDeckBuilds = 0;
    const concurrentBuilders = {
      async createProjectBuilder(args) {
        const tag = JSON.parse(await fs.readFile(args.spec, "utf8")).tag;
        await fs.writeFile(args.output, `mjs-${tag}`);
        return { output: args.output };
      },
      async buildDeck(args) {
        activeDeckBuilds += 1;
        maximumActiveDeckBuilds = Math.max(maximumActiveDeckBuilds, activeDeckBuilds);
        try {
          await new Promise((resolve) => setTimeout(resolve, 25));
          const tag = JSON.parse(await fs.readFile(args.spec, "utf8")).tag;
          await fs.writeFile(args.output, `ppt-${tag}`);
          return { output: args.output };
        } finally {
          activeDeckBuilds -= 1;
        }
      },
      async buildSpeakerScriptFromFile(spec, output) {
        const tag = JSON.parse(await fs.readFile(spec, "utf8")).tag;
        await fs.writeFile(output, `doc-${tag}`);
        return { output };
      },
    };
    const concurrentStem = "并发缓存测试_组会汇报";
    const concurrentOptions = { outputDir: concurrentOutputDir, stem: concurrentStem, theme: "blue" };
    const [concurrentA, concurrentB] = await Promise.all([
      buildProject({ ...concurrentOptions, spec: concurrentSpecA }, concurrentBuilders),
      buildProject({ ...concurrentOptions, spec: concurrentSpecB }, concurrentBuilders),
    ]);
    assert.equal(maximumActiveDeckBuilds, 1);
    const concurrentState = JSON.parse(await fs.readFile(path.join(concurrentOutputDir, ".paper-club-ppt-build-state.json"), "utf8"));
    const concurrentSignatureA = (await computeProjectSignature({ spec: concurrentSpecA, stem: concurrentStem, theme: "blue" })).signature;
    const concurrentSignatureB = (await computeProjectSignature({ spec: concurrentSpecB, stem: concurrentStem, theme: "blue" })).signature;
    const finalTag = concurrentState.signature === concurrentSignatureA ? "A" : concurrentState.signature === concurrentSignatureB ? "B" : null;
    assert.ok(finalTag);
    assert.equal(await fs.readFile(path.join(concurrentOutputDir, `${concurrentStem}.pptx`), "utf8"), `ppt-${finalTag}`);
    assert.equal(await fs.readFile(path.join(concurrentOutputDir, `${concurrentStem}_发言稿.docx`), "utf8"), `doc-${finalTag}`);
    assert.equal(await fs.readFile(path.join(concurrentOutputDir, `${concurrentStem}.mjs`), "utf8"), `mjs-${finalTag}`);
    assert.equal(concurrentA.ok && concurrentB.ok, true);
    assert.equal(await fs.access(projectLockPath(concurrentOutputDir, concurrentStem)).then(() => true).catch(() => false), false);

    const staleOutputDir = path.join(temporary, "stale-lock-output");
    await fs.mkdir(staleOutputDir, { recursive: true });
    const staleLock = projectLockPath(staleOutputDir, concurrentStem);
    await fs.mkdir(staleLock);
    const staleOwnerPath = path.join(staleLock, "owner.json");
    await fs.writeFile(staleOwnerPath, `${JSON.stringify({ schema_version: 1 })}\n`);
    const staleTime = new Date(Date.now() - 2 * 60 * 1000);
    await fs.utimes(staleOwnerPath, staleTime, staleTime);
    await fs.utimes(staleLock, staleTime, staleTime);
    const staleRecovery = await buildProject({ ...concurrentOptions, outputDir: staleOutputDir, spec: concurrentSpecA }, concurrentBuilders);
    assert.equal(staleRecovery.ok, true);
    assert.equal(await fs.access(staleLock).then(() => true).catch(() => false), false);

    const transactionDir = path.join(temporary, "transaction");
    const transactionBackup = path.join(transactionDir, "backup");
    await fs.mkdir(transactionDir, { recursive: true });
    const oldA = path.join(transactionDir, "a.txt");
    const oldB = path.join(transactionDir, "b.txt");
    const newA = path.join(transactionDir, "new-a.txt");
    await fs.writeFile(oldA, "old-a");
    await fs.writeFile(oldB, "old-b");
    await fs.writeFile(newA, "new-a");
    await assert.rejects(() => publishArtifactsTransactionally([
      { source: newA, target: oldA },
      { source: path.join(transactionDir, "missing.txt"), target: oldB },
    ], transactionBackup));
    assert.equal(await fs.readFile(oldA, "utf8"), "old-a");
    assert.equal(await fs.readFile(oldB, "utf8"), "old-b");
  } finally {
    if (originalRuntimeModules === undefined) delete process.env.RUNTIME_NODE_MODULES;
    else process.env.RUNTIME_NODE_MODULES = originalRuntimeModules;
    if (originalCjkFont === undefined) delete process.env.PAPER_CLUB_PPT_CJK_FONT;
    else process.env.PAPER_CLUB_PPT_CJK_FONT = originalCjkFont;
    await fs.rm(temporary, { recursive: true, force: true });
  }
  console.log("build-project-cache.test.mjs: PASS");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
