#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { validateScientificDesign, validateScientificDesignFile } from "../scripts/validate-scientific-design.mjs";

const execFileAsync = promisify(execFile);
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(TEST_DIR, "..");
const VALIDATOR = path.join(SKILL_DIR, "scripts", "validate-scientific-design.mjs");
const GALLERY = path.join(SKILL_DIR, "assets", "group-meeting-literature-universal", "sample-deck-spec.json");

function contentSlide(id, overrides = {}) {
  return {
    id,
    order: 1,
    kind: "content",
    priority: "core",
    purpose: "解释论文证据",
    audience_question: "这项证据如何支持论文结论？",
    takeaway: "本页给出一项可辩护结论",
    relationship_topology: "none",
    content: { title: "论文证据与判断" },
    layout: { family: "chart_insight", variant: "table-chart-result" },
    render_data: { chart: { categories: ["A", "B"], series: [{ name: "响应", values: [1, 2] }] } },
    text_emphasis: [{ text: "可辩护结论", role: "key" }],
    visuals: [],
    ...overrides,
  };
}

function deck(slides, overrides = {}) {
  return {
    profile: "group_meeting_literature",
    project_id: "paper-club-design-test",
    title: "论文组会汇报",
    artifact_purpose: "production",
    sections: [],
    slides,
    ...overrides,
  };
}

function codes(result) {
  return result.issues.map((item) => item.code);
}

const baseline = validateScientificDesign(deck([contentSlide("baseline")]), { strict: true });
assert.equal(baseline.ok, true, JSON.stringify(baseline.issues, null, 2));

const nonlinear = deck([contentSlide("nonlinear", {
  relationship_topology: "branch_converge",
  layout: { family: "process_flow", variant: "method-sequence" },
  render_data: { events: [{ title: "入口", body: "公共输入" }, { title: "并行分支", body: "两条路径" }, { title: "汇合", body: "共同验证" }] },
  diagram: {
    include: true,
    nodes: [{ id: "model" }, { id: "a" }, { id: "b" }, { id: "validation" }],
    edges: [
      { from: "model", to: "a", relation: "branch" },
      { from: "model", to: "b", relation: "branch" },
      { from: "a", to: "validation", relation: "convergence" },
      { from: "b", to: "validation", relation: "convergence" }
    ]
  }
})]);
assert(codes(validateScientificDesign(nonlinear, { strict: true })).includes("scientific.topology.process_shell_mismatch"), "branch/converge must reject the linear method-sequence renderer");

const missingStoryboard = deck([contentSlide("missing-storyboard", { audience_question: null, relationship_topology: undefined })]);
const missingStoryboardCodes = codes(validateScientificDesign(missingStoryboard, { strict: true }));
assert(missingStoryboardCodes.includes("scientific.storyboard.audience_question_missing"));
assert(missingStoryboardCodes.includes("scientific.storyboard.topology_missing"));

const missingPriority = deck([contentSlide("missing-priority", { priority: undefined })]);
assert(codes(validateScientificDesign(missingPriority, { strict: true })).includes("scientific.storyboard.priority_missing"));

const allSupporting = deck([contentSlide("supporting", { priority: "supporting" })]);
assert(codes(validateScientificDesign(allSupporting)).includes("scientific.deck.core_absent"), "Paper Club PPT must retain at least one core evidence page");

const wrongAgenda = deck([contentSlide("wrong-agenda", {
  kind: "agenda",
  priority: undefined,
  layout: { family: "contribution_limits", variant: "critical-appraisal" },
  render_data: { strengths: ["可信"], risks: ["边界"], verdict: "审慎接受" }
})]);
assert(codes(validateScientificDesign(wrongAgenda)).includes("scientific.shell.kind_layout_mismatch"));

const shellAsContent = deck([contentSlide("shell-as-content", { layout: { family: "title", variant: "group-cover" } })]);
assert(codes(validateScientificDesign(shellAsContent)).includes("scientific.shell.layout_kind_mismatch"));

const removedWorkflowLayout = deck([contentSlide("removed-layout", { layout: { family: "title", variant: "cover" } })]);
assert(codes(validateScientificDesign(removedWorkflowLayout)).includes("scientific.layout.profile_mismatch"), "removed workflow layouts must not be accepted");

