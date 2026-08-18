#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { auditProductionBudget } from "../scripts/audit-production-budget.mjs";
import { buildDeckMapFile, writeDeckMapFile } from "../scripts/build-deck-map.mjs";

const execFileAsync = promisify(execFile);
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(TEST_DIR, "..");
const FIXTURE_DIR = path.join(TEST_DIR, "fixtures", "production-budget");

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeFixtureFile(filePath, value = "fixture\n") {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, value, "utf8");
}

async function copyJsonFixture(name, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(await readJson(path.join(FIXTURE_DIR, name)), null, 2)}\n`, "utf8");
}

async function treeSnapshot(root) {
  const output = [];
  const walk = async (directory) => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const full = path.join(directory, entry.name);
      const relative = path.relative(root, full).replaceAll(path.sep, "/");
      if (entry.isDirectory()) {
        output.push({ path: `${relative}/`, type: "directory" });
        await walk(full);
      } else if (entry.isFile()) {
        const content = await readFile(full);
        const info = await stat(full);
        output.push({
          path: relative,
          type: "file",
          bytes: content.byteLength,
          mtime_ms: info.mtimeMs,
          sha256: createHash("sha256").update(content).digest("hex"),
        });
      }
    }
  };
  await walk(root);
  return output;
}

function containsForbiddenMapField(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsForbiddenMapField);
  return Object.entries(value).some(([key, item]) => ["render_data", "renderData", "speaker_notes", "speakerNotes"].includes(key) || containsForbiddenMapField(item));
}

async function main() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "academic-slides-budget-"));
  try {
    const specPath = path.join(temporary, "deck-spec.json");
    const manifestPath = path.join(temporary, "assets", "figures", "figures.manifest.json");
    const policyPath = path.join(temporary, "lenient-policy.json");
    const deck = await readJson(path.join(FIXTURE_DIR, "deck-spec.json"));
    // Make the fixture realistic enough to prove that render payloads and full
    // notes, rather than whitespace alone, are removed from the deck map.
    deck.slides[1].render_data.verbose_payload = "render payload ".repeat(2_500);
    deck.slides[1].speaker_notes.script = "speaker note ".repeat(1_500);
    await writeFile(specPath, `${JSON.stringify(deck, null, 2)}\n`, "utf8");
    await copyJsonFixture("figures.manifest.json", manifestPath);
    await copyJsonFixture("lenient-policy.json", policyPath);

    for (const relative of [
      "assets/figures/ready/main.png",
      "assets/figures/ready/unused-1.png",
      "assets/figures/ready/unused-2.png",
      "assets/figures/ready/unused-3.png",
      "assets/figures/ready/unused-4.png",
      "assets/formulas/original/formula.png",
    ]) await writeFixtureFile(path.join(temporary, relative));

    for (const previewDir of [".academic-slides-preview", "qa/review-preview"]) {
      for (let index = 1; index <= 4; index += 1) await writeFixtureFile(path.join(temporary, previewDir, `slide-${String(index).padStart(2, "0")}.png`));
    }
    for (const wordDir of [".word-qa", ".word-qa-final"]) {
      for (let index = 1; index <= 4; index += 1) await writeFixtureFile(path.join(temporary, wordDir, `page-${index}.png`));
      await writeFixtureFile(path.join(temporary, wordDir, "speaker-script.pdf"));
    }

    const built = await buildDeckMapFile(specPath);
    assert.equal(built.deckMap.kind, "academic-slides-deck-map");
    assert.equal(built.deckMap.counts.slides, 4);
    assert.equal(containsForbiddenMapField(built.deckMap), false, "deck map must never contain full render_data or speaker_notes branches");
    assert(built.ratio < 0.35, `navigation map should be materially smaller than the spec; ratio=${built.ratio}`);
    assert.equal(built.deckMap.slides[1].notes_summary.estimated_seconds, 70);
    assert.deepEqual(built.deckMap.slides[1].notes_summary.source_ids, ["thesis-page-20"]);
    assert(built.deckMap.slides[1].asset_refs.includes("ready-main"));
    assert.equal(JSON.stringify(built.deckMap).includes("speaker note speaker note"), false);
    assert.equal(JSON.stringify(built.deckMap).includes("render payload render payload"), false);

    const beforeStdoutBuild = await treeSnapshot(temporary);
    const stdoutBuild = await execFileAsync(process.execPath, [path.join(SKILL_DIR, "scripts", "build-deck-map.mjs"), "--spec", specPath, "--compact"], { encoding: "utf8" });
    assert.equal(JSON.parse(stdoutBuild.stdout).kind, "academic-slides-deck-map");
    assert.deepEqual(await treeSnapshot(temporary), beforeStdoutBuild, "stdout-only deck-map generation must not change the project");

    const deckMapPath = path.join(temporary, "deck-map.json");
    await writeDeckMapFile(specPath, deckMapPath);
    const firstDeckMap = await readFile(deckMapPath, "utf8");
    await assert.rejects(() => writeDeckMapFile(specPath, deckMapPath), /already exists/);
    assert.equal(await readFile(deckMapPath, "utf8"), firstDeckMap, "refusing overwrite must preserve the existing map");

    const beforeAudit = await treeSnapshot(temporary);
    const defaultAudit = await auditProductionBudget({ spec: specPath, projectDir: temporary, deckMap: deckMapPath });
    assert.equal(defaultAudit.read_only, true);
    assert.equal(defaultAudit.status, "fail", "an actually missing selected asset is a default hard failure");
    assert(defaultAudit.findings.some((item) => item.code === "assets.selected.missing" && item.ref === "missing-only"));
    assert.equal(defaultAudit.findings.some((item) => item.code === "assets.selected.missing" && item.ref.includes("missing-primary")), false, "an available declared fallback must prevent a false missing-primary failure");
    assert(defaultAudit.findings.some((item) => item.code === "assets.ready.unselected-budget" && item.severity === "warn"));
    assert(defaultAudit.findings.some((item) => item.code === "previews.full-deck.duplicate" && item.severity === "warn"));
    assert(defaultAudit.findings.some((item) => item.code === "word-qa.full-render.duplicate" && item.severity === "warn"));
    assert.deepEqual(await treeSnapshot(temporary), beforeAudit, "budget audit must remain read-only even when it fails");

    const lenientAudit = await auditProductionBudget({ spec: specPath, projectDir: temporary, deckMap: deckMapPath, config: policyPath });
    assert.equal(lenientAudit.status, "pass", lenientAudit.findings.map((item) => `${item.code}: ${item.message}`).join("\n"));
    assert.equal(lenientAudit.checks.find((item) => item.id === "context-size").metrics.deck_map_to_spec_ratio < 0.35, true);

    const verboseMapPath = path.join(temporary, "invalid-verbose-deck-map.json");
    const verboseMap = JSON.parse(firstDeckMap);
    verboseMap.slides[0].speaker_notes = { script: "Full notes must never enter a navigation map." };
    await writeFile(verboseMapPath, `${JSON.stringify(verboseMap, null, 2)}\n`, "utf8");
    const verboseMapAudit = await auditProductionBudget({ spec: specPath, projectDir: temporary, deckMap: verboseMapPath, config: policyPath });
    assert.equal(verboseMapAudit.status, "fail");
    assert(verboseMapAudit.findings.some((item) => item.code === "context.deck-map.verbose-fields" && item.severity === "fail"));

    const configuredHardGate = await auditProductionBudget({
      spec: specPath,
      projectDir: temporary,
      deckMap: deckMapPath,
      policy: {
        assets: {
          allowed_missing_refs: ["missing-only"],
          max_unselected_ready_count: 99,
          max_unselected_ready_ratio: 1,
          untracked_ready_severity: "pass"
        },
        previews: { max_full_deck_sets: 1, duplicate_severity: "fail" },
        word_qa: { max_full_sets: 2 }
      },
    });
    assert.equal(configuredHardGate.status, "fail");
    assert(configuredHardGate.findings.some((item) => item.code === "previews.full-deck.duplicate" && item.severity === "fail"), "warning gates must be promotable explicitly without making every fallback fatal");

    let cliFailure;
    try {
      await execFileAsync(process.execPath, [path.join(SKILL_DIR, "scripts", "audit-production-budget.mjs"), "--spec", specPath, "--project-dir", temporary, "--deck-map", deckMapPath, "--json"], { encoding: "utf8" });
    } catch (error) {
      cliFailure = error;
    }
    assert.equal(cliFailure?.code, 1, "audit CLI must use exit 1 for a policy failure");
    const cliFailureJson = JSON.parse(cliFailure.stdout);
    assert.equal(cliFailureJson.status, "fail");
    assert.equal(cliFailureJson.read_only, true);

    const cliPass = await execFileAsync(process.execPath, [
      path.join(SKILL_DIR, "scripts", "audit-production-budget.mjs"),
      "--spec", specPath,
      "--project-dir", temporary,
      "--deck-map", deckMapPath,
      "--config", policyPath,
      "--json",
    ], { encoding: "utf8" });
    assert.equal(JSON.parse(cliPass.stdout).status, "pass");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

await main();
console.log("PASS production budget and deck-map tests");
