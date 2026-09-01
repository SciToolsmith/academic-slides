#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPresentationFromSpec } from "../scripts/presentation-core.mjs";
import { validateJsonValue } from "../scripts/validate-deck-spec.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(TEST_DIR, "..");

async function readJson(relative) {
  return JSON.parse(await readFile(path.join(SKILL_DIR, relative), "utf8"));
}

function findTextRuns(value, text, output = []) {
  if (!value || typeof value !== "object") return output;
  if (value.text === text && value.textStyle) output.push(value);
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) child.forEach((item) => findTextRuns(item, text, output));
    else if (child && typeof child === "object") findTextRuns(child, text, output);
  }
  return output;
}

function themeColors(preset) {
  return {
    primary: preset.primary,
    primary_dark: preset.primaryDark,
    primary_light: preset.primaryLight,
    accent: preset.accent,
    emphasis: preset.emphasis,
    background: "#FFFFFF",
    surface: "#F6F8FB",
    text: "#17213A",
    muted_text: "#5D667A",
    warning: preset.warning,
    chart_series: preset.chart,
  };
}

function oneSlideSpec(deck, slideId) {
  const spec = structuredClone(deck);
  spec.slides = [structuredClone(deck.slides.find((slide) => slide.id === slideId))];
  spec.slides[0].order = 1;
  return spec;
}

const [schema, deck, tokens, presets] = await Promise.all([
  readJson("schemas/deck-spec.schema.json"),
  readJson("assets/group-meeting-literature-universal/sample-deck-spec.json"),
  readJson("assets/group-meeting-literature-universal/design-tokens.json"),
  readJson("assets/group-meeting-literature-universal/theme-presets.json"),
]);

const overBudget = structuredClone(deck);
overBudget.slides[8].text_emphasis = [
  { text: "阶段末值", role: "key" },
  { text: "提高 24%", role: "result" },
  { text: "限定条件", role: "warning" },
];
const schemaIssues = [];
validateJsonValue(overBudget, schema, { rootSchema: schema, issues: schemaIssues });
assert(schemaIssues.some((item) => item.code === "maxItems"), "schema must reject more than two emphasis spans per slide");

for (const [presetName, preset] of Object.entries(presets.presets)) {
  const spec = oneSlideSpec(deck, "sample-table-chart-result");
  spec.slides[0].text_emphasis = [{ text: "效应随条件增强", role: "result" }];
  spec.theme.colors = themeColors(preset);
  const result = await createPresentationFromSpec(spec, { tokens, presets, theme: presetName, allowPlaceholder: true });
  const runs = findTextRuns(result.presentation.toProto(), "效应随条件增强");
  assert.equal(runs.length, 1, `${presetName} should export one exact emphasis run`);
  assert.equal(runs[0].textStyle.bold, true, `${presetName} emphasis should be bold`);
  assert.equal(runs[0].textStyle.fill?.color?.value, preset.emphasis.slice(1).toUpperCase(), `${presetName} should use its text-safe emphasis token`);
}

const legacySpec = oneSlideSpec(deck, "sample-table-chart-result");
legacySpec.slides[0].text_emphasis = [];
const legacyText = "需要加粗的整条项目符号";
legacySpec.slides[0].content.bullets = [{ text: legacyText, level: 0, emphasis: "strong", evidence_refs: ["layout-registry"] }];
const legacyResult = await createPresentationFromSpec(legacySpec, { tokens, presets, allowPlaceholder: true });
assert(findTextRuns(legacyResult.presentation.toProto(), legacyText).some((run) => run.textStyle.bold === true), "legacy bullet emphasis should remain bold");

const tableSpec = oneSlideSpec(deck, "sample-method-comparison");
tableSpec.slides[0].text_emphasis = [{ text: "混杂偏倚", role: "critical" }];
const tableResult = await createPresentationFromSpec(tableSpec, { tokens, presets, allowPlaceholder: true });
const tableRuns = findTextRuns(tableResult.presentation.toProto(), "混杂偏倚");
assert(tableRuns.length >= 1, "table-cell emphasis should export an exact rich-text run");
assert(tableRuns.some((run) => run.textStyle.bold === true), "table-cell emphasis should be bold");
assert(tableRuns.some((run) => run.textStyle.fill?.color?.value === "A5424A"), "critical table text should use the danger token");

const ambiguous = oneSlideSpec(deck, "sample-table-chart-result");
ambiguous.slides[0].content.title = "效应随条件增强";
ambiguous.slides[0].text_emphasis = [{ text: "效应随条件增强", role: "result" }];
await assert.rejects(
  () => createPresentationFromSpec(ambiguous, { tokens, presets, allowPlaceholder: true }),
  /must match exactly once/,
  "ambiguous emphasis text must fail fast",
);

const shell = oneSlideSpec(deck, "sample-group-cover");
shell.slides[0].text_emphasis = [{ text: shell.slides[0].content.title.slice(0, 4), role: "key" }];
await assert.rejects(
  () => createPresentationFromSpec(shell, { tokens, presets, allowPlaceholder: true }),
  /cannot use text_emphasis/,
  "cover pages must not use colored text emphasis",
);

console.log("PASS semantic text-emphasis tests");
