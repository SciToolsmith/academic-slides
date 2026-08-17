#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createProjectBuilder } from "../scripts/create-project-builder.mjs";
import { serializeSpeakerNotes } from "../scripts/speaker-notes.mjs";
import { stageDelivery, validateAssetTree, validateDeliveryStem } from "../scripts/stage-delivery.mjs";
import { validateDeckSpecFile } from "../scripts/validate-deck-spec.mjs";

const execFileAsync = promisify(execFile);
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(TEST_DIR, "..");
const SAMPLE_SPEC = path.join(SKILL_DIR, "assets", "final-defense-universal", "sample-deck-spec.json");
const STEM = "客机侧开式登机门优化设计_硕士答辩";

function threeSlideSpec(sample) {
  const slides = sample.slides.slice(0, 3).map((slide, index) => ({ ...structuredClone(slide), order: index + 1 }));
  const seconds = slides.reduce((sum, slide) => sum + slide.speaker_notes.estimated_seconds, 0);
  return {
    ...sample,
    project_id: "delivery-contract-fixture",
    title: "客机侧开式登机门优化设计",
    timing: {
      ...sample.timing,
      duration_minutes: seconds / 60 / Number(sample.timing.usable_fraction || 0.75),
      target_seconds: seconds,
      estimated_seconds: seconds,
      target_slide_count: 3,
    },
    slides,
    sources: sample.sources.map((source) => ({
      ...source,
      citation: source.id === "layout-registry" ? "本项目版式规范" : "本项目视觉规范",
      path: null,
    })),
    claim_evidence_map: [],
  };
}

