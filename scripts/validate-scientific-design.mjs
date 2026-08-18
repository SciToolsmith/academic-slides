#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(SCRIPT_DIR, "..");
const PROFILE_REGISTRY = JSON.parse(await fs.readFile(path.join(SKILL_DIR, "assets", "profile-registry.json"), "utf8"));
const PROFILE_LAYOUT_IDS = Object.freeze(Object.fromEntries(await Promise.all(Object.entries(PROFILE_REGISTRY.profiles ?? {}).map(async ([profile, config]) => {
  const registry = JSON.parse(await fs.readFile(path.join(SKILL_DIR, config.assetDirectory, config.layoutRegistry ?? "layout-registry.json"), "utf8"));
  return [profile, new Set(list(registry.layouts).map((layout) => clean(layout?.id)).filter(Boolean))];
}))));

const LINEAR_VARIANT_PATTERN = /(?:^|[-_ ])(?:four[-_ ]?step(?:[-_ ]?ribbon)?|step[-_ ]?ribbon|linear(?:[-_ ]?process)?|arrow[-_ ]?sequence|pipeline|stair(?:case)?|timeline)(?:$|[-_ ])/i;
const NONLINEAR_RELATION_PATTERN = /branch|fork|parallel|converg|join|merge|feedback|loop|bifurcat|分支|并行|汇合|收敛|合流|反馈|循环/i;
const RESULT_VALIDATION_PATTERN = /result|validation|verify|verification|finding|结果|验证|核验|发现/i;
const CONCLUSION_KEY_PATTERN = /(?:^|_)(?:conclusion|takeaway|summary)(?:$|_)/i;
const COMPLEX_TRANSFORM_PATTERN = /complex|复杂|multi[-_ ]?panel|多面板/i;
const PROFILE_SHELL_LAYOUTS = Object.freeze({
  final_defense: Object.freeze({
    title: new Set(["cover"]), agenda: new Set(["agenda"]), section: new Set(["section-divider"]), closing: new Set(["closing"]),
  }),
  group_meeting_literature: Object.freeze({
    title: new Set(["group-cover"]), agenda: new Set(["paper-agenda"]), section: new Set(["paper-divider"]), closing: new Set(["group-closing"]),
  }),
  proposal_midterm: Object.freeze({
    title: new Set(["cover-short-title", "cover-long-title"]), agenda: new Set(["agenda-adaptive"]), section: new Set(["section-divider"]), closing: new Set(["closing-feedback"]),
  }),
});
const SHELL_KIND_BY_LAYOUT = new Map(Object.values(PROFILE_SHELL_LAYOUTS).flatMap((byKind) => Object.entries(byKind)
  .flatMap(([kind, layoutIds]) => [...layoutIds].map((layoutId) => [layoutId, kind]))));
const VISUAL_RENDERER_SLOT_CAPACITY = new Map([
  ["paper-profile", 1],
  ["claim-evidence", 1],
  ["image-left-text-right", 1],
  ["text-left-image-right", 1],
  ["image-compare", 2],
  ["case-compare", 2],
  ["multi-image-evidence", 4],
  ["chart-insight", 3],
  ["formula-visual", 1],
  ["two-image-results", 2],
  ["figure-conclusion", 1],
  ["single-result-evidence", 1],
  ["result-compare", 2],
  ["multi-result-evidence", 4],
  ["table-chart-result", 3],
  ["mechanism-explanation", 1],
  ["leading-result-single", 1],
  ["leading-results-multipanel", 4],
  ["free-evidence", 2],
]);
const FORMULA_RENDERER_LAYOUTS = new Set(["formula-visual", "model-formula"]);
const TABLE_DATA_LAYOUTS = new Set(["table-insight", "validation-matrix", "method-comparison", "cross-paper-matrix"]);
const REFERENCE_LAYOUTS = new Set(["references", "selected-sources"]);
const FREE_CANVAS_ELEMENT_TYPES = new Set(["image", "formula", "shape", "line", "connector", "arrow", "callout", "annotation", "highlight", "text", "metric"]);
const FREE_CANVAS_CONNECTOR_DIRECTIONS = new Set(["right", "left", "down", "up"]);
const FREE_CANVAS_GEOMETRY_ALIASES = new Map([
  ["roundedrect", "roundrect"],
  ["roundrectangle", "roundrect"],
  ["roundedrectangle", "roundrect"],
  ["rectangle", "rect"],
  ["oval", "ellipse"],
]);
const FREE_CANVAS_GEOMETRIES = new Set(["rect", "roundrect", "ellipse", "diamond", "triangle", "rightarrow", "leftarrow", "uparrow", "downarrow"]);
const SEMANTIC_ITEM_LAYOUT_KEYS = new Map([
  ["claim-evidence", ["items", "evidence"]],
  ["three-column-overview", ["items", "columns", "evidence_items", "evidenceItems"]],
  ["three-level-analysis", ["items", "levels", "branches", "categories"]],
  ["four-point-list", ["items", "points"]],
  ["three-row-content", ["items", "rows", "modules"]],
  ["four-objectives", ["items", "objectives"]],
  ["radial-methods", ["items", "methods"]],
  ["four-step-ribbon", ["items", "steps"]],
  ["innovation-brackets", ["items", "innovations", "contributions"]],
  ["four-results-cycle", ["items", "results"]],
  ["conclusion-list", ["items", "conclusions", "outcomes"]],
  ["three-outlook-columns", ["items", "outlook", "directions"]],
  ["evaluation-focus", ["criteria", "focus_items", "focusItems", "checks", "items"]],
  ["objectives-workpackages", ["work_packages", "workPackages", "workpackages", "items"]],
]);
const INTERNAL_PLACEHOLDER_TEXT = [
  /^\s*要点\s*\d{1,2}\s*$/u,
  /^用与论文证据对应的短句替换这里的说明。?$/u,
  /^先给出本页的一句话结论。?$/u,
  /^用一句话解释趋势，而不是复述坐标轴。?$/u,
  /^示例数据$/u,
  /^说明本步骤的输入、动作与输出。?$/u,
  /^说明后续方向、验证方法与可交付结果。?$/u,
];

