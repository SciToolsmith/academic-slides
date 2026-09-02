#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCHEMA = path.resolve(SCRIPT_DIR, "../schemas/deck-spec.schema.json");

function issue(severity, code, pointer, message, options = {}) {
  const result = { severity, code, path: pointer, message };
  if (options.strictExempt === true) result.strict_exempt = true;
  return result;
}

function valueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value === "object" ? "object" : typeof value;
}

function matchesType(value, expected) {
  if (Array.isArray(expected)) return expected.some((candidate) => matchesType(value, candidate));
  if (expected === "number") return typeof value === "number" && Number.isFinite(value);
  if (expected === "integer") return Number.isInteger(value);
  return valueType(value) === expected;
}

function escapePointerPart(value) {
  return String(value).replaceAll("~", "~0").replaceAll("/", "~1");
}

function resolvePointer(root, reference) {
  if (reference === "#") return root;
  if (!reference.startsWith("#/")) return undefined;
  return reference
    .slice(2)
    .split("/")
    .map((part) => decodeURIComponent(part).replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((current, part) => (current == null ? undefined : current[part]), root);
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function branchIsValid(value, schema, rootSchema) {
  const branchIssues = [];
  validateJsonValue(value, schema, { rootSchema, issues: branchIssues });
  return branchIssues.every((item) => item.severity !== "error");
}

/**
 * Validate a value against the dependency-free JSON Schema subset used by this skill.
 * Supports local $ref, type, required, properties, additionalProperties, arrays,
 * enum/const, numeric/string bounds, allOf/anyOf/oneOf/not and if/then/else.
 */
export function validateJsonValue(value, schema, options = {}) {
  const rootSchema = options.rootSchema ?? schema;
  const issues = options.issues ?? [];
  const pointer = options.path ?? "$";

  if (schema === true || schema == null) return issues;
  if (schema === false) {
    issues.push(issue("error", "schema.false", pointer, "Value is forbidden by the schema."));
    return issues;
  }
  if (typeof schema !== "object" || Array.isArray(schema)) {
    issues.push(issue("error", "schema.invalid", pointer, "Schema node must be an object or boolean."));
    return issues;
  }

  if (schema.$ref) {
    const referenced = resolvePointer(rootSchema, schema.$ref);
    if (referenced === undefined) {
      issues.push(issue("error", "schema.ref", pointer, `Unresolved local schema reference: ${schema.$ref}`));
      return issues;
    }
    validateJsonValue(value, referenced, { rootSchema, issues, path: pointer });
  }

  if (schema.type && !matchesType(value, schema.type)) {
    const expected = Array.isArray(schema.type) ? schema.type.join(" or ") : schema.type;
    issues.push(issue("error", "type", pointer, `Expected ${expected}; received ${valueType(value)}.`));
    return issues;
  }

  if (schema.const !== undefined && !deepEqual(value, schema.const)) {
    issues.push(issue("error", "const", pointer, `Value must equal ${JSON.stringify(schema.const)}.`));
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => deepEqual(value, candidate))) {
    issues.push(issue("error", "enum", pointer, `Value is not one of: ${schema.enum.map(JSON.stringify).join(", ")}.`));
  }

  if (Array.isArray(schema.allOf)) {
    for (const child of schema.allOf) validateJsonValue(value, child, { rootSchema, issues, path: pointer });
  }
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((child) => branchIsValid(value, child, rootSchema))) {
    issues.push(issue("error", "anyOf", pointer, "Value does not satisfy any allowed schema branch."));
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((child) => branchIsValid(value, child, rootSchema)).length;
    if (matches !== 1) issues.push(issue("error", "oneOf", pointer, `Value must satisfy exactly one branch; matched ${matches}.`));
  }
  if (schema.not && branchIsValid(value, schema.not, rootSchema)) {
    issues.push(issue("error", "not", pointer, "Value satisfies a schema branch that is explicitly forbidden."));
  }
  if (schema.if) {
    const conditionMatches = branchIsValid(value, schema.if, rootSchema);
    if (conditionMatches && schema.then) validateJsonValue(value, schema.then, { rootSchema, issues, path: pointer });
    if (!conditionMatches && schema.else) validateJsonValue(value, schema.else, { rootSchema, issues, path: pointer });
  }

  if (typeof value === "string") {
    if (schema.minLength != null && [...value].length < schema.minLength) {
      issues.push(issue("error", "minLength", pointer, `String must contain at least ${schema.minLength} characters.`));
    }
    if (schema.maxLength != null && [...value].length > schema.maxLength) {
      issues.push(issue("error", "maxLength", pointer, `String must contain at most ${schema.maxLength} characters.`));
    }
    if (schema.pattern) {
      try {
        if (!new RegExp(schema.pattern).test(value)) issues.push(issue("error", "pattern", pointer, `String does not match /${schema.pattern}/.`));
      } catch {
        issues.push(issue("error", "schema.pattern", pointer, `Schema contains an invalid pattern: ${schema.pattern}`));
      }
    }
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    if (schema.minimum != null && value < schema.minimum) issues.push(issue("error", "minimum", pointer, `Number must be >= ${schema.minimum}.`));
    if (schema.maximum != null && value > schema.maximum) issues.push(issue("error", "maximum", pointer, `Number must be <= ${schema.maximum}.`));
    if (schema.exclusiveMinimum != null && value <= schema.exclusiveMinimum) issues.push(issue("error", "exclusiveMinimum", pointer, `Number must be > ${schema.exclusiveMinimum}.`));
    if (schema.exclusiveMaximum != null && value >= schema.exclusiveMaximum) issues.push(issue("error", "exclusiveMaximum", pointer, `Number must be < ${schema.exclusiveMaximum}.`));
    if (schema.multipleOf != null && Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) > 1e-10) {
      issues.push(issue("error", "multipleOf", pointer, `Number must be a multiple of ${schema.multipleOf}.`));
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) issues.push(issue("error", "minItems", pointer, `Array needs at least ${schema.minItems} items.`));
    if (schema.maxItems != null && value.length > schema.maxItems) issues.push(issue("error", "maxItems", pointer, `Array allows at most ${schema.maxItems} items.`));
    if (schema.uniqueItems) {
      const encoded = value.map((item) => JSON.stringify(item));
      if (new Set(encoded).size !== encoded.length) issues.push(issue("error", "uniqueItems", pointer, "Array items must be unique."));
    }
    if (schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)) {
      value.forEach((item, index) => validateJsonValue(item, schema.items, { rootSchema, issues, path: `${pointer}/${index}` }));
    } else if (Array.isArray(schema.prefixItems)) {
      schema.prefixItems.forEach((child, index) => {
        if (index < value.length) validateJsonValue(value[index], child, { rootSchema, issues, path: `${pointer}/${index}` });
      });
    }
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const properties = schema.properties ?? {};
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) issues.push(issue("error", "required", `${pointer}/${escapePointerPart(required)}`, `Missing required property: ${required}.`));
    }
    for (const [key, child] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) validateJsonValue(value[key], child, { rootSchema, issues, path: `${pointer}/${escapePointerPart(key)}` });
    }
    const knownKeys = new Set(Object.keys(properties));
    const patterns = Object.entries(schema.patternProperties ?? {}).map(([pattern, child]) => [new RegExp(pattern), child]);
    for (const [key, childValue] of Object.entries(value)) {
      const matching = patterns.filter(([regex]) => regex.test(key));
      for (const [, childSchema] of matching) validateJsonValue(childValue, childSchema, { rootSchema, issues, path: `${pointer}/${escapePointerPart(key)}` });
      if (!knownKeys.has(key) && matching.length === 0) {
        if (schema.additionalProperties === false) issues.push(issue("error", "additionalProperties", `${pointer}/${escapePointerPart(key)}`, `Unexpected property: ${key}.`));
        else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
          validateJsonValue(childValue, schema.additionalProperties, { rootSchema, issues, path: `${pointer}/${escapePointerPart(key)}` });
        }
      }
    }
    if (schema.minProperties != null && Object.keys(value).length < schema.minProperties) issues.push(issue("error", "minProperties", pointer, `Object needs at least ${schema.minProperties} properties.`));
    if (schema.maxProperties != null && Object.keys(value).length > schema.maxProperties) issues.push(issue("error", "maxProperties", pointer, `Object allows at most ${schema.maxProperties} properties.`));
    for (const [key, dependencies] of Object.entries(schema.dependentRequired ?? {})) {
      if (Object.hasOwn(value, key)) {
        for (const dependency of dependencies) {
          if (!Object.hasOwn(value, dependency)) issues.push(issue("error", "dependentRequired", `${pointer}/${escapePointerPart(dependency)}`, `${dependency} is required when ${key} is present.`));
        }
      }
    }
  }
  return issues;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function listOfStrings(value) {
  return Array.isArray(value) ? value.filter(isNonEmptyString) : [];
}

