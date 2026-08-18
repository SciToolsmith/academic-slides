#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { validateScientificDesign, validateScientificDesignFile } from "../scripts/validate-scientific-design.mjs";

const execFileAsync = promisify(execFile);
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(TEST_DIR, "..");
const VALIDATOR = path.join(SKILL_DIR, "scripts", "validate-scientific-design.mjs");

function slide(id, order, overrides = {}) {
  return {
    id,
    order,
    kind: "content",
    priority: "core",
    purpose: "解释研究方法",
    audience_question: "这页要回答什么？",
    takeaway: "本页给出一项可辩护结论",
    relationship_topology: "none",
    content: { title: `页面 ${order}` },
    layout: { family: "chart_insight", variant: "chart-insight" },
    visuals: [],
    render_data: { visual_focus: "主证据" },
    ...overrides,
  };
}

function deck(slides, overrides = {}) {
  return {
    profile: "final_defense",
    project_id: "scientific-design-production",
    title: "科研答辩",
    slides,
    ...overrides,
  };
}

function codes(result) {
  return result.issues.map((item) => item.code);
}

const nonlinear = deck([slide("route", 1, {
  relationship_topology: "branch_converge",
  layout: { family: "process_flow", variant: "four-step-ribbon" },
  diagram: {
    include: true,
    nodes: [{ id: "model" }, { id: "grid" }, { id: "island" }, { id: "validation" }],
    edges: [
      { from: "model", to: "grid", relation: "branch" },
      { from: "model", to: "island", relation: "branch" },
      { from: "grid", to: "validation", relation: "convergence" },
      { from: "island", to: "validation", relation: "convergence" },
    ],
  },
})]);
assert(codes(validateScientificDesign(nonlinear)).includes("scientific.diagram.linear_layout_mismatch"), "branch/convergence topology must reject a linear ribbon");

const cycle = deck([slide("feedback", 1, {
  layout: { family: "process_flow", variant: "linear-process" },
  diagram: {
    include: true,
    nodes: [{ id: "a" }, { id: "b" }],
    edges: [{ from: "a", to: "b", relation: "sequence" }, { from: "b", to: "a", relation: "sequence" }],
  },
})]);
assert(codes(validateScientificDesign(cycle)).includes("scientific.diagram.linear_layout_mismatch"), "a detected cycle must reject a linear layout even without a feedback label");

const branchInProcess = deck([slide("branch-process", 1, {
  relationship_topology: "branch_converge",
  layout: { family: "process_flow", variant: "process" },
  diagram: nonlinear.slides[0].diagram,
})]);
assert(codes(validateScientificDesign(branchInProcess, { strict: true })).includes("scientific.topology.process_shell_mismatch"), "branch/converge must not bypass the gate through variant=process");

const missingStoryboard = deck([slide("missing-storyboard", 1, {
  audience_question: null,
  relationship_topology: undefined,
})]);
const missingStoryboardCodes = codes(validateScientificDesign(missingStoryboard, { strict: true }));
assert(missingStoryboardCodes.includes("scientific.storyboard.audience_question_missing"), "core content must declare the audience question");
assert(missingStoryboardCodes.includes("scientific.storyboard.topology_missing"), "core content must declare its visual relationship even when it is none");

const missingPriority = deck([slide("missing-priority", 1, { priority: undefined })]);
assert(codes(validateScientificDesign(missingPriority, { strict: true })).includes("scientific.storyboard.priority_missing"), "omitting priority must not bypass core-slide gates");

const allSupporting = deck([slide("supporting-only", 1, { priority: "supporting" })]);
assert(codes(validateScientificDesign(allSupporting)).includes("scientific.deck.core_absent"), "a final defense must not bypass all core gates by marking every main slide supporting");

const kindLayoutMismatch = deck([slide("fake-agenda", 1, {
  kind: "agenda",
  priority: undefined,
  layout: { family: "agenda", variant: "four-point-list" },
})]);
assert(codes(validateScientificDesign(kindLayoutMismatch)).includes("scientific.shell.kind_layout_mismatch"), "kind=agenda must resolve to the profile agenda renderer");

const reverseShellMismatch = deck([slide("cover-as-content", 1, {
  layout: { family: "title", variant: "cover" },
})]);
assert(codes(validateScientificDesign(reverseShellMismatch)).includes("scientific.shell.layout_kind_mismatch"), "a cover renderer must not masquerade as a content slide");

