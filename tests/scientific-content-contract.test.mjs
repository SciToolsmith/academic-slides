#!/usr/bin/env node

import assert from "node:assert/strict";
import { validateScientificContent } from "../scripts/validate-scientific-content.mjs";

function codes(result, severity = null) {
  return result.issues
    .filter((item) => severity == null || item.severity === severity)
    .map((item) => item.code);
}

function fixture() {
  return {
    config: { schema_version: "1.1" },
    paperIndex: {
      schema_version: "1.0",
      mode: "single_paper",
      focal_paper_ids: ["paper-1"],
      papers: [{
        paper_id: "paper-1",
        analysis: {
          evidence_logic: "A controlled comparison isolates the intervention, and the observed response supports the mechanism claim.",
          method_formality: "non_equation",
          key_findings: [{
            id: "finding-1",
            claim_id: "claim-1",
            presentation_priority: "core",
            evidence_refs: ["evidence-figure-1"],
          }],
          credibility_checks: ["The ablation preserves the effect direction."],
          presenter_observations: ["The evidence is persuasive in-distribution, but external validity remains open."],
        },
      }],
    },
    evidenceIndex: {
      evidence: [{
        id: "evidence-figure-1",
        paper_id: "paper-1",
        asset_id: "figure-1",
        modality: "figure",
      }],
    },
    deck: {
      profile: "group_meeting_literature",
      literature: { mode: "single_paper", scientific_contract: "group_meeting_v1" },
      sources: [{ id: "evidence-figure-1", paper_id: "paper-1", asset_id: "figure-1" }],
      claim_evidence_map: [{
        claim_id: "claim-1",
        evidence_refs: ["evidence-figure-1"],
        slide_ids: ["finding-slide"],
      }],
      slides: [{
        id: "finding-slide",
        kind: "content",
        priority: "core",
        narrative_roles: ["why_read", "evidence_generation", "key_finding", "boundary", "presenter_judgment"],
        layout: { family: "hero_figure", variant: "image-left-text-right" },
        content: { title: "The intervention changes the response", bullets: ["The controlled comparison supports the core claim."] },
        visuals: [{
          include: true,
          type: "figure",
          role: "evidence",
          asset_ref: "figure-1",
          source_refs: ["evidence-figure-1"],
        }],
      }],
    },
    assetManifests: [],
  };
}

const complete = fixture();
const completeResult = validateScientificContent(complete, { strict: true });
assert.equal(completeResult.ok, true, `A complete non-equation contract should pass: ${JSON.stringify(completeResult.issues)}`);

const missingContractContent = fixture();
delete missingContractContent.paperIndex.papers[0].analysis.evidence_logic;
missingContractContent.paperIndex.papers[0].analysis.key_findings = [];
missingContractContent.paperIndex.papers[0].analysis.presenter_observations = [];
const missingResult = validateScientificContent(missingContractContent);
const missingErrors = codes(missingResult, "error");
assert.equal(missingResult.ok, false, "group_meeting_v1 must hard-fail when required scientific content is absent");
assert(missingErrors.includes("scientific-content.evidence-logic.missing"), "missing evidence logic must fail");
assert(missingErrors.includes("scientific-content.core-finding.missing"), "missing core finding must fail");
assert(missingErrors.includes("scientific-content.presenter-judgment.missing"), "missing presenter judgment must fail");

const declaredButNotRendered = fixture();
declaredButNotRendered.deck.slides[0].layout = { family: "summary", variant: "four-point-list" };
const notRenderedResult = validateScientificContent(declaredButNotRendered);
assert.equal(notRenderedResult.ok, false, "declaring a source visual must not satisfy the contract when its renderer does not consume it");
assert(codes(notRenderedResult, "error").includes("scientific-content.core-finding.visible-evidence-missing"));

const renderedSourceVisual = fixture();
const renderedResult = validateScientificContent(renderedSourceVisual);
assert.equal(renderedResult.ok, true, "a core finding with a renderer-consumed source visual should pass");
assert(!codes(renderedResult).includes("scientific-content.core-finding.visible-evidence-missing"));

const equationCentric = fixture();
equationCentric.paperIndex.papers[0].analysis.method_formality = "equation_centric";
const equationResult = validateScientificContent(equationCentric);
assert.equal(equationResult.ok, false, "an equation-centric paper with no rendered formula must fail");
assert(codes(equationResult, "error").includes("scientific-content.formula.required"));

const nonEquation = fixture();
nonEquation.paperIndex.papers[0].analysis.method_formality = "non_equation";
const nonEquationResult = validateScientificContent(nonEquation);
assert.equal(nonEquationResult.ok, true, "a non-equation paper may legitimately render zero formulas");
assert(!codes(nonEquationResult).includes("scientific-content.formula.required"));

const legacy = fixture();
legacy.deck.literature.scientific_contract = "legacy";
legacy.paperIndex.papers[0].analysis = {};
legacy.deck.slides[0].narrative_roles = [];
legacy.deck.slides[0].visuals = [];
legacy.deck.claim_evidence_map = [];
const legacyResult = validateScientificContent(legacy, { strict: true });
assert.equal(legacyResult.ok, true, "the legacy 1.0 contract must remain compatible even under strict validation");
assert(legacyResult.issues.length > 0, "legacy decks should still receive migration guidance");
assert(legacyResult.issues.every((item) => item.severity === "warning" && item.strict_exempt === true), "legacy guidance must never be promoted to a hard failure");

console.log("scientific content contract tests passed");
