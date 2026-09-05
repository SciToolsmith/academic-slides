#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateDeckSpec } from "../scripts/validate-deck-spec.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(TEST_DIR, "..");
const SAMPLE_PATH = path.join(SKILL_DIR, "assets", "group-meeting-literature-universal", "sample-deck-spec.json");

function issueCodes(result, severity = "error") {
  return result.issues.filter((item) => item.severity === severity).map((item) => item.code);
}

async function fixture() {
  const sample = JSON.parse(await readFile(SAMPLE_PATH, "utf8"));
  const cover = structuredClone(sample.slides.find((slide) => slide.id === "sample-group-cover"));
  const bodySource = structuredClone(sample.slides.find((slide) => slide.id === "sample-known-gap-question"));
  const closing = structuredClone(sample.slides.find((slide) => slide.id === "sample-group-closing"));
  cover.id = "group-cover";
  cover.content.title = "A focal paper and what I learned from it";
  cover.content.subtitle = "Author et al. · Journal · 2026";
  cover.render_data = { subtitle: cover.content.subtitle, presenter: "Student A", research_group: "Lab A", date: "2026-09-01" };
  const bodyTitles = [
    "1.1 文献基本信息",
    "1.2 研究背景与意义",
    "1.3 研究设计与方法",
    "1.4 主要结果与结论",
  ];
  const bodies = bodyTitles.map((title, index) => ({
    ...structuredClone(bodySource),
    id: `group-body-${index + 1}`,
    content: { ...structuredClone(bodySource.content), title },
    render_data: { ...structuredClone(bodySource.render_data), paper_no: "1" },
  }));
  closing.id = "group-closing";
  closing.content.title = "谢谢老师，请批评指正";
  closing.render_data = { presenter: "Student A" };
  const slides = [cover, ...bodies, closing].map((slide, index) => {
    const noteIds = new Set((slide.speaker_notes?.sources ?? []).map((source) => source.source_id));
    return {
      ...slide,
      order: index + 1,
      evidence_refs: (slide.evidence_refs ?? []).filter((id) => noteIds.has(id)),
    };
  });
  const estimated = slides.reduce((sum, slide) => sum + Number(slide.speaker_notes?.estimated_seconds ?? 0), 0);
  return {
    ...sample,
    artifact_purpose: "production",
    structure: { section_transition_mode: "none", appendix_policy: "none" },
    literature: { mode: "single_paper", focal_paper_ids: ["paper-a"], scientific_contract: "group_meeting_v2" },
    title: "A focal paper and what I learned from it",
    timing: { estimated_seconds: estimated, approximate: true, page_policy: "fixed", target_slide_count: slides.length, timing_notes: [] },
    slides,
    claim_evidence_map: [],
  };
}

async function validate(deck) {
  return validateDeckSpec(deck, { strict: false, requireSchema: true });
}

const baseline = await fixture();
const baselineResult = await validate(baseline);
assert.deepEqual(issueCodes(baselineResult), [], JSON.stringify(baselineResult.issues, null, 2));

const coverNotFirst = structuredClone(baseline);
[coverNotFirst.slides[0].order, coverNotFirst.slides[1].order] = [2, 1];
assert(issueCodes(await validate(coverNotFirst)).includes("group-meeting.cover.order"));

const afterClosing = structuredClone(baseline);
const extra = structuredClone(afterClosing.slides[1]);
extra.id = "after-closing";
extra.order = afterClosing.slides.length + 1;
afterClosing.slides.push(extra);
afterClosing.timing.target_slide_count = afterClosing.slides.length;
afterClosing.timing.estimated_seconds += extra.speaker_notes.estimated_seconds;
assert(issueCodes(await validate(afterClosing)).includes("group-meeting.closing.order"));

const visibleAppendix = structuredClone(baseline);
visibleAppendix.slides[1].kind = "appendix";
visibleAppendix.slides[1].priority = "appendix";
assert(issueCodes(await validate(visibleAppendix)).includes("group-meeting.appendix.visible"));

const appendixPolicy = structuredClone(baseline);
appendixPolicy.structure.appendix_policy = "after_closing_unlisted";
const backup = structuredClone(extra);
backup.id = "explicit-backup";
backup.kind = "appendix";
backup.priority = "appendix";
backup.content.title = "Additional method detail for questions";
appendixPolicy.slides.push(backup);
appendixPolicy.timing.target_slide_count = baseline.slides.length;
appendixPolicy.timing.estimated_seconds += backup.speaker_notes.estimated_seconds;
assert.deepEqual(issueCodes(await validate(appendixPolicy)), [], "explicit backup pages after the main closing must pass");
const countBackup = structuredClone(appendixPolicy);
countBackup.timing.include_appendix_in_count = true;
assert(issueCodes(await validate(countBackup)).includes("timing.slide-count.mismatch"), "including backup pages must affect a fixed target");
countBackup.timing.target_slide_count = countBackup.slides.length;
assert.deepEqual(issueCodes(await validate(countBackup)), [], "explicit all-pages targets include the backup exactly once");
const priorityBackup = structuredClone(appendixPolicy);
priorityBackup.slides.at(-1).kind = "content";
assert.deepEqual(issueCodes(await validate(priorityBackup)), [], "priority-marked backup uses the same count policy as kind=appendix");