const crossProfileLayout = deck([slide("group-layout-in-final", 1, {
  layout: { family: "discussion", variant: "discussion-questions" },
})]);
assert(codes(validateScientificDesign(crossProfileLayout)).includes("scientific.layout.profile_mismatch"), "a production deck must not borrow a body renderer from another profile registry");

const explicitRendererPlaceholder = deck([slide("placeholder-copy", 1, {
  content: { title: "空内容", bullets: ["要点 01"] },
})]);
assert(codes(validateScientificDesign(explicitRendererPlaceholder)).includes("scientific.content.renderer_placeholder"), "renderer fallback copy must never be accepted as production content");

const emptyRendererPayload = deck([slide("empty-four-point", 1, {
  layout: { family: "summary", variant: "four-point-list" },
  content: { title: "只有标题", body: [], bullets: [] },
  render_data: {},
})]);
assert(codes(validateScientificDesign(emptyRendererPayload)).includes("scientific.content.empty_renderer_fallback"), "an empty semantic layout must fail validation before the renderer can inject generic points");

for (const kind of ["summary", "questions"]) {
  const disguisedEmptyBody = deck([slide(`${kind}-as-empty-body`, 1, {
    kind,
    priority: "supporting",
    layout: { family: "summary", variant: "four-point-list" },
    content: { title: "不得绕过正文门禁", body: [], bullets: [] },
    render_data: {},
  })]);
  const disguisedCodes = codes(validateScientificDesign(disguisedEmptyBody, { strict: true }));
  assert(disguisedCodes.includes("scientific.content.empty_renderer_fallback"), `kind=${kind} must not bypass production placeholder gates`);
  assert(disguisedCodes.includes("scientific.deck.core_absent"), `kind=${kind} must count when enforcing at least one core substantive slide`);
}

const summaryCoreGates = deck([slide("summary-core-gates", 1, {
  kind: "summary",
  priority: undefined,
  audience_question: null,
  relationship_topology: undefined,
  layout: { family: "summary", variant: "four-point-list" },
  render_data: { items: [{ title: "结论", body: "证据性收束" }] },
})]);
const summaryCoreGateCodes = codes(validateScientificDesign(summaryCoreGates, { strict: true }));
assert(summaryCoreGateCodes.includes("scientific.storyboard.priority_missing"), "kind=summary must declare priority like every other substantive production slide");

const emptyDiscussionQuestions = deck([slide("empty-discussion", 1, {
  kind: "questions",
  layout: { family: "discussion", variant: "discussion-questions" },
  render_data: {},
})], { profile: "group_meeting_literature" });
assert(codes(validateScientificDesign(emptyDiscussionQuestions)).includes("scientific.content.partial_renderer_payload"), "kind=questions must not let the discussion renderer invent generic questions");

const emptyPaperConclusion = deck([slide("empty-paper-conclusion", 1, {
  kind: "summary",
  layout: { family: "summary", variant: "paper-conclusion" },
  render_data: {},
})], { profile: "group_meeting_literature" });
assert(codes(validateScientificDesign(emptyPaperConclusion)).includes("scientific.content.partial_renderer_payload"), "kind=summary must not let the paper-conclusion renderer invent findings, evidence, or boundaries");

const partialClaimEvidence = deck([slide("partial-claim-evidence", 1, {
  layout: { family: "evidence_chain", variant: "claim-evidence" },
  render_data: {
    items: [{ title: "唯一证据", body: "" }],
    boundary: "结论只适用于已验证工况",
    synthesis: "多源证据共同支持本页结论",
  },
})]);
assert(codes(validateScientificDesign(partialClaimEvidence)).includes("scientific.content.partial_renderer_payload"), "a titled item with an empty evidence body must fail before claim-evidence injects fallback prose");

