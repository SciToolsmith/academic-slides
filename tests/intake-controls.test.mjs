#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runSkillEvals } from "../scripts/run-skill-evals.mjs";
import { validateDeckSpecFile, validateJsonValue } from "../scripts/validate-deck-spec.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(TEST_DIR, "..");

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(SKILL_DIR, relativePath), "utf8"));
}

function schemaErrors(value, schema) {
  const issues = [];
  validateJsonValue(value, schema, { rootSchema: schema, issues });
  return issues.filter((item) => item.severity === "error");
}

async function runFixtureMutation(tempDir, fixture, mutate) {
  const candidate = structuredClone(fixture);
  mutate(candidate);
  const fixturePath = path.join(tempDir, `fixture-${Math.random().toString(16).slice(2)}.json`);
  await writeFile(fixturePath, `${JSON.stringify(candidate, null, 2)}\n`, "utf8");
  return runSkillEvals({ skillDir: SKILL_DIR, fixture: fixturePath });
}

const [fixture, projectSchema, deckSchema, sampleDeck] = await Promise.all([
  readJson("evals/skill-evals.json"),
  readJson("schemas/project-config.schema.json"),
  readJson("schemas/deck-spec.schema.json"),
  readJson("assets/group-meeting-literature-universal/sample-deck-spec.json"),
]);

const baseline = await runSkillEvals({ skillDir: SKILL_DIR });
assert.equal(baseline.ok, true, JSON.stringify(baseline.findings, null, 2));
assert.equal(baseline.coverage.intake_controls, 4, "all four missing/provided intake combinations must be covered");