const earlyAppendix = structuredClone(appendixPolicy);
[earlyAppendix.slides.at(-1).order, earlyAppendix.slides.at(-2).order] = [earlyAppendix.slides.at(-2).order, earlyAppendix.slides.at(-1).order];
assert(issueCodes(await validate(earlyAppendix)).includes("group-meeting.appendix.order"));

const listedAppendix = structuredClone(appendixPolicy);
listedAppendix.sections.push({ id: "backup", order: listedAppendix.sections.length + 1, title: "Backup", role: "appendix", show_in_agenda: true });
listedAppendix.slides.at(-1).section_id = "backup";
assert(issueCodes(await validate(listedAppendix)).includes("group-meeting.appendix.navigation"));

const missingPresenter = structuredClone(baseline);
delete missingPresenter.slides[0].render_data.presenter;
delete missingPresenter.slides[0].render_data.date;
assert.deepEqual(issueCodes(await validate(missingPresenter)), [], "unknown user identity and meeting date may be omitted");

const genericClosing = structuredClone(baseline);
genericClosing.slides.at(-1).content.title = "讨论与下一步";
assert.deepEqual(issueCodes(await validate(genericClosing)), [], "closing wording is not fixed to a Chinese phrase");
genericClosing.slides.at(-1).render_data.shell_source = "user_locked";
assert(!issueCodes(await validate(genericClosing)).includes("group-meeting.closing.student-shell"), "a genuinely user-locked closing shell must remain allowed");

const productionLabel = structuredClone(baseline);
productionLabel.slides[0].content.subtitle = "GROUP MEETING · LITERATURE REVIEW";
assert(issueCodes(await validate(productionLabel)).includes("group-meeting.production-language.generator-label"));

const notesOnly = structuredClone(baseline);
notesOnly.slides[1].speaker_notes.script += " Internal deck-spec QA passed.";
assert(!issueCodes(await validate(notesOnly)).some((code) => code.startsWith("group-meeting.production-language")), "internal notes must not be confused with visible audience text");

const internalMetadata = structuredClone(baseline);
internalMetadata.slides[1].render_data.internal_reference = "evidence-index";
assert(!issueCodes(await validate(internalMetadata)).some((code) => code.startsWith("group-meeting.production-language")), "non-rendered metadata must not be treated as audience text");

const closingAnalysis = structuredClone(baseline);
closingAnalysis.slides.at(-1).render_data.synthesis = "A final analytical summary";
assert(issueCodes(await validate(closingAnalysis)).includes("group-meeting.closing.analysis-payload"), "analysis belongs before the fixed closing shell");
closingAnalysis.structure.closing_mode = "discussion";
closingAnalysis.slides.at(-1).content.title = "Which explanation should we test next?";
closingAnalysis.slides.at(-1).render_data.prompts = ["Which control would distinguish the alternatives?"];
assert.deepEqual(issueCodes(await validate(closingAnalysis)), [], "an explicit discussion closing may carry the final synthesis and question");
const equivalentClosingFields = structuredClone(closingAnalysis);
equivalentClosingFields.slides.at(-1).content.body = ["A final", "analytical summary"];
equivalentClosingFields.slides.at(-1).content.bullets = [{ text: "Which control would distinguish the alternatives?", level: 0 }];
assert.deepEqual(issueCodes(await validate(equivalentClosingFields)), [], "equivalent strings and bullet text objects can mirror the renderer payload");
const conflictingClosingBody = structuredClone(equivalentClosingFields);
conflictingClosingBody.slides.at(-1).content.body = ["External validity remains unresolved."];
assert(issueCodes(await validate(conflictingClosingBody)).includes("group-meeting.closing.payload-conflict"), "an overriding synthesis cannot silently hide a different body judgment");
const conflictingClosingPrompts = structuredClone(equivalentClosingFields);
conflictingClosingPrompts.slides.at(-1).content.bullets[0].text = "Can a new cohort reproduce the finding?";
assert(issueCodes(await validate(conflictingClosingPrompts)).includes("group-meeting.closing.payload-conflict"), "an overriding prompts list cannot silently hide a different question");
const fallbackClosing = structuredClone(equivalentClosingFields);
fallbackClosing.slides.at(-1).render_data.synthesis = "  ";
fallbackClosing.slides.at(-1).render_data.prompts = [];
assert.deepEqual(issueCodes(await validate(fallbackClosing)), [], "empty renderer fields allow English body and bullet-object fallbacks");
fallbackClosing.slides.at(-1).content.bullets = [1, 2, 3, 4].map((number) => ({ text: `Question ${number}?`, level: 0 }));
assert(issueCodes(await validate(fallbackClosing)).includes("group-meeting.closing.prompts-capacity"), "capacity checks must cover the fallback list when prompts is empty");
const invalidBodyObject = structuredClone(closingAnalysis);
invalidBodyObject.slides.at(-1).content.body = [{ text: "Do not stringify this object." }];
assert(issueCodes(await validate(invalidBodyObject)).includes("group-meeting.closing.payload-shape"), "body remains an array of strings; only bullet/prompt entries accept text objects");
const silentDiscussion = structuredClone(closingAnalysis);
silentDiscussion.slides.at(-1).speaker_notes.script = "";
assert(issueCodes(await validate(silentDiscussion)).includes("notes.script.empty"), "an analytical closing needs speaker notes like any other substantive slide");
const unsourcedDiscussion = structuredClone(closingAnalysis);
unsourcedDiscussion.slides.at(-1).speaker_notes.sources = [];
assert(issueCodes(await validate(unsourcedDiscussion)).includes("notes.sources.coverage"), "discussion evidence must remain traceable in the notes");