const noEmphasis = deck([slide("method", 1, { render_data: {} })]);
assert(codes(validateScientificDesign(noEmphasis)).includes("scientific.deck.emphasis_absent"), "production final defense must not have zero emphasis and zero visual focus");
const visualFocusExemption = structuredClone(noEmphasis);
visualFocusExemption.slides[0].render_data.visual_focus = "关键模型项";
assert(codes(validateScientificDesign(visualFocusExemption)).includes("scientific.deck.emphasis_absent"), "visual focus does not replace the deck-level need for a few editable emphasized findings");
visualFocusExemption.slides[0].text_emphasis = [{ text: "关键模型项", role: "key" }];
assert(!codes(validateScientificDesign(visualFocusExemption)).includes("scientific.deck.emphasis_absent"));
const strongOnly = structuredClone(noEmphasis);
strongOnly.slides[0].text_emphasis = [{ text: "仅加粗", role: "strong" }];
assert(codes(validateScientificDesign(strongOnly, { strict: true })).includes("scientific.deck.emphasis_absent"), "strong-only emphasis must not masquerade as semantic focal color");

const cropOnly = deck([slide("crop-only", 1, {
  visuals: [{ id: "plot", type: "figure", include: true, crop: "contain", transformations: ["裁取图身并去除题注"] }],
})]);
const cropOnlyResult = validateScientificDesign(cropOnly);
assert(codes(cropOnlyResult).includes("scientific.visuals.unprocessed"), "crop/contain alone is not presentation treatment");
assert.equal(cropOnlyResult.issues.find((item) => item.code === "scientific.visuals.unprocessed").severity, "warning");
const cropOnlyStrict = validateScientificDesign(cropOnly, { strict: true });
assert.equal(cropOnlyStrict.issues.find((item) => item.code === "scientific.visuals.unprocessed").severity, "error", "strict mode must promote scientific warnings");
assert.equal(cropOnlyStrict.ok, false);

const treated = structuredClone(cropOnly);
treated.slides[0].visuals[0].transformations.push("局部放大并标注 45 Hz 敏感峰");
assert(codes(validateScientificDesign(treated)).includes("scientific.visuals.unprocessed"), "metadata-only transformation prose must not satisfy the treatment gate");
treated.assets = [{ id: "plot-ready", path: "assets/figures/ready/plot-annotated.png" }];
treated.slides[0].visuals[0].asset_ref = "plot-ready";
assert(!codes(validateScientificDesign(treated)).includes("scientific.visuals.unprocessed"), "a selected asset from the ready derivative directory must satisfy the treatment gate");

const ignoredReadySecondSlot = deck([slide("ready-outside-renderer-slot", 1, {
  purpose: "验证关键结果",
  narrative_roles: ["validation"],
  layout: { family: "evidence_chain", variant: "claim-evidence" },
  render_data: {
    items: [{ title: "稳定性证据", body: "原始曲线展示临界频段的变化" }],
    boundary: "结论限于当前工况",
  },
  visuals: [
    { type: "chart", include: true, asset_ref: "raw-first" },
    { type: "chart", include: true, asset_ref: "ready-second" },
  ],
})], {
  assets: [
    { id: "raw-first", path: "assets/figures/raw/original.png" },
    { id: "ready-second", path: "assets/figures/ready/annotated.png" },
  ],
});
const ignoredReadySecondCodes = codes(validateScientificDesign(ignoredReadySecondSlot, { strict: true }));
assert(ignoredReadySecondCodes.includes("scientific.visuals.unconsumed"), "a ready visual outside claim-evidence's first rendered slot must be rejected as surplus");
assert(ignoredReadySecondCodes.includes("scientific.visuals.unprocessed"), "the untreated first rendered visual must still fail treatment even when a later unused visual is ready");
assert(ignoredReadySecondCodes.includes("scientific.core_result.visual_focus_missing"), "an unused ready visual must not satisfy the rendered focal-treatment gate");

