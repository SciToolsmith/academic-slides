#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createProjectBuilder } from "../scripts/create-project-builder.mjs";
import { buildSpeakerScriptFromSpec } from "../scripts/build-speaker-script.mjs";
import { normalizeSpeakerNotes, serializeSpeakerNotes } from "../scripts/speaker-notes.mjs";
import { stageDelivery, validateAssetTree, validateDeliveryStem, validatePresentationScriptParity } from "../scripts/stage-delivery.mjs";
import { validateDeckSpec, validateDeckSpecFile } from "../scripts/validate-deck-spec.mjs";

const execFileAsync = promisify(execFile);
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(TEST_DIR, "..");
const SAMPLE_SPEC = path.join(SKILL_DIR, "assets", "group-meeting-literature-universal", "sample-deck-spec.json");
const STEM = "客机侧开式登机门优化设计_组会汇报";

function threeSlideSpec(sample) {
  const sections = [
    { id: "problem", order: 1, title: "研究问题与证据", short_title: "研究问题", role: "problem", audience_role: "main", show_in_agenda: true, show_in_navigation: true },
    { id: "method", order: 2, title: "研究方法与分析", short_title: "研究方法", role: "method", audience_role: "main", show_in_agenda: true, show_in_navigation: true },
    { id: "result", order: 3, title: "研究结果与边界", short_title: "研究结果", role: "results", audience_role: "main", show_in_agenda: true, show_in_navigation: true },
  ];
  const cover = structuredClone(sample.slides.find((slide) => slide.kind === "title"));
  const agenda = structuredClone(sample.slides.find((slide) => slide.kind === "agenda"));
  const bodyIds = ["sample-claim-evidence-boundary", "sample-critical-appraisal", "sample-paper-conclusion"];
  const bodies = bodyIds.map((id, index) => {
    const slide = structuredClone(sample.slides.find((item) => item.id === id));
    slide.id = `delivery-body-${index + 1}`;
    slide.section_id = sections[index].id;
    slide.priority = index === 0 ? "core" : "supporting";
    if (index === 0) slide.relationship_topology = "none";
    slide.evidence_refs = slide.speaker_notes.sources.map((source) => source.source_id);
    return slide;
  });
  const closing = structuredClone(sample.slides.find((slide) => slide.kind === "closing"));
  cover.id = "delivery-cover";
  cover.section_id = sections[0].id;
  agenda.id = "delivery-agenda";
  agenda.section_id = sections[0].id;
  agenda.render_data.sections = sections.map((section, index) => ({ number: String(index + 1).padStart(2, "0"), title: section.title }));
  agenda.content.body = sections.map((section, index) => `${String(index + 1).padStart(2, "0")} ${section.title}`);
  closing.id = "delivery-closing";
  closing.section_id = sections.at(-1).id;
  const slides = [cover, agenda, ...bodies, closing].map((slide, index) => ({ ...slide, order: index + 1 }));
  const seconds = slides.reduce((sum, slide) => sum + slide.speaker_notes.estimated_seconds, 0);
  return {
    ...sample,
    artifact_purpose: "production",
    structure: {
      section_transition_mode: "integrated",
      section_transition_reason: "精简交付契约测试使用集成过渡。",
      appendix_policy: "none",
    },
    project_id: "delivery-contract-fixture",
    title: "客机侧开式登机门优化设计",
    sections,
    timing: {
      ...sample.timing,
      duration_minutes: seconds / 60 / Number(sample.timing.usable_fraction || 0.75),
      target_seconds: seconds,
      estimated_seconds: seconds,
      target_slide_count: slides.length,
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

function decodeXml(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'");
}

function wordParagraphs(documentXml) {
  return [...documentXml.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)].map((match) => ({
    xml: match[0],
    text: decodeXml([...match[0].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((item) => item[1]).join("")),
  }));
}

function embeddedArtifactBuilder(stem, spec, pptxBytes, docxBytes) {
  const contract = {
    contract_version: 2,
    generator: "paper-club-ppt/create-project-builder",
    stem,
    pptx: `${stem}.pptx`,
    docx: `${stem}_发言稿.docx`,
    theme: null,
    artifact_purpose: "production",
    spec_sha256: crypto.createHash("sha256").update(JSON.stringify(spec)).digest("hex"),
  };
  return [
    "#!/usr/bin/env node",
    `// paper-club-ppt-delivery: ${JSON.stringify(contract)}`,
    'import fs from "node:fs";',
    'import path from "node:path";',
    `const deckSpec = ${JSON.stringify(spec, null, 2)};`,
    "const themePreset = null;",
    `fs.writeFileSync(path.join(process.cwd(), ${JSON.stringify(contract.pptx)}), Buffer.from(${JSON.stringify(pptxBytes.toString("base64"))}, "base64"));`,
    `fs.writeFileSync(path.join(process.cwd(), ${JSON.stringify(contract.docx)}), Buffer.from(${JSON.stringify(docxBytes.toString("base64"))}, "base64"));`,
    "",
  ].join("\n");
}

async function main() {
  assert.equal(validateDeliveryStem(STEM), STEM);
  for (const valid of ["IPv6网络测量方法_组会汇报", "V2X协同感知方法_组会汇报", "HIV1感染机制_组会汇报", "V1视觉皮层机制_组会汇报"]) {
    assert.equal(validateDeliveryStem(valid), valid);
  }
  for (const invalid of [
    `${STEM}_叶梯`,
    "客机侧开式登机门优化设计_2026-08-16_组会汇报",
    "客机侧开式登机门优化设计_2026_组会汇报",
    "2026客机侧开式登机门优化设计_组会汇报",
    "客机侧开式登机门优化设计20260816_组会汇报",
    "客机侧开式登机门优化设计v1_组会汇报",
    "客机侧开式登机门优化设计_版本2_组会汇报",
    "客机侧开式登机门优化设计_rev2_组会汇报",
    "客机侧开式登机门优化设计_定稿_组会汇报",
    "客机侧开式登机门优化设计_latest_组会汇报",
    "客机侧开式登机门优化设计_终版_组会汇报",
    "客机侧开式登机门优化设计_修订版_组会汇报",
    "客机侧开式登机门优化设计_v 2_组会汇报",
    "客机侧开式登机门优化设计v1版_组会汇报",
    "客机侧开式登机门优化设计v1修改_组会汇报",
    "客机侧开式登机门优化设计_final",
    ` ${STEM}`,
  ]) assert.throws(() => validateDeliveryStem(invalid));
  assert.throws(() => validateDeliveryStem("叶梯项目_组会汇报", ["叶梯"]));

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

  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "paper-club-ppt-delivery-"));
  try {
    const sample = JSON.parse(await fs.readFile(SAMPLE_SPEC, "utf8"));
    const specPath = path.join(temporary, "deck-spec.json");
    await fs.writeFile(specPath, `${JSON.stringify(threeSlideSpec(sample), null, 2)}\n`, "utf8");
    const validation = await validateDeckSpecFile(specPath, { strict: true, requireSchema: true });
    assert.deepEqual(validation.issues, []);
    const inMemoryValidation = await validateDeckSpec(threeSlideSpec(sample), { strict: true, requireSchema: true });
    assert.deepEqual(inMemoryValidation.issues, []);

    const invalidCases = [
      {
        name: "blank-script",
        mutate(spec) { spec.slides[2].speaker_notes.script = "   "; },
        code: "notes.script.empty",
      },
      {
        name: "script-marker",
        mutate(spec) { spec.slides[2].speaker_notes.script += " [Sources]"; },
        code: "notes.sources.marker",
      },
      {
        name: "transition-marker",
        mutate(spec) { spec.slides[2].speaker_notes.transition = "[/Sources]"; },
        code: "notes.sources.marker",
      },
      {
        name: "citation-marker",
        mutate(spec) { spec.slides[2].speaker_notes.sources[0].citation += " [Sources]"; },
        code: "notes.sources.marker",
      },
      {
        name: "missing-note-source",
        mutate(spec) { spec.slides[2].speaker_notes.sources = []; },
        code: "notes.sources.coverage",
      },
    ];
    for (const invalidCase of invalidCases) {
      const invalidSpec = threeSlideSpec(sample);
      invalidCase.mutate(invalidSpec);
      const invalidPath = path.join(temporary, `${invalidCase.name}.json`);
      await fs.writeFile(invalidPath, `${JSON.stringify(invalidSpec, null, 2)}\n`, "utf8");
      const invalidResult = await validateDeckSpecFile(invalidPath, { strict: true, requireSchema: true });
      assert.ok(invalidResult.issues.some((item) => item.code === invalidCase.code && item.severity === "error"), `${invalidCase.name} must fail with ${invalidCase.code}`);
    }

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
    assert.match(generated, /^\/\/ paper-club-ppt-delivery:/m);
    assert.match(generated, /"artifact_purpose":"production"/);
    assert.match(generated, /validate-scientific-design\.mjs/);
    assert.match(generated, /validateScientificDesign\(deckSpec, \{ strict: true \}\)/);
    assert.doesNotMatch(generated, /"qa"\s*:/, "internal QA records must not be embedded in the customer MJS");
    assert.doesNotMatch(generated, /not_checked/, "stale not_checked QA placeholders must not leak into the customer MJS");
    await assert.rejects(() => createProjectBuilder({
      spec: specPath,
      output: path.join(temporary, `${STEM}.mjs`),
      pptxName: "其他名称.pptx",
      docxName: `${STEM}_发言稿.docx`,
    }));

    const gallerySpec = threeSlideSpec(sample);
    gallerySpec.artifact_purpose = "layout_gallery";
    const gallerySpecPath = path.join(temporary, "layout-gallery-spec.json");
    await fs.writeFile(gallerySpecPath, `${JSON.stringify(gallerySpec, null, 2)}\n`, "utf8");
    await assert.rejects(() => createProjectBuilder({
      spec: gallerySpecPath,
      output: path.join(temporary, "画廊_组会汇报.mjs"),
      pptxName: "画廊_组会汇报.pptx",
      docxName: "画廊_组会汇报_发言稿.docx",
    }), /layout_gallery/);
    const galleryMjs = path.join(temporary, "画廊_组会汇报.mjs");
    await fs.writeFile(galleryMjs, `#!/usr/bin/env node\n// paper-club-ppt-delivery: ${JSON.stringify({
      stem: "画廊_组会汇报",
      pptx: "画廊_组会汇报.pptx",
      docx: "画廊_组会汇报_发言稿.docx",
      artifact_purpose: "layout_gallery",
    })}\n`, "utf8");
    await assert.rejects(() => stageDelivery({
      output: path.join(temporary, "画廊_组会汇报"),
      mjs: galleryMjs,
    }), /artifact_purpose=production|generated embedded deck specification/);

    const unsafePaths = [
      ".." + "/../source/paper.pdf",
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
    for (const unsafeRelative of ["附件/论文.pdf", "source/论文.pdf", "资料/paper.pdf", "内部引用：附件/论文.pdf"]) {
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
    const validAssetStem = "有效素材_组会汇报";
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
    const doiStem = "DOI示例_组会汇报";
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
    const staged = await stageDelivery({ output: delivery, mjs: mjsPath, assets: assetSource });
    assert.deepEqual(staged.parity, { slideCount: 6, notesCount: 6, wordPageCount: 6, specSlideCount: 6 });
    assert.deepEqual((await fs.readdir(delivery)).sort(), [`${STEM}.mjs`, `${STEM}.pptx`, `${STEM}_发言稿.docx`, "assets"].sort());
    assert.equal(await fs.access(path.join(delivery, "assets", "formulas")).then(() => true).catch(() => false), false);

    const tamperedRoot = path.join(temporary, "tampered-builder");
    await fs.mkdir(tamperedRoot, { recursive: true });
    const tamperedMjs = path.join(tamperedRoot, `${STEM}.mjs`);
    const sideEffectPath = path.join(temporary, "unexpected-side-effect.txt");
    await fs.writeFile(tamperedMjs, `${await fs.readFile(mjsPath, "utf8")}\nawait fs.writeFile(${JSON.stringify(sideEffectPath)}, "unexpected");\n`, "utf8");
    await assert.rejects(() => stageDelivery({
      output: path.join(temporary, "tampered-output", STEM),
      mjs: tamperedMjs,
      assets: assetSource,
    }), /not the canonical source/);
    assert.equal(await fs.access(sideEffectPath).then(() => true).catch(() => false), false);

    const docXml = await xmlText(path.join(delivery, `${STEM}_发言稿.docx`), "word/document.xml");
    const docParagraphs = wordParagraphs(docXml);
    const expectedSlides = threeSlideSpec(sample).slides;
    assert.equal(docParagraphs.length, expectedSlides.length + 1);
    assert.equal(docParagraphs[0].text, `${STEM.replaceAll("_", " ")}发言稿`);
    for (const [index, slide] of expectedSlides.entries()) {
      const notes = normalizeSpeakerNotes(slide);
      const transition = notes.transition && !notes.script.includes(notes.transition) ? ` ${notes.transition}` : "";
      assert.equal(docParagraphs[index + 1].text, `第${index + 1}页：${notes.script}${transition}`);
      assert.match(docParagraphs[index + 1].xml, new RegExp(`<w:b(?:\\s[^>]*)?\\/>[\\s\\S]*?<w:t(?:\\s[^>]*)?>第${index + 1}页：<\\/w:t>`));
    }
    assert.doesNotMatch(docXml, /\[\/?Sources\]/);
    assert.doesNotMatch(docXml, /过渡：/);
    assert.doesNotMatch(docXml, /P01｜|PPT 备注/);
    const deliveredPptx = path.join(delivery, `${STEM}.pptx`);
    const notesEntries = (await archiveEntries(deliveredPptx)).filter((entry) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(entry));
    assert.equal(notesEntries.length, expectedSlides.length);
    const noteXml = (await Promise.all(notesEntries.map((entry) => xmlText(deliveredPptx, entry)))).join("\n");
    assert.equal((noteXml.match(/\[Sources\]/g) ?? []).length, expectedSlides.length);
    assert.equal((noteXml.match(/\[\/Sources\]/g) ?? []).length, expectedSlides.length);

    const mismatchedSpec = threeSlideSpec(sample);
    mismatchedSpec.slides[0].speaker_notes.script += " 这段文字只存在被篡改的 Word 中。";
    const mismatchedStem = "逐页同源门禁_组会汇报";
    const mismatchedDocx = path.join(temporary, `${mismatchedStem}_发言稿.docx`);
    await buildSpeakerScriptFromSpec(mismatchedSpec, mismatchedDocx);
    const mismatchedMjs = path.join(temporary, `${mismatchedStem}.mjs`);
    await fs.writeFile(mismatchedMjs, embeddedArtifactBuilder(
      mismatchedStem,
      threeSlideSpec(sample),
      await fs.readFile(deliveredPptx),
      await fs.readFile(mismatchedDocx),
    ), "utf8");
    await assert.rejects(
      () => validatePresentationScriptParity(deliveredPptx, mismatchedDocx, threeSlideSpec(sample)),
      /slide 1 speaker script differs/,
    );
    await assert.rejects(() => stageDelivery({
      output: path.join(temporary, mismatchedStem),
      mjs: mismatchedMjs,
    }), /not the canonical source/);

    const shortSpec = threeSlideSpec(sample);
    shortSpec.slides = shortSpec.slides.slice(0, -1);
    const shortStem = "页数同源门禁_组会汇报";
    const shortDocx = path.join(temporary, `${shortStem}_发言稿.docx`);
    await buildSpeakerScriptFromSpec(shortSpec, shortDocx);
    const shortMjs = path.join(temporary, `${shortStem}.mjs`);
    await fs.writeFile(shortMjs, embeddedArtifactBuilder(
      shortStem,
      threeSlideSpec(sample),
      await fs.readFile(deliveredPptx),
      await fs.readFile(shortDocx),
    ), "utf8");
    await assert.rejects(
      () => validatePresentationScriptParity(deliveredPptx, shortDocx, threeSlideSpec(sample)),
      /Word must contain one title plus 6 page paragraphs; found 6/,
    );
    await assert.rejects(() => stageDelivery({
      output: path.join(temporary, shortStem),
      mjs: shortMjs,
    }), /not the canonical source/);

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
      PAPER_CLUB_PPT_SKILL_DIR: SKILL_DIR,
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