const claimTitles = structuredClone(baseline);
claimTitles.structure.title_policy = "claim";
for (const [index, slide] of claimTitles.slides.slice(1, -1).entries()) {
  slide.content.section_label = slide.content.title;
  slide.content.title = `This page explains evidence step ${index + 1}`;
}
assert.deepEqual(issueCodes(await validate(claimTitles)), [], "conclusion titles preserve numbered navigation independently");
delete claimTitles.slides[2].content.section_label;
assert(issueCodes(await validate(claimTitles)).includes("group-meeting.paper-section.missing"), "claim titles must not erase walkthrough coverage");

const comparison = structuredClone(baseline);
comparison.structure.narrative_mode = "question_comparison";
comparison.structure.title_policy = "claim";
comparison.literature.mode = "multi_paper";
comparison.literature.focal_paper_ids = ["paper-a", "paper-b"];
for (const slide of comparison.slides.slice(1, -1)) {
  slide.paper_ids = ["paper-a", "paper-b"];
  slide.content.title = "The studies differ in the control they use";
}
assert.deepEqual(issueCodes(await validate(comparison)), [], "question comparison does not require serial paper dividers or numbered section titles");
comparison.slides[1].paper_ids.push("missing-paper");
assert(issueCodes(await validate(comparison)).includes("group-meeting.paper-reference.unknown"));
comparison.slides[1].paper_ids.pop();
comparison.structure.narrative_mode = "paper_walkthrough";
assert(issueCodes(await validate(comparison)).includes("group-meeting.multi-paper.agenda"), "legacy walkthrough still requires its paper agenda");

const legacyCompatible = structuredClone(baseline);
delete legacyCompatible.literature.scientific_contract;
delete legacyCompatible.slides[0].render_data.presenter;
delete legacyCompatible.slides[0].render_data.date;
legacyCompatible.slides.at(-1).content.title = "讨论与下一步";
legacyCompatible.slides[0].content.subtitle = "GROUP MEETING · LITERATURE REVIEW";
legacyCompatible.structure.appendix_policy = "after_closing_unlisted";
const legacyAppendix = structuredClone(legacyCompatible.slides[1]);
legacyAppendix.id = "legacy-appendix";
legacyAppendix.kind = "appendix";
legacyAppendix.priority = "appendix";
legacyAppendix.order = legacyCompatible.slides.length + 1;
legacyCompatible.slides.push(legacyAppendix);
legacyCompatible.timing.target_slide_count = legacyCompatible.slides.length;
legacyCompatible.timing.include_appendix_in_count = true;
legacyCompatible.timing.estimated_seconds += legacyAppendix.speaker_notes.estimated_seconds;
const legacyCodes = issueCodes(await validate(legacyCompatible));
assert(!legacyCodes.some((code) => code.startsWith("group-meeting.cover.")
  || code.startsWith("group-meeting.closing.")
  || code.startsWith("group-meeting.appendix.")
  || code.startsWith("group-meeting.production-language.")), "omitted/v1 contracts must retain the pre-v2 shell and appendix behavior");

console.log("PASS group-meeting-shell-contract: compatible walkthrough defaults, claim navigation, comparison structure, localized/discussion closings, and explicit backup pages.");
