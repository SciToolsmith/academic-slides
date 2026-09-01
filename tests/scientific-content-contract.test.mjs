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
        claim: "The intervention changes the response.",
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

const v2Complete = fixture();
v2Complete.deck.literature.scientific_contract = "group_meeting_v2";
v2Complete.deck.claim_evidence_map[0].voice = "source_author_claim";
v2Complete.deck.slides[0].narrative_roles.push("method");
v2Complete.deck.claim_evidence_map.push({
  claim_id: "presenter-judgment-1",
  claim: "I think the in-distribution evidence is useful, but external validity remains unresolved.",
  voice: "presenter_critique",
  evidence_refs: ["evidence-figure-1"],
  slide_ids: ["finding-slide"],
});
v2Complete.deck.slides[0].content.bullets.push("I think the in-distribution evidence is useful, but external validity remains unresolved.");
const v2CompleteResult = validateScientificContent(v2Complete, { strict: true });
assert.equal(v2CompleteResult.ok, true, `group_meeting_v2 should pass with a visible evidence-bound presenter judgment: ${JSON.stringify(v2CompleteResult.issues)}`);

const v2MissingMethod = structuredClone(v2Complete);
v2MissingMethod.deck.slides[0].narrative_roles = v2MissingMethod.deck.slides[0].narrative_roles.filter((role) => role !== "method");
assert(codes(validateScientificContent(v2MissingMethod), "error").includes("scientific-content.roles.method-reconstruction.missing"), "v2 requires a method reconstruction separately from evidence generation");

const v2MissingEvidenceGeneration = structuredClone(v2Complete);
v2MissingEvidenceGeneration.deck.slides[0].narrative_roles = v2MissingEvidenceGeneration.deck.slides[0].narrative_roles.filter((role) => role !== "evidence_generation");
assert(codes(validateScientificContent(v2MissingEvidenceGeneration), "error").includes("scientific-content.roles.evidence-generation.missing"), "v2 requires evidence generation separately from the method reconstruction");

const v2MappedButInvisible = structuredClone(v2Complete);
v2MappedButInvisible.deck.slides[0].content.bullets.pop();
const v2MappedButInvisibleResult = validateScientificContent(v2MappedButInvisible);
assert(codes(v2MappedButInvisibleResult, "error").includes("scientific-content.presenter-voice.visible-evidence-missing"), "mapping a presenter claim to a slide is insufficient when its wording is not visible");

const v2HiddenPresenter = fixture();
v2HiddenPresenter.deck.literature.scientific_contract = "group_meeting_v2";
v2HiddenPresenter.deck.claim_evidence_map[0].voice = "source_author_claim";
const v2HiddenPresenterResult = validateScientificContent(v2HiddenPresenter);
assert.equal(v2HiddenPresenterResult.ok, false, "a presenter observation stored only in paper-index must not satisfy group_meeting_v2");
assert(codes(v2HiddenPresenterResult, "error").includes("scientific-content.presenter-voice.visible-evidence-missing"));

const v2MixedVoice = structuredClone(v2Complete);
v2MixedVoice.deck.claim_evidence_map[0].voice = "presenter_synthesis";
const v2MixedVoiceResult = validateScientificContent(v2MixedVoice);
assert(codes(v2MixedVoiceResult, "error").includes("scientific-content.core-finding.voice"), "a paper's core finding must not be rewritten as the student's own claim");

const selfProvingSuperiority = structuredClone(v2Complete);
selfProvingSuperiority.deck.claim_evidence_map[0].claim = "The proposed method outperforms the baseline.";
selfProvingSuperiority.evidenceIndex.evidence[0].evidence_role = "objective";
const superiorityResult = validateScientificContent(selfProvingSuperiority);
assert(codes(superiorityResult, "error").includes("scientific-content.superiority.independent-evidence-missing"), "superiority cannot be proved only by objective/training evidence");

const backgroundOnlySuperiority = structuredClone(v2Complete);
backgroundOnlySuperiority.deck.claim_evidence_map[0].claim = "The proposed method outperforms the baseline.";
backgroundOnlySuperiority.evidenceIndex.evidence[0].evidence_role = "background";
assert(codes(validateScientificContent(backgroundOnlySuperiority), "error").includes("scientific-content.superiority.independent-evidence-missing"), "background or missing evidence roles must not prove superiority");

const independentlyCompared = structuredClone(backgroundOnlySuperiority);
independentlyCompared.evidenceIndex.evidence[0].evidence_role = "comparison";
assert(!codes(validateScientificContent(independentlyCompared), "error").includes("scientific-content.superiority.independent-evidence-missing"), "comparison evidence may support a bounded superiority claim");

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