const complexDual = deck([slide("dual", 1, {
  layout: { family: "comparison", variant: "two-image-results" },
  visuals: [
    { id: "left", type: "chart", include: true, crop: "contain", transformations: [] },
    { id: "right", type: "chart", include: true, crop: "contain", transformations: [] },
  ],
})]);
assert(codes(validateScientificDesign(complexDual)).includes("scientific.visuals.complex_dual_column_unannotated"), "complex dual-column charts need an annotation plan");
const annotatedDual = structuredClone(complexDual);
annotatedDual.slides[0].render_data.annotation_plan = { left: "标注 45 Hz", right: "标注 650 Hz" };
const annotatedCodes = codes(validateScientificDesign(annotatedDual));
assert(annotatedCodes.includes("scientific.visuals.complex_dual_column_unannotated"), "metadata-only annotation plan must not claim that a standard dual-image renderer applied the treatment");
assert(annotatedCodes.includes("scientific.visuals.unprocessed"));
annotatedDual.slides[0].visuals.forEach((visual, index) => { visual.highlight = index === 0 ? "45 Hz" : "650 Hz"; });
const highlightOnlyCodes = codes(validateScientificDesign(annotatedDual));
assert(highlightOnlyCodes.includes("scientific.visuals.complex_dual_column_unannotated"), "per-visual highlight metadata is not rendered by a standard dual-image layout");
assert(highlightOnlyCodes.includes("scientific.visuals.unprocessed"));
annotatedDual.slides[0].visuals.forEach((visual) => visual.transformations.push("准备已标注的 ready 资产"));
const claimedReadyCodes = codes(validateScientificDesign(annotatedDual));
assert(claimedReadyCodes.includes("scientific.visuals.complex_dual_column_unannotated"), "claiming that a ready asset exists must not replace selecting that derivative");
annotatedDual.assets = [
  { id: "left-ready", path: "assets/figures/ready/left-annotated.png" },
  { id: "right-ready", path: "assets/figures/ready/right-annotated.png" },
];
annotatedDual.slides[0].visuals[0].asset_ref = "left-ready";
annotatedDual.slides[0].visuals[1].asset_ref = "right-ready";
const appliedAnnotationCodes = codes(validateScientificDesign(annotatedDual));
assert(!appliedAnnotationCodes.includes("scientific.visuals.complex_dual_column_unannotated"));
assert(!appliedAnnotationCodes.includes("scientific.visuals.unprocessed"));

const duplicate = deck([slide("duplicate", 1, {
  content: { title: "提高渗透率能够改善正序稳定裕度" },
  takeaway: "提高渗透率能够改善正序稳定裕度。",
  render_data: { visual_focus: "渗透率", conclusion: "提高渗透率能够改善正序稳定裕度" },
})]);
assert(codes(validateScientificDesign(duplicate)).includes("scientific.conclusion.duplicated"), "repeated title/takeaway/render conclusion must be reported");

const repetition = deck([
  slide("r1", 1, { layout: { family: "comparison", variant: "image-compare" } }),
  slide("r2", 2, { layout: { family: "comparison", variant: "image-compare" } }),
  slide("r3", 3, { layout: { family: "comparison", variant: "image-compare" } }),
]);
assert(codes(validateScientificDesign(repetition)).includes("scientific.layout.variant_repetition"), "three consecutive identical variants must be reported");

const fakeCustomCanvas = deck(Array.from({ length: 6 }, (_, index) => slide(`fake-${index + 1}`, index + 1, index === 0 ? {
  layout: { family: "free_canvas", variant: "custom:fake" },
  render_data: { visual_focus: "假画布", custom_elements: [{}] },
  text_emphasis: [{ text: "假画布", role: "key" }],
} : {})));
const fakeCustomCodes = codes(validateScientificDesign(fakeCustomCanvas, { strict: true }));
assert(fakeCustomCodes.includes("scientific.free_canvas.elements_missing"), "an empty custom element must not count as an editable scientific canvas");
assert(fakeCustomCodes.includes("scientific.deck.paper_specific_canvas_absent"), "a decorative custom shell must not satisfy the paper-specific canvas requirement");

const decorativeCustomCanvas = structuredClone(fakeCustomCanvas);
decorativeCustomCanvas.slides[0].render_data.custom_elements = [
  { type: "shape", x: 80, y: 180, w: 260, h: 120 },
  { type: "shape", x: 380, y: 180, w: 260, h: 120 },
  { type: "text", text: "通用方法", x: 100, y: 200, w: 200, h: 50 },
];
const decorativeCustomCodes = codes(validateScientificDesign(decorativeCustomCanvas, { strict: true }));
assert(decorativeCustomCodes.includes("scientific.free_canvas.elements_missing"), "two blank boxes and generic text are not thesis-specific evidence");
assert(decorativeCustomCodes.includes("scientific.deck.paper_specific_canvas_absent"));

