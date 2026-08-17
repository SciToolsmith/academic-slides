#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPresentationFromSpec } from "../scripts/presentation-core.mjs";
import { validateDeckSpecFile, validateJsonValue } from "../scripts/validate-deck-spec.mjs";
import { validateProject } from "../scripts/validate-project.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(TEST_DIR, "..");

async function readJson(relative) {
  return JSON.parse(await readFile(path.join(SKILL_DIR, relative), "utf8"));
}

function schemaIssues(value, schema) {
  const issues = [];
  validateJsonValue(value, schema, { rootSchema: schema, issues });
  return issues.filter((item) => item.severity === "error");
}

const [projectSchema, deckSchema, evidenceSchema, milestoneSchema, registry, baseDeck, milestoneGallery] = await Promise.all([
  readJson("schemas/project-config.schema.json"),
  readJson("schemas/deck-spec.schema.json"),
  readJson("schemas/evidence-index.schema.json"),
  readJson("schemas/milestone-analysis.schema.json"),
  readJson("assets/profile-registry.json"),
  readJson("assets/final-defense-universal/sample-deck-spec.json"),
  readJson("assets/proposal-midterm-universal/sample-deck-spec.json"),
]);

assert.deepEqual(registry.profiles.proposal_midterm.modes, ["proposal", "midterm"]);
assert.equal(registry.profiles.proposal_midterm.expectedLayoutCount, 32);

const baseConfig = {
  schema_version: "1.0",
  project: { id: "milestone-test", name: "Milestone test", language: "zh-CN" },
  input: { documents: [{ id: "plan", path: "plan.pdf", role: "research_proposal", format: "pdf" }] },
  presentation: {
    type: "proposal_midterm",
    duration_minutes: 15,
    page_policy: { mode: "auto" },
    theme: { mode: "preset", preset: "blue" },
    workflow_mode: "auto",
    aspect_ratio: "16:9"
  },
  academic_profile: { degree_level: "master", evidence_grammar: "mixed" },
  milestone_profile: { mode: "proposal", plan_document_ids: ["plan"], progress_document_ids: [], emphasis: "balanced" },
  identity: { institution: "Example University", author: "Example Student" },
  constraints: { required_sections: [], required_content: [], excluded_content: [], confidential_content: [] },
  preferences: { speaker_notes: true, sources_in_notes: true, editable_output: true, include_appendix: true },
  output: { project_directory: "output", filename_stem: "proposal", keep_intermediates: true, deploy_skill: false },
  assumptions: []
};
assert.equal(schemaIssues(baseConfig, projectSchema).length, 0, "proposal project-config should validate");

const midtermConfig = structuredClone(baseConfig);
midtermConfig.input.documents.push({ id: "progress", path: "progress.pdf", role: "midterm_report", format: "pdf" });
midtermConfig.milestone_profile = { mode: "midterm", plan_document_ids: ["plan"], progress_document_ids: ["progress"], as_of_date: "2026-08-16", emphasis: "progress" };
assert.equal(schemaIssues(midtermConfig, projectSchema).length, 0, "midterm project-config should validate");
delete midtermConfig.milestone_profile.as_of_date;
assert(schemaIssues(midtermConfig, projectSchema).some((item) => item.code === "required"), "midterm config without as_of_date should fail");

const proposalDeck = structuredClone(baseDeck);
proposalDeck.profile = "proposal_midterm";
proposalDeck.milestone = {
  mode: "proposal",
  as_of_date: null,
  plan_document_ids: ["plan"],
  progress_document_ids: [],
  work_packages: [{ id: "wp1", title: "Work package", status: "planned", planned_output: "Verifiable output", evidence_refs: ["layout-registry"] }],
  review_question: "Is the proposed evidence path feasible?"
};
proposalDeck.slides[0].layout.variant = "custom:proposal-specific-free-variant";
proposalDeck.slides[1].layout.family = "free_canvas";
assert.equal(schemaIssues(proposalDeck, deckSchema).length, 0, "proposal deck should allow registered, custom variants and free_canvas");

