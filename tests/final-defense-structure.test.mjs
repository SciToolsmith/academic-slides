#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDeck } from "../scripts/build.mjs";
import { validateDeckSpecFile } from "../scripts/validate-deck-spec.mjs";
import { internal } from "../scripts/presentation-core.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(TEST_DIR, "..");
const SAMPLE_PATH = path.join(SKILL_DIR, "assets", "final-defense-universal", "sample-deck-spec.json");

assert.equal(internal.sectionVisible({ role: "results" }, "show_in_navigation"), true);
assert.equal(internal.sectionVisible({ role: "appendix" }, "show_in_navigation"), false);
assert.equal(internal.sectionVisible({ role: "results", show_in_navigation: false }, "show_in_navigation"), false);

function cloneSlide(sample, id, kind, sectionId) {
  const slide = structuredClone(sample);
  slide.id = id;
  slide.kind = kind;
  slide.section_id = sectionId;
  return slide;
}

function makeProductionDeck(sample) {
  const deck = structuredClone(sample);
  deck.project_id = "final-defense-structure-fixture";
  deck.title = "Production final defense fixture";
  deck.artifact_purpose = "production";
  deck.structure = {
    section_transition_mode: "full",
    appendix_policy: "after_closing_unlisted",
  };
  deck.assets = [{
    id: "structure-map",
    path: "assets/figures/structure-map.png",
    type: "diagram",
    alt_text: "科学叙事分支与汇合示意图",
  }];
  deck.sections = [
    ["background", "研究背景与问题", "背景问题", "problem"],
    ["method", "研究方法与模型", "方法模型", "method"],
    ["results", "核心结果", "核心结果", "results"],
    ["validation", "验证与讨论", "验证讨论", "validation"],
    ["conclusion", "结论与贡献", "结论贡献", "conclusion"],
  ].map(([id, title, shortTitle, role], index) => ({
    id,
    order: index + 1,
    title,
    short_title: shortTitle,
    role,
    audience_role: "main",
    show_in_agenda: true,
    show_in_navigation: true,
    purpose: `${title}的答辩叙事任务。`,
  }));

  const coverTemplate = sample.slides.find((slide) => slide.kind === "title");
  const agendaTemplate = sample.slides.find((slide) => slide.kind === "agenda");
  const dividerTemplate = sample.slides.find((slide) => slide.kind === "section");
  const bodyTemplate = sample.slides.find((slide) => slide.kind === "content");
  const closingTemplate = sample.slides.find((slide) => slide.kind === "closing");
  const slides = [
    cloneSlide(coverTemplate, "cover", "title", "background"),
    cloneSlide(agendaTemplate, "agenda", "agenda", "background"),
  ];
  slides[1].render_data.sections = deck.sections.map((section, index) => ({
    number: String(index + 1).padStart(2, "0"),
    title: section.title,
  }));
  slides[1].content.body = deck.sections.map((section, index) => `${String(index + 1).padStart(2, "0")} ${section.title}`);

  for (const section of deck.sections) {
    const divider = cloneSlide(dividerTemplate, `divider-${section.id}`, "section", section.id);
    divider.content.title = section.title;
    divider.content.kicker = `PART ${String(section.order).padStart(2, "0")}`;
    const body = cloneSlide(bodyTemplate, `body-${section.id}`, "content", section.id);
    body.content.title = `${section.title}：核心证据`;
    slides.push(divider, body);
  }
  slides.push(cloneSlide(closingTemplate, "closing", "closing", "conclusion"));
  slides.forEach((slide, index) => { slide.order = index + 1; });
  slides[3].relationship_topology = "branch_converge";
  slides[3].visual_focus = "从共同模型分支到两类验证路径";
  slides[3].annotation_plan = ["标明分支条件", "标明汇合结论"];
  slides[3].asset_transform = {
    asset_ref: "structure-map",
    mode: "annotate",
    reason: "在证据上直接标明评委需要观察的关键区域。",
  };
  deck.slides = slides;
  deck.claim_evidence_map = [];
  const estimatedSeconds = slides.reduce((sum, slide) => sum + Number(slide.speaker_notes?.estimated_seconds ?? 0), 0);
  deck.timing.estimated_seconds = estimatedSeconds;
  deck.timing.target_seconds = estimatedSeconds;
  deck.timing.duration_minutes = estimatedSeconds / deck.timing.usable_fraction / 60;
  deck.timing.page_policy = "fixed";
  deck.timing.target_slide_count = slides.length;
  return deck;
}

