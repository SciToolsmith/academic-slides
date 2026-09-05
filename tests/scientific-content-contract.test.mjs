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
        layout: { family: "hero_figure", variant: "single-result-evidence" },
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
declaredButNotRendered.deck.slides[0].layout = { family: "contribution_limits", variant: "critical-appraisal" };
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

for (const claim of [
  "The proposed method outperforms the baseline.",
  "The proposed method achieves the best accuracy across all baselines.",
  "The proposed method has the highest precision among tested methods.",
  "本方法优于所测试的基线。",
  "本方法在所有基线中具有最佳性能。",
  "不优于基线A，但优于基线B。",
  "The method not only outperforms the baseline but also uses less memory.",
  "The method does not improve runtime, but achieves the best accuracy across all baselines.",
]) {
  const candidate = structuredClone(v2Complete);
  candidate.deck.claim_evidence_map[0].claim = claim;
  candidate.evidenceIndex.evidence[0].evidence_role = "objective";
  assert(codes(validateScientificContent(candidate, { strict: true })).includes("scientific-content.superiority.independent-evidence-missing"), `affirmative comparison requires comparison evidence: ${claim}`);
  candidate.evidenceIndex.evidence[0].evidence_role = "comparison";
  assert.equal(validateScientificContent(candidate, { strict: true }).ok, true, `same wording with comparison evidence satisfies the structural screen: ${claim}`);
}
for (const claim of [
  "This evidence does not establish that the method outperforms any baseline.",
  "No evidence establishes that this method achieves the best accuracy.",
  "The method is not better than the baseline.",
  "现有证据未证明本方法优于基线。",
  "这些结果不足以证明本方法具有最佳性能。",
  "不优于基线方法。",
  "未优于基线方法。",
  "本方法并不优于所测基线。",
]) {
  const candidate = structuredClone(v2Complete);
  candidate.deck.claim_evidence_map[0].claim = claim;
  candidate.evidenceIndex.evidence[0].evidence_role = "objective";
  assert.equal(validateScientificContent(candidate, { strict: true }).ok, true, `cautious wording must not be treated as affirmative superiority: ${claim}`);
}
const explicitComparison = structuredClone(v2Complete);
explicitComparison.deck.claim_evidence_map[0].claim = "The method dominates the tested baseline.";
explicitComparison.deck.claim_evidence_map[0].comparison_assertion = "affirmed";
explicitComparison.deck.claim_evidence_map[0].comparison_review_reason = "This sentence asserts dominance over the named baseline; verify its held-out comparison.";
explicitComparison.evidenceIndex.evidence[0].evidence_role = "objective";
assert(codes(validateScientificContent(explicitComparison)).includes("scientific-content.superiority.independent-evidence-missing"), "an explicit reviewed comparison works outside the bounded language vocabulary");
explicitComparison.deck.claim_evidence_map[0].comparison_assertion = "not_applicable";
delete explicitComparison.deck.claim_evidence_map[0].comparison_review_reason;
assert(codes(validateScientificContent(explicitComparison)).includes("scientific-content.comparison.review-incomplete"), "an override requires a review reason");
const conflictingReview = structuredClone(selfProvingSuperiority);
conflictingReview.deck.claim_evidence_map[0].comparison_assertion = "not_established";
conflictingReview.deck.claim_evidence_map[0].comparison_review_reason = "The source does not support the comparison.";
assert(codes(validateScientificContent(conflictingReview)).includes("scientific-content.comparison.review-language-conflict"), "a metadata override cannot silently erase an affirmative language cue");
assert.equal(validateScientificContent(v2Complete).scope, "structure_and_language_risk_checks");

const sharedComparison = structuredClone(v2Complete);
sharedComparison.deck.structure = { narrative_mode: "question_comparison" };
sharedComparison.paperIndex.mode = sharedComparison.deck.literature.mode = "multi_paper";
sharedComparison.paperIndex.focal_paper_ids.push("paper-2");
const secondPaper = structuredClone(sharedComparison.paperIndex.papers[0]);
secondPaper.paper_id = "paper-2";
secondPaper.analysis.key_findings = [{ id: "finding-2", claim_id: "claim-2", presentation_priority: "core", evidence_refs: ["evidence-figure-2"] }];
sharedComparison.paperIndex.papers.push(secondPaper);
sharedComparison.evidenceIndex.evidence.push({ id: "evidence-figure-2", paper_id: "paper-2", asset_id: "figure-2", modality: "figure" });
sharedComparison.deck.sources.push({ id: "evidence-figure-2", paper_id: "paper-2", asset_id: "figure-2" });
sharedComparison.deck.claim_evidence_map.push({ claim_id: "claim-2", claim: "The second controlled observation replicates the direction.", voice: "source_author_claim", evidence_refs: ["evidence-figure-2"], slide_ids: ["finding-slide"] });
sharedComparison.deck.slides[0].layout = { family: "comparison", variant: "result-compare" };
sharedComparison.deck.slides[0].paper_ids = ["paper-1", "paper-2"];
sharedComparison.deck.slides[0].visuals.push({ include: true, type: "figure", role: "evidence", asset_ref: "figure-2", source_refs: ["evidence-figure-2"] });
sharedComparison.assetManifests = [1, 2].map((id) => ({ paper_id: `paper-${id}`, manifest: { assets: [{ id: `figure-${id}`, kind: "figure" }] } }));
assert.equal(validateScientificContent(sharedComparison, { strict: true }).ok, true, "a source-linked shared comparison page can cover both focal papers without duplicating their sequence");
const missingSecondSource = structuredClone(sharedComparison);
missingSecondSource.deck.slides[0].visuals.pop();
assert(codes(validateScientificContent(missingSecondSource)).includes("scientific-content.comparison.paper-source-missing"), "paper_ids alone cannot replace a source link");
assert(codes(validateScientificContent(missingSecondSource)).includes("scientific-content.comparison.paper-role-missing"), "the second paper cannot borrow the first paper's coverage");

const appendixEvidence = structuredClone(v2Complete);
appendixEvidence.deck.sections = [{ id: "backup", audience_role: "appendix" }];
appendixEvidence.deck.slides[0].section_id = "backup";
assert(codes(validateScientificContent(appendixEvidence)).includes("scientific-content.core-finding.visible-evidence-missing"), "backup evidence cannot satisfy a core finding in the main deck");
const discussionClosing = structuredClone(v2Complete);
discussionClosing.deck.structure = { closing_mode: "discussion" };
discussionClosing.deck.slides[0].kind = "closing";
assert.equal(validateScientificContent(discussionClosing, { strict: true }).ok, true, "an explicitly substantive discussion closing contributes main-deck evidence coverage");
discussionClosing.deck.structure.closing_mode = "thanks";
assert(codes(validateScientificContent(discussionClosing)).includes("scientific-content.core-finding.visible-evidence-missing"), "a thanks closing cannot conceal required main-deck evidence");

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
