#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const LINEAR_VARIANT_PATTERN = /(?:^|[-_ ])(?:four[-_ ]?step(?:[-_ ]?ribbon)?|step[-_ ]?ribbon|linear(?:[-_ ]?process)?|arrow[-_ ]?sequence|pipeline|stair(?:case)?|timeline)(?:$|[-_ ])/i;
const NONLINEAR_RELATION_PATTERN = /branch|fork|parallel|converg|join|merge|feedback|loop|bifurcat|分支|并行|汇合|收敛|合流|反馈|循环/i;
const RESULT_VALIDATION_PATTERN = /result|validation|verify|verification|finding|结果|验证|核验|发现/i;
const CONCLUSION_KEY_PATTERN = /(?:^|_)(?:conclusion|takeaway|summary)(?:$|_)/i;
const COMPLEX_TRANSFORM_PATTERN = /complex|复杂|multi[-_ ]?panel|多面板/i;

function issue(severity, code, pointer, message, options = {}) {
  const output = { severity, code, path: pointer, message };
  if (options.slideId) output.slide_id = options.slideId;
  if (options.order != null) output.order = options.order;
  return output;
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isLibraryGallery(deck) {
  return clean(deck?.artifact_purpose).toLowerCase() === "layout_gallery";
}

function slidePointer(index, suffix = "") {
  return `$/slides/${index}${suffix}`;
}

function slideOptions(slide) {
  return { slideId: clean(slide?.id) || undefined, order: slide?.order };
}

function transformationText(visual) {
  return list(visual?.transformations).map((item) => typeof item === "string" ? item : JSON.stringify(item)).join(" ");
}

function readyDerivedAssetIds(deck) {
  return new Set(list(deck?.assets)
    .filter((asset) => /(?:^|\/)ready(?:\/|$)/i.test(clean(asset?.path).replaceAll("\\", "/")))
    .map((asset) => clean(asset?.id))
    .filter(Boolean));
}

function declaredAssetIds(deck) {
  return new Set(list(deck?.assets).map((asset) => clean(asset?.id)).filter(Boolean));
}

function declaredEvidenceIds(deck) {
  return new Set([
    ...list(deck?.sources).map((source) => clean(source?.id)),
    ...list(deck?.claim_evidence_map).map((claim) => clean(claim?.claim_id)),
  ].filter(Boolean));
}

function hasPresentationTreatment(visual, readyAssetIds) {
  const assetRef = clean(visual?.asset_ref ?? visual?.assetRef);
  return Boolean(assetRef && readyAssetIds.has(assetRef));
}

function hasVisualFocus(slide, readyAssetIds, assetIds, evidenceIds) {
  return list(slide?.text_emphasis).length > 0
    || list(slide?.visuals).some((visual) => visual?.include !== false && hasPresentationTreatment(visual, readyAssetIds))
    || hasRenderedCanvasTreatment(slide, assetIds, evidenceIds);
}

function includedScientificVisuals(slide) {
  return list(slide?.visuals).filter((visual) => {
    if (!visual || visual.include === false) return false;
    const type = clean(visual.type).toLowerCase();
    return !["logo", "branding", "decorative", "icon"].includes(type);
  });
}

function isComplexVisual(visual) {
  const type = clean(visual?.type).toLowerCase();
  return ["chart", "diagram"].includes(type) || COMPLEX_TRANSFORM_PATTERN.test(transformationText(visual));
}

function isDualColumnLayout(slide, scientificVisuals) {
  const family = clean(slide?.layout?.family).toLowerCase();
  const variant = clean(slide?.layout?.variant).toLowerCase();
  return scientificVisuals.length >= 2
    && (/comparison|two[-_ ]?(?:column|image)|image[-_ ]?compare|side[-_ ]?by[-_ ]?side|双栏|双图/.test(`${family} ${variant}`));
}

function isLinearVariant(slide) {
  return LINEAR_VARIANT_PATTERN.test(clean(slide?.layout?.variant).toLowerCase());
}

function isProcessShell(slide) {
  // The renderer dispatches by the resolved layout ID, not by the broad
  // semantic family. A method_design family can legitimately select a radial
  // or other non-process renderer, so treating the family itself as a linear
  // process would reject a topology the chosen renderer actually supports.
  return ["process", "method-sequence", "four-step-ribbon"].includes(effectiveLayoutId(slide));
}

function effectiveLayoutId(slide) {
  const variant = clean(slide?.layout?.variant).toLowerCase().replaceAll("_", "-");
  if (variant) return variant;
  const family = clean(slide?.layout?.family).toLowerCase();
  const fallback = {
    title: "cover",
    agenda: "agenda",
    section: "section-divider",
    hero_figure: "image-left-text-right",
    comparison: "image-compare",
    chart_insight: "chart-insight",
    figure_formula: "formula-visual",
    process_flow: "process",
    system_architecture: "framework",
    evidence_chain: "claim-evidence",
    quote_analysis: "quote-analysis",
    case_matrix: "case-compare",
    method_design: "process",
    validation_matrix: "validation-matrix",
    contribution_limits: "contribution",
    summary: "contribution",
    closing: "closing",
    free_canvas: "free-evidence",
  };
  return fallback[family] ?? family.replaceAll("_", "-");
}

function customCanvasElements(slide) {
  return list(slide?.render_data?.custom_elements ?? slide?.render_data?.customElements);
}

function hasPosition(element) {
  return [element?.x, element?.y, element?.w, element?.h].every((value) => Number.isFinite(Number(value)))
    && Number(element?.w) > 0 && Number(element?.h) > 0;
}

function substantiveCustomElement(element) {
  if (!element || typeof element !== "object" || !hasPosition(element)) return false;
  const type = clean(element.type).toLowerCase();
  if (["image", "formula"].includes(type)) return Boolean(clean(element.asset_ref ?? element.assetRef ?? element.path ?? element.src));
  if (["text", "metric", "callout", "annotation"].includes(type)) return Boolean(clean(element.text ?? element.value ?? element.label));
  if (["shape", "line", "connector", "arrow", "highlight"].includes(type)) return true;
  return false;
}

function elementEvidenceRefs(element) {
  return [
    element?.evidence_ref,
    element?.evidenceRef,
    element?.source_ref,
    element?.sourceRef,
    ...list(element?.evidence_refs),
    ...list(element?.source_refs),
  ].map(clean).filter(Boolean);
}

function isCustomScientificCanvas(slide, assetIds = new Set(), evidenceIds = new Set()) {
  const family = clean(slide?.layout?.family).toLowerCase();
  const variant = clean(slide?.layout?.variant).toLowerCase();
  const customElements = customCanvasElements(slide).filter(substantiveCustomElement);
  const types = customElements.map((element) => clean(element.type).toLowerCase());
  const shapeCount = types.filter((type) => type === "shape").length;
  const connectorCount = types.filter((type) => ["connector", "arrow"].includes(type)).length;
  const hasDirectEvidence = customElements.some((element) => {
    const type = clean(element?.type).toLowerCase();
    if (type === "metric") return Boolean(clean(element?.text ?? element?.value ?? element?.label));
    if (["image", "formula"].includes(type)) {
      const assetRef = clean(element?.asset_ref ?? element?.assetRef);
      return Boolean(assetRef && assetIds.has(assetRef));
    }
    if (!["text", "callout", "annotation"].includes(type)) return false;
    return elementEvidenceRefs(element).some((reference) => evidenceIds.has(reference));
  });
  const diagram = slide?.diagram;
  const hasSemanticModelGraph = diagram?.include === true
    && list(diagram?.nodes).length >= 2
    && list(diagram?.edges).length >= 1
    && shapeCount >= 2
    && connectorCount >= 1;
  const hasInterpretation = types.some((type) => ["text", "annotation", "callout", "highlight", "connector", "arrow"].includes(type));
  return family === "free_canvas" && variant.startsWith("custom:")
    && customElements.length >= 3 && (hasDirectEvidence || hasSemanticModelGraph) && hasInterpretation;
}

function hasRenderedCanvasTreatment(slide, assetIds = new Set(), evidenceIds = new Set()) {
  if (!isCustomScientificCanvas(slide, assetIds, evidenceIds)) return false;
  return customCanvasElements(slide).some((element) => ["annotation", "callout", "highlight"].includes(clean(element?.type).toLowerCase()));
}

function diagramTopology(diagram) {
  const edges = list(diagram?.edges);
  const outgoing = new Map();
  const incoming = new Map();
  const adjacency = new Map();
  let semanticNonlinear = false;
  for (const edge of edges) {
    const from = clean(edge?.from);
    const to = clean(edge?.to);
    if (!from || !to) continue;
    outgoing.set(from, (outgoing.get(from) ?? 0) + 1);
    incoming.set(to, (incoming.get(to) ?? 0) + 1);
    if (!adjacency.has(from)) adjacency.set(from, []);
    adjacency.get(from).push(to);
    if (NONLINEAR_RELATION_PATTERN.test(clean(edge?.relation))) semanticNonlinear = true;
  }
  const degreeNonlinear = [...outgoing.values(), ...incoming.values()].some((degree) => degree > 1);
  const visiting = new Set();
  const visited = new Set();
  function hasCycle(node) {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const next of adjacency.get(node) ?? []) if (hasCycle(next)) return true;
    visiting.delete(node);
    visited.add(node);
    return false;
  }
  const cyclic = [...adjacency.keys()].some(hasCycle);
  return { nonlinear: semanticNonlinear || degreeNonlinear || cyclic, semanticNonlinear, degreeNonlinear, cyclic };
}

