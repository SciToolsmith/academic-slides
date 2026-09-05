#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createPresentationFromSpec, exportPresentation } from "../scripts/presentation-core.mjs";

const execFileAsync = promisify(execFile);
const skillDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sample = JSON.parse(await fs.readFile(path.join(skillDir, "assets/group-meeting-literature-universal/sample-deck-spec.json"), "utf8"));
const content = structuredClone(sample.slides.find((slide) => slide.id === "sample-known-gap-question"));
content.content.title = "The matched control isolates the mechanism";
content.content.section_label = "1.3 Research design";
content.render_data.continuation = { index: 2, total: 3 };
const closing = structuredClone(sample.slides.find((slide) => slide.kind === "closing"));
closing.content.title = "Which control should we add next?";
closing.source_line = "Synthetic visual fixture; no real study claim";
closing.render_data = {
  synthesis: "The observed contrast leaves a shared confound unresolved.",
  prompts: ["Can a matched control distinguish the explanations?"],
};
closing.content.body = ["The observed contrast leaves a shared confound unresolved."];
closing.content.bullets = [{ text: "Can a matched control distinguish the explanations?", level: 0 }];
const appendix = structuredClone(content);
appendix.id = "backup-method-detail";
appendix.kind = "appendix";
appendix.priority = "appendix";
appendix.content.title = "Backup: control assignment details";
appendix.content.section_label = "Backup";
delete appendix.render_data.continuation;
const slides = [content, closing, appendix].map((slide, index) => ({ ...slide, order: index + 1 }));
const deck = {
  ...sample,
  language: "en",
  artifact_purpose: "production",
  structure: { narrative_mode: "paper_walkthrough", title_policy: "claim", closing_mode: "discussion", section_transition_mode: "none", appendix_policy: "after_closing_unlisted" },
  literature: { mode: "single_paper", focal_paper_ids: ["paper-a"], scientific_contract: "group_meeting_v2" },
  slides,
  claim_evidence_map: [],
};
const built = await createPresentationFromSpec(deck);
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "paper-club-ppt-narrative-"));
try {
  const pptx = path.join(temporary, "narrative.pptx");
  await exportPresentation(built.presentation, pptx);
  async function slideXml(number) {
    return (await execFileAsync("unzip", ["-p", pptx, `ppt/slides/slide${number}.xml`], { maxBuffer: 10 * 1024 * 1024 })).stdout;
  }
  const first = await slideXml(1);
  assert.match(first, /The matched control isolates the mechanism/);
  assert.match(first, /1\.3 Research design/);
  assert.match(first, /2\/3/);
  assert.match(first, /group-context-tag/);
  const lastMain = await slideXml(2);
  assert.match(lastMain, /Which control should we add next\?/);
  assert.match(lastMain, /The observed contrast leaves a shared confound unresolved\./);
  assert.match(lastMain, /Can a matched control distinguish the explanations\?/);
  assert.match(lastMain, /Synthetic visual fixture; no real study claim/);
  assert.doesNotMatch(lastMain, /谢谢老师|用一句话带走/);
  const backupXml = await slideXml(3);
  assert.match(backupXml, /Backup: control assignment details/);
  assert.match(backupXml, /Backup/);
  assert.equal(built.slideSpecs.at(-1).id, "backup-method-detail");
  const fallbackDeck = structuredClone(deck);
  fallbackDeck.slides[1].render_data.synthesis = "  ";
  fallbackDeck.slides[1].render_data.prompts = [];
  const fallbackBuilt = await createPresentationFromSpec(fallbackDeck);
  const fallbackPptx = path.join(temporary, "fallback-narrative.pptx");
  await exportPresentation(fallbackBuilt.presentation, fallbackPptx);
  const fallbackXml = (await execFileAsync("unzip", ["-p", fallbackPptx, "ppt/slides/slide2.xml"], { maxBuffer: 10 * 1024 * 1024 })).stdout;
  assert.match(fallbackXml, /The observed contrast leaves a shared confound unresolved\./);
  assert.match(fallbackXml, /Can a matched control distinguish the explanations\?/);
  assert.doesNotMatch(fallbackXml, /\[object Object\]/);
  for (const field of ["body", "bullets"]) {
    const conflict = structuredClone(deck);
    conflict.slides[1].content[field] = field === "body" ? ["A different presenter judgment."] : [{ text: "A different discussion question?", level: 0 }];
    await assert.rejects(() => createPresentationFromSpec(conflict), /Discussion closing payload is invalid:.*different non-empty/, `the direct renderer must reject conflicting ${field} content rather than losing it`);
  }
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}

console.log("PASS group-meeting-narrative-render: independent navigation, English discussion closing, empty-field fallbacks, and backup order survive PPTX export; conflicting copies are rejected.");