function collectTextValues(value, output = []) {
  if (isNonEmptyString(value)) {
    output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectTextValues(item, output);
    return output;
  }
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) collectTextValues(child, output);
  }
  return output;
}

function exactOccurrenceCount(value, needle) {
  if (!isNonEmptyString(value) || !isNonEmptyString(needle)) return 0;
  let count = 0;
  let start = 0;
  while (true) {
    const index = value.indexOf(needle, start);
    if (index < 0) return count;
    count += 1;
    start = index + needle.length;
  }
}

function effectiveSectionAudienceRole(section) {
  if (section?.audience_role === "main" || section?.audience_role === "appendix") return section.audience_role;
  return section?.role === "appendix" ? "appendix" : "main";
}

function sectionVisibility(section, field) {
  if (typeof section?.[field] === "boolean") return section[field];
  return effectiveSectionAudienceRole(section) === "main";
}

function slidePosition(slide, index) {
  return Number.isInteger(slide?.order) ? slide.order : index + 1;
}

const PAPER_SECTION_TITLES = new Map([
  [1, "文献基本信息"],
  [2, "研究背景与意义"],
  [3, "研究设计与方法"],
  [4, "主要结果与结论"],
  [5, "批判性思考与启示"],
]);

function normalizedSlideTitle(slide) {
  return String(slide?.content?.title ?? slide?.title ?? "").trim().replace(/\s+/g, " ");
}

function numberedPaperSection(title) {
  const match = String(title).match(/^(\d+)\.(\d+)\s+(.+)$/);
  if (!match) return null;
  return {
    paperIndex: Number(match[1]),
    sectionIndex: Number(match[2]),
    sectionTitle: match[3].trim(),
  };
}

function renderedPaperNumber(slide) {
  const raw = slide?.render_data?.paper_no ?? slide?.render_data?.paperNo ?? slide?.paper_no ?? slide?.paperNo;
  if (raw === undefined || raw === null || raw === "") return null;
  const value = Number.parseInt(String(raw), 10);
  return Number.isInteger(value) && value >= 1 ? value : null;
}

 function groupMeetingContract(deck) {
  return deck?.literature?.scientific_contract ?? "group_meeting_v1";
}