const humanitiesCanvas = deck(Array.from({ length: 6 }, (_, index) => slide(`argument-${index + 1}`, index + 1, index === 0 ? {
  layout: { family: "free_canvas", variant: "custom:source-bound-argument" },
  render_data: {
    custom_elements: [
      { type: "text", text: "原始史料中的关键表述", evidence_ref: "archive-quote", x: 80, y: 180, w: 470, h: 150 },
      { type: "annotation", text: "这一表述限定了概念的时代语境", x: 620, y: 190, w: 480, h: 110 },
      { type: "text", text: "对照反例显示该概念不能跨语境外推", x: 620, y: 350, w: 480, h: 90 },
    ],
  },
  text_emphasis: [{ text: "时代语境", role: "key" }],
} : {})), {
  sources: [{ id: "archive-quote", type: "thesis_text", title: "原始史料", citation: "论文第 3 章", verification_status: "verified" }],
});
const humanitiesCodes = codes(validateScientificDesign(humanitiesCanvas, { strict: true }));
assert(!humanitiesCodes.includes("scientific.free_canvas.elements_missing"), "source-bound quotation/text evidence must count as a thesis-specific editable evidence canvas");
assert(!humanitiesCodes.includes("scientific.deck.paper_specific_canvas_absent"), "argument-driven work must not be forced to add a metric, formula, or decorative image");

const familyFallbackShells = deck(Array.from({ length: 8 }, (_, index) => slide(`family-shell-${index + 1}`, index + 1, index === 7 ? {
  layout: { family: "free_canvas", variant: "custom:metric-evidence" },
  render_data: {
    visual_focus: "关键指标",
    custom_elements: [
      { type: "metric", text: "+24%", x: 100, y: 180, w: 220, h: 80 },
      { type: "annotation", text: "相对基线提升", x: 360, y: 180, w: 260, h: 80 },
      { type: "text", text: "验证工况", x: 100, y: 300, w: 220, h: 50 },
    ],
  },
} : {
  layout: { family: "comparison", variant: null },
  text_emphasis: index < 2 ? [{ text: `页面 ${index + 1}`, role: "key" }] : [],
})));
const familyFallbackCodes = codes(validateScientificDesign(familyFallbackShells, { strict: true }));
assert(familyFallbackCodes.includes("scientific.deck.layout_dominance"), "family fallback must be counted as the renderer's image-compare layout even when variant is empty");
assert(familyFallbackCodes.includes("scientific.deck.generic_shell_dominance"), "empty variants must not hide repeated generic shells");

const resultWithoutFocus = deck([slide("model-validation", 1, {
  narrative_roles: ["validation"],
  purpose: "验证解析模型与扫频结果",
  render_data: {},
  visuals: [{ id: "bode", type: "chart", include: true, crop: "contain", transformations: [] }],
})]);
assert(codes(validateScientificDesign(resultWithoutFocus)).includes("scientific.core_result.visual_focus_missing"), "core result/validation page must identify a visual focus");
const resultWithMetadataOnlyFocus = structuredClone(resultWithoutFocus);
resultWithMetadataOnlyFocus.slides[0].visual_focus = "45 Hz 敏感峰";
resultWithMetadataOnlyFocus.slides[0].render_data.visual_focus = "在曲线上直接标出 45 Hz";
resultWithMetadataOnlyFocus.slides[0].annotation_plan = ["标出 45 Hz 敏感峰"];
assert(
  codes(validateScientificDesign(resultWithMetadataOnlyFocus)).includes("scientific.core_result.visual_focus_missing"),
  "planning-only visual_focus/annotation_plan metadata must not masquerade as a rendered focal treatment",
);
const resultWithEmphasis = structuredClone(resultWithoutFocus);
resultWithEmphasis.slides[0].text_emphasis = [{ text: "45 Hz", role: "result" }];
assert(!codes(validateScientificDesign(resultWithEmphasis)).includes("scientific.core_result.visual_focus_missing"), "text emphasis must satisfy the per-slide focal gate");

const ignoredReadyVisual = structuredClone(resultWithoutFocus);
ignoredReadyVisual.assets = [{ id: "bode-ready", path: "assets/figures/ready/bode-annotated.png" }];
ignoredReadyVisual.slides[0].visuals[0].asset_ref = "bode-ready";
ignoredReadyVisual.slides[0].layout = { family: "summary", variant: "four-point-list" };
const ignoredReadyCodes = codes(validateScientificDesign(ignoredReadyVisual));
assert(ignoredReadyCodes.includes("scientific.visuals.renderer_mismatch"), "a ready visual must be rejected when the effective renderer ignores slide.visuals");
assert(ignoredReadyCodes.includes("scientific.core_result.visual_focus_missing"), "an ignored ready visual must not satisfy the core-result focal gate");