function addAppendix(deck, { showInAgenda = false, beforeClosing = false } = {}) {
  const appendixSection = {
    id: "appendix-material",
    order: deck.sections.length + 1,
    title: "附录材料",
    short_title: "附录",
    role: "appendix",
    show_in_agenda: showInAgenda,
    show_in_navigation: false,
    purpose: "承接评委追问的补充证据。",
  };
  deck.sections.push(appendixSection);
  const bodyTemplate = deck.slides.find((slide) => slide.kind === "content");
  const appendix = cloneSlide(bodyTemplate, "appendix-slide", "appendix", appendixSection.id);
  appendix.content.title = "附录证据";
  const closingIndex = deck.slides.findIndex((slide) => slide.kind === "closing");
  deck.slides.splice(beforeClosing ? closingIndex : closingIndex + 1, 0, appendix);
  deck.slides.forEach((slide, index) => { slide.order = index + 1; });
  const estimatedSeconds = deck.slides.reduce((sum, slide) => sum + Number(slide.speaker_notes?.estimated_seconds ?? 0), 0);
  deck.timing.estimated_seconds = estimatedSeconds;
  deck.timing.target_seconds = estimatedSeconds;
  deck.timing.duration_minutes = estimatedSeconds / deck.timing.usable_fraction / 60;
  deck.timing.target_slide_count = deck.slides.length;
}

function refreshDeck(deck) {
  deck.slides.forEach((slide, index) => { slide.order = index + 1; });
  const estimatedSeconds = deck.slides.reduce((sum, slide) => sum + Number(slide.speaker_notes?.estimated_seconds ?? 0), 0);
  deck.timing.estimated_seconds = estimatedSeconds;
  deck.timing.target_seconds = estimatedSeconds;
  deck.timing.duration_minutes = estimatedSeconds / deck.timing.usable_fraction / 60;
  deck.timing.target_slide_count = deck.slides.length;
}

async function validateFixture(tempDir, name, deck) {
  const specPath = path.join(tempDir, `${name}.json`);
  await writeFile(specPath, `${JSON.stringify(deck, null, 2)}\n`, "utf8");
  return validateDeckSpecFile(specPath, { strict: false, requireSchema: true });
}