function normalizeConclusion(value) {
  return clean(value)
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function similarConclusion(left, right) {
  const a = normalizeConclusion(left);
  const b = normalizeConclusion(right);
  if (!a || !b || Math.min([...a].length, [...b].length) < 8) return false;
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length > b.length ? a : b;
  return longer.includes(shorter) && shorter.length / longer.length >= 0.72;
}

function renderConclusions(renderData, output = [], prefix = "render_data") {
  if (!renderData || typeof renderData !== "object") return output;
  for (const [key, value] of Object.entries(renderData)) {
    const pointer = `${prefix}/${key}`;
    if (typeof value === "string" && CONCLUSION_KEY_PATTERN.test(key)) output.push({ label: pointer, value });
    else if (Array.isArray(value) && CONCLUSION_KEY_PATTERN.test(key)) {
      value.filter((item) => typeof item === "string").forEach((item, index) => output.push({ label: `${pointer}/${index}`, value: item }));
    } else if (value && typeof value === "object" && !Array.isArray(value)) renderConclusions(value, output, pointer);
  }
  return output;
}

function duplicatedConclusion(slide) {
  const candidates = [
    { label: "content/title", value: slide?.content?.title },
    { label: "takeaway", value: slide?.takeaway },
    ...renderConclusions(slide?.render_data),
  ].filter((item) => clean(item.value));
  for (let left = 0; left < candidates.length; left += 1) {
    for (let right = left + 1; right < candidates.length; right += 1) {
      if (similarConclusion(candidates[left].value, candidates[right].value)) return [candidates[left], candidates[right]];
    }
  }
  return null;
}

function isCoreResultOrValidation(slide) {
  if (clean(slide?.kind).toLowerCase() !== "content") return false;
  if (clean(slide?.priority).toLowerCase() !== "core") return false;
  const roles = list(slide?.narrative_roles).join(" ");
  const purpose = clean(slide?.purpose);
  const id = clean(slide?.id);
  return RESULT_VALIDATION_PATTERN.test(`${roles} ${purpose} ${id}`);
}

export function validateScientificDesign(deck, options = {}) {
  const strict = options.strict === true;
  const findings = [];
  if (!deck || typeof deck !== "object" || Array.isArray(deck)) {
    findings.push(issue("error", "scientific.deck.invalid", "$", "Deck spec must be a JSON object."));
    return finalize(findings, strict, false);
  }
  const gallery = isLibraryGallery(deck);
  const assetIds = declaredAssetIds(deck);
  const evidenceIds = declaredEvidenceIds(deck);
  const readyAssetIds = readyDerivedAssetIds(deck);

  const slides = list(deck.slides).map((slide, index) => ({ slide, index }))
    .sort((left, right) => Number(left.slide?.order ?? left.index) - Number(right.slide?.order ?? right.index));

  for (const { slide, index } of slides) {
    if (!slide || typeof slide !== "object") continue;
    const pointer = slidePointer(index);
    const optionsForSlide = slideOptions(slide);
    if (!gallery && clean(slide?.kind).toLowerCase() === "content" && !clean(slide?.priority)) {
      findings.push(issue(
        "error",
        "scientific.storyboard.priority_missing",
        `${pointer}/priority`,
        "Every production content slide must declare priority so core scientific gates cannot be bypassed.",
        optionsForSlide,
      ));
    }
    const productionCoreContent = clean(slide?.kind).toLowerCase() === "content"
      && clean(slide?.priority).toLowerCase() === "core";
    if (!gallery && productionCoreContent && !clean(slide?.audience_question)) {
      findings.push(issue(
        "warning",
        "scientific.storyboard.audience_question_missing",
        `${pointer}/audience_question`,
        "Core content slide needs an explicit audience question before choosing its evidence and composition.",
        optionsForSlide,
      ));
    }
    if (!gallery && productionCoreContent && !clean(slide?.relationship_topology)) {
      findings.push(issue(
        "warning",
        "scientific.storyboard.topology_missing",
        `${pointer}/relationship_topology`,
        "Core content slide must declare the relationship it visualizes (including none); do not let a template silently invent the topology.",
        optionsForSlide,
      ));
    }
    const diagram = slide.diagram;
    const declaredTopology = clean(slide.relationship_topology).toLowerCase();
    if (["branch_converge", "feedback", "parallel", "hierarchy"].includes(declaredTopology) && isLinearVariant(slide)) {
      findings.push(issue(
        "error",
        "scientific.topology.linear_layout_mismatch",
        `${pointer}/layout/variant`,
        `Slide declares ${declaredTopology} topology, but layout variant "${clean(slide.layout?.variant)}" encodes a linear sequence. Use a relationship-faithful scientific canvas.`,
        optionsForSlide,
      ));
    }
    if (["branch_converge", "parallel", "hierarchy"].includes(declaredTopology) && isProcessShell(slide)) {
      findings.push(issue(
        "error",
        "scientific.topology.process_shell_mismatch",
        `${pointer}/layout`,
        `Slide declares ${declaredTopology} topology, but the selected process renderer is a single horizontal chain. Use a branch/converge, hierarchy, or custom scientific canvas.`,
        optionsForSlide,
      ));
    }
    if (diagram?.include === true && list(diagram.edges).length > 0) {
      const topology = diagramTopology(diagram);
      if (topology.nonlinear && isLinearVariant(slide)) {
        findings.push(issue(
          "error",
          "scientific.diagram.linear_layout_mismatch",
          `${pointer}/layout/variant`,
          `Diagram contains branching, convergence, feedback, a cycle, or non-linear node degrees, but layout variant "${clean(slide.layout?.variant)}" encodes a linear sequence. Use a relationship-faithful layout.`,
          optionsForSlide,
        ));
      }
      if (isProcessShell(slide)) {
        const edges = list(diagram.edges);
        const feedbackEdges = edges.filter((edge) => clean(edge?.relation).toLowerCase() === "feedback");
        const forwardEdges = edges.filter((edge) => clean(edge?.relation).toLowerCase() !== "feedback");
        const outgoing = new Map();
        const incoming = new Map();
        for (const edge of forwardEdges) {
          const from = clean(edge?.from);
          const to = clean(edge?.to);
          outgoing.set(from, (outgoing.get(from) ?? 0) + 1);
          incoming.set(to, (incoming.get(to) ?? 0) + 1);
        }
        const unsupportedRelation = forwardEdges.some((edge) => !["", "sequence"].includes(clean(edge?.relation).toLowerCase()));
        const branched = [...outgoing.values(), ...incoming.values()].some((degree) => degree > 1);
        const nodeCount = list(diagram.nodes).length;
        if (unsupportedRelation || branched || feedbackEdges.length > 1 || (nodeCount > 0 && forwardEdges.length !== nodeCount - 1) || (topology.cyclic && feedbackEdges.length === 0)) {
          findings.push(issue(
            "error",
            "scientific.diagram.process_shell_mismatch",
            `${pointer}/diagram/edges`,
            "The selected process renderer supports only one linear chain plus at most one explicit feedback edge; it cannot render this topology faithfully.",
            optionsForSlide,
          ));
        }
      }
    }

    const visuals = includedScientificVisuals(slide);
    if (!gallery && visuals.length > 0 && visuals.every((visual) => !hasPresentationTreatment(visual, readyAssetIds)) && !hasRenderedCanvasTreatment(slide, assetIds, evidenceIds)) {
      findings.push(issue(
        "warning",
        "scientific.visuals.unprocessed",
        `${pointer}/visuals`,
        "All included scientific visuals are only contained/cropped or have no presentation treatment. Add an evidence-directed annotation, split, zoom, inset, or faithful redraw where it improves reading.",
        optionsForSlide,
      ));
    }

    if (!gallery && isDualColumnLayout(slide, visuals) && visuals.some((visual) => isComplexVisual(visual) && !hasPresentationTreatment(visual, readyAssetIds))) {
      findings.push(issue(
        "warning",
        "scientific.visuals.complex_dual_column_unannotated",
        `${pointer}/layout`,
        "A complex chart/diagram is placed in a dual-column comparison without an applied per-visual treatment. Prepare an annotated/zoomed/split asset or use a custom scientific canvas; metadata-only annotation plans do not alter the rendered slide.",
        optionsForSlide,
      ));
    }

    const duplicate = gallery ? null : duplicatedConclusion(slide);
    if (duplicate) {
      findings.push(issue(
        "warning",
        "scientific.conclusion.duplicated",
        pointer,
        `The same conclusion is repeated in ${duplicate[0].label} and ${duplicate[1].label}. Keep one conclusion and use the remaining space for evidence or boundary.`,
        optionsForSlide,
      ));
    }

    if (!gallery && isCoreResultOrValidation(slide) && !hasVisualFocus(slide, readyAssetIds, assetIds, evidenceIds)) {
      findings.push(issue(
        "error",
        "scientific.core_result.visual_focus_missing",
        pointer,
        "Core result/validation slide has no rendered focal treatment. Planning-only visual_focus/annotation_plan metadata does not alter the slide; apply text_emphasis, select a prepared ready asset, or render a direct annotation/highlight.",
        optionsForSlide,
      ));
    }

    if (clean(slide?.layout?.family).toLowerCase() === "free_canvas" && clean(slide?.layout?.variant).toLowerCase().startsWith("custom:") && !isCustomScientificCanvas(slide, assetIds, evidenceIds)) {
      findings.push(issue(
        "error",
        "scientific.free_canvas.elements_missing",
        `${pointer}/render_data/custom_elements`,
        "A production custom free_canvas needs positioned editable scientific elements; do not fall back to a generic image-and-text shell.",
        optionsForSlide,
      ));
    }
  }

  for (let start = 0; !gallery && start < slides.length;) {
    const variant = effectiveLayoutId(slides[start].slide);
    let end = start + 1;
    while (variant && end < slides.length && effectiveLayoutId(slides[end].slide) === variant) end += 1;
    if (variant && end - start >= 3) {
      const first = slides[start];
      const last = slides[end - 1];
      findings.push(issue(
        "warning",
        "scientific.layout.variant_repetition",
        slidePointer(first.index, "/layout/variant"),
        `Layout variant "${variant}" repeats for ${end - start} consecutive slides (orders ${first.slide?.order ?? "?"}–${last.slide?.order ?? "?"}). Vary the evidence canvas unless the repeated structure is analytically necessary.`,
        slideOptions(first.slide),
      ));
    }
    start = end;
  }

  if (!gallery && clean(deck.profile).toLowerCase() === "final_defense") {
    const coreTechnicalSlides = slides.map((item) => item.slide).filter((slide) => clean(slide?.kind).toLowerCase() === "content" && clean(slide?.priority).toLowerCase() === "core");
    const emphasizedSlides = coreTechnicalSlides.filter((slide) => list(slide?.text_emphasis).some((directive) => clean(directive?.role).toLowerCase() !== "strong")).length;
    const recommendedMinimum = Math.min(3, Math.max(1, Math.ceil(coreTechnicalSlides.length / 6)));
    if (coreTechnicalSlides.length > 0 && emphasizedSlides < recommendedMinimum) {
      findings.push(issue(
        "error",
        "scientific.deck.emphasis_absent",
        "$/slides",
        `Production final-defense deck emphasizes ${emphasizedSlides} core slide(s); at least ${recommendedMinimum} evidence-bearing focal slide(s) are needed for this deck size. Emphasize short decisive values or judgments, not every page.`,
      ));
    }

    if (coreTechnicalSlides.length >= 6 && !coreTechnicalSlides.some((slide) => isCustomScientificCanvas(slide, assetIds, evidenceIds))) {
      findings.push(issue(
        "error",
        "scientific.deck.paper_specific_canvas_absent",
        "$/slides",
        "A final-defense deck with six or more core slides needs at least one thesis-specific editable evidence canvas. Quantitative evidence may use figures, formulas, or metrics; argument-driven work may use source-bound quotations, cases, or text evidence with visible interpretation.",
      ));
    }

    const variants = coreTechnicalSlides.map(effectiveLayoutId).filter(Boolean);
    const counts = new Map();
    for (const variant of variants) counts.set(variant, (counts.get(variant) ?? 0) + 1);
    const dominant = [...counts.entries()].sort((left, right) => right[1] - left[1])[0];
    if (coreTechnicalSlides.length >= 8 && dominant && dominant[1] / coreTechnicalSlides.length > 0.4 && !dominant[0].startsWith("custom:")) {
      findings.push(issue(
        "warning",
        "scientific.deck.layout_dominance",
        "$/slides",
        `Generic layout variant "${dominant[0]}" is used on ${dominant[1]} of ${coreTechnicalSlides.length} core slides. Recompose the thesis-specific evidence pages instead of repeating one shell.`,
      ));
    }

    const genericShells = new Set([
      "claim-evidence", "image-compare", "two-image-results", "process", "four-step-ribbon",
      "three-column-overview", "three-row-content", "four-point-list", "four-objectives", "multi-image-evidence",
    ]);
    const genericShellCount = variants.filter((variant) => genericShells.has(variant)).length;
    if (coreTechnicalSlides.length >= 8 && genericShellCount / coreTechnicalSlides.length > 0.6) {
      findings.push(issue(
        "warning",
        "scientific.deck.generic_shell_dominance",
        "$/slides",
        `${genericShellCount} of ${coreTechnicalSlides.length} core slides use generic card/process/dual-image shells. Recompose more thesis-specific evidence canvases instead of alternating a small set of templates.`,
      ));
    }
  }

  return finalize(findings, strict, gallery);
}

function finalize(findings, strict, galleryExempt) {
  const issues = findings.map((item) => strict && item.severity === "warning" ? { ...item, severity: "error", promoted_by_strict: true } : item);
  const counts = issues.reduce((result, item) => {
    result[item.severity] = (result[item.severity] ?? 0) + 1;
    return result;
  }, { error: 0, warning: 0 });
  return {
    ok: counts.error === 0,
    strict,
    library_gallery_exempt: galleryExempt,
    summary: { errors: counts.error, warnings: counts.warning, total: issues.length },
    issues,
  };
}

export async function validateScientificDesignFile(specPath, options = {}) {
  const absolute = path.resolve(specPath);
  const deck = JSON.parse(await fs.readFile(absolute, "utf8"));
  return { spec: absolute, ...validateScientificDesign(deck, options) };
}

function usage() {
  return [
    "Usage: node validate-scientific-design.mjs <deck-spec.json> [options]",
    "",
    "Options:",
    "  --strict  Promote scientific-design warnings to errors",
    "  --json    Emit machine-readable JSON",
    "  -h        Show this help",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { strict: false, json: false, spec: null };
  for (const token of argv) {
    if (token === "--strict") options.strict = true;
    else if (token === "--json") options.json = true;
    else if (token === "-h" || token === "--help") options.help = true;
    else if (token.startsWith("-")) throw new Error(`Unknown option: ${token}`);
    else if (options.spec) throw new Error("Provide exactly one deck-spec path.");
    else options.spec = token;
  }
  return options;
}

function printText(result) {
  if (result.library_gallery_exempt && result.ok) {
    console.log(`SCIENTIFIC DESIGN PASS (library_gallery production-only gates exempt): ${result.spec}`);
    return;
  }
  console.log(`${result.ok ? "SCIENTIFIC DESIGN PASS" : "SCIENTIFIC DESIGN FAILED"}: ${result.spec}`);
  console.log(`errors=${result.summary.errors} warnings=${result.summary.warnings}`);
  for (const item of result.issues) {
    const location = item.slide_id ? `${item.path} [${item.slide_id}]` : item.path;
    console.log(`${item.severity.toUpperCase()} ${item.code} ${location}: ${item.message}`);
  }
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(usage());
      return;
    }
    if (!args.spec) throw new Error(usage());
    const result = await validateScientificDesignFile(args.spec, { strict: args.strict });
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else printText(result);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(`SCIENTIFIC DESIGN VALIDATION FAILED: ${error.message}`);
    process.exitCode = 2;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) await main();

export { isLibraryGallery, parseArgs };
