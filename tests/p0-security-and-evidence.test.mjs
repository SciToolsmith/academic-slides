#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { latexCompilerArgs, validateMathExpression } from "../scripts/render-formula.mjs";
import { validateDeckSpec } from "../scripts/validate-deck-spec.mjs";
import { validateProject } from "../scripts/validate-project.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(TEST_DIR, "..");
const GALLERY_SPEC = path.join(SKILL_DIR, "assets", "final-defense-universal", "sample-deck-spec.json");

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
    String.raw`x + \write18{touch /tmp/academic-slides-pwned}`,
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
  for (const source of deck.sources) source.document_id = "thesis-main";
  const evidence = deck.sources.map((source) => ({
    id: source.id,
    type: "layout_policy",
    document_id: "thesis-main",
    locator: source.path ?? source.citation ?? source.id,
    confidence: 1,
  }));

  const config = {
    schema_version: "1.0",
    project: { id: "p0-evidence-fixture", name: "Evidence closure fixture", language: "zh-CN" },
    input: { documents: [{ id: "thesis-main", path: "source/thesis.pdf", role: "main_thesis", format: "pdf" }] },
    presentation: {
      type: "final_defense",
      duration_minutes: deck.timing.duration_minutes,
      page_policy: { mode: "fixed", target_slide_count: deck.slides.length, include_appendix_in_count: true },
      theme: { mode: "preset", preset: "blue", institution_branding: false },
      workflow_mode: "auto",
      aspect_ratio: "16:9",
      output_language: "zh-CN",
    },
    academic_profile: { degree_level: "master", evidence_grammar: "mixed" },
    identity: { institution: null, author: "Fixture" },
    constraints: { required_sections: [], required_content: [], excluded_content: [], confidential_content: [] },
    preferences: { speaker_notes: true, sources_in_notes: true, editable_output: true, include_appendix: false },
    output: { project_directory: ".", filename_stem: "fixture", keep_intermediates: true, deploy_skill: false },
    assumptions: [],
  };

  const sourceManifest = {
    schema_version: "1.0",
    project_id: "p0-evidence-fixture",
    documents: [{ id: "thesis-main", role: "main_thesis", path: "source/thesis.pdf" }],
    derived_sources: [{ id: "other-doc", role: "test-alternative", path: "source/other.txt" }],
  };
  const figuresManifest = {
    schema_version: "1.0",
    project_id: "p0-evidence-fixture",
    source_document_id: "thesis-main",
    generated_at: "2026-01-01T00:00:00Z",
    extraction_summary: {
      detected_caption_count: 0,
      manifest_record_count: 0,
      file_count: 0,
      differences: [],
      status: "matched",
    },
    figures: [],
  };

  await mkdir(path.join(destination, "source"), { recursive: true });
  await mkdir(path.join(destination, "assets", "figures"), { recursive: true });
  await writeFile(path.join(destination, "source", "thesis.pdf"), "%PDF-1.4\n% deterministic test fixture\n", "utf8");
  await writeFile(path.join(destination, "source", "other.txt"), "fixture", "utf8");
  await writeFile(path.join(destination, "project-config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await writeFile(path.join(destination, "source-manifest.json"), `${JSON.stringify(sourceManifest, null, 2)}\n`, "utf8");
  await writeFile(path.join(destination, "thesis-analysis.json"), "{\"status\":\"fixture\"}\n", "utf8");
  await writeFile(path.join(destination, "evidence-index.json"), `${JSON.stringify({ schema_version: "1.0", project_id: "p0-evidence-fixture", evidence }, null, 2)}\n`, "utf8");
  await writeFile(path.join(destination, "deck-spec.json"), `${JSON.stringify(deck, null, 2)}\n`, "utf8");
  await writeFile(path.join(destination, "PPT内容与设计大纲.md"), `# Evidence closure fixture\n\n${"This outline exists only to exercise deterministic cross-file validation. ".repeat(3)}\n`, "utf8");
  await writeFile(path.join(destination, "assets", "figures", "figures.manifest.json"), `${JSON.stringify(figuresManifest, null, 2)}\n`, "utf8");
}

async function testEvidenceClosure() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "academic-slides-evidence-test-"));
  try {
    await createSelfContainedFixture(tempDir);
    const baseline = await validateProject(tempDir, { stage: "deck", strict: true, requireSchemas: true });
    assert.equal(baseline.ok, true, JSON.stringify(baseline.issues, null, 2));

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