export const PRODUCTION_SUBSTANTIVE_KINDS = new Set(["content", "summary", "questions"]);

export function isProductionSubstantiveKind(value) {
  const kind = typeof value === "object" && value !== null ? value.kind : value;
  return PRODUCTION_SUBSTANTIVE_KINDS.has(clean(kind).toLowerCase());
}

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

function readyDerivedAssetIds(deck, availableAssetIds) {
  return new Set(list(deck?.assets)
    .filter((asset) => /(?:^|\/)ready(?:\/|$)/i.test(clean(asset?.path).replaceAll("\\", "/")))
    .filter((asset) => !availableAssetIds || availableAssetIds.has(clean(asset?.id)))
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

function firstDeclared(...values) {
  for (const value of values) if (value !== undefined && value !== null && value !== "") return value;
  return undefined;
}

function visualAssetRef(visual) {
  return clean(visual?.asset_ref ?? visual?.assetRef);
}

function legacyCustomElementsArePositioned(slide) {
  const elements = list(slide?.render_data?.elements);
  return elements.length > 0 && elements.every((element) => {
    const box = firstDeclared(element?.position, element?.bounds, element?.box, element);
    return box && typeof box === "object"
      && firstDeclared(box.left, box.x) != null
      && firstDeclared(box.top, box.y) != null
      && firstDeclared(box.width, box.w) != null
      && firstDeclared(box.height, box.h) != null;
  });
}

function usesCustomCanvasRenderer(slide, layoutId) {
  return layoutId === "free-evidence"
    && (customCanvasElements(slide).length > 0 || legacyCustomElementsArePositioned(slide));
}

function assetRequestsBeforeScientificVisuals(slide) {
  const visual = slide?.visual && typeof slide.visual === "object" ? slide.visual : {};
  return list(firstDeclared(slide?.images, slide?.media, slide?.asset_refs, slide?.assetRefs, [])).filter(Boolean).length
    + list(firstDeclared(visual.images, visual.assets, visual.asset_refs, visual.assetRefs, [])).filter(Boolean).length;
}

export function rendererVisualConsumption(slide, requestedLayoutId = null) {
  const layoutId = clean(requestedLayoutId).toLowerCase().replaceAll("_", "-") || effectiveLayoutId(slide);
  const declared = includedScientificVisuals(slide);
  if (usesCustomCanvasRenderer(slide, layoutId)) {
    const elements = customCanvasElements(slide).length > 0 ? customCanvasElements(slide) : list(slide?.render_data?.elements);
    const renderedAssetRefs = new Set(elements
      .filter((element) => clean(element?.type).toLowerCase() === "image")
      .map((element) => clean(firstDeclared(element?.asset_ref, element?.assetRef, element?.asset, element?.path, element?.src)))
      .filter(Boolean));
    const consumed = declared.filter((visual) => renderedAssetRefs.has(visualAssetRef(visual)));
    const consumedSet = new Set(consumed);
    return {
      layoutId,
      supported: renderedAssetRefs.size > 0,
      slotCapacity: renderedAssetRefs.size,
      occupiedBeforeVisuals: 0,
      declared,
      consumed,
      unconsumed: declared.filter((visual) => !consumedSet.has(visual)),
    };
  }
  const slotCapacity = VISUAL_RENDERER_SLOT_CAPACITY.get(layoutId) ?? 0;
  const occupiedBeforeVisuals = Math.min(slotCapacity, assetRequestsBeforeScientificVisuals(slide));
  let remaining = Math.max(0, slotCapacity - occupiedBeforeVisuals);
  const formulaAssetRef = layoutId === "formula-visual"
    ? clean(firstDeclared(slide?.formula?.asset_ref, slide?.formula?.assetRef, slide?.formula?.asset_path, slide?.formula?.assetPath))
    : "";
  const consumed = [];
  const unconsumed = [];
  for (const visual of declared) {
    const assetRef = visualAssetRef(visual);
    if (assetRef && assetRef !== formulaAssetRef && remaining > 0) {
      consumed.push(visual);
      remaining -= 1;
    } else {
      unconsumed.push(visual);
    }
  }
  return {
    layoutId,
    supported: slotCapacity > 0,
    slotCapacity,
    occupiedBeforeVisuals,
    declared,
    consumed,
    unconsumed,
  };
}

function hasVisualFocus(slide, readyAssetIds, assetIds, evidenceIds) {
  const visualConsumption = rendererVisualConsumption(slide);
  return list(slide?.text_emphasis).length > 0
    || visualConsumption.consumed.some((visual) => hasPresentationTreatment(visual, readyAssetIds))
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
  const family = clean(slide?.layout?.family).toLowerCase();
  if (family === "free_canvas" && variant.startsWith("custom:")) return "free-evidence";
  if (variant) return variant;
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
    paper_profile: "paper-profile",
    literature_synthesis: "cross-paper-matrix",
    discussion: "discussion-questions",
    summary: "contribution",
    closing: "closing",
    free_canvas: "free-evidence",
  };
  return fallback[family] ?? family.replaceAll("_", "-");
}

function isCustomFreeCanvas(slide) {
  return clean(slide?.layout?.family).toLowerCase() === "free_canvas"
    && clean(slide?.layout?.variant).toLowerCase().startsWith("custom:");
}

function customFormulaElementMatches(slide, formulaAssetRef) {
  return customCanvasElements(slide).some((element) => clean(element?.type).toLowerCase() === "formula"
    && (!formulaAssetRef || clean(element?.asset_ref ?? element?.assetRef ?? element?.asset ?? element?.path ?? element?.src) === formulaAssetRef));
}

function containsInternalPlaceholder(value) {
  if (typeof value === "string") return INTERNAL_PLACEHOLDER_TEXT.some((pattern) => pattern.test(value.trim()));
  if (Array.isArray(value)) return value.some(containsInternalPlaceholder);
  if (value && typeof value === "object") return Object.values(value).some(containsInternalPlaceholder);
  return false;
}

function hasMeaningfulValue(value) {
  if (typeof value === "string") return Boolean(clean(value));
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.some(hasMeaningfulValue);
  if (value && typeof value === "object") return Object.values(value).some(hasMeaningfulValue);
  return false;
}

function semanticItemSource(slide, keys) {
  const data = slide?.render_data ?? {};
  for (const key of keys) if (data[key] != null) return list(data[key]);
  for (const value of [data.items, data.cards, slide?.content?.bullets, slide?.content?.body, slide?.bullets]) {
    if (value != null) return list(value);
  }
  return [];
}

function semanticItemTitle(item) {
  if (typeof item === "string" || typeof item === "number") return clean(String(item));
  return clean(firstDeclared(item?.title, item?.label, item?.heading, item?.claim, item?.text, item?.target, item?.novelty));
}

function semanticItemBody(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return "";
  const direct = clean(firstDeclared(item.body, item.detail, item.description, item.evidence, item.caption));
  if (direct) return direct;
  if (clean(item.question) || clean(item.output)) return [clean(item.question), clean(item.output)].filter(Boolean).join(" ");
  if (clean(item.deliverable) || clean(item.acceptance)) return [clean(item.deliverable), clean(item.acceptance)].filter(Boolean).join(" ");
  if (clean(item.gap) || clean(item.novelty) || clean(item.validation)) return [clean(item.gap), clean(item.novelty), clean(item.validation)].filter(Boolean).join(" ");
  if (clean(item.verdict) || clean(item.evidence)) return [clean(item.verdict), clean(item.evidence)].filter(Boolean).join(" ");
  return "";
}

function slideTakeawayValue(slide) {
  return clean(firstDeclared(slide?.takeaway, slide?.claim, slide?.copy?.takeaway, slide?.content?.takeaway));
}

function hasDeclaredImageRequest(slide) {
  const visual = slide?.visual && typeof slide.visual === "object" ? slide.visual : {};
  const collections = [
    firstDeclared(slide?.images, slide?.media, slide?.asset_refs, slide?.assetRefs),
    firstDeclared(visual.images, visual.assets, visual.asset_refs, visual.assetRefs),
    slide?.visuals,
    firstDeclared(slide?.render_data?.image_refs, slide?.render_data?.asset_refs),
  ];
  if (collections.some((value) => list(value).some((entry) => Boolean(
    typeof entry === "string" ? clean(entry) : clean(firstDeclared(entry?.asset_ref, entry?.assetRef, entry?.path, entry?.file, entry?.src, entry?.uri)),
  )))) return true;
  return [slide?.image, slide?.left_image, slide?.right_image, visual.image, visual.left_image, visual.right_image]
    .some((value) => Boolean(value));
}

function itemPayloadProblem(layoutId, item, index) {
  if (!semanticItemTitle(item)) {
    return `layout="${layoutId}" item ${index + 1} needs an explicit title/label; renderer-generated point labels are forbidden.`;
  }
  if (!semanticItemBody(item)) {
    return `layout="${layoutId}" item ${index + 1} needs explicit evidence/detail text; renderer fallback explanations are forbidden.`;
  }
  return null;
}

export function productionPayloadProblems(slide, requestedLayoutId = null) {
  if (!isProductionSubstantiveKind(slide)) return [];
  const layoutId = clean(requestedLayoutId).toLowerCase().replaceAll("_", "-") || effectiveLayoutId(slide);
  const data = slide?.render_data ?? {};
  const problems = [];
  const semanticKeys = SEMANTIC_ITEM_LAYOUT_KEYS.get(layoutId);
  if (semanticKeys) {
    const items = semanticItemSource(slide, semanticKeys);
    if (items.length === 0 || !items.some(hasMeaningfulValue)) {
      problems.push(`layout="${layoutId}" needs explicit semantic items; renderer-generated generic points are forbidden.`);
    } else {
      items.forEach((item, index) => {
        const problem = itemPayloadProblem(layoutId, item, index);
        if (problem) problems.push(problem);
      });
    }
  }

  const requireValue = (label, ...values) => {
    if (!values.some(hasMeaningfulValue)) problems.push(`layout="${layoutId}" needs explicit ${label}; renderer fallback copy is forbidden.`);
  };
  const declaredVisuals = includedScientificVisuals(slide);
  const visualCaptionAt = (index) => clean(firstDeclared(
    declaredVisuals[index]?.caption,
    declaredVisuals[index]?.alt_text,
    declaredVisuals[index]?.alt,
    declaredVisuals[index]?.title,
  ));
  const panelItems = semanticItemSource(slide, ["panels", "items"]);
  const panelTitleAt = (index) => semanticItemTitle(panelItems[index]);
  if (layoutId === "claim-evidence") {
    requireValue("claim/takeaway", slideTakeawayValue(slide));
    requireValue("conclusion boundary", data.boundary, slide?.content?.callout);
    if (!hasDeclaredImageRequest(slide) && list(firstDeclared(slide?.metrics, slide?.key_numbers, slide?.content?.metrics)).length === 0) {
      requireValue("evidence synthesis", data.synthesis);
    }
  } else if (["chart-insight", "table-chart-result"].includes(layoutId)) {
    requireValue("chart interpretation/takeaway", slideTakeawayValue(slide));
  } else if (layoutId === "formula-visual") {
    requireValue("plain-language formula meaning", slide?.formula?.plain_meaning, slide?.formula?.plainMeaning, slide?.plain_meaning, slideTakeawayValue(slide));
    requireValue("formula variable explanations", slide?.formula?.variables_to_explain, slide?.formula?.variablesToExplain, slide?.formula?.variables);
  } else if (layoutId === "three-column-overview") {
    requireValue("overview banner/conclusion", data.banner, data.conclusion, slideTakeawayValue(slide));
  } else if (layoutId === "four-objectives") {
    requireValue("overall research goal", data.overall_goal);
  } else if (layoutId === "radial-methods") {
    requireValue("central research question", data.center, data.center_label, slideTakeawayValue(slide));
  } else if (["image-compare", "case-compare", "result-compare"].includes(layoutId)) {
    requireValue("left comparison label", data.left_label, slide?.left_label, slide?.leftLabel, slide?.left_case?.title, visualCaptionAt(0));
    requireValue("right comparison label", data.right_label, slide?.right_label, slide?.rightLabel, slide?.right_case?.title, visualCaptionAt(1));
  } else if (layoutId === "two-image-results") {
    requireValue("left result label", data.left_label, panelTitleAt(0), visualCaptionAt(0));
    requireValue("right result label", data.right_label, panelTitleAt(1), visualCaptionAt(1));
    requireValue("comparison takeaway", slideTakeawayValue(slide));
  } else if (["multi-image-evidence", "multi-result-evidence", "leading-results-multipanel"].includes(layoutId)) {
    const captions = list(firstDeclared(data.captions, data.labels));
    const requiredCaptions = Math.max(2, Math.min(4, rendererVisualConsumption(slide, layoutId).consumed.length || 2));
    for (let index = 0; index < requiredCaptions; index += 1) {
      requireValue(`caption for rendered visual ${index + 1}`, captions[index], panelTitleAt(index), visualCaptionAt(index));
    }
  } else if (["figure-conclusion", "single-result-evidence", "leading-result-single"].includes(layoutId)) {
    requireValue("figure conclusion", data.conclusion, slideTakeawayValue(slide));
  } else if (layoutId === "quote-analysis") {
    requireValue("source quotation", data.quote, slide?.quote, slide?.content?.quote?.text);
    requireValue("quotation analysis", data.analysis, slide?.analysis, slide?.content?.quote?.analysis, slideTakeawayValue(slide));
  } else if (layoutId === "discussion-questions") {
    requireValue("discussion questions", data.questions, data.items, slide?.bullets, slide?.content?.body);
  } else if (layoutId === "paper-conclusion") {
    requireValue("paper finding", data.finding, slideTakeawayValue(slide));
    requireValue("supporting evidence", data.support, data.evidence);
    requireValue("unproven claim/boundary", data.not_proven, data.boundary);
    requireValue("one-line synthesis", data.one_line);
  } else if (layoutId === "contribution") {
    const contributions = list(firstDeclared(data.contributions, slide?.contributions, slide?.bullets, slide?.content?.bullets));
    requireValue("contribution claims", contributions);
    contributions.forEach((item, index) => {
      if (!semanticItemTitle(item) || !semanticItemBody(item)) {
        problems.push(`layout="${layoutId}" contribution ${index + 1} needs both a claim and linked evidence/boundary.`);
      }
    });
  } else if (layoutId === "limitations") {
    requireValue("current limitations", data.limitations, slide?.limitations, slide?.bullets, slide?.content?.bullets);
    requireValue("next validation steps", data.next_steps, slide?.next_steps, slide?.nextSteps);
  } else if (layoutId === "thesis-framework") {
    requireValue("thesis-specific framework nodes", slide?.diagram?.nodes, slide?.nodes);
  } else if (layoutId === "free-evidence" && !usesCustomCanvasRenderer(slide, layoutId)) {
    requireValue("free-canvas evidence claim", slideTakeawayValue(slide));
  }
  return problems;
}

function customCanvasElements(slide) {
  const declared = list(slide?.render_data?.custom_elements ?? slide?.render_data?.customElements);
  if (declared.length > 0) return declared;
  return legacyCustomElementsArePositioned(slide) ? list(slide?.render_data?.elements) : [];
}

function hasPosition(element) {
  const box = firstDeclared(element?.position, element?.bounds, element?.box, element);
  const left = firstDeclared(box?.left, box?.x);
  const top = firstDeclared(box?.top, box?.y);
  const width = firstDeclared(box?.width, box?.w);
  const height = firstDeclared(box?.height, box?.h);
  return [left, top, width, height].every((value) => Number.isFinite(Number(value)))
    && Number(width) > 0 && Number(height) > 0;
}

function normalizeFreeCanvasGeometry(value, fallback) {
  const raw = clean(firstDeclared(value, fallback));
  const key = raw.toLowerCase().replace(/[\s_-]+/g, "");
  return FREE_CANVAS_GEOMETRY_ALIASES.get(key) ?? key;
}

function assetReference(entry) {
  if (typeof entry === "string") return clean(entry);
  return clean(firstDeclared(entry?.asset_ref, entry?.assetRef, entry?.id_ref, entry?.ref, entry?.path, entry?.file, entry?.src, entry?.uri));
}

function rendererAssetEntries(slide) {
  const visual = slide?.visual && typeof slide.visual === "object" ? slide.visual : {};
  const entries = [];
  for (const value of [
    firstDeclared(slide?.images, slide?.media, slide?.asset_refs, slide?.assetRefs),
    firstDeclared(visual.images, visual.assets, visual.asset_refs, visual.assetRefs),
    slide?.visuals,
    firstDeclared(slide?.render_data?.image_refs, slide?.render_data?.asset_refs),
  ]) entries.push(...list(value));
  for (const value of [slide?.image, slide?.left_image, slide?.right_image, visual.image, visual.left_image, visual.right_image]) {
    if (value) entries.push(value);
  }
  return entries;
}

function hasFormulaLinkedVisual(slide) {
  const formulaRef = clean(firstDeclared(slide?.formula?.asset_ref, slide?.formula?.assetRef, slide?.formula?.asset_path, slide?.formula?.assetPath));
  return rendererAssetEntries(slide).some((entry) => {
    if (entry?.include === false || clean(entry?.type).toLowerCase() === "formula") return false;
    const reference = assetReference(entry);
    return Boolean(reference && reference !== formulaRef);
  });
}

function explicitTablePayload(slide) {
  const data = slide?.render_data ?? {};
  const table = firstDeclared(data.table, slide?.table) ?? {};
  const headers = firstDeclared(table?.headers, table?.columns, data.columns, slide?.columns);
  const rows = firstDeclared(table?.rows, data.rows, slide?.rows);
  return { headers, rows, complete: hasMeaningfulValue(headers) && hasMeaningfulValue(rows) };
}

function explicitReferenceEntries(slide) {
  const data = slide?.render_data ?? {};
  const groups = list(data.groups);
  if (groups.length > 0) {
    return groups.flatMap((group) => {
      if (!group || typeof group !== "object") return list(group);
      return list(firstDeclared(group.references, group.entries, group.items, group.bullets, group.content?.bullets, group.content?.body, group.content, group.body));
    }).filter(hasMeaningfulValue);
  }
  return list(firstDeclared(data.references, slide?.references, slide?.bullets, slide?.content?.bullets, slide?.content?.body)).filter(hasMeaningfulValue);
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
  if (!isProductionSubstantiveKind(slide)) return false;
  if (clean(slide?.priority).toLowerCase() !== "core") return false;
  const roles = list(slide?.narrative_roles).join(" ");
  const purpose = clean(slide?.purpose);
  const id = clean(slide?.id);
  return RESULT_VALIDATION_PATTERN.test(`${roles} ${purpose} ${id}`);
}

function appendixSectionIds(deck) {
  return new Set(list(deck?.sections)
    .filter((section) => [clean(section?.audience_role), clean(section?.role)].some((role) => role.toLowerCase() === "appendix"))
    .map((section) => clean(section?.id))
    .filter(Boolean));
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
  const availableAssetIds = options.availableAssetIds instanceof Set ? options.availableAssetIds : null;
  const readyAssetIds = readyDerivedAssetIds(deck, availableAssetIds);
  const profile = clean(deck.profile).toLowerCase() || "final_defense";
  const allowedLayouts = PROFILE_LAYOUT_IDS[profile];

  const slides = list(deck.slides).map((slide, index) => ({ slide, index }))
    .sort((left, right) => Number(left.slide?.order ?? left.index) - Number(right.slide?.order ?? right.index));

  for (const { slide, index } of slides) {
    if (!slide || typeof slide !== "object") continue;
    const pointer = slidePointer(index);
    const optionsForSlide = slideOptions(slide);
    const layoutId = effectiveLayoutId(slide);
    const customEscape = layoutId === "free-evidence" && isCustomFreeCanvas(slide);
    if (!gallery && !allowedLayouts?.has(layoutId) && !customEscape) {
      findings.push(issue(
        "error",
        "scientific.layout.profile_mismatch",
        `${pointer}/layout`,
        `Layout "${layoutId}" is not registered for profile=${profile}. Select a layout from the active profile or use an explicit custom free_canvas.`,
        optionsForSlide,
      ));
    }
    if (!gallery) {
      const kind = clean(slide?.kind).toLowerCase();
      const expectedShells = PROFILE_SHELL_LAYOUTS[profile]?.[kind];
      if (expectedShells && !expectedShells.has(layoutId)) {
        findings.push(issue(
          "error",
          "scientific.shell.kind_layout_mismatch",
          `${pointer}/layout`,
          `Production slide declares kind=${kind}, but effective layout is "${layoutId}"; expected one of: ${[...expectedShells].join(", ")}.`,
          optionsForSlide,
        ));
      }
      const shellKind = SHELL_KIND_BY_LAYOUT.get(layoutId);
      if (shellKind && shellKind !== kind) {
        findings.push(issue(
          "error",
          "scientific.shell.layout_kind_mismatch",
          `${pointer}/kind`,
          `Effective layout "${layoutId}" is a ${shellKind} shell, but the slide declares kind=${kind || "missing"}.`,
          optionsForSlide,
        ));
      }
      if (containsInternalPlaceholder({ content: slide.content, render_data: slide.render_data, bullets: slide.bullets })) {
        findings.push(issue(
          "error",
          "scientific.content.renderer_placeholder",
          pointer,
          "Production slide contains default renderer placeholder copy; replace it with thesis-specific evidence before building.",
          optionsForSlide,
        ));
      }
      if (isProductionSubstantiveKind(slide)) {
        for (const problem of productionPayloadProblems(slide, layoutId)) {
          findings.push(issue(
            "error",
            problem.includes("needs explicit semantic items")
              ? "scientific.content.empty_renderer_fallback"
              : "scientific.content.partial_renderer_payload",
            pointer,
            `Production slide has an incomplete renderer payload: ${problem}`,
            optionsForSlide,
          ));
        }
        if (TABLE_DATA_LAYOUTS.has(layoutId) && !explicitTablePayload(slide).complete) {
          findings.push(issue(
            "error",
            "scientific.table.payload_missing",
            `${pointer}/render_data/table`,
            `Layout "${layoutId}" needs explicit non-empty table columns/headers and rows; renderer sample data is forbidden.`,
            optionsForSlide,
          ));
        }
        if (REFERENCE_LAYOUTS.has(layoutId) && explicitReferenceEntries(slide).length === 0) {
          findings.push(issue(
            "error",
            "scientific.references.payload_missing",
            `${pointer}/render_data`,
            `Layout "${layoutId}" needs explicit references in render_data.references, render_data.groups, slide.references, bullets, or content.bullets/body.`,
            optionsForSlide,
          ));
        }
      }
    }
    if (!gallery && isProductionSubstantiveKind(slide) && !clean(slide?.priority)) {
      findings.push(issue(
        "error",
        "scientific.storyboard.priority_missing",
        `${pointer}/priority`,
        "Every production substantive slide must declare priority so core scientific gates cannot be bypassed.",
        optionsForSlide,
      ));
    }
    const productionCoreContent = isProductionSubstantiveKind(slide)
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

    const visualConsumption = rendererVisualConsumption(slide, layoutId);
    const visuals = visualConsumption.declared;
    const renderedVisuals = visualConsumption.consumed;
    const treatmentCandidates = renderedVisuals.length > 0 ? renderedVisuals : visuals;
    if (visuals.length > 0 && !visualConsumption.supported) {
      findings.push(issue(
        "error",
        "scientific.visuals.renderer_mismatch",
        `${pointer}/layout`,
        `Slide declares ${visuals.length} scientific visual(s), but effective layout "${layoutId}" does not render slide.visuals.`,
        optionsForSlide,
      ));
    }
    if (!gallery && visualConsumption.supported && visualConsumption.unconsumed.length > 0) {
      findings.push(issue(
        "error",
        "scientific.visuals.unconsumed",
        `${pointer}/visuals`,
        `Effective layout "${layoutId}" consumes ${renderedVisuals.length} of ${visuals.length} declared scientific visual(s) in renderer order; remove the surplus visual(s) or choose a layout with enough real visual slots.`,
        optionsForSlide,
      ));
    }
    if (!gallery && visualConsumption.supported && treatmentCandidates.length > 0 && treatmentCandidates.every((visual) => !hasPresentationTreatment(visual, readyAssetIds)) && !hasRenderedCanvasTreatment(slide, assetIds, evidenceIds)) {
      findings.push(issue(
        "warning",
        "scientific.visuals.unprocessed",
        `${pointer}/visuals`,
        "All scientific visuals actually consumed by the renderer are only contained/cropped or have no presentation treatment. Add an evidence-directed annotation, split, zoom, inset, or faithful redraw where it improves reading.",
        optionsForSlide,
      ));
    }

    if (!gallery && isDualColumnLayout(slide, treatmentCandidates) && treatmentCandidates.some((visual) => isComplexVisual(visual) && !hasPresentationTreatment(visual, readyAssetIds))) {
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

    if (slide.formula?.include === true) {
      const formulaRef = clean(slide.formula.asset_ref ?? slide.formula.assetRef ?? slide.formula.asset_path ?? slide.formula.assetPath);
      const customFormula = layoutId === "free-evidence" && customFormulaElementMatches(slide, formulaRef);
      if (!FORMULA_RENDERER_LAYOUTS.has(layoutId) && !customFormula) {
        findings.push(issue(
          "error",
          "scientific.formula.renderer_mismatch",
          `${pointer}/layout`,
          `formula.include=true is declared, but effective layout "${layoutId}" does not render that formula.`,
          optionsForSlide,
        ));
      }
      const customFormulaRef = customFormula
        ? clean(customCanvasElements(slide).find((element) => clean(element?.type).toLowerCase() === "formula")?.asset_ref
          ?? customCanvasElements(slide).find((element) => clean(element?.type).toLowerCase() === "formula")?.assetRef)
        : "";
      const renderedFormulaRef = formulaRef || customFormulaRef;
      const renderMethod = clean(slide.formula.render_method ?? slide.formula.renderMethod).toLowerCase();
      const latex = clean(slide.formula.latex ?? slide.formula.equation);
      const validUnicode = FORMULA_RENDERER_LAYOUTS.has(layoutId) && renderMethod === "unicode_text"
        && latex.length > 0 && latex.length <= 120 && !/[\\{}]/.test(latex);
      if (!gallery && !renderedFormulaRef && !validUnicode) {
        findings.push(issue(
          "error",
          "scientific.formula.asset_missing",
          `${pointer}/formula`,
          "Rendered formula needs a declared local asset, or unicode_text with a short plain Unicode equation on a formula renderer.",
          optionsForSlide,
        ));
      } else if (!gallery && renderedFormulaRef && !assetIds.has(renderedFormulaRef)) {
        findings.push(issue(
          "error",
          "scientific.formula.asset_undeclared",
          `${pointer}/formula`,
          `Formula asset_ref "${renderedFormulaRef}" is not declared in deck.assets.`,
          optionsForSlide,
        ));
      } else if (!gallery && renderedFormulaRef && availableAssetIds && !availableAssetIds.has(renderedFormulaRef)) {
        findings.push(issue(
          "error",
          "scientific.formula.asset_unavailable",
          `${pointer}/formula`,
          `Formula asset_ref "${renderedFormulaRef}" does not resolve to a readable local file.`,
          optionsForSlide,
        ));
      }
      if (!gallery && layoutId === "formula-visual" && !hasFormulaLinkedVisual(slide)) {
        findings.push(issue(
          "error",
          "scientific.formula.linked_visual_missing",
          `${pointer}/visuals`,
          "A formula-visual slide needs a distinct non-formula image, chart, diagram, table, or result that shows what the equation explains; the formula itself cannot fill both visual roles.",
          optionsForSlide,
        ));
      }
    }

    if (isCustomFreeCanvas(slide)) {
      const elements = customCanvasElements(slide);
      for (const [elementIndex, element] of elements.entries()) {
        const elementPointer = `${pointer}/render_data/custom_elements/${elementIndex}`;
        const type = clean(element?.type).toLowerCase();
        if (type && !FREE_CANVAS_ELEMENT_TYPES.has(type)) {
          findings.push(issue(
            "error",
            "scientific.free_canvas.element_type_unsupported",
            `${elementPointer}/type`,
            `Unsupported free-canvas element type "${type}". Use one of: ${[...FREE_CANVAS_ELEMENT_TYPES].join(", ")}.`,
            optionsForSlide,
          ));
        }
        if (["connector", "arrow"].includes(type)) {
          const direction = clean(element?.direction).toLowerCase();
          if (direction && !FREE_CANVAS_CONNECTOR_DIRECTIONS.has(direction)) {
            findings.push(issue(
              "error",
              "scientific.free_canvas.connector_direction_unsupported",
              `${elementPointer}/direction`,
              `Unsupported connector direction "${direction}". Use right, left, up, or down; represent diagonal or bent paths with multiple orthogonal connector elements.`,
              optionsForSlide,
            ));
          }
        }
        if (["shape", "callout", "annotation", "highlight"].includes(type)) {
          const fallback = type === "highlight" ? "ellipse" : "roundRect";
          const geometry = normalizeFreeCanvasGeometry(firstDeclared(element?.geometry, element?.shape), fallback);
          if (!FREE_CANVAS_GEOMETRIES.has(geometry)) {
            findings.push(issue(
              "error",
              "scientific.free_canvas.shape_geometry_unsupported",
              `${elementPointer}/geometry`,
              `Unsupported free-canvas geometry "${clean(firstDeclared(element?.geometry, element?.shape, fallback))}". Use a renderer-supported geometry or a documented alias such as rounded_rect.`,
              optionsForSlide,
            ));
          }
        }
      }
    }

    if (isCustomFreeCanvas(slide) && !isCustomScientificCanvas(slide, assetIds, evidenceIds)) {
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

  if (!gallery && profile === "final_defense") {
    const appendixSections = appendixSectionIds(deck);
    const mainContentSlides = slides.map((item) => item.slide).filter((slide) => isProductionSubstantiveKind(slide)
      && clean(slide?.priority).toLowerCase() !== "appendix"
      && !appendixSections.has(clean(slide?.section_id)));
    const coreTechnicalSlides = mainContentSlides.filter((slide) => clean(slide?.priority).toLowerCase() === "core");
    if (mainContentSlides.length > 0 && coreTechnicalSlides.length === 0) {
      findings.push(issue(
        "error",
        "scientific.deck.core_absent",
        "$/slides",
        "A production final-defense deck cannot mark every main content slide as supporting; declare the thesis-bearing evidence pages as priority=core.",
      ));
    }
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
  const baseDir = path.dirname(absolute);
  const availableAssetIds = new Set();
  await Promise.all(list(deck.assets).map(async (asset) => {
    const id = clean(asset?.id);
    const rawPath = clean(asset?.path ?? asset?.file ?? asset?.src);
    if (!id || !rawPath || /^https?:\/\//i.test(rawPath) || rawPath.startsWith("sample:")) return;
    const resolved = path.isAbsolute(rawPath) ? rawPath : path.resolve(baseDir, rawPath);
    try {
      const stats = await fs.stat(resolved);
      if (stats.isFile()) availableAssetIds.add(id);
    } catch {
      // The validator reports unavailable formula/ready assets through the
      // same scientific contract; missing generic assets still fail when the
      // renderer attempts to consume them.
    }
  }));
  return { spec: absolute, ...validateScientificDesign(deck, { ...options, availableAssetIds }) };
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
