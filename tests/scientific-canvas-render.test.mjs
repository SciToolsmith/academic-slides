#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createPresentationFromSpec, exportPresentation } from "../scripts/presentation-core.mjs";

const execFileAsync = promisify(execFile);
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(TEST_DIR, "..");

async function readJson(relative) {
  return JSON.parse(await fs.readFile(path.join(SKILL_DIR, relative), "utf8"));
}

function makeOneSlideDeck(sample, layout, renderData, extra = {}) {
  const slide = structuredClone(sample.slides.find((item) => item.kind === "content"));
  slide.id = "scientific-canvas-test";
  slide.order = 1;
  slide.layout = layout;
  slide.render_data = renderData;
  slide.visuals = [];
  slide.text_emphasis = [];
  Object.assign(slide, extra);
  return {
    ...structuredClone(sample),
    sections: sample.sections.slice(0, 1),
    slides: [slide],
    timing: {
      ...sample.timing,
      estimated_seconds: slide.speaker_notes.estimated_seconds,
      target_slide_count: 1,
    },
    claim_evidence_map: [],
  };
}

const sample = await readJson("assets/group-meeting-literature-universal/sample-deck-spec.json");
const agendaSlide = structuredClone(sample.slides.find((item) => item.kind === "agenda"));
agendaSlide.id = "agenda-empty-fallback-test";
agendaSlide.order = 1;
agendaSlide.render_data = { sections: [] };
agendaSlide.content.body = [];
const agendaDeck = {
  ...structuredClone(sample),
  artifact_purpose: "production",
  sections: [
    { id: "problem", order: 1, title: "研究问题", short_title: "研究问题", role: "problem", audience_role: "main", show_in_agenda: true, show_in_navigation: true },
    { id: "method", order: 2, title: "研究方法", short_title: "研究方法", role: "method", audience_role: "main", show_in_agenda: true, show_in_navigation: true },
    { id: "results", order: 3, title: "研究结果", short_title: "研究结果", role: "results", audience_role: "main", show_in_agenda: true, show_in_navigation: true },
    { id: "appendix", order: 4, title: "绝不显示的附录材料", short_title: "绝不显示附录", role: "appendix", audience_role: "appendix", show_in_agenda: false, show_in_navigation: false },
  ],
  slides: [agendaSlide],
  claim_evidence_map: [],
};
const builtAgenda = await createPresentationFromSpec(agendaDeck, { allowPlaceholder: true });
const agendaTemporary = await fs.mkdtemp(path.join(os.tmpdir(), "paper-club-ppt-agenda-fallback-"));
try {
  const output = path.join(agendaTemporary, "agenda-fallback.pptx");
  await exportPresentation(builtAgenda.presentation, output);
  const slideXml = await execFileAsync("unzip", ["-p", output, "ppt/slides/slide1.xml"], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  for (const expected of ["研究问题", "研究方法", "研究结果"]) assert.match(slideXml.stdout, new RegExp(expected));
  assert.doesNotMatch(slideXml.stdout, /绝不显示/);
} finally {
  await fs.rm(agendaTemporary, { recursive: true, force: true });
}

const scientificDeck = makeOneSlideDeck(sample, {
  family: "free_canvas",
  variant: "custom:scientific-evidence",
  rationale: "A branch-and-converge scientific relationship needs a custom evidence canvas.",
  reading_order: ["shared model", "parallel scenes", "validation"],
}, {
  chrome: "none",
  custom_elements: [
    { type: "shape", name: "shared-model", text: "", x: 60, y: 220, w: 220, h: 100, fill: "primaryLight", line: "primary" },
    { type: "text", name: "shared-label", text: "公共模型", x: 84, y: 246, w: 170, h: 44, style: { fontSize: 22, bold: true, color: "primaryDark", alignment: "center" } },
    { type: "connector", name: "branch-up", direction: "right", x: 282, y: 192, w: 120, h: 18, color: "secondary" },
    { type: "connector", name: "branch-down", direction: "right", x: 282, y: 332, w: 120, h: 18, color: "secondary" },
    { type: "formula", name: "equation-slot", asset_ref: null, alt: "LaTeX 公式", x: 430, y: 176, w: 310, h: 86 },
    { type: "annotation", name: "claim-callout", text: "分支工况在同一验证层汇合", x: 780, y: 214, w: 360, h: 82, fill: "primaryLight", color: "emphasis" },
    { type: "highlight", name: "evidence-highlight", geometry: "ellipse", x: 430, y: 300, w: 250, h: 120, color: "emphasis" },
    { type: "metric", name: "result-metric", text: "+24%", x: 820, y: 344, w: 230, h: 66, color: "emphasis" },
  ],
}, {
  relationship_topology: "branch_converge",
  visual_focus: "parallel scene branches and the shared validation output",
  annotation_plan: ["mark the branch variables", "highlight the converged result"],
});

const built = await createPresentationFromSpec(scientificDeck, { allowPlaceholder: true });
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "paper-club-ppt-scientific-canvas-"));
try {
  const output = path.join(temporary, "scientific-canvas.pptx");
  await exportPresentation(built.presentation, output);
  assert.ok((await fs.stat(output)).size > 10_000);
  const slideXml = await execFileAsync("unzip", ["-p", output, "ppt/slides/slide1.xml"], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  for (const expected of ["shared-model", "branch-up-line", "claim-callout-box", "evidence-highlight", "result-metric"]) {
    assert.match(slideXml.stdout, new RegExp(expected), `expected editable scientific element ${expected}`);
  }
  assert.match(slideXml.stdout, /\+24%/);
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}

const wrongRibbon = makeOneSlideDeck(sample, {
  family: "process_flow",
  variant: "method-sequence",
  rationale: "Negative test",
  reading_order: ["model", "branch A", "branch B", "validation"],
}, {
  items: [
    { title: "公共模型", body: "入口" },
    { title: "分支 A", body: "并行场景" },
    { title: "分支 B", body: "并行场景" },
    { title: "验证", body: "汇合" },
  ],
}, { relationship_topology: "branch_converge" });

await assert.rejects(
  () => createPresentationFromSpec(wrongRibbon, { allowPlaceholder: true }),
  /cannot use the linear method-sequence renderer/,
  "a branch/converge relationship must not be rendered as a linear method sequence",
);

const wrongProcess = makeOneSlideDeck(sample, {
  family: "process_flow",
  variant: "research-evolution",
  rationale: "Negative test",
  reading_order: ["model", "parallel scenes", "validation"],
}, {}, {
  relationship_topology: "branch_converge",
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
});

await assert.rejects(
  () => createPresentationFromSpec(wrongProcess, { allowPlaceholder: true }),
  /cannot use the linear research-evolution renderer/,
  "the research-evolution renderer must reject branch/converge topology too",
);

const emptyProduction = makeOneSlideDeck(sample, {
  family: "selection",
  variant: "selection-rationale",
}, {}, {
  content: { title: "不得生成占位要点", body: [], bullets: [] },
  artifact_purpose: undefined,
});
emptyProduction.artifact_purpose = "production";
emptyProduction.slides[0].artifact_purpose = undefined;
await assert.rejects(
  () => createPresentationFromSpec(emptyProduction, { allowPlaceholder: true }),
  /incomplete payload.*needs explicit semantic items/,
  "production rendering must fail instead of injecting generic semanticItems copy",
);

const emptySummaryProduction = structuredClone(emptyProduction);
emptySummaryProduction.slides[0].kind = "summary";
emptySummaryProduction.slides[0].priority = "core";
await assert.rejects(
  () => createPresentationFromSpec(emptySummaryProduction, { allowPlaceholder: true }),
  /incomplete payload.*needs explicit semantic items/,
  "kind=summary must not bypass the same production payload gate as kind=content",
);

const partialClaimProduction = structuredClone(emptyProduction);
partialClaimProduction.slides[0].layout = { family: "evidence_chain", variant: "claim-evidence-boundary" };
partialClaimProduction.slides[0].render_data = {
  evidence: [{ title: "唯一证据", body: "" }],
  boundary: "结论只适用于已验证工况",
  verdict: "证据仍不足",
};
await assert.rejects(
  () => createPresentationFromSpec(partialClaimProduction, { allowPlaceholder: true }),
  /incomplete payload.*item 1 needs explicit evidence\/detail text/,
  "claim-evidence-boundary must fail before a partial item can inject renderer fallback prose",
);

const surplusVisualProduction = structuredClone(partialClaimProduction);
surplusVisualProduction.slides[0].layout = { family: "hero_figure", variant: "single-result-evidence" };
surplusVisualProduction.slides[0].render_data = { conclusion: "原始曲线展示临界频段变化" };
surplusVisualProduction.slides[0].visuals = [
  { type: "chart", include: true, asset_ref: "raw-first" },
  { type: "chart", include: true, asset_ref: "ready-second" },
];
surplusVisualProduction.assets = [
  { id: "raw-first", path: "assets/figures/raw/original.png" },
  { id: "ready-second", path: "assets/figures/ready/annotated.png" },
];
await assert.rejects(
  () => createPresentationFromSpec(surplusVisualProduction, { allowPlaceholder: true }),
  /declares 2 scientific visual\(s\).*consumes only 1/,
  "single-result-evidence must reject a second declared visual that its renderer never consumes",
);

const wrongAgendaRenderer = structuredClone(emptyProduction);
wrongAgendaRenderer.slides[0].kind = "agenda";
wrongAgendaRenderer.slides[0].priority = undefined;
wrongAgendaRenderer.slides[0].render_data = { items: [{ title: "伪目录" }] };
await assert.rejects(
  () => createPresentationFromSpec(wrongAgendaRenderer, { allowPlaceholder: true }),
  /kind=agenda.*selection-rationale.*expected one of: paper-agenda/,
  "production kind and effective shell renderer must remain consistent",
);

const crossProfileRenderer = structuredClone(emptyProduction);
crossProfileRenderer.slides[0].layout = { family: "title", variant: "cover" };
await assert.rejects(
  () => createPresentationFromSpec(crossProfileRenderer, { allowPlaceholder: true }),
  /Unknown layout variant "cover"/,
  "a removed workflow renderer must not be silently accepted",
);

const ignoredVisualRenderer = structuredClone(emptyProduction);
ignoredVisualRenderer.slides[0].render_data = { items: [{ title: "结论", body: "证据" }] };
ignoredVisualRenderer.slides[0].visuals = [{ type: "chart", include: true, asset_ref: "ignored-ready" }];
ignoredVisualRenderer.assets = [{ id: "ignored-ready", path: "assets/figures/ready/ignored.png" }];
await assert.rejects(
  () => createPresentationFromSpec(ignoredVisualRenderer, { allowPlaceholder: true }),
  /declares scientific visuals.*does not render them/,
  "declaring a ready visual on a non-visual renderer must fail rather than being silently ignored",
);

const ignoredFormulaRenderer = structuredClone(emptyProduction);
ignoredFormulaRenderer.slides[0].render_data = { items: [{ title: "方程", body: "说明" }] };
ignoredFormulaRenderer.slides[0].formula = { include: true, asset_ref: "ignored-formula", render_method: "latex_svg" };
ignoredFormulaRenderer.assets = [{ id: "ignored-formula", path: "assets/formulas/ready/ignored.svg" }];
await assert.rejects(
  () => createPresentationFromSpec(ignoredFormulaRenderer, { allowPlaceholder: true }),
  /formula\.include=true.*does not render that formula/,
  "formula metadata on a non-formula renderer must fail rather than being silently ignored",
);

console.log("scientific-canvas-render.test.mjs: PASS");