const ignoredFormula = deck([slide("ignored-formula", 1, {
  layout: { family: "summary", variant: "four-point-list" },
  formula: { include: true, asset_ref: "equation-ready", render_method: "latex_svg" },
  assets: undefined,
})], { assets: [{ id: "equation-ready", path: "assets/formulas/ready/equation.svg" }] });
assert(codes(validateScientificDesign(ignoredFormula)).includes("scientific.formula.renderer_mismatch"), "formula metadata must fail when the selected renderer never consumes it");

const invalidTopologyGallery = { ...structuredClone(nonlinear), artifact_purpose: "layout_gallery" };
const invalidGalleryResult = validateScientificDesign(invalidTopologyGallery, { strict: true });
assert.equal(invalidGalleryResult.library_gallery_exempt, true);
assert.equal(invalidGalleryResult.ok, false, "gallery exempts production narrative gates, not renderer/topology contradictions");
assert(codes(invalidGalleryResult).includes("scientific.diagram.linear_layout_mismatch"));

const gallery = deck([slide("gallery-shell", 1, {
  priority: undefined,
  audience_question: null,
  relationship_topology: undefined,
  render_data: {},
})], { artifact_purpose: "layout_gallery" });
const galleryResult = validateScientificDesign(gallery, { strict: true });
assert.equal(galleryResult.ok, true);
assert.equal(galleryResult.library_gallery_exempt, true);
assert.deepEqual(galleryResult.issues, []);

const bundledGallery = JSON.parse(await fs.readFile(path.join(SKILL_DIR, "assets", "final-defense-universal", "sample-deck-spec.json"), "utf8"));
const bundledGalleryResult = validateScientificDesign(bundledGallery, { strict: true });
assert.equal(bundledGalleryResult.library_gallery_exempt, true, "bundled layout gallery must be explicitly exempt");
assert.equal(bundledGalleryResult.ok, true, "a radial method renderer must not be mistaken for the method_design family's linear fallback");

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "academic-scientific-design-"));
try {
  const galleryPath = path.join(temporary, "gallery.json");
  await fs.writeFile(galleryPath, `${JSON.stringify(gallery)}\n`, "utf8");
  const cli = await execFileAsync(process.execPath, [VALIDATOR, galleryPath, "--json", "--strict"], { encoding: "utf8" });
  const cliResult = JSON.parse(cli.stdout);
  assert.equal(cliResult.ok, true);
  assert.equal(cliResult.library_gallery_exempt, true);

  const missingFormulaFile = deck([slide("missing-formula-file", 1, {
    purpose: "解释核心方程",
    layout: { family: "figure_formula", variant: "formula-visual" },
    formula: { include: true, asset_ref: "missing-equation", render_method: "latex_svg", latex: "x=y" },
    text_emphasis: [{ text: "核心方程", role: "key" }],
  })], { assets: [{ id: "missing-equation", path: "assets/formulas/ready/missing.svg" }] });
  const missingFormulaPath = path.join(temporary, "missing-formula.json");
  await fs.writeFile(missingFormulaPath, `${JSON.stringify(missingFormulaFile)}\n`, "utf8");
  const missingFormulaResult = await validateScientificDesignFile(missingFormulaPath);
  assert(codes(missingFormulaResult).includes("scientific.formula.asset_unavailable"), "a declared formula path must resolve to a real local file before it counts as rendered evidence");

  const missingReadyVisual = structuredClone(resultWithoutFocus);
  missingReadyVisual.assets = [{ id: "missing-ready-chart", path: "assets/figures/ready/missing.png" }];
  missingReadyVisual.slides[0].visuals[0].asset_ref = "missing-ready-chart";
  const missingReadyPath = path.join(temporary, "missing-ready-visual.json");
  await fs.writeFile(missingReadyPath, `${JSON.stringify(missingReadyVisual)}\n`, "utf8");
  const missingReadyResult = await validateScientificDesignFile(missingReadyPath);
  assert(codes(missingReadyResult).includes("scientific.core_result.visual_focus_missing"), "a ready-directory path that does not exist must not satisfy the rendered focal-treatment gate");
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}

console.log("PASS scientific-design quality gates");