const wrongProfileDeck = structuredClone(baseDeck);
wrongProfileDeck.profile = "final_defense";
wrongProfileDeck.slides = [structuredClone(wrongProfileDeck.slides[0])];
wrongProfileDeck.slides[0].layout.variant = "cover-short-title";
await assert.rejects(
  () => createPresentationFromSpec(wrongProfileDeck, { allowPlaceholder: true }),
  /belongs to profile=proposal_midterm/,
  "proposal/midterm-only layouts must fail fast under another profile",
);

const evidence = {
  schema_version: "1.0",
  project_id: "milestone-test",
  evidence: [{
    id: "progress-1",
    type: "progress_record",
    evidence_role: "progress_update",
    document_id: "progress",
    locator: "PDF page 3",
    as_of_date: "2026-08-16",
    research_status: "completed",
    related_evidence_ids: [],
    source_nature: "project_record",
    verification_status: "verified",
    confidence: 0.9
  }]
};
assert.equal(schemaIssues(evidence, evidenceSchema).length, 0, "dated progress evidence should validate");
delete evidence.evidence[0].as_of_date;
assert(schemaIssues(evidence, evidenceSchema).some((item) => item.code === "required"), "completed progress evidence without as_of_date should fail");

const analysis = {
  schema_version: "1.0",
  project_id: "milestone-test",
  mode: "midterm",
  as_of_date: "2026-08-16",
  plan_document_ids: ["plan"],
  progress_document_ids: ["progress"],
  objectives: [{ id: "objective-1", statement: "Test the research question", epistemic_status: "planned", evidence_refs: ["plan-1"] }],
  work_packages: [{ id: "wp1", title: "Work package", status: "completed", planned_output: "Dataset", baseline_evidence_refs: ["plan-1"], progress_evidence_refs: ["progress-1"] }],
  risks: []
};
assert.equal(schemaIssues(analysis, milestoneSchema).length, 0, "midterm milestone analysis should validate");