function groupMeetingStructureIssues(deck, slides) {
  const findings = [];
  if (deck.profile !== "group_meeting_literature") return findings;
  if ((deck.artifact_purpose ?? "production") === "layout_gallery") return findings;
  const contract = groupMeetingContract(deck);
  const v2Enabled = contract === "group_meeting_v2";

  const positioned = slides.map((slide, index) => ({ slide, index, position: slidePosition(slide, index) }));
  const coverSlides = positioned.filter(({ slide }) => slide?.kind === "title");
  const agendaSlides = positioned.filter(({ slide }) => slide?.kind === "agenda");
  const dividerSlides = positioned.filter(({ slide }) => slide?.kind === "section");
  const closingSlides = positioned.filter(({ slide }) => slide?.kind === "closing");
  const appendixSectionIds = new Set((deck.sections ?? [])
    .filter((section) => effectiveSectionAudienceRole(section) === "appendix")
    .map((section) => section?.id)
    .filter(isNonEmptyString));
  const appendixSlides = positioned.filter(({ slide }) => (
    slide?.kind === "appendix"
    || slide?.priority === "appendix"
    || appendixSectionIds.has(slide?.section_id)
  ));

  if (v2Enabled) {
    if (coverSlides.length !== 1) {
      findings.push(issue("error", "group-meeting.cover.count", "$/slides", `Production group-meeting decks need exactly one cover slide; found ${coverSlides.length}.`));
    } else if (coverSlides[0].position !== 1) {
      findings.push(issue("error", "group-meeting.cover.order", `$/slides/${coverSlides[0].index}`, "The group-meeting cover must be the first visible slide."));
    }
    if (closingSlides.length !== 1) {
      findings.push(issue("error", "group-meeting.closing.count", "$/slides", `Production group-meeting decks need exactly one closing slide; found ${closingSlides.length}.`));
    } else {
      const finalPosition = Math.max(...positioned.map(({ position }) => position));
      if (closingSlides[0].position !== finalPosition) {
        findings.push(issue("error", "group-meeting.closing.order", `$/slides/${closingSlides[0].index}`, "The student-facing closing must be the final visible slide; discussion and next actions belong before it."));
      }
    }

    const appendixPolicy = deck.structure?.appendix_policy ?? "none";
    if (appendixPolicy !== "none") {
      findings.push(issue("error", "group-meeting.appendix.policy", "$/structure/appendix_policy", "Production group-meeting decks default to appendix_policy=none. Keep audit/reproduction material in notes or internal Markdown instead of placing visible slides after the closing."));
    }
    if (appendixSlides.length > 0 || appendixSectionIds.size > 0) {
      findings.push(issue("error", "group-meeting.appendix.visible", "$/slides", "Visible appendix/backup material is not allowed in a production group-meeting deck; the closing must remain the final slide."));
    }

    const literatureMode = deck.literature?.mode;
    const focalPaperIds = Array.isArray(deck.literature?.focal_paper_ids) ? deck.literature.focal_paper_ids : [];
    const paperCount = focalPaperIds.length;
    if (literatureMode === "single_paper" && slides.length < 12) {
      findings.push(issue("error", "group-meeting.single-paper.page-minimum", "$/slides", "A production single-paper group meeting needs at least 12 visible slides. Reach the floor with evidence-bearing continuation pages, not agenda, divider, or filler slides."));
    }
    if (literatureMode === "single_paper" && agendaSlides.length > 0) {
      findings.push(issue("error", "group-meeting.single-paper.agenda", "$/slides", "A single-paper group meeting must not contain an agenda slide. Start the substantive deck at 1.1 文献基本信息."));
    }
    if (literatureMode === "multi_paper" && agendaSlides.length === 0) {
      findings.push(issue("error", "group-meeting.multi-paper.agenda", "$/slides", "A multi-paper group meeting requires an agenda that lists the focal papers in order."));
    }
    if (literatureMode === "multi_paper") {
      const dividerNumbers = new Set(dividerSlides.map(({ slide }) => renderedPaperNumber(slide)).filter(Number.isInteger));
      for (let paperIndex = 1; paperIndex <= paperCount; paperIndex += 1) {
        if (!dividerNumbers.has(paperIndex)) {
          findings.push(issue("error", "group-meeting.multi-paper.divider", "$/slides", `Focal paper ${paperIndex} needs a numbered paper-divider slide before its substantive content.`));
        }
      }

      const agendaNumbers = new Set(agendaSlides.flatMap(({ slide }) => {
        const entries = Array.isArray(slide?.render_data?.papers) ? slide.render_data.papers : [];
        return entries
          .filter((entry) => !/^(?:Q|问)$/i.test(String(entry?.number ?? "").trim()))
          .map((entry) => Number.parseInt(String(entry?.number ?? ""), 10))
          .filter(Number.isInteger);
      }));
      for (let paperIndex = 1; paperIndex <= paperCount; paperIndex += 1) {
        if (!agendaNumbers.has(paperIndex)) {
          findings.push(issue("error", "group-meeting.multi-paper.agenda-entry", "$/slides", `The paper agenda is missing focal paper ${paperIndex}.`));
        }
      }
    }

    const numberedSlides = positioned.map((entry) => ({
      ...entry,
      title: normalizedSlideTitle(entry.slide),
      numbered: numberedPaperSection(normalizedSlideTitle(entry.slide)),
    })).filter((entry) => entry.numbered);
    for (let paperIndex = 1; paperIndex <= paperCount; paperIndex += 1) {
      const paperSlides = numberedSlides.filter((entry) => entry.numbered.paperIndex === paperIndex);
      const firstPositionBySection = new Map();
      for (const entry of paperSlides) {
        const expectedTitle = PAPER_SECTION_TITLES.get(entry.numbered.sectionIndex);
        if (expectedTitle && entry.numbered.sectionTitle !== expectedTitle) {
          findings.push(issue("error", "group-meeting.paper-section.title", `$/slides/${entry.index}/content/title`, `Section ${paperIndex}.${entry.numbered.sectionIndex} must be titled “${expectedTitle}”.`));
        }
        if (expectedTitle && !firstPositionBySection.has(entry.numbered.sectionIndex)) {
          firstPositionBySection.set(entry.numbered.sectionIndex, entry.position);
        }
        const renderedNumber = renderedPaperNumber(entry.slide);
        if (renderedNumber !== null && renderedNumber !== paperIndex) {
          findings.push(issue("error", "group-meeting.paper-section.paper-number", `$/slides/${entry.index}/render_data/paper_no`, `The rendered paper number ${renderedNumber} does not match the title prefix ${paperIndex}.`));
        }
      }
      for (let sectionIndex = 1; sectionIndex <= 4; sectionIndex += 1) {
        if (!firstPositionBySection.has(sectionIndex)) {
          findings.push(issue("error", "group-meeting.paper-section.missing", "$/slides", `Focal paper ${paperIndex} is missing ${paperIndex}.${sectionIndex} ${PAPER_SECTION_TITLES.get(sectionIndex)}.`));
        }
      }
      const orderedPositions = [1, 2, 3, 4].map((sectionIndex) => firstPositionBySection.get(sectionIndex));
      if (orderedPositions.every(Number.isFinite) && orderedPositions.some((position, index) => index > 0 && position <= orderedPositions[index - 1])) {
        findings.push(issue("error", "group-meeting.paper-section.order", "$/slides", `Focal paper ${paperIndex} must present sections ${paperIndex}.1 through ${paperIndex}.4 in order.`));
      }
    }

    if (coverSlides.length === 1) {
      const coverData = coverSlides[0].slide?.render_data ?? {};
      if (!isNonEmptyString(coverData.presenter)) {
        findings.push(issue("error", "group-meeting.cover.presenter", `$/slides/${coverSlides[0].index}/render_data/presenter`, "A student group-meeting cover must identify the presenter."));
      }
      if (!isNonEmptyString(coverData.date)) {
        findings.push(issue("error", "group-meeting.cover.date", `$/slides/${coverSlides[0].index}/render_data/date`, "A student group-meeting cover must identify the meeting date."));
      }
    }
    if (closingSlides.length === 1) {
      const closing = closingSlides[0].slide;
      const title = String(closing?.content?.title ?? "").trim();
      const shellSource = closing?.render_data?.shell_source ?? "profile_default";
      if (!["profile_default", "user_locked"].includes(shellSource)) {
        findings.push(issue("error", "group-meeting.closing.shell-source", `$/slides/${closingSlides[0].index}/render_data/shell_source`, "render_data.shell_source must be profile_default or user_locked for a v2 group-meeting closing."));
      }
      if (shellSource !== "user_locked" && title !== "谢谢老师，请批评指正") {
        findings.push(issue("error", "group-meeting.closing.student-shell", `$/slides/${closingSlides[0].index}/content/title`, "Use the fixed student closing “谢谢老师，请批评指正”, or mark a genuinely user-supplied shell with render_data.shell_source=user_locked."));
      }
      const analysisPayload = collectTextValues([
        closing?.render_data?.synthesis,
        closing?.render_data?.prompts,
        closing?.content?.body,
        closing?.content?.bullets,
        closing?.content?.metrics,
        closing?.content?.quote,
        closing?.content?.callout,
      ]);
      if (analysisPayload.length > 0) {
        findings.push(issue("error", "group-meeting.closing.analysis-payload", `$/slides/${closingSlides[0].index}`, "The final student closing is a shell only. Move synthesis, prompts, evidence, and next actions to the preceding slide."));
      }
    }
  }

  const singlePaperAuto = deck.literature?.mode === "single_paper" && deck.timing?.page_policy === "auto";
  if (singlePaperAuto && slides.length > 16) {
    findings.push(issue("warning", "group-meeting.single-paper.page-budget", "$/slides", `An automatic single-paper deck has ${slides.length} visible slides. Review whether every page has an independent evidence, explanation, or discussion role; this is a redundancy check, not an upper limit.`, { strictExempt: true }));
  }
  if (singlePaperAuto) {
    const navigationFillers = positioned.filter(({ slide }) => ["agenda", "section"].includes(slide?.kind));
    if (navigationFillers.length > 0) {
      findings.push(issue("warning", "group-meeting.single-paper.navigation-budget", "$/slides", "A normal single-paper group meeting does not need agenda or section-divider filler pages. Keep them only when the evidence really forms several stable parts.", { strictExempt: true }));
    }
  }

  return findings;
}