const tempDir = await mkdtemp(path.join(os.tmpdir(), "paper-club-ppt-intake-test-"));
try {
  const incompleteThemeList = await runFixtureMutation(tempDir, fixture, (candidate) => {
    const testCase = candidate.cases.find((item) => item.id === "default-page-and-theme");
    testCase.expected.availableThemePresets = ["blue", "red", "cyan"];
  });
  assert.equal(incompleteThemeList.ok, false, "omitting a built-in theme must fail the contract eval");
  assert(incompleteThemeList.findings.some((item) => item.code === "case.theme-presets"));

  const repeatedQuestion = await runFixtureMutation(tempDir, fixture, (candidate) => {
    const testCase = candidate.cases.find((item) => item.id === "default-page-only");
    testCase.expected.askControls.push("theme_policy");
  });
  assert.equal(repeatedQuestion.ok, false, "asking a supplied control again must fail the contract eval");
  assert(repeatedQuestion.findings.some((item) => item.code === "case.intake-ask-exact"));

  const durationQuestion = await runFixtureMutation(tempDir, fixture, (candidate) => {
    const testCase = candidate.cases.find((item) => item.id === "default-page-and-theme");
    testCase.expected.mustNotAsk = [];
  });
  assert.equal(durationQuestion.ok, false, "duration must remain outside the intake question");
  assert(durationQuestion.findings.some((item) => item.code === "case.duration-reprompt"));

  const requiredDuration = await runFixtureMutation(tempDir, fixture, (candidate) => {
    const testCase = candidate.cases.find((item) => item.id === "page-policy-controls-depth");
    testCase.variants.find((item) => item.pagePolicy === "auto" && !("durationMinutes" in item)).durationMinutes = 12;
  });
  assert.equal(requiredDuration.ok, false, "auto page planning must retain a no-duration variant");
  assert(requiredDuration.findings.some((item) => item.code === "case.duration-optional"));

  const legacyAdaptation = await runFixtureMutation(tempDir, fixture, (candidate) => {
    const testCase = candidate.cases.find((item) => item.id === "page-policy-controls-depth");
    testCase.variants = [
      { id: "short-auto", durationMinutes: 8, pagePolicy: "auto" },
      { id: "long-auto", durationMinutes: 20, pagePolicy: "auto" },
      { id: "fixed-15", durationMinutes: 15, pagePolicy: "fixed", targetSlideCount: 15 },
    ];
    testCase.expected = {
      autoDepthMonotonicWithDuration: true,
      fixedTargetMustMatchOrExplainConflict: true,
      durationIsApproximateNotExact: true,
    };
  });
  assert.equal(legacyAdaptation.ok, true, "the deterministic runner must remain compatible with the original adaptation fixture shape");

  const noDurationConfig = {
    schema_version: "1.1",
    project: { id: "intake-no-duration", name: "No-duration intake", language: "zh-CN" },
    input: { documents: [{ id: "paper-main", path: "paper.pdf", role: "focal_paper", format: "pdf" }] },
    presentation: {
      type: "group_meeting_literature",
      page_policy: { mode: "auto" },
      theme: { mode: "preset", preset: "blue", institution_branding: true },
      workflow_mode: "auto",
      aspect_ratio: "16:9",
    },
    academic_profile: { evidence_grammar: "mixed" },
    identity: { institution: "Example University", author: "Example Student" },
    constraints: { required_sections: [], required_content: [], excluded_content: [], confidential_content: [] },
    preferences: { speaker_notes: true, sources_in_notes: true, editable_output: true, include_appendix: false },
    literature_profile: { mode: "single_paper", focal_document_ids: ["paper-main"], emphasis: "balanced" },
    output: { project_directory: ".", filename_stem: "example_组会汇报", keep_intermediates: true, deploy_skill: false },
    assumptions: [],
  };
  assert.deepEqual(schemaErrors(noDurationConfig, projectSchema), [], "auto-page project config must validate without duration");

  const legacyProjectConfig = structuredClone(noDurationConfig);
  legacyProjectConfig.schema_version = "1.0";
  assert(
    schemaErrors(legacyProjectConfig, projectSchema).some((item) => item.code === "required" && item.path.includes("presentation")),
    "legacy 1.0 project config must preserve its original duration requirement",
  );
  legacyProjectConfig.presentation.duration_minutes = 15;
  assert.deepEqual(schemaErrors(legacyProjectConfig, projectSchema), [], "legacy 1.0 project config with duration must remain valid");

  const fixedConfig = structuredClone(noDurationConfig);
  fixedConfig.presentation.page_policy = { mode: "fixed" };
  assert(
    schemaErrors(fixedConfig, projectSchema).some((item) => item.code === "required" && item.path.includes("page_policy")),
    "fixed page policy must require target_slide_count",
  );
  fixedConfig.presentation.page_policy.target_slide_count = 18;
  assert.deepEqual(schemaErrors(fixedConfig, projectSchema), [], "fixed page policy with target N must validate without duration");

  const autoDeck = structuredClone(sampleDeck);
  delete autoDeck.timing.duration_minutes;
  delete autoDeck.timing.usable_fraction;
  delete autoDeck.timing.target_seconds;
  autoDeck.timing.page_policy = "auto";
  autoDeck.timing.target_slide_count = null;
  autoDeck.theme.preset = "blue";
  assert.deepEqual(schemaErrors(autoDeck, deckSchema), [], "auto-page deck spec must validate without duration fields");

  const orphanBudgetDeck = structuredClone(autoDeck);
  orphanBudgetDeck.timing.target_seconds = 45;
  assert(schemaErrors(orphanBudgetDeck, deckSchema).some((item) => item.code === "not"), "duration-derived fields must be absent when duration is omitted");

  const legacyDeck = structuredClone(sampleDeck);
  legacyDeck.schema_version = "1.0";
  delete legacyDeck.timing.page_policy;
  delete legacyDeck.timing.target_slide_count;
  delete legacyDeck.theme.preset;
  assert.deepEqual(schemaErrors(legacyDeck, deckSchema), [], "legacy 1.0 deck specs must remain valid without new page/theme controls");

  const autoDeckPath = path.join(tempDir, "auto-no-duration.json");
  await writeFile(autoDeckPath, `${JSON.stringify(autoDeck, null, 2)}\n`, "utf8");
  const autoValidation = await validateDeckSpecFile(autoDeckPath, { strict: false, requireSchema: true });
  assert.equal(autoValidation.issues.some((item) => item.severity === "error"), false, JSON.stringify(autoValidation.issues, null, 2));

  const fixedDeck = structuredClone(autoDeck);
  fixedDeck.timing.page_policy = "fixed";
  fixedDeck.timing.target_slide_count = fixedDeck.slides.length;
  const fixedDeckPath = path.join(tempDir, "fixed-valid.json");
  await writeFile(fixedDeckPath, `${JSON.stringify(fixedDeck, null, 2)}\n`, "utf8");
  const fixedValidation = await validateDeckSpecFile(fixedDeckPath, { strict: false, requireSchema: true });
  assert.equal(fixedValidation.issues.some((item) => item.code === "timing.slide-count.mismatch"), false, JSON.stringify(fixedValidation.issues, null, 2));

  const nullFixedDeck = structuredClone(fixedDeck);
  nullFixedDeck.timing.target_slide_count = null;
  assert(schemaErrors(nullFixedDeck, deckSchema).some((item) => item.code === "type"), "fixed page policy must reject a null target");
  const nullFixedPath = path.join(tempDir, "fixed-null.json");
  await writeFile(nullFixedPath, `${JSON.stringify(nullFixedDeck, null, 2)}\n`, "utf8");
  const nullFixedValidation = await validateDeckSpecFile(nullFixedPath, { strict: false, requireSchema: true });
  assert(nullFixedValidation.issues.some((item) => item.code === "timing.slide-count.invalid"), "semantic validation must reject a null fixed target");

  fixedDeck.timing.target_slide_count += 1;
  const mismatchedDeckPath = path.join(tempDir, "fixed-mismatch.json");
  await writeFile(mismatchedDeckPath, `${JSON.stringify(fixedDeck, null, 2)}\n`, "utf8");
  const mismatchedValidation = await validateDeckSpecFile(mismatchedDeckPath, { strict: false, requireSchema: true });
  assert(mismatchedValidation.issues.some((item) => item.code === "timing.slide-count.mismatch" && item.severity === "error"), "fixed N must fail when it differs from the slide count");

  const softDurationDeck = structuredClone(autoDeck);
  softDurationDeck.timing.duration_minutes = 1;
  softDurationDeck.timing.usable_fraction = 0.75;
  softDurationDeck.timing.target_seconds = 45;
  const softDurationPath = path.join(tempDir, "auto-soft-duration.json");
  await writeFile(softDurationPath, `${JSON.stringify(softDurationDeck, null, 2)}\n`, "utf8");
  const softDurationValidation = await validateDeckSpecFile(softDurationPath, { strict: false, requireSchema: true });
  assert.equal(softDurationValidation.issues.some((item) => item.severity === "error"), false, JSON.stringify(softDurationValidation.issues, null, 2));
  assert.equal(
    softDurationValidation.issues.some((item) => item.code === "timing.slide-count.mismatch"),
    false,
    "a supplied duration remains a soft hint and must not impose a slide count under auto policy",
  );
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log("PASS intake controls: nonblocking default-control intake, four themes, optional duration, and fixed N enforcement.");
