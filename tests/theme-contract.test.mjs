#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { buildDeck } from "../scripts/build.mjs";
import { createProjectBuilder } from "../scripts/create-project-builder.mjs";
import { internal } from "../scripts/presentation-core.mjs";

const execFileAsync = promisify(execFile);
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(TEST_DIR, "..");
const PRESET_NAMES = ["blue", "red", "purple", "cyan"];
const PROFILE_DIRS = [
  "final-defense-universal",
  "proposal-midterm-universal",
  "group-meeting-literature-universal",
];

function deckColors(preset) {
  return {
    primary: preset.primary,
    primary_dark: preset.primaryDark,
    primary_light: preset.primaryLight,
    accent: preset.accent,
    emphasis: preset.emphasis,
    background: "#FFFFFF",
    surface: "#F6F8FB",
    text: "#17213A",
    muted_text: "#5D667A",
    warning: preset.warning,
    chart_series: preset.chart,
  };
}

function assertCompletePreset(actual, expected, presetName, label) {
  assert.equal(actual.presetName, presetName, `${label}: presetName`);
  for (const key of [
    "displayName",
    "primary",
    "primaryDark",
    "primaryLight",
    "secondary",
    "accent",
    "emphasis",
    "success",
    "warning",
    "danger",
  ]) assert.equal(actual[key], expected[key], `${label}: ${key}`);
  assert.deepEqual(actual.chart, expected.chart, `${label}: chart`);
  assert.equal(actual.background, "#FFFFFF", `${label}: background`);
  assert.equal(actual.surface, "#F6F8FB", `${label}: surface`);
  assert.equal(actual.text, "#17213A", `${label}: text`);
  assert.equal(actual.mutedText, "#5D667A", `${label}: mutedText`);
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function main() {
  await assert.rejects(() => buildDeck({
    spec: "missing-deck-spec.json",
    output: "unused.pptx",
    theme: "orange",
  }), /Unsupported --theme "orange"/);

  for (const profileDir of PROFILE_DIRS) {
    const presets = await readJson(path.join(SKILL_DIR, "assets", profileDir, "theme-presets.json"));
    for (const [index, presetName] of PRESET_NAMES.entries()) {
      const expected = presets.presets[presetName];
      const stalePreset = presets.presets[PRESET_NAMES[(index + 1) % PRESET_NAMES.length]];
      const staleSpec = { theme: { mode: "preset", colors: deckColors(stalePreset) } };

      const explicit = internal.normalizeTheme(presets, staleSpec, { theme: presetName });
      assertCompletePreset(explicit, expected, presetName, `${profileDir}/${presetName}/explicit`);

      const reconstructedSpec = {
        theme: {
          mode: "preset",
          colors: { ...deckColors(stalePreset), primary: expected.primary },
        },
      };
      const reconstructed = internal.normalizeTheme(presets, reconstructedSpec);
      assertCompletePreset(reconstructed, expected, presetName, `${profileDir}/${presetName}/reconstructed`);
    }

    assert.throws(
      () => internal.normalizeTheme(presets, { theme: { mode: "preset", colors: deckColors(presets.presets.blue) } }, { theme: "orange" }),
      /Unsupported theme preset "orange"/,
      `${profileDir}: invalid preset should fail fast`,
    );
  }

  const finalPresets = await readJson(path.join(SKILL_DIR, "assets", "final-defense-universal", "theme-presets.json"));
  const custom = internal.normalizeTheme(finalPresets, {
    theme: {
      mode: "custom",
      preset: "blue",
      colors: {
        primary: "#123456",
        primary_dark: "#102030",
        primary_light: "#DDEEFF",
        accent: "#AA7700",
        emphasis: "#AA2233",
        background: "#FFFFFF",
        surface: "#F5F6F7",
        text: "#101820",
        muted_text: "#59636E",
        warning: "#A06020",
        chart_series: ["#123456", "#AA7700", "#39786E"],
      },
    },
  });
  assert.equal(custom.presetName, "custom");
  assert.equal(custom.primary, "#123456");
  assert.equal(custom.primaryDark, "#102030");
  assert.equal(custom.primaryLight, "#DDEEFF");
  assert.deepEqual(custom.chart, ["#123456", "#AA7700", "#39786E"]);

  const legacyAdaptive = internal.normalizeTheme(finalPresets, {
    theme: {
      mode: "adaptive",
      colors: {
        ...deckColors(finalPresets.presets.blue),
        primary: "#345678",
        primary_dark: "#234567",
        primary_light: "#E4EDF3",
      },
    },
  });
  assert.equal(legacyAdaptive.presetName, "custom");
  assert.equal(legacyAdaptive.primary, "#345678");

  const primaryOverride = internal.normalizeTheme(finalPresets, {
    theme: { mode: "preset", preset: "blue", colors: deckColors(finalPresets.presets.blue) },
  }, { primaryColor: "#654321" });
  assert.equal(primaryOverride.presetName, "custom");
  assert.equal(primaryOverride.primary, "#654321");

  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "academic-slides-theme-contract-"));
  try {
    const sample = await readJson(path.join(SKILL_DIR, "assets", "final-defense-universal", "sample-deck-spec.json"));
    sample.theme.preset = "blue";
    sample.sources = sample.sources.map((source) => ({ ...source, citation: "本项目规范", path: null }));
    sample.slides = sample.slides.slice(0, 3).map((slide, index) => ({ ...slide, order: index + 1 }));
    sample.timing = {
      ...sample.timing,
      duration_minutes: 30 / 60 / Number(sample.timing.usable_fraction),
      target_seconds: 30,
      estimated_seconds: 30,
      target_slide_count: 3,
    };
    sample.claim_evidence_map = [];
    const sampleSpec = path.join(temporary, "deck-spec.json");
    await fs.writeFile(sampleSpec, `${JSON.stringify(sample, null, 2)}\n`, "utf8");
    const stem = "主题契约_硕士答辩";
    const builderPath = path.join(temporary, `${stem}.mjs`);
    const result = await createProjectBuilder({
      spec: sampleSpec,
      output: builderPath,
      pptxName: `${stem}.pptx`,
      docxName: `${stem}_发言稿.docx`,
      theme: "purple",
    });
    assert.equal(result.theme, "purple");
    await execFileAsync(process.execPath, ["--check", builderPath], { encoding: "utf8" });
    const source = await fs.readFile(builderPath, "utf8");
    assert.match(source, /"theme":"purple"/);
    assert.match(source, /const themePreset = "purple";/);
    assert.match(source, /theme: themePreset \|\| undefined/);

    await execFileAsync(process.execPath, [builderPath, "--pptx"], {
      cwd: temporary,
      env: { ...process.env, ACADEMIC_SLIDES_SKILL_DIR: SKILL_DIR },
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      timeout: 120_000,
    });
    const rebuiltPptx = path.join(temporary, `${stem}.pptx`);
    assert.ok((await fs.stat(rebuiltPptx)).size > 10_000);
    const themeXml = await execFileAsync("unzip", ["-p", rebuiltPptx, "ppt/theme/theme1.xml"], {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    });
    const expectedPurple = finalPresets.presets.purple;
    for (const color of [
      expectedPurple.primary,
      expectedPurple.secondary,
      expectedPurple.success,
      expectedPurple.accent,
      expectedPurple.danger,
    ].map((value) => value.slice(1))) {
      assert.match(themeXml.stdout, new RegExp(color, "i"), `rebuilt project MJS should preserve purple token ${color}`);
    }

    await assert.rejects(() => createProjectBuilder({
      spec: sampleSpec,
      output: path.join(temporary, `${stem}.mjs`),
      pptxName: `${stem}.pptx`,
      docxName: `${stem}_发言稿.docx`,
      theme: "orange",
    }), /Unsupported theme preset "orange"/);
  } finally {
    if (process.env.KEEP_THEME_TMP === "1") console.log(`theme-test-temp: ${temporary}`);
    else await fs.rm(temporary, { recursive: true, force: true });
  }

  console.log("theme-contract.test.mjs: PASS");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