const RESERVED_SOURCES_MARKER = /\[\/?Sources\]/i;
const NON_SUBSTANTIVE_SLIDE_KINDS = new Set(["title", "section", "agenda", "closing", "questions"]);
const GROUP_PRODUCTION_LANGUAGE_PATTERNS = [
  { code: "generator-label", pattern: /(?:GROUP\s+MEETING\s*[·|]\s*LITERATURE\s+REVIEW|MULTI[-\s]?PAPER\s+REVIEW|(?<![A-Z-])PAPER\s+REVIEW)/i },
  { code: "internal-artifact", pattern: /(?:deck-spec|paper-assets|evidence-index|qa-report|\bMJS\b|交付包|项目构建器)/i },
  { code: "qa-status", pattern: /(?:(?:QA|逐页渲染|完整性检查|证据链).{0,16}(?:已通过|通过|完成|已建立|闭环|pass(?:ed)?))/i },
  { code: "audit-tone", pattern: /(?:机器可核|自动迁移建议|生成流程已完成)/i },
];

const GROUP_VISIBLE_RENDER_DATA_KEYS = new Set([
  "actions", "boundary", "boundary_label", "boundaryLabel", "caption", "captions", "cards", "caveat", "checks",
  "chrome_label", "chromeLabel", "citation", "claim", "claim_label", "claimLabel", "conclusion", "consensus",
  "context", "criteria", "criterion", "custom_elements", "customElements", "data_layers", "date", "decision",
  "divergence", "evidence", "evidence_label", "evidenceLabel", "events", "explanations", "finding", "footer_label",
  "gap", "group_labels", "implication", "items", "kicker", "known", "label", "labels", "layers", "left_label",
  "left_text", "limitations", "next_action", "not_proven", "one_line", "options", "paper", "paper_finding", "papers",
  "points", "presenter", "prompts", "purpose", "question", "questions", "references", "reminder", "research_group",
  "researchGroup", "right_label", "right_text", "risks", "sample_label", "strengths", "subtitle", "support", "synthesis",
  "synthesis_question", "synthesisQuestion", "table", "chart", "transfer", "transfer_logic", "verdict",
]);

function groupAudienceTextValues(slide) {
  const visibleRenderData = Object.fromEntries(Object.entries(slide?.render_data ?? {})
    .filter(([key]) => GROUP_VISIBLE_RENDER_DATA_KEYS.has(key)));
  return collectTextValues([
    slide?.takeaway,
    slide?.content,
    visibleRenderData,
    (slide?.diagram?.nodes ?? []).map((node) => [node?.label, node?.detail]),
    (slide?.visuals ?? []).map((visual) => [visual?.caption, visual?.highlight]),
  ]);
}

function slideEvidenceReferenceItems(slide, base) {
  const output = [];
  const add = (value, pointer) => {
    if (isNonEmptyString(value)) output.push({ value, path: pointer });
  };
  listOfStrings(slide.evidence_refs).forEach((value, index) => add(value, `${base}/evidence_refs/${index}`));
  for (const [index, bullet] of (slide.content?.bullets ?? []).entries()) {
    listOfStrings(bullet?.evidence_refs).forEach((value, refIndex) => add(value, `${base}/content/bullets/${index}/evidence_refs/${refIndex}`));
  }
  for (const [index, metric] of (slide.content?.metrics ?? []).entries()) add(metric?.evidence_ref, `${base}/content/metrics/${index}/evidence_ref`);
  add(slide.content?.quote?.source_ref, `${base}/content/quote/source_ref`);
  for (const [index, visual] of (slide.visuals ?? []).entries()) {
    listOfStrings(visual?.source_refs).forEach((value, refIndex) => add(value, `${base}/visuals/${index}/source_refs/${refIndex}`));
  }
  listOfStrings(slide.formula?.source_refs).forEach((value, index) => add(value, `${base}/formula/source_refs/${index}`));
  listOfStrings(slide.diagram?.source_refs).forEach((value, index) => add(value, `${base}/diagram/source_refs/${index}`));
  for (const [index, node] of (slide.diagram?.nodes ?? []).entries()) {
    listOfStrings(node?.source_refs).forEach((value, refIndex) => add(value, `${base}/diagram/nodes/${index}/source_refs/${refIndex}`));
  }
  return output;
}