async function xmlText(archive, entry) {
  const result = await execFileAsync("unzip", ["-p", archive, entry], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  return result.stdout;
}

async function archiveEntries(archive) {
  const result = await execFileAsync("unzip", ["-Z1", archive], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

async function main() {
  assert.equal(validateDeliveryStem(STEM), STEM);
  for (const valid of ["IPv6网络测量方法_硕士答辩", "V2X协同感知方法_硕士答辩", "HIV1感染机制_博士答辩", "V1视觉皮层机制_博士答辩"]) {
    assert.equal(validateDeliveryStem(valid), valid);
  }
  for (const invalid of [
    `${STEM}_叶梯`,
    "客机侧开式登机门优化设计_2026-08-16_硕士答辩",
    "客机侧开式登机门优化设计_2026_硕士答辩",
    "2026客机侧开式登机门优化设计_硕士答辩",
    "客机侧开式登机门优化设计20260816_硕士答辩",
    "客机侧开式登机门优化设计v1_硕士答辩",
    "客机侧开式登机门优化设计_版本2_硕士答辩",
    "客机侧开式登机门优化设计_rev2_硕士答辩",
    "客机侧开式登机门优化设计_定稿_硕士答辩",
    "客机侧开式登机门优化设计_latest_硕士答辩",
    "客机侧开式登机门优化设计_终版_硕士答辩",
    "客机侧开式登机门优化设计_修订版_硕士答辩",
    "客机侧开式登机门优化设计_v 2_硕士答辩",
    "客机侧开式登机门优化设计v1版_硕士答辩",
    "客机侧开式登机门优化设计v1修改_硕士答辩",
    "客机侧开式登机门优化设计_final",
    ` ${STEM}`,
  ]) assert.throws(() => validateDeliveryStem(invalid));
  assert.throws(() => validateDeliveryStem("叶梯项目_硕士答辩", ["叶梯"]));

  const note = serializeSpeakerNotes({
    speaker_notes: {
      script: "讲稿正文。",
      transition: "进入下一页。",
      sources: [{ source_id: "internal-id", citation: "原论文", locator: "PDF第3页" }],
    },
  });
  assert.match(note, /讲稿正文。\n\n过渡：进入下一页。\n\n\n\[Sources\]/);
  assert.match(note, /- 原论文；PDF第3页/);
  assert.doesNotMatch(note, /internal-id/);
  assert.equal((note.match(/\[Sources\]/g) ?? []).length, 1);

  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "academic-slides-delivery-"));
  try {
    const sample = JSON.parse(await fs.readFile(SAMPLE_SPEC, "utf8"));
    const specPath = path.join(temporary, "deck-spec.json");
    await fs.writeFile(specPath, `${JSON.stringify(threeSlideSpec(sample), null, 2)}\n`, "utf8");
    const validation = await validateDeckSpecFile(specPath, { strict: true, requireSchema: true });
    assert.deepEqual(validation.issues, []);
    const mjsPath = path.join(temporary, `${STEM}.mjs`);
    await createProjectBuilder({
      spec: specPath,
      output: mjsPath,
      pptxName: `${STEM}.pptx`,
      docxName: `${STEM}_发言稿.docx`,
    });
    await execFileAsync(process.execPath, ["--check", mjsPath], { encoding: "utf8" });
    const generated = await fs.readFile(mjsPath, "utf8");
    assert.doesNotMatch(generated, /\/(?:Users|Volumes|home|private\/var|var\/folders)\//);
    assert.doesNotMatch(generated, /readFile\([^\n]*deck-spec\.json/);
    assert.match(generated, /^\/\/ academic-slides-delivery:/m);
    await assert.rejects(() => createProjectBuilder({
      spec: specPath,
      output: path.join(temporary, `${STEM}.mjs`),
      pptxName: "其他名称.pptx",
      docxName: `${STEM}_发言稿.docx`,
    }));

    const unsafePaths = [
      ".." + "/../source/thesis.pdf",
      ".." + "/assets/figure.png",
      "/" + "tmp/secret.png",
      "D:" + "\\secret\\x.png",
      "C:" + "/" + "Users" + "/name/a.png",
    ];
    for (const unsafePath of unsafePaths) {
      const unsafeSpec = threeSlideSpec(sample);
      unsafeSpec.assets = [{ id: "unsafe-asset", path: unsafePath, type: "figure", alt_text: "unsafe" }];
      const unsafeSpecPath = path.join(temporary, "unsafe-deck-spec.json");
      await fs.writeFile(unsafeSpecPath, `${JSON.stringify(unsafeSpec, null, 2)}\n`, "utf8");
      await assert.rejects(() => createProjectBuilder({
        spec: unsafeSpecPath,
        output: path.join(temporary, `${STEM}.mjs`),
        pptxName: `${STEM}.pptx`,
        docxName: `${STEM}_发言稿.docx`,
      }));
    }
    const embeddedUnsafeSpec = threeSlideSpec(sample);
    embeddedUnsafeSpec.slides[0].speaker_notes.script = "内部调试路径 /etc/private-source.pdf";
    const embeddedUnsafeSpecPath = path.join(temporary, "embedded-unsafe-deck-spec.json");
    await fs.writeFile(embeddedUnsafeSpecPath, `${JSON.stringify(embeddedUnsafeSpec, null, 2)}\n`, "utf8");
    await assert.rejects(() => createProjectBuilder({
      spec: embeddedUnsafeSpecPath,
      output: path.join(temporary, `${STEM}.mjs`),
      pptxName: `${STEM}.pptx`,
      docxName: `${STEM}_发言稿.docx`,
    }));
    for (const unsafeRelative of ["附件/论文.pdf", "source/论文.pdf", "资料/thesis.pdf", "内部引用：附件/论文.pdf"]) {
      const localizedUnsafeSpec = threeSlideSpec(sample);
      localizedUnsafeSpec.slides[0].speaker_notes.script = unsafeRelative;
      const localizedUnsafeSpecPath = path.join(temporary, "localized-unsafe-deck-spec.json");
      await fs.writeFile(localizedUnsafeSpecPath, `${JSON.stringify(localizedUnsafeSpec, null, 2)}\n`, "utf8");
      await assert.rejects(() => createProjectBuilder({
        spec: localizedUnsafeSpecPath,
        output: path.join(temporary, `${STEM}.mjs`),
        pptxName: `${STEM}.pptx`,
        docxName: `${STEM}_发言稿.docx`,
      }));
    }
    for (const unsafeApiTraversal of ["接口 /api/v1/../../etc/passwd", "接口 /api/v1/.." + "/" + "Users" + "/name/file.pdf"]) {
      const traversalSpec = threeSlideSpec(sample);
      traversalSpec.slides[0].speaker_notes.script = unsafeApiTraversal;
      const traversalSpecPath = path.join(temporary, "api-traversal-deck-spec.json");
      await fs.writeFile(traversalSpecPath, `${JSON.stringify(traversalSpec, null, 2)}\n`, "utf8");
      await assert.rejects(() => createProjectBuilder({
        spec: traversalSpecPath,
        output: path.join(temporary, `${STEM}.mjs`),
        pptxName: `${STEM}.pptx`,
        docxName: `${STEM}_发言稿.docx`,
      }));
    }
    const validAssetStem = "有效素材_硕士答辩";
    const validAssetSpec = threeSlideSpec(sample);
    validAssetSpec.assets = [{ id: "valid-asset", path: "assets/figures/original/图1.1 示例图.png", type: "figure", alt_text: "示例" }];
    const validAssetSpecPath = path.join(temporary, "valid-asset-deck-spec.json");
    await fs.writeFile(validAssetSpecPath, `${JSON.stringify(validAssetSpec, null, 2)}\n`, "utf8");
    await createProjectBuilder({
      spec: validAssetSpecPath,
      output: path.join(temporary, `${validAssetStem}.mjs`),
      pptxName: `${validAssetStem}.pptx`,
      docxName: `${validAssetStem}_发言稿.docx`,
    });
    const doiSpec = threeSlideSpec(sample);
    doiSpec.slides[0].speaker_notes.script = "DOI 10.1016/j.jmb.2024.168012；接口路径 /api/v1、/api/v1/users.json 与 /api/v1.0/predict 仅为研究对象标识。";
    const doiSpecPath = path.join(temporary, "doi-deck-spec.json");
    await fs.writeFile(doiSpecPath, `${JSON.stringify(doiSpec, null, 2)}\n`, "utf8");
    const doiStem = "DOI示例_硕士答辩";
    await createProjectBuilder({
      spec: doiSpecPath,
      output: path.join(temporary, `${doiStem}.mjs`),
      pptxName: `${doiStem}.pptx`,
      docxName: `${doiStem}_发言稿.docx`,
    });

    const assetSource = path.join(temporary, "asset-source");
    await fs.mkdir(path.join(assetSource, "figures", "original"), { recursive: true });
    await fs.writeFile(path.join(assetSource, "figures", "original", "图1.1 示例图.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await fs.writeFile(path.join(assetSource, "figures", "论文图片说明.md"), "# 论文图片说明\n", "utf8");
    const delivery = path.join(temporary, STEM);
    await stageDelivery({ output: delivery, mjs: mjsPath, assets: assetSource });
    assert.deepEqual((await fs.readdir(delivery)).sort(), [`${STEM}.mjs`, `${STEM}.pptx`, `${STEM}_发言稿.docx`, "assets"].sort());
    assert.equal(await fs.access(path.join(delivery, "assets", "formulas")).then(() => true).catch(() => false), false);

    const docXml = await xmlText(path.join(delivery, `${STEM}_发言稿.docx`), "word/document.xml");
    assert.equal((docXml.match(/\[Sources\]/g) ?? []).length, 3);
    assert.equal((docXml.match(/\[\/Sources\]/g) ?? []).length, 3);
    const deliveredPptx = path.join(delivery, `${STEM}.pptx`);
    const notesEntries = (await archiveEntries(deliveredPptx)).filter((entry) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(entry));
    assert.equal(notesEntries.length, 3);
    const noteXml = (await Promise.all(notesEntries.map((entry) => xmlText(deliveredPptx, entry)))).join("\n");
    assert.equal((noteXml.match(/\[Sources\]/g) ?? []).length, 3);
    assert.equal((noteXml.match(/\[\/Sources\]/g) ?? []).length, 3);

    const badAssets = path.join(temporary, "bad-assets");
    await fs.mkdir(path.join(badAssets, "figures"), { recursive: true });
    await fs.writeFile(path.join(badAssets, "figures", "figures.manifest.json"), "{}\n", "utf8");
    await assert.rejects(() => stageDelivery({ output: delivery, mjs: mjsPath, assets: badAssets, force: true }));
    assert.ok((await fs.stat(deliveredPptx)).size > 10_000);
    const injectedAssets = path.join(temporary, "injected-assets");
    await fs.mkdir(path.join(injectedAssets, "figures"), { recursive: true });
    await fs.writeFile(path.join(injectedAssets, "figures", "figures.manifest.json"), "{}\n", "utf8");
    await assert.rejects(() => validateAssetTree(injectedAssets));
    const emptyAssets = path.join(temporary, "empty-assets");
    await fs.mkdir(path.join(emptyAssets, "formulas"), { recursive: true });
    await assert.rejects(() => validateAssetTree(emptyAssets));

    const environment = {
      ...process.env,
      ACADEMIC_SLIDES_SKILL_DIR: SKILL_DIR,
      RUNTIME_NODE_MODULES: process.env.RUNTIME_NODE_MODULES,
    };
    await execFileAsync(process.execPath, [path.join(delivery, `${STEM}.mjs`), "--all"], {
      cwd: delivery,
      env: environment,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      timeout: 120_000,
    });
    assert.ok((await fs.stat(deliveredPptx)).size > 10_000);
    assert.ok((await fs.stat(path.join(delivery, `${STEM}_发言稿.docx`))).size > 5_000);
    assert.deepEqual((await fs.readdir(delivery)).sort(), [`${STEM}.mjs`, `${STEM}.pptx`, `${STEM}_发言稿.docx`, "assets"].sort());
  } finally {
    if (process.env.KEEP_DELIVERY_TMP === "1") console.log(`delivery-test-temp: ${temporary}`);
    else await fs.rm(temporary, { recursive: true, force: true });
  }
  console.log("delivery-contract.test.mjs: PASS");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
