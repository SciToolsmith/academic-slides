#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { latexCompilerArgs, validateMathExpression } from "../scripts/render-formula.mjs";
import { validateDeckSpec, validateJsonValue } from "../scripts/validate-deck-spec.mjs";
import { validateProject } from "../scripts/validate-project.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(TEST_DIR, "..");
const GALLERY_SPEC = path.join(SKILL_DIR, "assets", "group-meeting-literature-universal", "sample-deck-spec.json");

function testFormulaValidation() {
  assert.ok(latexCompilerArgs("/tmp/formula", "/tmp/formula/equation.tex").includes("-no-shell-escape"));
  const valid = [
    String.raw`F_h = \frac{M_h}{r_h} = 114\,\mathrm{N}`,
    String.raw`\sum_{i=1}^{n} x_i^2 \leq \alpha`,
    String.raw`\begin{bmatrix} a & b \\ c & d \end{bmatrix}`,
  ];
  for (const expression of valid) assert.equal(validateMathExpression(expression), expression);

  const malicious = [
    String.raw`\input{/etc/passwd}`,
    String.raw`x + \write18{touch /tmp/paper-club-ppt-pwned}`,
    String.raw`\begin{document}secret\end{document}`,
    String.raw`x % comment that changes the wrapper`,
    String.raw`^^5cinput{/etc/passwd}`,
    String.raw`\newcommand{\evil}{x}\evil`,
    String.raw`\unknowncommand{x}`,
  ];
  for (const expression of malicious) {
    assert.throws(() => validateMathExpression(expression), /Unsafe LaTeX expression/);
  }
}