function noteSourceReferenceItems(slide, base) {
  const output = [];
  const add = (value, pointer) => {
    if (isNonEmptyString(value)) output.push({ value, path: pointer });
  };
  for (const [index, source] of (slide.speaker_notes?.sources ?? []).entries()) add(source?.source_id, `${base}/speaker_notes/sources/${index}/source_id`);
  return output;
}

function semanticDeckIssues(deck, strict = false) {
  const findings = [];
  const soft = strict ? "error" : "warning";
  if (!deck || typeof deck !== "object" || Array.isArray(deck)) return findings;
  const slides = Array.isArray(deck.slides) ? deck.slides : [];
  if (slides.length === 0) {
    findings.push(issue("error", "deck.slides.empty", "$/slides", "Deck must contain at least one slide."));
    return findings;
  }

  const ids = new Map();
  const orders = new Map();
  const sections = new Map();
  const sectionOrders = new Map();
  for (const [index, section] of (deck.sections ?? []).entries()) {
    if (isNonEmptyString(section?.id)) {
      if (sections.has(section.id)) findings.push(issue("error", "section.id.duplicate", `$/sections/${index}/id`, `Duplicate section id: ${section.id}.`));
      else sections.set(section.id, section);
    }
    if (Number.isInteger(section?.order)) {
      if (sectionOrders.has(section.order)) findings.push(issue("error", "section.order.duplicate", `$/sections/${index}/order`, `Duplicate section order: ${section.order}.`));
      else sectionOrders.set(section.order, section.id);
    }
  }
  const sourceIds = new Map();
  for (const [index, source] of (deck.sources ?? []).entries()) {
    if (!isNonEmptyString(source?.id)) continue;
    if (sourceIds.has(source.id)) findings.push(issue("error", "source.id.duplicate", `$/sources/${index}/id`, `Duplicate source id: ${source.id}.`));
    else sourceIds.set(source.id, source);
  }
  const assetIds = new Map();
  for (const [index, asset] of (deck.assets ?? []).entries()) {
    if (!isNonEmptyString(asset?.id)) continue;
    if (assetIds.has(asset.id)) findings.push(issue("error", "asset.id.duplicate", `$/assets/${index}/id`, `Duplicate asset id: ${asset.id}.`));
    else assetIds.set(asset.id, asset);
    if (isNonEmptyString(asset?.source_ref) && !sourceIds.has(asset.source_ref)) {
      findings.push(issue("error", "asset.source.unknown", `$/assets/${index}/source_ref`, `Unknown asset source reference: ${asset.source_ref}.`));
    }
  }
  const logoAssetId = deck.theme?.verified_logo_asset_id;
  if (isNonEmptyString(logoAssetId)) {
    const logoAsset = assetIds.get(logoAssetId);
    if (!logoAsset) findings.push(issue("error", "theme.logo.unknown", "$/theme/verified_logo_asset_id", `Unknown verified logo asset id: ${logoAssetId}.`));
    else if (logoAsset.type !== "logo") findings.push(issue("error", "theme.logo.type", "$/theme/verified_logo_asset_id", `Verified logo asset ${logoAssetId} must have type=logo.`));
  }
  const claimIds = new Map();
  for (const [index, claim] of (deck.claim_evidence_map ?? []).entries()) {
    if (!isNonEmptyString(claim?.claim_id)) continue;
    if (claimIds.has(claim.claim_id)) findings.push(issue("error", "claim.id.duplicate", `$/claim_evidence_map/${index}/claim_id`, `Duplicate claim id: ${claim.claim_id}.`));
    else claimIds.set(claim.claim_id, claim);
  }
  for (const [index, slide] of slides.entries()) {
    const base = `$/slides/${index}`;
    if (!slide || typeof slide !== "object" || Array.isArray(slide)) continue;
    if (isNonEmptyString(slide.id)) {
      if (ids.has(slide.id)) findings.push(issue("error", "slide.id.duplicate", `${base}/id`, `Duplicate slide id ${slide.id}; first used at slide index ${ids.get(slide.id)}.`));
      else ids.set(slide.id, index);
    }
    if (Number.isInteger(slide.order)) {
      if (orders.has(slide.order)) findings.push(issue("error", "slide.order.duplicate", `${base}/order`, `Duplicate slide order ${slide.order}.`));
      else orders.set(slide.order, index);
    }
    const takeawayExempt = new Set(["title", "agenda", "section", "questions"]);
    if (!takeawayExempt.has(slide.kind) && !isNonEmptyString(slide.takeaway)) findings.push(issue(soft, "slide.takeaway.blank", `${base}/takeaway`, "Slide takeaway should state the single audience-facing conclusion."));
    const explicitEmphasis = Array.isArray(slide.text_emphasis) ? slide.text_emphasis : [];
    const legacyRoleMap = { strong: "strong", accent: "key", warning: "warning" };
    const legacyEmphasis = explicitEmphasis.length ? [] : (slide.content?.bullets ?? [])
      .map((bullet, bulletIndex) => legacyRoleMap[bullet?.emphasis]
        ? { text: bullet.text, role: legacyRoleMap[bullet.emphasis], _pointer: `${base}/content/bullets/${bulletIndex}/emphasis` }
        : null)
      .filter(Boolean);
    const emphasis = explicitEmphasis.length ? explicitEmphasis : legacyEmphasis;
    const emphasisExcludedKinds = new Set(["title", "agenda", "section", "closing"]);
    if (emphasis.length > 0 && emphasisExcludedKinds.has(String(slide.kind ?? "").toLowerCase())) {
      findings.push(issue("error", "slide.emphasis.shell", `${base}/text_emphasis`, "Cover, agenda, section, and closing slides must rely on hierarchy rather than colored text emphasis."));
    }
    const emphasizedCharacters = emphasis
      .filter((directive) => directive?.role !== "strong")
      .reduce((sum, directive) => sum + [...String(directive?.text ?? "")].length, 0);
    if (emphasizedCharacters > 32) {
      findings.push(issue("error", "slide.emphasis.budget", `${base}/text_emphasis`, `Colored emphasis covers ${emphasizedCharacters} characters; the per-slide budget is 32.`));
    }
    const visibleTextValues = collectTextValues([
      slide.takeaway,
      slide.content,
      slide.render_data,
      slide.diagram?.nodes,
      slide.visuals,
    ]);
    if (deck.profile === "group_meeting_literature"
      && (deck.artifact_purpose ?? "production") === "production"
      && groupMeetingContract(deck) === "group_meeting_v2") {
      const audienceText = groupAudienceTextValues(slide).join("\n");
      for (const entry of GROUP_PRODUCTION_LANGUAGE_PATTERNS) {
        if (entry.pattern.test(audienceText)) {
          findings.push(issue("error", `group-meeting.production-language.${entry.code}`, `${base}/content`, "Visible group-meeting slides must contain academic content for the audience, not generator, QA, audit, or delivery-process language."));
        }
      }
      const aiAttribution = /(?:(?:本(?:PPT|演示|汇报)|this\s+(?:deck|presentation)).{0,16}(?:由\s*(?:ChatGPT|Codex|AI|大模型)\s*(?:生成|制作)|generated\s+by\s+(?:ChatGPT|Codex|AI))|由\s*(?:ChatGPT|Codex)\s*(?:生成|制作))/i;
      if (aiAttribution.test(audienceText) && slide?.render_data?.ai_disclosure !== "institution_required") {
        findings.push(issue("error", "group-meeting.production-language.ai-attribution", `${base}/content`, "Do not add an automatic AI-production label to the audience deck. If institutional policy requires disclosure, set render_data.ai_disclosure=institution_required and follow that policy explicitly."));
      }
    }
    const seenEmphasis = new Set();
    for (const [emphasisIndex, directive] of emphasis.entries()) {
      const pointer = directive?._pointer ?? `${base}/text_emphasis/${emphasisIndex}`;
      const text = String(directive?.text ?? "");
      const signature = `${directive?.shape_name ?? ""}\u0000${text}`;
      if (seenEmphasis.has(signature)) findings.push(issue("error", "slide.emphasis.duplicate", pointer, `Duplicate text-emphasis directive for "${text}".`));
      seenEmphasis.add(signature);
      const occurrences = visibleTextValues.reduce((sum, value) => sum + exactOccurrenceCount(value, text), 0);
      if (occurrences === 0 && !directive?._pointer) {
        findings.push(issue("error", "slide.emphasis.missing", directive?._pointer ? pointer : `${pointer}/text`, `Emphasis text "${text}" does not occur in the slide's visible content payload.`));
      } else if (occurrences > 1 && !directive?._pointer && !isNonEmptyString(directive?.shape_name)) {
        findings.push(issue("error", "slide.emphasis.ambiguous", pointer, `Emphasis text "${text}" occurs ${occurrences} times; provide shape_name or choose a unique phrase.`));
      }
    }
    if (isNonEmptyString(slide.section_id) && !sections.has(slide.section_id)) findings.push(issue("error", "slide.section.unknown", `${base}/section_id`, `Unknown section_id: ${slide.section_id}.`));
    for (const [claimIndex, claimId] of (slide.claim_ids ?? []).entries()) {
      if (!claimIds.has(claimId)) findings.push(issue("error", "slide.claim.unknown", `${base}/claim_ids/${claimIndex}`, `Unknown claim_id: ${claimId}.`));
    }

    const formula = slide.formula;
    if (formula?.include === true) {
      if (!isNonEmptyString(formula.equation_ref) && !isNonEmptyString(formula.latex)) {
        findings.push(issue("error", "formula.content", `${base}/formula`, "Included formula needs equation_ref or latex."));
      }
      if (!isNonEmptyString(formula.reason)) findings.push(issue(soft, "formula.reason", `${base}/formula/reason`, "Explain why the formula belongs on this slide."));
      if (!isNonEmptyString(formula.plain_meaning)) findings.push(issue(soft, "formula.meaning", `${base}/formula/plain_meaning`, "Included formula should have a plain-language meaning."));
      if (listOfStrings(formula.source_refs).length === 0) findings.push(issue(soft, "formula.sources", `${base}/formula/source_refs`, "Included formula should cite its paper evidence."));
      if (!Array.isArray(formula.variables_to_explain) || formula.variables_to_explain.length === 0) findings.push(issue(soft, "formula.variables", `${base}/formula/variables_to_explain`, "Included formula should identify the variables that must be explained."));
      const formulaAsset = isNonEmptyString(formula.asset_ref);
      const unicodeText = formula.render_method === "unicode_text";
      const simpleUnicode = isNonEmptyString(formula.latex)
        && !/[\\{}]/.test(formula.latex)
        && formula.latex.length <= 120;
      if (!formulaAsset && !unicodeText) {
        findings.push(issue("error", "formula.asset", `${base}/formula/asset_ref`, "Rendered formulas require an asset_ref; raw LaTeX is not a display fallback."));
      }
      if (unicodeText && !simpleUnicode) {
        findings.push(issue("error", "formula.unicode.complex", `${base}/formula/latex`, "unicode_text is only allowed for short formulas without LaTeX commands or braces."));
      }
    } else if (formula && (isNonEmptyString(formula.latex) || (formula.role && formula.role !== "none"))) {
      findings.push(issue(soft, "formula.excluded.content", `${base}/formula`, "Formula is excluded but still carries display content or a non-none role."));
    }

    const diagram = slide.diagram;
    if (diagram?.include === true) {
      if (!isNonEmptyString(diagram.reason)) findings.push(issue(soft, "diagram.reason", `${base}/diagram/reason`, "Explain why a diagram is clearer than text or an existing paper figure."));
      if (listOfStrings(diagram.source_refs).length === 0) findings.push(issue(soft, "diagram.sources", `${base}/diagram/source_refs`, "Diagram semantics should cite paper evidence."));
      const nodes = Array.isArray(diagram.nodes) ? diagram.nodes : [];
      const edges = Array.isArray(diagram.edges) ? diagram.edges : [];
      if (nodes.length < 2) findings.push(issue("error", "diagram.nodes", `${base}/diagram/nodes`, "Included diagram needs at least two nodes."));
      if (edges.length < 1) findings.push(issue("error", "diagram.edges", `${base}/diagram/edges`, "Included diagram needs at least one edge."));
      const nodeIds = new Set();
      for (const [nodeIndex, node] of nodes.entries()) {
        const nodeId = typeof node === "string" ? node : node?.id;
        if (!isNonEmptyString(nodeId)) findings.push(issue("error", "diagram.node.id", `${base}/diagram/nodes/${nodeIndex}`, "Each diagram node needs a stable id."));
        else if (nodeIds.has(nodeId)) findings.push(issue("error", "diagram.node.duplicate", `${base}/diagram/nodes/${nodeIndex}`, `Duplicate diagram node id: ${nodeId}.`));
        else nodeIds.add(nodeId);
      }
      for (const [edgeIndex, edge] of edges.entries()) {
        const from = edge?.from ?? edge?.source;
        const to = edge?.to ?? edge?.target;
        if (!isNonEmptyString(from) || !isNonEmptyString(to)) {
          findings.push(issue("error", "diagram.edge.endpoints", `${base}/diagram/edges/${edgeIndex}`, "Each diagram edge needs from/to endpoints."));
        } else {
          if (!nodeIds.has(from)) findings.push(issue("error", "diagram.edge.from", `${base}/diagram/edges/${edgeIndex}`, `Edge starts at unknown node: ${from}.`));
          if (!nodeIds.has(to)) findings.push(issue("error", "diagram.edge.to", `${base}/diagram/edges/${edgeIndex}`, `Edge ends at unknown node: ${to}.`));
        }
      }
    } else if (diagram && ((diagram.nodes?.length ?? 0) > 0 || (diagram.edges?.length ?? 0) > 0)) {
      findings.push(issue(soft, "diagram.excluded.content", `${base}/diagram`, "Diagram is excluded but still contains nodes or edges."));
    }

    const kind = String(slide.kind ?? "").toLowerCase();
    const substantive = !NON_SUBSTANTIVE_SLIDE_KINDS.has(kind);
    const noteScript = slide.speaker_notes?.script;
    const noteTransition = slide.speaker_notes?.transition;
    if (substantive && !isNonEmptyString(noteScript)) {
      findings.push(issue("error", "notes.script.empty", `${base}/speaker_notes/script`, "Every substantive slide needs a non-empty speaker script."));
    }
    if (RESERVED_SOURCES_MARKER.test(String(noteScript ?? ""))) {
      findings.push(issue("error", "notes.sources.marker", `${base}/speaker_notes/script`, "[Sources] and [/Sources] are reserved output markers and must not appear in the speaker script."));
    }
    if (RESERVED_SOURCES_MARKER.test(String(noteTransition ?? ""))) {
      findings.push(issue("error", "notes.sources.marker", `${base}/speaker_notes/transition`, "[Sources] and [/Sources] are reserved output markers and must not appear in the transition."));
    }
    for (const [sourceIndex, source] of (slide.speaker_notes?.sources ?? []).entries()) {
      if (RESERVED_SOURCES_MARKER.test(String(source?.citation ?? ""))) {
        findings.push(issue("error", "notes.sources.marker", `${base}/speaker_notes/sources/${sourceIndex}/citation`, "[Sources] and [/Sources] are reserved output markers and must not appear in a citation."));
      }
    }

    const evidenceReferences = slideEvidenceReferenceItems(slide, base);
    const noteReferences = noteSourceReferenceItems(slide, base);
    const references = [...evidenceReferences, ...noteReferences];
    for (const reference of references) {
      if (!sourceIds.has(reference.value)) findings.push(issue("error", "source.ref.unknown", reference.path, `Unknown source/evidence reference: ${reference.value}.`));
    }
    if (deck.artifact_purpose === "production" && substantive) {
      const noteSourceIds = new Set(noteReferences.map((reference) => reference.value));
      const missingNoteSources = [...new Set(evidenceReferences.map((reference) => reference.value))]
        .filter((sourceId) => !noteSourceIds.has(sourceId));
      if (missingNoteSources.length > 0) {
        findings.push(issue("error", "notes.sources.coverage", `${base}/speaker_notes/sources`, `Speaker-note sources must cover every evidence reference used by the slide; missing: ${missingNoteSources.join(", ")}.`));
      }
    }
    const primaryVisuals = (slide.visuals ?? []).filter((visual) => visual?.include === true && visual?.role === "primary_evidence");
    if (primaryVisuals.length > 1) findings.push(issue(soft, "visual.primary.multiple", `${base}/visuals`, "Slide has more than one primary-evidence visual; confirm that comparison is intentional."));
    if (substantive && evidenceReferences.length === 0) {
      findings.push(issue(soft, "slide.evidence.empty", `${base}/evidence_refs`, "Content slide has no evidence_refs."));
    }
  }

  findings.push(...groupMeetingStructureIssues(deck, slides));


  const sortedOrders = [...orders.keys()].sort((a, b) => a - b);
  if (sortedOrders.length === slides.length && sortedOrders.some((value, index) => value !== index + 1)) {
    findings.push(issue(soft, "slide.order.sequence", "$/slides", "Slide order values should form a contiguous 1-based sequence."));
  }

  const map = deck.claim_evidence_map;
  if (Array.isArray(map)) {
    for (const [index, entry] of map.entries()) {
      const refs = entry?.evidence_refs ?? entry?.refs;
      if (!Array.isArray(refs) || refs.length === 0) findings.push(issue("error", "claim.evidence.empty", `$/claim_evidence_map/${index}`, "Every claim mapping needs at least one evidence reference."));
      for (const [refIndex, ref] of (refs ?? []).entries()) {
        if (!sourceIds.has(ref)) findings.push(issue("error", "claim.evidence.unknown", `$/claim_evidence_map/${index}/evidence_refs/${refIndex}`, `Unknown claim evidence reference: ${ref}.`));
      }
      for (const [slideIndex, slideId] of (entry?.slide_ids ?? []).entries()) {
        if (!ids.has(slideId)) findings.push(issue("error", "claim.slide.unknown", `$/claim_evidence_map/${index}/slide_ids/${slideIndex}`, `Unknown claim slide id: ${slideId}.`));
      }
    }
  } else if (map && typeof map === "object") {
    for (const [claimId, refs] of Object.entries(map)) {
      if (!Array.isArray(refs) || refs.length === 0) findings.push(issue("error", "claim.evidence.empty", `$/claim_evidence_map/${escapePointerPart(claimId)}`, "Every claim mapping needs at least one evidence reference."));
    }
  }
  if (deck.timing && typeof deck.timing === "object") {
    const estimated = slides.reduce((sum, slide) => sum + (Number(slide?.speaker_notes?.estimated_seconds) || 0), 0);
    if (Number.isFinite(deck.timing.estimated_seconds) && Math.abs(estimated - deck.timing.estimated_seconds) > 1) {
      findings.push(issue("error", "timing.estimated.mismatch", "$/timing/estimated_seconds", `Deck estimated_seconds is ${deck.timing.estimated_seconds}, but slide notes sum to ${estimated}.`));
    }
    const hasDuration = typeof deck.timing.duration_minutes === "number" && Number.isFinite(deck.timing.duration_minutes);
    const hasUsableFraction = typeof deck.timing.usable_fraction === "number" && Number.isFinite(deck.timing.usable_fraction);
    const hasTargetSeconds = typeof deck.timing.target_seconds === "number" && Number.isFinite(deck.timing.target_seconds);
    if (["1.1", "1.2"].includes(deck.schema_version) && !hasDuration && (deck.timing.usable_fraction != null || deck.timing.target_seconds != null)) {
      findings.push(issue("error", "timing.orphan-budget", "$/timing", "usable_fraction and target_seconds must be omitted when duration_minutes is absent."));
    }
    const calculatedTarget = hasDuration && hasUsableFraction ? deck.timing.duration_minutes * deck.timing.usable_fraction * 60 : null;
    if (calculatedTarget != null && hasTargetSeconds && Math.abs(calculatedTarget - deck.timing.target_seconds) > 1) {
      findings.push(issue(soft, "timing.target.mismatch", "$/timing/target_seconds", `Expected approximately ${calculatedTarget} seconds from duration_minutes × usable_fraction.`));
    }
    if (deck.timing.page_policy === "fixed") {
      if (!Number.isInteger(deck.timing.target_slide_count) || deck.timing.target_slide_count < 3) {
        findings.push(issue("error", "timing.slide-count.invalid", "$/timing/target_slide_count", "Fixed page policy requires an integer target_slide_count of at least 3."));
      } else if (slides.length !== deck.timing.target_slide_count) {
        findings.push(issue("error", "timing.slide-count.mismatch", "$/timing/target_slide_count", `Fixed target is ${deck.timing.target_slide_count} slides; deck contains ${slides.length}.`));
      }
    }
  }
  return findings;
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readJsonFile(filePath) {
  const text = await readFile(filePath, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    const wrapped = new Error(`Invalid JSON in ${filePath}: ${error.message}`);
    wrapped.cause = error;
    throw wrapped;
  }
}

export async function validateDeckSpec(deck, options = {}) {
  const schemaPath = options.schemaPath ? path.resolve(options.schemaPath) : DEFAULT_SCHEMA;
  const findings = [];
  if (await fileExists(schemaPath)) {
    const schema = await readJsonFile(schemaPath);
    validateJsonValue(deck, schema, { rootSchema: schema, issues: findings });
  } else if (options.requireSchema) {
    findings.push(issue("error", "schema.missing", "$", `Schema file does not exist: ${schemaPath}`));
  } else {
    findings.push(issue("warning", "schema.missing", "$", `Schema not found; only semantic checks ran: ${schemaPath}`));
  }
  findings.push(...semanticDeckIssues(deck, options.strict));
  const issues = options.strict === true
    ? findings.map((item) => item.severity === "warning" && item.strict_exempt !== true
      ? { ...item, severity: "error", promoted_by_strict: true }
      : item)
    : findings;
  return { schema: schemaPath, deck, issues };
}

export async function validateDeckSpecFile(specPath, options = {}) {
  const absoluteSpec = path.resolve(specPath);
  const deck = await readJsonFile(absoluteSpec);
  return { file: absoluteSpec, ...await validateDeckSpec(deck, options) };
}

function usage() {
  return [
    "Usage: node validate-deck-spec.mjs <deck-spec.json> [options]",
    "",
    "Options:",
    "  --schema <file>    JSON Schema path (default: ../schemas/deck-spec.schema.json)",
    "  --strict           Treat semantic warnings as errors",
    "  --require-schema   Fail when the schema file is absent",
    "  --json             Emit machine-readable JSON",
    "  -h, --help         Show this help",
  ].join("\n");
}

function parseArgs(argv) {
  const result = { strict: false, requireSchema: false, json: false };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--strict") result.strict = true;
    else if (arg === "--require-schema") result.requireSchema = true;
    else if (arg === "--json") result.json = true;
    else if (arg === "--schema") {
      if (!argv[index + 1]) throw new Error("--schema requires a file path.");
      result.schemaPath = argv[++index];
    } else if (arg === "-h" || arg === "--help") result.help = true;
    else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else positional.push(arg);
  }
  if (positional.length > 1) throw new Error("Provide exactly one deck-spec path.");
  result.specPath = positional[0];
  return result;
}

function printHuman(result) {
  const errors = result.issues.filter((item) => item.severity === "error");
  const warnings = result.issues.filter((item) => item.severity === "warning");
  const status = errors.length === 0 ? "PASS" : "FAIL";
  console.log(`${status}: ${result.file}`);
  for (const item of result.issues) console.log(`- ${item.severity.toUpperCase()} ${item.code} ${item.path}: ${item.message}`);
  console.log(`${errors.length} error(s), ${warnings.length} warning(s)`);
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.specPath) {
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  try {
    const result = await validateDeckSpecFile(args.specPath, args);
    const errors = result.issues.filter((item) => item.severity === "error");
    if (args.json) console.log(JSON.stringify({ ok: errors.length === 0, file: result.file, schema: result.schema, issues: result.issues }, null, 2));
    else printHuman(result);
    if (errors.length > 0) process.exitCode = 1;
  } catch (error) {
    if (args.json) console.log(JSON.stringify({ ok: false, error: error.message }, null, 2));
    else console.error(`ERROR: ${error.message}`);
    process.exitCode = 2;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) await main();