const projectDir = await mkdtemp(path.join(os.tmpdir(), "academic-slides-milestone-"));
try {
  await mkdir(path.join(projectDir, "qa"), { recursive: true });
  const baselineOptionalDeck = structuredClone(milestoneGallery);
  baselineOptionalDeck.milestone.mode = "midterm";
  baselineOptionalDeck.milestone.as_of_date = "2026-08-16";
  baselineOptionalDeck.milestone.plan_document_ids = [];
  baselineOptionalDeck.milestone.progress_document_ids = ["gallery-progress"];
  const baselineOptionalPath = path.join(projectDir, "baseline-optional-deck.json");
  await writeFile(baselineOptionalPath, JSON.stringify(baselineOptionalDeck, null, 2));
  const baselineOptionalResult = await validateDeckSpecFile(baselineOptionalPath, { strict: true, requireSchema: true });
  assert.equal(
    baselineOptionalResult.issues.some((item) => item.severity === "error"),
    false,
    "a disclosed missing midterm baseline must remain buildable in strict mode",
  );
  assert(
    baselineOptionalResult.issues.some((item) => item.code === "milestone.baseline.missing" && item.severity === "warning"),
    "a missing midterm baseline should remain an explicit non-blocking warning",
  );
  await Promise.all([
    writeFile(path.join(projectDir, "plan.pdf"), "plan fixture\n"),
    writeFile(path.join(projectDir, "progress.pdf"), "progress fixture\n"),
    writeFile(path.join(projectDir, "PPT内容与设计大纲.md"), `# Midterm outline\n\n${"Evidence-based outline. ".repeat(8)}\n`),
  ]);
  const projectConfig = structuredClone(baseConfig);
  projectConfig.input.documents = [
    { id: "plan", path: "plan.pdf", role: "approved_plan", format: "pdf" },
    { id: "progress", path: "progress.pdf", role: "midterm_report", format: "pdf" }
  ];
  projectConfig.presentation.duration_minutes = 8;
  projectConfig.milestone_profile = { mode: "midterm", plan_document_ids: ["plan"], progress_document_ids: ["progress"], as_of_date: "2026-08-16", emphasis: "progress" };
  projectConfig.output = { project_directory: ".", filename_stem: "midterm", keep_intermediates: true, deploy_skill: false };
  const projectEvidence = {
    schema_version: "1.0",
    project_id: "milestone-test",
    evidence: [
      { id: "layout-registry", type: "user_material", locator: "layout-registry.json", source_nature: "author_original", verification_status: "verified", confidence: 1 },
      { id: "design-tokens", type: "user_material", locator: "design-tokens.json", source_nature: "author_original", verification_status: "verified", confidence: 1 },
      { id: "plan-1", type: "approved_plan", evidence_role: "plan_commitment", document_id: "plan", locator: "PDF page 2", research_status: "planned", source_nature: "project_record", verification_status: "verified", confidence: 1 },
      { id: "progress-1", type: "progress_record", evidence_role: "completed_result", document_id: "progress", locator: "PDF page 4", as_of_date: "2026-08-16", research_status: "completed", source_nature: "project_record", verification_status: "verified", confidence: 0.9 }
    ]
  };
  const projectAnalysis = structuredClone(analysis);
  const projectDeck = structuredClone(proposalDeck);
  projectDeck.project_id = "milestone-test";
  projectDeck.profile = "proposal_midterm";
  projectDeck.milestone = {
    mode: "midterm",
    as_of_date: "2026-08-16",
    plan_document_ids: ["plan"],
    progress_document_ids: ["progress"],
    work_packages: [{ id: "wp1", title: "Work package", status: "completed", planned_output: "Dataset", actual_output: "Dataset v1", evidence_refs: ["progress-1"] }],
    review_question: "Can the remaining work converge on schedule?"
  };
  projectDeck.sources.push(
    { id: "plan-1", type: "approved_plan", title: "Approved plan", citation: "Approved plan, page 2", document_id: "plan", path: "plan.pdf", url: null, creator: null, published_at: null, accessed_at: null, source_nature: "project_record", verification_status: "verified", notes: null },
    { id: "progress-1", type: "progress_record", title: "Progress record", citation: "Midterm report, page 4", document_id: "progress", path: "progress.pdf", url: null, creator: null, published_at: null, accessed_at: null, source_nature: "project_record", verification_status: "verified", notes: null }
  );
  await Promise.all([
    writeFile(path.join(projectDir, "project-config.json"), JSON.stringify(projectConfig, null, 2)),
    writeFile(path.join(projectDir, "source-manifest.json"), JSON.stringify({ project_id: "milestone-test", documents: [{ id: "plan" }, { id: "progress" }], derived_sources: [] }, null, 2)),
    writeFile(path.join(projectDir, "evidence-index.json"), JSON.stringify(projectEvidence, null, 2)),
    writeFile(path.join(projectDir, "milestone-analysis.json"), JSON.stringify(projectAnalysis, null, 2)),
    writeFile(path.join(projectDir, "deck-spec.json"), JSON.stringify(projectDeck, null, 2)),
  ]);
  const projectResult = await validateProject(projectDir, { stage: "deck", strict: false, requireSchemas: true });
  assert.equal(projectResult.ok, true, projectResult.issues.map((item) => `${item.code}: ${item.message}`).join("\n"));

  projectDeck.slides[0].layout.variant = "plan-vs-actual";
  projectDeck.slides[0].evidence_refs = ["progress-1"];
  projectDeck.slides[0].speaker_notes.sources = [{ source_id: "progress-1", locator: "PDF page 4", citation: "Midterm report, page 4", purpose: "current progress" }];
  await writeFile(path.join(projectDir, "deck-spec.json"), JSON.stringify(projectDeck, null, 2));
  const brokenClosure = await validateProject(projectDir, { stage: "deck", strict: false, requireSchemas: true });
  assert.equal(brokenClosure.ok, false, "plan-vs-actual without plan evidence should fail");
  assert(brokenClosure.issues.some((item) => ["deck.milestone.plan-actual.evidence", "evidence.milestone.plan-actual"].includes(item.code)), "missing plan evidence should produce a milestone closure error");
} finally {
  await rm(projectDir, { recursive: true, force: true });
}

console.log("PASS proposal-midterm contract tests");