const placeholder = deck([contentSlide("placeholder", {
  layout: { family: "selection", variant: "selection-rationale" },
  content: { title: "阅读理由", bullets: ["要点 01"] },
  render_data: { criteria: [{ title: "重要性", body: "要点 01" }] }
})]);
assert(codes(validateScientificDesign(placeholder)).includes("scientific.content.renderer_placeholder"));

const emptySelection = deck([contentSlide("empty-selection", {
  layout: { family: "selection", variant: "selection-rationale" },
  content: { title: "只有标题" },
  render_data: {}
})]);
assert(codes(validateScientificDesign(emptySelection)).includes("scientific.content.empty_renderer_fallback"));

const emptyQuestions = deck([contentSlide("empty-questions", {
  kind: "questions",
  layout: { family: "discussion", variant: "discussion-questions" },
  render_data: {}
})]);
assert(codes(validateScientificDesign(emptyQuestions)).includes("scientific.content.partial_renderer_payload"));

const emptyConclusion = deck([contentSlide("empty-conclusion", {
  kind: "summary",
  layout: { family: "summary", variant: "paper-conclusion" },
  render_data: {}
})]);
assert(codes(validateScientificDesign(emptyConclusion)).includes("scientific.content.partial_renderer_payload"));

const noEmphasis = deck([contentSlide("no-emphasis", { text_emphasis: [] })]);
assert(codes(validateScientificDesign(noEmphasis)).includes("scientific.deck.emphasis_absent"));
assert(!codes(validateScientificDesign(deck([contentSlide("with-emphasis")]))).includes("scientific.deck.emphasis_absent"));

const untreatedVisual = deck([contentSlide("untreated-visual", {
  layout: { family: "hero_figure", variant: "single-result-evidence" },
  narrative_roles: ["key_finding"],
  render_data: { conclusion: "图中趋势支持方向性判断" },
  visuals: [{ id: "plot", type: "figure", include: true, asset_ref: "plot", transformations: ["裁取图身并去除题注"] }]
})], { assets: [{ id: "plot", path: "assets/figures/original/plot.png" }] });
assert(codes(validateScientificDesign(untreatedVisual)).includes("scientific.visuals.unprocessed"));
const treatedVisual = structuredClone(untreatedVisual);
treatedVisual.assets[0].path = "assets/figures/ready/plot-annotated.png";
assert(codes(validateScientificDesign(treatedVisual)).includes("scientific.visuals.unprocessed"), "a ready directory cannot establish processing or readability");
const clearOriginal = structuredClone(untreatedVisual);
clearOriginal.slides[0].asset_transform = {
  asset_ref: "plot", mode: "original", readability_verified: true,
  output_sha256: createHash("sha256").update("reviewed original fixture bytes").digest("hex"),
  reason: "At the final slide size the two curves, tick labels and legend are readable; the original already isolates the relevant comparison.",
};
assert.equal(validateScientificDesign(clearOriginal, { strict: true }).ok, true, "a reviewed clear original needs no decorative annotation");
const noReview = structuredClone(clearOriginal);
noReview.slides[0].asset_transform.readability_verified = false;
assert(codes(validateScientificDesign(noReview)).includes("scientific.visuals.unprocessed"), "a reason without a completed review is only a plan");
const unboundReview = structuredClone(clearOriginal);
delete unboundReview.slides[0].asset_transform.output_sha256;
assert(codes(validateScientificDesign(unboundReview)).includes("scientific.visuals.readability_review_invalid"), "a readability boolean without an asset hash cannot bind the review to a file");