async function createSelfContainedFixture(destination) {
  const deck = JSON.parse(await readFile(GALLERY_SPEC, "utf8"));
  deck.project_id = "p0-evidence-fixture";
  deck.literature = { mode: "single_paper", focal_paper_ids: ["paper-main"], scientific_contract: "legacy" };
  for (const source of deck.sources) source.document_id = "paper-main";
  const evidence = deck.sources.map((source) => ({
    id: source.id,
    type: "layout_policy",
    document_id: "paper-main",
    locator: source.path ?? source.citation ?? source.id,
    confidence: 1,
  }));

  const config = {
    schema_version: "1.1",
    project: { id: "p0-evidence-fixture", name: "Evidence closure fixture", language: "zh-CN" },
    input: { documents: [{ id: "paper-main", path: "source/paper.pdf", role: "focal_paper", format: "pdf" }] },
    presentation: {
      type: "group_meeting_literature",
      duration_minutes: deck.timing.duration_minutes,
      page_policy: { mode: "fixed", target_slide_count: deck.slides.length, include_appendix_in_count: true },
      theme: { mode: "preset", preset: "blue", institution_branding: false },
      workflow_mode: "auto",
      aspect_ratio: "16:9",
      output_language: "zh-CN",
    },
    academic_profile: { evidence_grammar: "mixed" },
    identity: { institution: null, author: "Fixture" },
    constraints: { required_sections: [], required_content: [], excluded_content: [], confidential_content: [] },
    preferences: { speaker_notes: true, sources_in_notes: true, editable_output: true, include_appendix: false },
    literature_profile: { mode: "single_paper", focal_document_ids: ["paper-main"], emphasis: "balanced" },
    output: { project_directory: ".", filename_stem: "fixture", keep_intermediates: true, deploy_skill: false },
    assumptions: [],
  };

  const sourceManifest = {
    schema_version: "1.0",
    project_id: "p0-evidence-fixture",
    documents: [{ id: "paper-main", role: "focal_paper", path: "source/paper.pdf" }],
    derived_sources: [{ id: "other-doc", role: "test-alternative", path: "source/other.txt" }],
  };
  const paperIndex = {
    schema_version: "1.0",
    project_id: "p0-evidence-fixture",
    mode: "single_paper",
    focal_paper_ids: ["paper-main"],
    generated_at: "2026-01-01T00:00:00Z",
    papers: [{
      paper_id: "paper-main",
      document_id: "paper-main",
      role: "focal",
      bibliography: { title: "Evidence Fixture Paper", authors: ["Fixture Author"], publication_type: "journal_article", venue: null, year_or_date: "2026" },
      metadata_verification: { status: "needs_review", verified_fields: [], sources: [] },
      analysis: { research_questions: [], gap: null, method: [], data_or_sample: null, key_findings: [], author_stated_limitations: [] },
      asset_manifest_path: null,
      presentation_priority: "core"
    }]
  };

  await mkdir(path.join(destination, "source"), { recursive: true });
  await writeFile(path.join(destination, "source", "paper.pdf"), "%PDF-1.4\n% deterministic test fixture\n", "utf8");
  await writeFile(path.join(destination, "source", "other.txt"), "fixture", "utf8");
  await writeFile(path.join(destination, "project-config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await writeFile(path.join(destination, "source-manifest.json"), `${JSON.stringify(sourceManifest, null, 2)}\n`, "utf8");
  await writeFile(path.join(destination, "paper-index.json"), `${JSON.stringify(paperIndex, null, 2)}\n`, "utf8");
  await writeFile(path.join(destination, "evidence-index.json"), `${JSON.stringify({ schema_version: "1.0", project_id: "p0-evidence-fixture", evidence }, null, 2)}\n`, "utf8");
  await writeFile(path.join(destination, "deck-spec.json"), `${JSON.stringify(deck, null, 2)}\n`, "utf8");
  await writeFile(path.join(destination, "PPT内容与设计大纲.md"), `# Evidence closure fixture\n\n${"This outline exists only to exercise deterministic cross-file validation. ".repeat(3)}\n`, "utf8");
}

async function testEvidenceClosure() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "paper-club-ppt-evidence-test-"));
  try {
    await createSelfContainedFixture(tempDir);
    const baseline = await validateProject(tempDir, { stage: "deck", strict: true, requireSchemas: true });
    assert.equal(baseline.ok, true, JSON.stringify(baseline.issues, null, 2));

    const paperPath = path.join(tempDir, "paper-index.json");
    const originalPaperIndex = JSON.parse(await readFile(paperPath, "utf8"));
    const paperSchema = JSON.parse(await readFile(path.join(SKILL_DIR, "schemas", "paper-index.schema.json"), "utf8"));
    const unknownAuthors = structuredClone(originalPaperIndex);
    unknownAuthors.papers[0].bibliography.authors = [];
    unknownAuthors.papers[0].metadata_verification = { status: "partial", verified_fields: ["title"], sources: [{ citation: "Provided excerpt", locator: "Heading 1" }] };
    unknownAuthors.papers[0].notes = "The provided excerpt does not contain an author list; authors remain unknown.";
    assert.deepEqual(validateJsonValue(unknownAuthors, paperSchema), [], "The schema must permit honest unknown authors without a placeholder name.");
    await writeFile(paperPath, JSON.stringify(unknownAuthors));
    const unknownAuthorsResult = await validateProject(tempDir, { stage: "deck", strict: true, requireSchemas: true });
    assert.equal(unknownAuthorsResult.ok, true, JSON.stringify(unknownAuthorsResult.issues, null, 2));
    for (const invalidCase of [
      { code: "paper-index.authors.unverified", mutate(paper) { paper.metadata_verification.status = "verified"; } },
      { code: "paper-index.authors.verified-field", mutate(paper) { paper.metadata_verification.verified_fields.push("authors"); } },
      { code: "paper-index.authors.verified-field", mutate(paper) { paper.metadata_verification.verified_fields.push("bibliography.authors"); } },
      { code: "paper-index.authors.missing-note", mutate(paper) { delete paper.notes; } },
      { code: "paper-index.authors.missing-note", mutate(paper) { paper.notes = "  "; } },
    ]) {
      const invalidIndex = structuredClone(unknownAuthors);
      invalidCase.mutate(invalidIndex.papers[0]);
      assert.ok(validateJsonValue(invalidIndex, paperSchema).length > 0, `${invalidCase.code} must also fail standalone schema validation.`);
      await writeFile(paperPath, JSON.stringify(invalidIndex));
      const rejected = await validateProject(tempDir, { stage: "deck", strict: true, requireSchemas: true });
      assert.equal(rejected.ok, false);
      assert.ok(rejected.issues.some((item) => item.code === invalidCase.code), `${invalidCase.code}: ${JSON.stringify(rejected.issues)}`);
    }
    await writeFile(paperPath, JSON.stringify(originalPaperIndex));

    const deckPath = path.join(tempDir, "deck-spec.json");
    const originalDeck = JSON.parse(await readFile(deckPath, "utf8"));
    const appendixDeck = structuredClone(originalDeck);
    appendixDeck.slides.at(-1).priority = "appendix";
    await writeFile(deckPath, JSON.stringify(appendixDeck));
    const appendixMismatch = await validateProject(tempDir, { stage: "deck", strict: true, requireSchemas: true });
    assert.ok(appendixMismatch.issues.some((item) => item.code === "deck.appendix-count-policy"));
    appendixDeck.timing.include_appendix_in_count = true;
    await writeFile(deckPath, JSON.stringify(appendixDeck));
    assert.equal((await validateProject(tempDir, { stage: "deck", strict: true, requireSchemas: true })).ok, true);
    await writeFile(deckPath, JSON.stringify(originalDeck));

    const evidencePath = path.join(tempDir, "evidence-index.json");
    const original = JSON.parse(await readFile(evidencePath, "utf8"));

    const missing = structuredClone(original);
    missing.evidence = missing.evidence.filter((entry) => entry.id !== "layout-registry");
    await writeFile(evidencePath, `${JSON.stringify(missing, null, 2)}\n`, "utf8");
    const missingResult = await validateProject(tempDir, { stage: "deck", strict: true, requireSchemas: true });
    assert.equal(missingResult.ok, false);
    assert.ok(missingResult.issues.some((item) => item.code === "evidence.source.unknown" || item.code === "evidence.reference.unknown"));

    const mismatched = structuredClone(original);
    mismatched.evidence.find((entry) => entry.id === "layout-registry").document_id = "other-doc";
    await writeFile(evidencePath, `${JSON.stringify(mismatched, null, 2)}\n`, "utf8");
    const mismatchResult = await validateProject(tempDir, { stage: "deck", strict: true, requireSchemas: true });
    assert.equal(mismatchResult.ok, false);
    assert.ok(mismatchResult.issues.some((item) => item.code === "evidence.document.mismatch"));

    const unknownDocument = structuredClone(original);
    unknownDocument.evidence.find((entry) => entry.id === "layout-registry").document_id = "missing-document";
    await writeFile(evidencePath, `${JSON.stringify(unknownDocument, null, 2)}\n`, "utf8");
    const unknownDocumentResult = await validateProject(tempDir, { stage: "deck", strict: true, requireSchemas: true });
    assert.equal(unknownDocumentResult.ok, false);
    assert.ok(unknownDocumentResult.issues.some((item) => item.code === "evidence.document.unknown"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function testAssetIdentity() {
  const sample = JSON.parse(await readFile(GALLERY_SPEC, "utf8"));
  const duplicate = structuredClone(sample);
  duplicate.assets = [
    { id: "duplicate-asset", path: "assets/a.png", type: "figure", alt_text: "A" },
    { id: "duplicate-asset", path: "assets/b.png", type: "figure", alt_text: "B" },
  ];
  const duplicateResult = await validateDeckSpec(duplicate, { strict: true, requireSchema: true });
  assert.ok(duplicateResult.issues.some((item) => item.code === "asset.id.duplicate"));

  const wrongLogo = structuredClone(sample);
  wrongLogo.assets = [{ id: "not-a-logo", path: "assets/figure.png", type: "figure", alt_text: "Figure" }];
  wrongLogo.theme.verified_logo_asset_id = "not-a-logo";
  const wrongLogoResult = await validateDeckSpec(wrongLogo, { strict: true, requireSchema: true });
  assert.ok(wrongLogoResult.issues.some((item) => item.code === "theme.logo.type"));
}

testFormulaValidation();
await testEvidenceClosure();
await testAssetIdentity();
console.log("PASS p0-security-and-evidence: safe formulas accepted, malicious TeX rejected, evidence closure enforced, and asset identities are unambiguous.");
