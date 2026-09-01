#!/usr/bin/env node

import { rendererVisualConsumption } from "./validate-scientific-design.mjs";

const GROUP_PROFILE = "group_meeting_literature";
const FORMULA_LAYOUTS = new Set(["formula-visual", "model-formula"]);
const SOURCE_VISUAL_TYPES = new Set(["figure", "table", "chart", "text_excerpt"]);

function list(value) {
  return Array.isArray(value) ? value : [];
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function issue(severity, code, pointer, message, options = {}) {
  const result = { severity, code, path: pointer, message };
  if (options.strictExempt === true) result.strict_exempt = true;
  return result;
}

function focalPapers(paperIndex) {
  const focalIds = new Set(list(paperIndex?.focal_paper_ids));
  return list(paperIndex?.papers).filter((paper) => focalIds.has(paper?.paper_id ?? paper?.id));
}

function evidenceMap(evidenceIndex) {
  return new Map(list(evidenceIndex?.evidence).map((record) => [clean(record?.id ?? record?.evidence_id), record]).filter(([id]) => id));
}

function sourceMap(deck) {
  return new Map(list(deck?.sources).map((record) => [clean(record?.id), record]).filter(([id]) => id));
}

function claimMap(deck) {
  return new Map(list(deck?.claim_evidence_map).map((record) => [clean(record?.claim_id), record]).filter(([id]) => id));
}

function mainSlides(deck) {
  return list(deck?.slides).filter((slide) => !["title", "agenda", "section", "closing", "appendix"].includes(clean(slide?.kind).toLowerCase())
    && clean(slide?.priority).toLowerCase() !== "appendix");
}

function slideById(deck) {
  return new Map(list(deck?.slides).map((slide) => [clean(slide?.id), slide]).filter(([id]) => id));
}

function customElements(slide) {
  return list(slide?.render_data?.custom_elements ?? slide?.render_data?.customElements ?? slide?.render_data?.elements);
}

function renderedFormula(slide) {
  if (slide?.formula?.include !== true) return false;
  const layoutId = rendererVisualConsumption(slide).layoutId;
  if (FORMULA_LAYOUTS.has(layoutId)) return true;
  if (layoutId !== "free-evidence") return false;
  const assetRef = clean(slide?.formula?.asset_ref);
  return customElements(slide).some((element) => {
    const type = clean(element?.type).toLowerCase();
    const role = clean(element?.role).toLowerCase();
    const ref = clean(element?.asset_ref ?? element?.assetRef ?? element?.asset ?? element?.path ?? element?.src);
    return (type === "formula" || role === "formula" || (assetRef && ref === assetRef));
  });
}

function renderedFormulaKeys(slide, evidenceById) {
  if (!renderedFormula(slide)) return new Set();
  const formula = slide.formula;
  const keys = new Set([
    clean(formula?.equation_ref),
    clean(formula?.asset_ref),
    ...list(formula?.source_refs).map(clean),
  ].filter(Boolean));
  for (const ref of list(formula?.source_refs)) {
    const record = evidenceById.get(ref);
    if (record?.asset_id) keys.add(clean(record.asset_id));
  }
  return keys;
}

function renderedSourceVisuals(slide) {
  return rendererVisualConsumption(slide).consumed.filter((visual) => SOURCE_VISUAL_TYPES.has(clean(visual?.type).toLowerCase())
    && !["branding", "decoration"].includes(clean(visual?.role).toLowerCase()));
}

function visualEvidenceKeys(visual, evidenceById) {
  const keys = new Set([clean(visual?.asset_ref), ...list(visual?.source_refs).map(clean)].filter(Boolean));
  for (const ref of list(visual?.source_refs)) {
    const record = evidenceById.get(ref);
    if (record?.asset_id) keys.add(clean(record.asset_id));
  }
  return keys;
}

function slideShowsFindingEvidence(slide, finding, evidenceById) {
  const findingRefs = new Set(list(finding?.evidence_refs));
  const findingAssetIds = new Set([...findingRefs].map((id) => clean(evidenceById.get(id)?.asset_id)).filter(Boolean));
  for (const visual of renderedSourceVisuals(slide)) {
    const keys = visualEvidenceKeys(visual, evidenceById);
    if ([...findingRefs, ...findingAssetIds].some((key) => keys.has(key))) return true;
  }
  const modalities = new Set([...findingRefs].map((id) => clean(evidenceById.get(id)?.modality).toLowerCase()).filter(Boolean));
  if (modalities.size > 0 && [...modalities].every((value) => value === "formula")) {
    const formulaKeys = renderedFormulaKeys(slide, evidenceById);
    return [...findingRefs, ...findingAssetIds].some((key) => formulaKeys.has(key));
  }
  return false;
}

function manifestRecords(assetManifests) {
  const records = [];
  for (const wrapper of list(assetManifests)) {
    const manifest = wrapper?.manifest ?? wrapper;
    const paperId = clean(wrapper?.paper_id ?? wrapper?.paperId);
    for (const asset of list(manifest?.assets)) records.push({ ...asset, paper_id: clean(asset?.paper_id) || paperId });
  }
  return records;
}

function eligibleVisualGroups(assetManifests) {
  const records = manifestRecords(assetManifests).filter((asset) => ["figure", "table"].includes(clean(asset?.kind ?? asset?.type).toLowerCase())
    && clean(asset?.selection?.priority ?? asset?.presentation_priority).toLowerCase() !== "exclude"
    && clean(asset?.crop?.status ?? asset?.materialization?.status).toLowerCase() !== "failed");
  const byAssetId = new Map();
  const groups = new Set();
  for (const asset of records) {
    const id = clean(asset?.id);
    const group = clean(asset?.group_id ?? asset?.groupId ?? id);
    if (id) byAssetId.set(id, { group, paper_id: asset.paper_id });
    if (group) groups.add(group);
  }
  return { records, byAssetId, groups };
}

function renderedVisualCoverage(deck, evidenceById, deckSources, eligibleById) {
  const groups = new Set();
  const paperIds = new Set();
  for (const slide of mainSlides(deck)) {
    for (const visual of renderedSourceVisuals(slide)) {
      const keys = visualEvidenceKeys(visual, evidenceById);
      for (const key of keys) {
        const record = evidenceById.get(key) ?? deckSources.get(key);
        const assetId = clean(record?.asset_id) || key;
        const eligible = eligibleById.get(assetId);
        if (eligible?.group) groups.add(eligible.group);
        else if (assetId) groups.add(assetId);
        const paperId = clean(record?.paper_id) || clean(eligible?.paper_id);
        if (paperId) paperIds.add(paperId);
      }
    }
  }
  return { groups, paperIds };
}

function finalize(findings, strict) {
  const issues = findings.map((item) => strict && item.severity === "warning" && item.strict_exempt !== true
    ? { ...item, severity: "error", promoted_by_strict: true }
    : item);
  const summary = issues.reduce((result, item) => {
    result[item.severity] = (result[item.severity] ?? 0) + 1;
    result.total += 1;
    return result;
  }, { error: 0, warning: 0, total: 0 });
  return { ok: summary.error === 0, strict, summary, issues };
}

export function validateScientificContent(input, options = {}) {
  const { config = {}, paperIndex = {}, evidenceIndex = {}, deck = {}, assetManifests = [] } = input ?? {};
  const findings = [];
  if (clean(deck?.profile).toLowerCase() !== GROUP_PROFILE) return finalize(findings, options.strict === true);

  const contractEnabled = deck?.literature?.scientific_contract === "group_meeting_v1"
    || paperIndex?.schema_version === "1.1"
    || config?.schema_version === "1.2";
  const contractIssue = (code, pointer, message) => issue(contractEnabled ? "error" : "warning", code, pointer, message, { strictExempt: !contractEnabled });
  const papers = focalPapers(paperIndex);
  const evidenceById = evidenceMap(evidenceIndex);
  const deckSources = sourceMap(deck);
  const claims = claimMap(deck);
  const slides = slideById(deck);
  const roles = new Set(mainSlides(deck).flatMap((slide) => list(slide?.narrative_roles).map((role) => clean(role).toLowerCase())));

  const roleGroups = [
    [["why_read", "gap", "research_question"], "framing", "Show why the paper matters and what question or gap it addresses."],
    [["method", "evidence_generation"], "evidence-generation", "Show how the authors generated the evidence, not only the method name."],
    [["key_finding", "validation"], "finding", "Show at least one evidence-bearing key finding or validation page."],
    [["credibility", "boundary"], "credibility-boundary", "Show a credibility check, uncertainty, limitation, or boundary condition."],
    [["presenter_judgment", "group_relevance", "discussion"], "presenter-voice", "Show the presenter's own synthesis, critique, application, or discussion question."],
  ];
  for (const [alternatives, code, message] of roleGroups) {
    if (!alternatives.some((role) => roles.has(role))) findings.push(contractIssue(`scientific-content.roles.${code}.missing`, "$/slides", message));
  }

  for (const [paperNumber, paper] of papers.entries()) {
    const analysis = paper?.analysis ?? {};
    const pointer = `$/papers/${paperNumber}/analysis`;
    if (!clean(analysis?.evidence_logic)) findings.push(contractIssue("scientific-content.evidence-logic.missing", `${pointer}/evidence_logic`, "Focal paper needs a concise evidence logic: design/observations → supported claims."));
    if (!clean(analysis?.method_formality)) findings.push(contractIssue("scientific-content.method-formality.missing", `${pointer}/method_formality`, "Classify the focal method as non_equation, equation_supported, or equation_centric before deciding formula coverage."));
    const coreFindings = list(analysis?.key_findings).filter((finding) => clean(finding?.presentation_priority).toLowerCase() === "core");
    if (coreFindings.length === 0) findings.push(contractIssue("scientific-content.core-finding.missing", `${pointer}/key_findings`, "At least one focal-paper finding must be marked presentation_priority=core."));
    if (list(analysis?.credibility_checks).length === 0 && list(analysis?.boundary_conditions).length === 0 && list(analysis?.author_stated_limitations).length === 0) {
      findings.push(contractIssue("scientific-content.credibility-boundary.missing", pointer, "Record at least one credibility check, limitation, or boundary condition."));
    }
    if (list(analysis?.presenter_observations).length === 0) findings.push(contractIssue("scientific-content.presenter-judgment.missing", `${pointer}/presenter_observations`, "Add at least one presenter synthesis, critique, question, or application judgment."));

    for (const finding of coreFindings) {
      const claimId = clean(finding?.claim_id ?? finding?.id);
      const claim = claims.get(claimId);
      if (!claim) {
        findings.push(contractIssue("scientific-content.core-finding.claim-missing", "$/claim_evidence_map", `Core finding ${clean(finding?.id) || "<unknown>"} has no claim-evidence mapping (${claimId || "missing claim id"}).`));
        continue;
      }
      const findingRefs = new Set(list(finding?.evidence_refs));
      if (!list(claim?.evidence_refs).some((ref) => findingRefs.has(ref))) {
        findings.push(contractIssue("scientific-content.core-finding.evidence-mismatch", `$/claim_evidence_map/${claimId}`, `Claim ${claimId} does not cite any evidence declared for its core finding.`));
      }
      const mappedSlides = list(claim?.slide_ids).map((id) => slides.get(id)).filter(Boolean);
      if (!mappedSlides.some((slide) => slideShowsFindingEvidence(slide, finding, evidenceById))) {
        findings.push(contractIssue("scientific-content.core-finding.visible-evidence-missing", `$/claim_evidence_map/${claimId}/slide_ids`, `Core finding ${clean(finding?.id) || claimId} is mapped to slides, but none renders its source visual (or its formula when the finding is formula-only).`));
      }
    }
  }

  const eligible = eligibleVisualGroups(assetManifests);
  const coverage = renderedVisualCoverage(deck, evidenceById, deckSources, eligible.byAssetId);
  const mode = clean(paperIndex?.mode ?? deck?.literature?.mode).toLowerCase();
  if (mode === "single_paper" && eligible.groups.size > 0) {
    const hardFloor = Math.min(eligible.groups.size, 5, Math.max(2, Math.ceil(eligible.groups.size * 0.20)));
    const recommended = Math.min(eligible.groups.size, 7, Math.max(hardFloor, Math.ceil(eligible.groups.size * 0.30)));
    if (coverage.groups.size < hardFloor) findings.push(contractIssue("scientific-content.visual.floor", "$/slides", `The deck renders ${coverage.groups.size} distinct source figure/table group(s); this paper needs at least ${hardFloor} to avoid an evidence-sparse report.`));
    else if (coverage.groups.size < recommended) findings.push(issue("warning", "scientific-content.visual.recommended", "$/slides", `The hard visual floor passes (${coverage.groups.size}/${hardFloor}); ${recommended} distinct source visual groups would be a useful target when they add explanatory value.`, { strictExempt: true }));
  }
  if (mode === "multi_paper") {
    for (const paperId of list(paperIndex?.focal_paper_ids)) {
      if (!coverage.paperIds.has(paperId)) findings.push(contractIssue("scientific-content.multi-paper.visual-coverage", "$/slides", `Focal paper ${paperId} has no rendered source visual in the main deck.`));
    }
  }

  const equationCentricPapers = papers.filter((paper) => clean(paper?.analysis?.method_formality).toLowerCase() === "equation_centric");
  if (equationCentricPapers.length > 0) {
    const formulaEvidence = list(evidenceIndex?.evidence).filter((record) => clean(record?.modality).toLowerCase() === "formula"
      && (!record?.paper_id || equationCentricPapers.some((paper) => (paper?.paper_id ?? paper?.id) === record.paper_id)));
    const coreFormulaKeys = new Set(formulaEvidence.filter((record) => record?.display_requirement === "main"
      || record?.presentation_priority === "core"
      || ["definition", "objective", "constraint", "method_core"].includes(record?.formula_role)).map((record) => clean(record?.id)).filter(Boolean));
    const renderedKeys = new Set(mainSlides(deck).flatMap((slide) => [...renderedFormulaKeys(slide, evidenceById)]));
    const renderedCount = list(deck?.slides).filter(renderedFormula).length;
    const minimum = Math.min(3, Math.max(1, Math.ceil(coreFormulaKeys.size * 0.10)));
    if (renderedCount < minimum) findings.push(contractIssue("scientific-content.formula.required", "$/slides", `Equation-centric method needs at least ${minimum} rendered core formula group(s); found ${renderedCount}.`));
    for (const record of formulaEvidence.filter((item) => item?.display_requirement === "main")) {
      const id = clean(record?.id);
      const assetId = clean(record?.asset_id);
      if (!renderedKeys.has(id) && (!assetId || !renderedKeys.has(assetId))) findings.push(contractIssue("scientific-content.formula.main-missing", "$/slides", `Core formula evidence ${id} is marked display_requirement=main but is not rendered in the main deck.`));
    }
  }

  return finalize(findings, options.strict === true);
}