const sample = JSON.parse(await readFile(SAMPLE_PATH, "utf8"));
const tempDir = await mkdtemp(path.join(os.tmpdir(), "academic-slides-final-defense-structure-"));
try {
  const correct = makeProductionDeck(sample);
  const correctResult = await validateFixture(tempDir, "correct-five-sections", correct);
  assert.equal(
    correctResult.issues.some((item) => item.severity === "error"),
    false,
    JSON.stringify(correctResult.issues, null, 2),
  );

  const missingSection = structuredClone(correct);
  missingSection.slides = missingSection.slides.filter((slide) => slide.id !== "divider-results");
  missingSection.slides.forEach((slide, index) => { slide.order = index + 1; });
  missingSection.timing.target_slide_count = missingSection.slides.length;
  missingSection.timing.estimated_seconds = missingSection.slides.reduce((sum, slide) => sum + Number(slide.speaker_notes?.estimated_seconds ?? 0), 0);
  missingSection.timing.target_seconds = missingSection.timing.estimated_seconds;
  missingSection.timing.duration_minutes = missingSection.timing.estimated_seconds / missingSection.timing.usable_fraction / 60;
  const missingResult = await validateFixture(tempDir, "missing-section", missingSection);
  assert(
    missingResult.issues.some((item) => item.code === "final-defense.section-divider.count" && item.severity === "error"),
    "a production deck missing a main-section divider must fail",
  );

  const missingAgenda = structuredClone(correct);
  missingAgenda.slides = missingAgenda.slides.filter((slide) => slide.kind !== "agenda");
  missingAgenda.slides.forEach((slide, index) => { slide.order = index + 1; });
  missingAgenda.timing.target_slide_count = missingAgenda.slides.length;
  const missingAgendaResult = await validateFixture(tempDir, "missing-agenda", missingAgenda);
  assert(
    missingAgendaResult.issues.some((item) => item.code === "final-defense.agenda.count" && item.severity === "error"),
    "a production defense needs one audience agenda",
  );

  const genericTitle = structuredClone(correct);
  genericTitle.sections[0].title = "问题与路线";
  genericTitle.slides.find((slide) => slide.id === "divider-background").content.title = "问题与路线";
  genericTitle.slides.find((slide) => slide.id === "agenda").render_data.sections[0].title = "问题与路线";
  genericTitle.slides.find((slide) => slide.id === "agenda").content.body[0] = "01 问题与路线";
  const genericTitleResult = await validateFixture(tempDir, "generic-section-title", genericTitle);
  assert(
    genericTitleResult.issues.some((item) => item.code === "final-defense.section-title.generic"),
    "workflow labels must be rejected in strict production validation in favor of thesis-specific academic titles",
  );
  const genericStrictResult = await validateDeckSpecFile(genericTitleResult.file, { strict: true, requireSchema: true });
  const promotedGeneric = genericStrictResult.issues.find((item) => item.code === "final-defense.section-title.generic");
  assert.equal(promotedGeneric?.severity, "error", "programmatic strict validation must promote generic section-title warnings");
  assert.equal(promotedGeneric?.promoted_by_strict, true, "strict promotion should be explicit and happen in the reusable API");
  await assert.rejects(
    () => buildDeck({ spec: genericTitleResult.file, output: path.join(tempDir, "generic-section-title.pptx") }),
    /final-defense\.section-title\.generic/,
    "buildDeck must stop before rendering when programmatic strict validation promotes a generic section title",
  );

  const badShortTitle = structuredClone(correct);
  badShortTitle.sections[0].short_title = "答辩备查";
  const badShortTitleResult = await validateFixture(tempDir, "bad-short-title", badShortTitle);
  assert(
    badShortTitleResult.issues.some((item) => item.code === "final-defense.section-title.reserved" && item.path.endsWith("/short_title")),
    "reserved production labels must be rejected in short_title as well as title",
  );

  const hiddenMainSection = structuredClone(correct);
  hiddenMainSection.sections[0].show_in_agenda = false;
  const hiddenMainResult = await validateFixture(tempDir, "hidden-main-section", hiddenMainSection);
  assert(
    hiddenMainResult.issues.some((item) => item.code === "final-defense.section.agenda-hidden"),
    "a main section must not be hidden from the audience agenda",
  );

  const unjustifiedIntegrated = structuredClone(correct);
  unjustifiedIntegrated.structure.section_transition_mode = "integrated";
  unjustifiedIntegrated.slides = unjustifiedIntegrated.slides.filter((slide) => slide.kind !== "section");
  unjustifiedIntegrated.slides.forEach((slide, index) => { slide.order = index + 1; });
  unjustifiedIntegrated.timing.target_slide_count = unjustifiedIntegrated.slides.length;
  const integratedResult = await validateFixture(tempDir, "unjustified-integrated", unjustifiedIntegrated);
  assert(
    integratedResult.issues.some((item) => item.code === "final-defense.section-divider.reason"),
    "integrated/none section transitions require an explicit rationale",
  );

  const emptyMainSection = structuredClone(correct);
  emptyMainSection.slides = emptyMainSection.slides.filter((slide) => slide.id !== "body-method");
  refreshDeck(emptyMainSection);
  const emptyMainResult = await validateFixture(tempDir, "empty-main-section", emptyMainSection);
  assert(
    emptyMainResult.issues.some((item) => item.code === "final-defense.section.body-missing"),
    "a divider without a non-appendix body slide must not satisfy a main section",
  );

  const integratedWithDividers = structuredClone(correct);
  integratedWithDividers.structure.section_transition_mode = "integrated";
  integratedWithDividers.structure.section_transition_reason = "用户要求紧凑过渡。";
  const integratedWithDividersResult = await validateFixture(tempDir, "integrated-with-dividers", integratedWithDividers);
  assert(
    integratedWithDividersResult.issues.some((item) => item.code === "final-defense.section-divider.unexpected"),
    "integrated/none modes must reject leftover standalone section pages",
  );

  const agendaAfterClosing = structuredClone(correct);
  const agendaIndex = agendaAfterClosing.slides.findIndex((slide) => slide.kind === "agenda");
  agendaAfterClosing.slides.push(agendaAfterClosing.slides.splice(agendaIndex, 1)[0]);
  refreshDeck(agendaAfterClosing);
  const agendaAfterClosingResult = await validateFixture(tempDir, "agenda-after-closing", agendaAfterClosing);
  assert(
    agendaAfterClosingResult.issues.some((item) => item.code === "final-defense.agenda.order"),
    "the agenda must immediately follow the cover",
  );

  const missingClosing = structuredClone(correct);
  missingClosing.slides = missingClosing.slides.filter((slide) => slide.kind !== "closing");
  refreshDeck(missingClosing);
  const missingClosingResult = await validateFixture(tempDir, "missing-closing", missingClosing);
  assert(
    missingClosingResult.issues.some((item) => item.code === "final-defense.closing.count"),
    "a production defense needs one closing slide even when it has no appendix",
  );

  const priorityAppendixBeforeClosing = structuredClone(correct);
  priorityAppendixBeforeClosing.slides.find((slide) => slide.id === "body-method").priority = "appendix";
  const priorityAppendixResult = await validateFixture(tempDir, "priority-appendix-before-closing", priorityAppendixBeforeClosing);
  assert(
    priorityAppendixResult.issues.some((item) => item.code === "final-defense.appendix.order"),
    "priority=appendix must be treated as appendix and remain after closing",
  );

  const appendixInAgenda = structuredClone(correct);
  addAppendix(appendixInAgenda, { showInAgenda: true });
  const agendaResult = await validateFixture(tempDir, "appendix-in-agenda", appendixInAgenda);
  assert(
    agendaResult.issues.some((item) => item.code === "final-defense.appendix.agenda" && item.severity === "error"),
    "appendix sections must not appear in the agenda",
  );

  const appendixBeforeClosing = structuredClone(correct);
  addAppendix(appendixBeforeClosing, { beforeClosing: true });
  const orderResult = await validateFixture(tempDir, "appendix-before-closing", appendixBeforeClosing);
  assert(
    orderResult.issues.some((item) => item.code === "final-defense.appendix.order" && item.severity === "error"),
    "appendix slides must appear after closing",
  );

  const gallery = structuredClone(missingSection);
  gallery.artifact_purpose = "layout_gallery";
  addAppendix(gallery, { showInAgenda: true, beforeClosing: true });
  gallery.sections[0].title = "答辩备查";
  const galleryResult = await validateFixture(tempDir, "layout-gallery-exemption", gallery);
  assert.equal(
    galleryResult.issues.some((item) => item.code.startsWith("final-defense.")),
    false,
    JSON.stringify(galleryResult.issues, null, 2),
  );
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log("PASS final-defense production structure contract");
