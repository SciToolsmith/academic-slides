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

const sample = await readJson("assets/final-defense-universal/sample-deck-spec.json");
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
const agendaTemporary = await fs.mkdtemp(path.join(os.tmpdir(), "academic-slides-agenda-fallback-"));
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
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "academic-slides-scientific-canvas-"));
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
  variant: "four-step-ribbon",
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
  /cannot use four-step-ribbon/,
  "a branch/converge relationship must not be rendered as a linear four-step ribbon",
);

const wrongProcess = makeOneSlideDeck(sample, {
  family: "process_flow",
  variant: "process",
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
  /cannot use the linear process renderer/,
  "the generic process renderer must reject branch/converge topology too",
);

console.log("scientific-canvas-render.test.mjs: PASS");