const proofDir = await fs.mkdtemp(path.join(os.tmpdir(), "paper-club-treatment-proof-"));
try {
  const original = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect x="20" y="20" width="30" height="30"/></svg>';
  const annotated = original.replace('</svg>', '<text x="10" y="80">Selected result</text></svg>');
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  await fs.mkdir(path.join(proofDir, "original"));
  await fs.mkdir(path.join(proofDir, "ready"));
  await fs.writeFile(path.join(proofDir, "original", "plot.svg"), original);
  await fs.writeFile(path.join(proofDir, "ready", "plot.svg"), original);
  const fileDeck = structuredClone(untreatedVisual);
  const validateFileDeck = async () => {
    const specPath = path.join(proofDir, "deck.json");
    await fs.writeFile(specPath, JSON.stringify(fileDeck));
    return validateScientificDesignFile(specPath, { strict: true });
  };
  fileDeck.assets[0].path = "original/plot.svg";
  const originalResult = await validateFileDeck();
  fileDeck.assets[0].path = "ready/plot.svg";
  const renamedResult = await validateFileDeck();
  assert.equal(originalResult.ok, false);
  assert.deepEqual(renamedResult.issues, originalResult.issues, "identical bytes under ready/ must have exactly the same treatment result");
  fileDeck.slides[0].asset_transform = { ...clearOriginal.slides[0].asset_transform, output_sha256: hash(original) };
  assert.equal((await validateFileDeck()).ok, true, "a review bound to the current original bytes permits the original");
  await fs.writeFile(path.join(proofDir, "ready", "plot.svg"), annotated);
  assert(codes(await validateFileDeck()).includes("scientific.visuals.readability_review_invalid"), "replacing the reviewed original invalidates its prior readability boolean");
  await fs.writeFile(path.join(proofDir, "ready", "plot.svg"), original);
  delete fileDeck.slides[0].asset_transform.output_sha256;
  assert(codes(await validateFileDeck()).includes("scientific.visuals.readability_review_invalid"), "file validation also rejects an unbound original review");
  fileDeck.assets.push({ id: "source-plot", path: "original/plot.svg" });
  fileDeck.slides[0].asset_transform = {
    asset_ref: "plot", input_asset_ref: "source-plot", mode: "annotate", reason: "Label the result region while retaining the source graphic.",
    input_sha256: hash(original), output_sha256: hash(original),
  };
  assert(codes(await validateFileDeck()).includes("scientific.visuals.processing_proof_invalid"), "byte-identical input and output are a copy, not a treatment");
  fileDeck.slides[0].asset_transform.output_sha256 = hash(annotated);
  assert(codes(await validateFileDeck()).includes("scientific.visuals.processing_proof_invalid"), "declaring a different output hash cannot prove a treatment that never happened");
  await fs.writeFile(path.join(proofDir, "ready", "plot.svg"), annotated);
  const actualTreatment = await validateFileDeck();
  assert.equal(actualTreatment.ok, true, JSON.stringify(actualTreatment.issues));
  assert.equal(actualTreatment.scope, "structure_and_file_provenance");
  await fs.writeFile(path.join(proofDir, "original", "plot.svg"), annotated);
  assert(codes(await validateFileDeck()).includes("scientific.visuals.processing_proof_invalid"), "changing the retained source invalidates the input proof");
} finally {
  await fs.rm(proofDir, { recursive: true, force: true });
}

const emptyCustom = deck([contentSlide("empty-custom", {
  layout: { family: "free_canvas", variant: "custom:paper-evidence" },
  render_data: { custom_elements: [{ type: "shape", x: 40, y: 100, w: 200, h: 100 }] }
})]);
assert(codes(validateScientificDesign(emptyCustom)).includes("scientific.free_canvas.elements_missing"));

const validCustom = deck([contentSlide("valid-custom", {
  layout: { family: "free_canvas", variant: "custom:paper-evidence" },
  relationship_topology: "branch_converge",
  render_data: {
    custom_elements: [
      { type: "text", text: "论文主张", x: 60, y: 120, w: 220, h: 60 },
      { type: "shape", text: "证据 A", x: 360, y: 100, w: 220, h: 100 },
      { type: "connector", x: 280, y: 140, w: 80, h: 20 },
      { type: "annotation", text: "适用边界", x: 700, y: 100, w: 220, h: 100 },
      { type: "metric", text: "+24%", x: 980, y: 100, w: 160, h: 80 }
    ]
  }
})]);
assert(!codes(validateScientificDesign(validCustom)).includes("scientific.free_canvas.elements_missing"));

const bundledGallery = JSON.parse(await fs.readFile(GALLERY, "utf8"));
const galleryResult = validateScientificDesign(bundledGallery, { strict: true });
assert.equal(galleryResult.ok, true, JSON.stringify(galleryResult.issues, null, 2));
const galleryFileResult = await validateScientificDesignFile(GALLERY, { strict: true });
assert.equal(galleryFileResult.ok, true);

const cli = await execFileAsync(process.execPath, [VALIDATOR, GALLERY, "--strict", "--json"], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
assert.equal(JSON.parse(cli.stdout).ok, true);

console.log("scientific-design-quality.test.mjs: PASS");
