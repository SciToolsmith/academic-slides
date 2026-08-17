#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { serializeSpeakerNotes } from "./speaker-notes.mjs";

async function loadArtifactTool() {
  const attempts = [
    () => import("@oai/artifact-tool"),
    ...[
      process.env.RUNTIME_NODE_MODULES,
      path.resolve(path.dirname(process.execPath), "..", "node_modules"),
    ].filter(Boolean).map((modulesDir) => () => import(pathToFileURL(path.join(
      modulesDir,
      "@oai",
      "artifact-tool",
      "dist",
      "artifact_tool.mjs",
    )).href)),
  ];
  const errors = [];
  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch (error) {
      errors.push(error?.message ?? String(error));
    }
  }
  throw new Error(`Cannot load @oai/artifact-tool. Run with the bundled workspace Node runtime or set RUNTIME_NODE_MODULES. ${errors.join(" | ")}`);
}

async function loadSharp() {
  const attempts = [
    () => import("sharp"),
    ...[
      process.env.RUNTIME_NODE_MODULES,
      path.resolve(path.dirname(process.execPath), "..", "node_modules"),
    ].filter(Boolean).map((modulesDir) => () => import(pathToFileURL(path.join(
      modulesDir,
      "sharp",
      "lib",
      "index.js",
    )).href)),
  ];
  for (const attempt of attempts) {
    try {
      const module = await attempt();
      return module.default ?? module;
    } catch {
      // Try the next workspace runtime location.
    }
  }
  return null;
}

const { Presentation, PresentationFile } = await loadArtifactTool();

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(SCRIPT_DIR, "..");
const PROFILE_REGISTRY_PATH = path.join(SKILL_DIR, "assets", "profile-registry.json");
const PROFILE_REGISTRY = JSON.parse(await fs.readFile(PROFILE_REGISTRY_PATH, "utf8"));
const PROFILE_TEMPLATE_DIRS = Object.freeze(Object.fromEntries(Object.entries(PROFILE_REGISTRY.profiles ?? {}).map(([id, profile]) => {
  const assetDirectory = String(profile?.assetDirectory ?? "");
  const resolved = path.resolve(SKILL_DIR, assetDirectory);
  if (!assetDirectory || (resolved !== SKILL_DIR && !resolved.startsWith(`${SKILL_DIR}${path.sep}`))) {
    throw new Error(`Invalid assetDirectory for profile ${id} in ${PROFILE_REGISTRY_PATH}.`);
  }
  return [id, resolved];
})));
const PPT_FONT_SCALE = 4 / 3;

const DEFAULT_TOKENS = Object.freeze({
  slideSize: { width: 1280, height: 720 },
  fonts: { zh: "Microsoft YaHei", en: "Arial", serif: "Times New Roman" },
  typeScale: {
    deckTitle: 52,
    sectionTitle: 44,
    slideTitle: 36,
    headline: 30,
    subheading: 24,
    body: 19,
    bodySmall: 16,
    caption: 14,
    footnote: 12,
    metric: 36,
  },
  spacing: {
    pageLeft: 64,
    pageRight: 64,
    headerHeight: 58,
    titleTop: 78,
    titleHeight: 54,
    contentTop: 154,
    contentBottom: 664,
    columnGap: 30,
  },
  textEmphasis: {
    maxSpansPerSlide: 2,
    maxCharactersPerSpan: 24,
    maxColoredCharactersPerSlide: 32,
    excludedKinds: ["title", "agenda", "section", "closing"],
    roles: {
      strong: "bold_only",
      key: "emphasis",
      result: "emphasis",
      decision: "emphasis",
      warning: "warning",
      critical: "danger",
      success: "success",
    },
  },
  neutral: {
    canvas: "#FFFFFF",
    surface: "#F6F8FB",
    surfaceStrong: "#E9EDF4",
    text: "#17213A",
    muted: "#5D667A",
    subtle: "#8A93A5",
    line: "#D5DBE6",
    white: "#FFFFFF",
    black: "#111827",
  },
});

const DEFAULT_THEME = Object.freeze({
  displayName: "学术蓝",
  primary: "#364A7C",
  primaryDark: "#25345B",
  primaryLight: "#E7EBF4",
  secondary: "#6482B5",
  accent: "#C88A2C",
  emphasis: "#B4233A",
  success: "#2F766D",
  warning: "#B46A2C",
  danger: "#A63C45",
  chart: ["#364A7C", "#6482B5", "#2F766D", "#C88A2C", "#7B5A8E", "#A63C45"],
});

const DEFAULT_NEUTRAL_THEME = Object.freeze({
  background: DEFAULT_TOKENS.neutral.canvas,
  surface: DEFAULT_TOKENS.neutral.surface,
  text: DEFAULT_TOKENS.neutral.text,
  mutedText: DEFAULT_TOKENS.neutral.muted,
});

const MILESTONE_EXCLUSIVE_LAYOUTS = new Set([
  "cover-short-title", "cover-long-title", "agenda-adaptive", "evaluation-focus", "closing-feedback",
  "context-stakes", "literature-landscape", "evidence-gap", "question-hypothesis", "objectives-workpackages",
  "conceptual-framework", "scope-boundaries", "contribution-value", "technical-route", "method-architecture",
  "data-sample-variables", "model-formula", "validation-plan-status", "feasibility-resources",
  "risk-ethics-contingency", "innovation-claims", "expected-outcomes", "baseline-gantt",
  "proposal-decision-check", "progress-snapshot", "plan-vs-actual", "leading-result-single",
  "leading-results-multipanel", "deviation-cause-action", "remaining-work-updated-plan",
]);
const PROPOSAL_ONLY_LAYOUTS = new Set(["innovation-claims", "expected-outcomes", "baseline-gantt", "proposal-decision-check"]);
const MIDTERM_ONLY_LAYOUTS = new Set(["progress-snapshot", "plan-vs-actual", "leading-result-single", "leading-results-multipanel", "deviation-cause-action", "remaining-work-updated-plan"]);
const SLIDE_TEXT_REGISTRY = new WeakMap();

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function first(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function list(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

function textOf(value) {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join("；");
  if (!isObject(value)) return "";
  return String(first(value.text, value.label, value.title, value.claim, value.value, value.caption, value.name, ""));
}

function cleanText(value) {
  return textOf(value).replace(/\r\n/g, "\n").trim();
}

function normalizeProfile(spec) {
  const raw = String(first(spec?.profile, spec?.presentation_type, spec?.presentation?.type, "final_defense"))
    .trim()
    .toLowerCase()
    .replaceAll("-", "_");
  const aliases = {
    final: "final_defense",
    final_defense: "final_defense",
    defense: "final_defense",
    group_meeting_literature: "group_meeting_literature",
    literature: "group_meeting_literature",
    journal_club: "group_meeting_literature",
    paper_presentation: "group_meeting_literature",
    proposal_midterm: "proposal_midterm",
    proposal: "proposal_midterm",
    proposal_defense: "proposal_midterm",
    opening_defense: "proposal_midterm",
    midterm: "proposal_midterm",
    midterm_defense: "proposal_midterm",
    midterm_review: "proposal_midterm",
  };
  const profile = aliases[raw] ?? (PROFILE_TEMPLATE_DIRS[raw] ? raw : null);
  if (!profile || !PROFILE_TEMPLATE_DIRS[profile]) {
    throw new Error(`Unsupported academic-slides profile "${raw}". Available profiles: ${Object.keys(PROFILE_TEMPLATE_DIRS).join(", ")}.`);
  }
  return profile;
}

function normalizeMilestoneMode(spec) {
  const explicit = first(
    spec?.milestone?.mode,
    spec?.milestone_profile?.mode,
    spec?.presentation?.mode,
  );
  const profileHint = String(first(spec?.profile, spec?.presentation_type, spec?.presentation?.type, ""))
    .trim().toLowerCase().replaceAll("-", "_");
  const inferred = profileHint.includes("midterm") ? "midterm" : "proposal";
  const raw = String(first(explicit, inferred)).trim().toLowerCase().replaceAll("-", "_");
  if (["proposal", "opening", "proposal_defense"].includes(raw)) return "proposal";
  if (["midterm", "mid_term", "midterm_defense", "midterm_review"].includes(raw)) return "midterm";
  throw new Error(`Unsupported proposal/midterm mode "${raw}". Use proposal or midterm.`);
}

function normalizeHex(value, fallback) {
  const candidate = String(value ?? "").trim();
  if (/^#[0-9a-f]{6}$/i.test(candidate)) return candidate.toUpperCase();
  return fallback;
}

function isRedDominant(hex) {
  const value = normalizeHex(hex, "#000000").slice(1);
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  return red > green * 1.25 && red > blue * 1.15;
}

function mixHex(left, right = "#FFFFFF", rightWeight = 0.5) {
  const a = normalizeHex(left, "#000000").slice(1);
  const b = normalizeHex(right, "#FFFFFF").slice(1);
  const weight = clamp(Number(rightWeight), 0, 1);
  const channels = [0, 2, 4].map((offset) => {
    const start = Number.parseInt(a.slice(offset, offset + 2), 16);
    const end = Number.parseInt(b.slice(offset, offset + 2), 16);
    return Math.round(start * (1 - weight) + end * weight).toString(16).padStart(2, "0");
  });
  return `#${channels.join("")}`.toUpperCase();
}

function relativeLuminance(hex) {
  const value = normalizeHex(hex, "#000000").slice(1);
  const channels = [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16) / 255)
    .map((channel) => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(left, right) {
  const light = Math.max(relativeLuminance(left), relativeLuminance(right));
  const dark = Math.min(relativeLuminance(left), relativeLuminance(right));
  return (light + 0.05) / (dark + 0.05);
}

function ensureTextContrastOnWhite(color, minimum = 4.5) {
  let resolved = normalizeHex(color, DEFAULT_THEME.emphasis);
  for (let step = 0; step < 8 && contrastRatio(resolved, "#FFFFFF") < minimum; step += 1) {
    resolved = mixHex(resolved, "#000000", 0.1);
  }
  return resolved;
}

function withAlpha(hex, _alpha) {
  return hex;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function pptFontSize(value) {
  return Number(value) * PPT_FONT_SCALE;
}

function fontFor(text, tokens, serif = false) {
  if (serif) return tokens.fonts?.serif ?? DEFAULT_TOKENS.fonts.serif;
  return /[\u3400-\u9fff]/.test(String(text))
    ? (tokens.fonts?.zh ?? DEFAULT_TOKENS.fonts.zh)
    : (tokens.fonts?.en ?? DEFAULT_TOKENS.fonts.en);
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function readOptionalJson(filePath, fallback) {
  try {
    return await readJson(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

function contentTypeFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  if (extension === ".svg") return "image/svg+xml";
  if (extension === ".gif") return "image/gif";
  throw new Error(`Unsupported image format: ${filePath}`);
}

function addShape(slide, geometry, position, options = {}) {
  return slide.shapes.add({
    geometry,
    position,
    name: options.name,
    fill: options.fill ?? "none",
    line: options.line ?? { style: "solid", fill: "none", width: 0 },
    ...(options.borderRadius ? { borderRadius: options.borderRadius } : {}),
    ...(options.shadow ? { shadow: options.shadow } : {}),
  });
}

function registerTextTarget(slide, textTarget, text, name, baseColor) {
  const registered = SLIDE_TEXT_REGISTRY.get(slide) ?? [];
  registered.push({ textTarget, text: String(text ?? ""), name: String(name ?? ""), baseColor });
  SLIDE_TEXT_REGISTRY.set(slide, registered);
}

function addText(slide, value, position, style = {}, name = undefined) {
  const text = String(value ?? "");
  const shape = addShape(slide, "textbox", position, { name, fill: "none" });
  shape.text = text;
  shape.text.autoFit = style.autoFit ?? "shrinkText";
  shape.text.wrap = "square";
  shape.text.style = {
    // Artifact Tool receives CSS-pixel-like values and serializes them at 0.75 pt.
    // Scale once here so a requested 19 renders as 19 pt in the exported PPTX.
    fontSize: pptFontSize(style.fontSize ?? 19),
    typeface: first(style.typeface, style.fontFamily),
    bold: style.bold ?? false,
    italic: style.italic ?? false,
    color: style.color ?? "#17213A",
    alignment: style.alignment ?? "left",
    verticalAlignment: style.verticalAlignment ?? "middle",
    ...(style.marginLeft != null ? { marginLeft: style.marginLeft } : {}),
    ...(style.marginRight != null ? { marginRight: style.marginRight } : {}),
    ...(style.marginTop != null ? { marginTop: style.marginTop } : {}),
    ...(style.marginBottom != null ? { marginBottom: style.marginBottom } : {}),
    ...(style.lineSpacing != null ? { lineSpacing: style.lineSpacing } : {}),
  };
  registerTextTarget(slide, shape.text, text, name, style.color ?? "#17213A");
  return shape;
}

function addRule(slide, left, top, width, color, thickness = 1, name = undefined) {
  return addShape(slide, "rect", { left, top, width, height: thickness }, {
    name,
    fill: color,
    line: { style: "solid", fill: color, width: 0 },
  });
}

function addVerticalRule(slide, left, top, height, color, thickness = 1, name = undefined) {
  return addShape(slide, "rect", { left, top, width: thickness, height }, {
    name,
    fill: color,
    line: { style: "solid", fill: color, width: 0 },
  });
}

function addPill(slide, text, position, colors, tokens, options = {}) {
  const box = addShape(slide, "roundRect", position, {
    name: options.name,
    fill: options.fill ?? colors.primaryLight,
    line: { style: "solid", fill: options.line ?? colors.primaryLight, width: options.lineWidth ?? 1 },
    borderRadius: "rounded-full",
  });
  box.text = String(text ?? "");
  box.text.autoFit = "shrinkText";
  box.text.style = {
    fontSize: pptFontSize(options.fontSize ?? 14),
    typeface: fontFor(text, tokens),
    bold: options.bold ?? true,
    color: options.color ?? colors.primary,
    alignment: "center",
    verticalAlignment: "middle",
  };
  registerTextTarget(slide, box.text, text, options.name, options.color ?? colors.primary);
  return box;
}

function countOccurrences(value, needle) {
  if (!needle) return 0;
  let count = 0;
  let start = 0;
  while (true) {
    const index = value.indexOf(needle, start);
    if (index < 0) return count;
    count += 1;
    start = index + needle.length;
  }
}

function textEmphasisColor(role, context, baseColor) {
  const colors = context.colors;
  const defaultSemantic = {
    key: colors.emphasis,
    result: colors.emphasis,
    decision: colors.emphasis,
    warning: colors.warning,
    critical: colors.danger,
    success: colors.success,
  };
  const paletteKey = context.tokens.textEmphasis?.roles?.[role];
  if (role === "strong" || paletteKey === "bold_only") return null;
  const selected = (paletteKey && colors[paletteKey]) || defaultSemantic[role] || colors.emphasis;
  const normalizedBase = normalizeHex(baseColor, context.tokens.neutral.text);
  if ([context.tokens.neutral.white, "#FFFFFF"].includes(normalizedBase)) {
    // On dark fills, white already has the safest contrast. Keep color stable
    // and use bold as the secondary cue instead of creating a low-contrast tint.
    return null;
  }
  return ensureTextContrastOnWhite(selected);
}

function applySlideTextEmphasis(slide, slideSpec, context) {
  const explicitDirectives = list(slideSpec.text_emphasis);
  const legacyRoleMap = { strong: "strong", accent: "key", warning: "warning" };
  const legacyDirectives = explicitDirectives.length ? [] : list(slideSpec.content?.bullets)
    .filter((bullet) => legacyRoleMap[bullet?.emphasis])
    .map((bullet) => ({ text: cleanText(bullet?.text), role: legacyRoleMap[bullet.emphasis], _legacy: true }));
  const directives = explicitDirectives.length ? explicitDirectives : legacyDirectives;
  if (directives.length === 0) return;
  const policy = context.tokens.textEmphasis ?? DEFAULT_TOKENS.textEmphasis;
  if (list(policy.excludedKinds).includes(slideSpec.kind)) {
    throw new Error(`Slide ${slideSpec.id ?? "unknown"} kind=${slideSpec.kind} cannot use text_emphasis; reserve colored emphasis for evidence-bearing slides.`);
  }
  if (directives.length > Number(policy.maxSpansPerSlide ?? 2)) {
    throw new Error(`Slide ${slideSpec.id ?? "unknown"} exceeds the text-emphasis budget of ${policy.maxSpansPerSlide ?? 2} spans.`);
  }
  const maxCharactersPerSpan = Number(policy.maxCharactersPerSpan ?? 24);
  const coloredCharacters = directives
    .filter((directive) => cleanText(directive?.role) !== "strong")
    .reduce((sum, directive) => sum + [...cleanText(directive?.text)].length, 0);
  if (coloredCharacters > Number(policy.maxColoredCharactersPerSlide ?? 32)) {
    throw new Error(`Slide ${slideSpec.id ?? "unknown"} exceeds the colored text-emphasis budget of ${policy.maxColoredCharactersPerSlide ?? 32} characters.`);
  }
  const entries = SLIDE_TEXT_REGISTRY.get(slide) ?? [];
  for (const [index, directive] of directives.entries()) {
    const text = cleanText(directive?.text);
    if (!text || [...text].length > maxCharactersPerSpan) {
      throw new Error(`Slide ${slideSpec.id ?? "unknown"} text_emphasis[${index}] must contain 1-${maxCharactersPerSpan} characters.`);
    }
    const shapeName = cleanText(directive?.shape_name);
    const candidates = shapeName ? entries.filter((entry) => entry.name === shapeName) : entries;
    const matches = candidates
      .map((entry) => ({ entry, count: countOccurrences(entry.text, text) }))
      .filter((match) => match.count > 0);
    const occurrenceCount = matches.reduce((sum, match) => sum + match.count, 0);
    const legacyPreferred = directive?._legacy
      ? matches.filter((match) => /bullet/i.test(match.entry.name))
      : [];
    const resolvedMatches = directive?._legacy && legacyPreferred.length ? legacyPreferred : matches;
    const resolvedOccurrenceCount = resolvedMatches.reduce((sum, match) => sum + match.count, 0);
    const allowRepeatedStrongLegacy = directive?._legacy && cleanText(directive?.role) === "strong" && resolvedOccurrenceCount > 0;
    if (directive?._legacy && occurrenceCount === 0) continue;
    if (occurrenceCount === 0 || (!allowRepeatedStrongLegacy && resolvedOccurrenceCount !== 1)) {
      const scope = shapeName ? ` in shape_name=${shapeName}` : " across the slide";
      throw new Error(`Slide ${slideSpec.id ?? "unknown"} text_emphasis[${index}] must match exactly once${scope}; found ${resolvedOccurrenceCount} occurrences of "${text}".`);
    }
    for (const match of resolvedMatches) {
      const target = match.entry;
      const range = target.textTarget.get(text);
      range.bold = true;
      const fill = textEmphasisColor(cleanText(directive?.role), context, target.baseColor);
      if (fill) range.fill = fill;
      if (!allowRepeatedStrongLegacy) break;
    }
  }
}

function addBulletList(slide, items, position, style, tokens, name = "bullet-list") {
  const cleaned = list(items).map(cleanText).filter(Boolean);
  const value = cleaned.map((item) => `•  ${item}`).join("\n");
  return addText(slide, value, position, {
    fontSize: style.fontSize ?? 18,
    fontFamily: fontFor(value, tokens),
    color: style.color,
    lineSpacing: style.lineSpacing ?? 1.18,
    verticalAlignment: style.verticalAlignment ?? "top",
  }, name);
}

function addKeyNumber(slide, metric, position, colors, tokens, name = "metric") {
  if (!metric) return;
  const rawValue = cleanText(first(metric.value, metric.number, metric));
  const unit = cleanText(first(metric.unit, ""));
  const comparison = cleanText(first(metric.comparison, ""));
  const value = [rawValue, unit].filter(Boolean).join(" ");
  const label = [cleanText(first(metric.label, metric.caption, "")), comparison].filter(Boolean).join(" · ");
  addText(slide, value, { ...position, height: Math.min(62, position.height ?? 62) }, {
    fontSize: 36,
    fontFamily: fontFor(value, tokens),
    bold: true,
    color: colors.primary,
    verticalAlignment: "bottom",
  }, `${name}-value`);
  if (label) addText(slide, label, {
    left: position.left,
    top: position.top + 64,
    width: position.width,
    height: Math.max(30, (position.height ?? 104) - 64),
  }, {
    fontSize: 14,
    fontFamily: fontFor(label, tokens),
    color: tokens.neutral.muted,
    verticalAlignment: "top",
  }, `${name}-label`);
}

function availablePresetNames(presets) {
  return Object.keys(isObject(presets?.presets) ? presets.presets : {});
}

function requirePreset(presets, value, source = "theme preset") {
  const presetName = String(value ?? "").trim().toLowerCase();
  const available = availablePresetNames(presets);
  if (!presetName || !isObject(presets?.presets?.[presetName])) {
    throw new Error(`Unsupported ${source} "${value ?? ""}". Available presets: ${available.join(", ") || "none"}.`);
  }
  return presetName;
}

function presetFromPrimary(presets, primary) {
  const normalizedPrimary = normalizeHex(primary, "");
  if (!normalizedPrimary) return null;
  const matches = availablePresetNames(presets).filter((name) => (
    normalizeHex(presets.presets[name]?.primary, "") === normalizedPrimary
  ));
  return matches.length === 1 ? matches[0] : null;
}

function completePresetTheme(presets, presetName) {
  const selected = presets.presets[presetName];
  return {
    ...DEFAULT_THEME,
    ...DEFAULT_NEUTRAL_THEME,
    ...selected,
    chart: list(selected.chart).map((color) => normalizeHex(color, DEFAULT_THEME.primary)),
    presetName,
  };
}

function customTheme(base, resolvedColors, primaryOverride) {
  const primary = normalizeHex(first(primaryOverride, resolvedColors.primary), base.primary);
  const chart = list(resolvedColors.chart_series);
  return {
    ...base,
    presetName: "custom",
    displayName: "自定义学术配色",
    primary,
    primaryDark: normalizeHex(resolvedColors.primary_dark, base.primaryDark),
    primaryLight: normalizeHex(resolvedColors.primary_light, base.primaryLight),
    secondary: normalizeHex(resolvedColors.secondary, base.secondary),
    accent: normalizeHex(resolvedColors.accent, base.accent),
    emphasis: normalizeHex(
      resolvedColors.emphasis,
      isRedDominant(primary) ? "#8A5A00" : base.emphasis,
    ),
    success: normalizeHex(resolvedColors.success, base.success),
    warning: normalizeHex(resolvedColors.warning, base.warning),
    danger: normalizeHex(resolvedColors.danger, base.danger),
    chart: chart.length ? chart.map((color) => normalizeHex(color, primary)) : [...base.chart],
    background: normalizeHex(resolvedColors.background, base.background),
    surface: normalizeHex(resolvedColors.surface, base.surface),
    text: normalizeHex(resolvedColors.text, base.text),
    mutedText: normalizeHex(resolvedColors.muted_text, base.mutedText),
  };
}

function normalizeTheme(presets, spec, options = {}) {
  const themeSpec = isObject(spec.theme) ? spec.theme : {};
  const resolvedColors = isObject(themeSpec.colors) ? themeSpec.colors : {};
  const optionPreset = first(options.theme);
  const primaryOverride = first(options.primaryColor, themeSpec.primary, spec.primary_color);
  if (optionPreset && primaryOverride) {
    throw new Error("Use either a theme preset or a custom primary color, not both.");
  }

  if (optionPreset) {
    const presetName = requirePreset(presets, optionPreset);
    return completePresetTheme(presets, presetName);
  }

  const defaultPreset = requirePreset(presets, first(presets.defaultPreset, "blue"), "default theme preset");
  const base = completePresetTheme(presets, defaultPreset);
  const mode = String(themeSpec.mode ?? "").trim().toLowerCase();
  if (mode === "custom" || primaryOverride || (!mode && resolvedColors.primary)) {
    return customTheme(base, resolvedColors, primaryOverride);
  }

  const declaredPreset = first(themeSpec.preset, themeSpec.name, spec.theme_preset);
  if (declaredPreset) {
    const presetName = requirePreset(presets, declaredPreset);
    return completePresetTheme(presets, presetName);
  }

  const inferredPreset = presetFromPrimary(presets, resolvedColors.primary);
  if (inferredPreset) return completePresetTheme(presets, inferredPreset);
  if (resolvedColors.primary && mode === "adaptive") {
    // Legacy adaptive specs already contain a resolved palette. Preserve that
    // palette as custom without performing any institution/logo inference.
    return customTheme(base, resolvedColors);
  }
  if (resolvedColors.primary && mode === "preset") {
    throw new Error(`Theme mode=preset requires colors.primary to match one complete preset; use mode=custom for ${resolvedColors.primary}.`);
  }
  return base;
}

function presentationTheme(colors, tokens) {
  return {
    name: `Academic Slides · ${colors.displayName}`,
    themeColors: {
      accent1: colors.primary,
      accent2: colors.secondary,
      accent3: colors.success,
      accent4: colors.accent,
      accent5: colors.chart?.[4] ?? colors.warning,
      accent6: colors.danger,
      bg1: tokens.neutral.canvas,
      bg2: tokens.neutral.surface,
      tx1: tokens.neutral.text,
      tx2: tokens.neutral.muted,
      dk1: tokens.neutral.black,
      dk2: colors.primaryDark,
      lt1: tokens.neutral.white,
      lt2: tokens.neutral.surfaceStrong,
      hlink: colors.primary,
      folHlink: colors.chart?.[4] ?? colors.primaryDark,
    },
  };
}

function normalizeBrand(spec) {
  const brand = isObject(spec.brand) ? spec.brand : {};
  return {
    institution: cleanText(first(brand.institution, spec.theme?.institution, spec.institution, spec.school, "学术机构")),
    department: cleanText(first(brand.department, spec.department, "")),
    logo: first(brand.logo_path, brand.logoPath, brand.logo?.path, spec.logo_path, spec.logoPath),
    logoAlt: cleanText(first(brand.logo_alt, brand.logoAlt, "学校标识")),
  };
}

function normalizeLayoutId(slide) {
  const layout = isObject(slide.layout) ? slide.layout : {};
  const raw = String(first(slide.layout_id, slide.layoutId, layout.id, layout.family, slide.kind, "claim-evidence")).toLowerCase();
  const variant = String(first(layout.variant, "")).toLowerCase();
  const normalizedVariant = variant.replaceAll("_", "-");
  const registered = new Set([
    "cover", "agenda", "section-divider", "claim-evidence", "image-left-text-right",
    "text-left-image-right", "image-compare", "chart-insight", "table-insight",
    "formula-visual", "process", "timeline", "framework", "quote-analysis",
    "case-compare", "validation-matrix", "contribution", "limitations", "references",
    "free-evidence", "closing", "three-column-overview", "three-level-analysis",
    "four-point-list", "three-row-content", "multi-image-evidence", "four-objectives",
    "thesis-framework", "radial-methods", "four-step-ribbon", "innovation-brackets",
    "four-results-cycle", "two-image-results", "figure-conclusion", "conclusion-list",
    "three-outlook-columns",
    "group-cover", "paper-agenda", "paper-divider", "paper-profile",
    "selection-rationale", "known-gap-question", "concept-framework",
    "study-design", "method-sequence", "method-comparison",
    "sample-data-profile", "single-result-evidence", "result-compare",
    "multi-result-evidence", "table-chart-result", "mechanism-explanation", "claim-evidence-boundary",
    "paper-conclusion", "critical-appraisal", "reproducibility-check",
    "cross-paper-matrix", "consensus-divergence", "evidence-quality-map",
    "research-evolution", "transfer-to-our-work", "discussion-questions",
    "decision-request", "next-reading-actions", "selected-sources", "group-closing",
    "cover-short-title", "cover-long-title", "agenda-adaptive", "evaluation-focus",
    "closing-feedback", "context-stakes", "literature-landscape", "evidence-gap",
    "question-hypothesis", "objectives-workpackages", "conceptual-framework",
    "scope-boundaries", "contribution-value", "technical-route", "method-architecture",
    "data-sample-variables", "model-formula", "validation-plan-status",
    "feasibility-resources", "risk-ethics-contingency", "innovation-claims",
    "expected-outcomes", "baseline-gantt", "proposal-decision-check",
    "progress-snapshot", "plan-vs-actual", "leading-result-single",
    "leading-results-multipanel", "deviation-cause-action", "remaining-work-updated-plan",
  ]);
  if (registered.has(normalizedVariant)) return normalizedVariant;
  if (normalizedVariant) {
    if (raw === "free_canvas" && normalizedVariant.startsWith("custom:")) return "free-evidence";
    throw new Error(`Unknown layout variant "${variant}". Use a registered layout ID, omit variant to map from family, or use family=free_canvas with variant=custom:<slug>.`);
  }
  const map = {
    title: "cover",
    agenda: "agenda",
    section: "section-divider",
    hero_figure: variant.includes("right") ? "text-left-image-right" : "image-left-text-right",
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
    contribution_limits: variant.includes("limit") ? "limitations" : "contribution",
    paper_profile: "paper-profile",
    literature_synthesis: "cross-paper-matrix",
    discussion: "discussion-questions",
    summary: "contribution",
    closing: "closing",
    free_canvas: "free-evidence",
  };
  return map[raw] ?? raw.replaceAll("_", "-");
}

function slideTitle(slide) {
  return cleanText(first(slide.title, slide.headline, slide.copy?.title, slide.content?.title, slide.takeaway, ""));
}

function slideTakeaway(slide) {
  return cleanText(first(slide.takeaway, slide.claim, slide.copy?.takeaway, slide.content?.takeaway, ""));
}

function slideBullets(slide) {
  const values = first(
    slide.bullets,
    slide.evidence_points,
    slide.evidence,
    slide.copy?.bullets,
    slide.content?.bullets,
    slide.content?.body,
    [],
  );
  return list(values).map(cleanText).filter(Boolean);
}

function slideMetrics(slide) {
  return list(first(slide.metrics, slide.key_numbers, slide.content?.metrics, [])).map((entry) => {
    if (isObject(entry)) return entry;
    return { value: cleanText(entry), label: "" };
  });
}

function renderData(slide) {
  return isObject(slide.render_data) ? slide.render_data : {};
}

function semanticItems(slide, keys = [], fallbackCount = 3) {
  const data = renderData(slide);
  let source;
  for (const key of keys) {
    if (data[key] != null) {
      source = data[key];
      break;
    }
  }
  source ??= first(data.items, data.cards, slide.content?.bullets, slide.content?.body, slide.bullets, []);
  const raw = list(source);
  const fallback = Array.from({ length: fallbackCount }, (_, index) => ({
    title: `要点 ${String(index + 1).padStart(2, "0")}`,
    body: "用与论文证据对应的短句替换这里的说明。",
  }));
  return (raw.length ? raw : fallback).map((entry, index) => {
    if (!isObject(entry)) return { id: `item-${index + 1}`, title: cleanText(entry), body: "" };
    return {
      ...entry,
      id: cleanText(first(entry.id, `item-${index + 1}`)),
      number: cleanText(first(entry.number, entry.index, String(index + 1).padStart(2, "0"))),
      title: cleanText(first(entry.title, entry.label, entry.heading, entry.claim, entry.text, `要点 ${index + 1}`)),
      body: cleanText(first(entry.body, entry.detail, entry.description, entry.evidence, entry.caption, "")),
    };
  });
}

function buildAssetIndex(spec, baseDir) {
  const result = new Map();
  const add = (id, value) => {
    if (!id || value == null) return;
    const record = isObject(value) ? { ...value } : { path: String(value) };
    const rawPath = first(record.path, record.file, record.src, record.uri);
    if (rawPath && !/^https?:\/\//i.test(rawPath)) record.path = path.resolve(baseDir, rawPath);
    result.set(String(id), { id: String(id), ...record });
  };
  if (Array.isArray(spec.assets)) {
    for (const item of spec.assets) add(first(item?.id, item?.asset_id, item?.name), item);
  } else if (isObject(spec.assets)) {
    for (const [id, item] of Object.entries(spec.assets)) add(id, item);
  }
  if (Array.isArray(spec.asset_manifest)) {
    for (const item of spec.asset_manifest) add(first(item?.id, item?.asset_id), item);
  }
  if (Array.isArray(spec.sources)) {
    for (const item of spec.sources) {
      if (item?.path && /^(?:brand_asset|thesis_figure|thesis_table|thesis_formula|paper_text|paper_figure|paper_table|paper_formula|paper_supplement|bibliographic_metadata|venue_metric|user_material|other)$/.test(String(item.type))) {
        add(item.id, { ...item, alt_text: first(item.alt_text, item.title), type: item.type });
      }
    }
  }
  return result;
}

function normalizeAssetRequest(value, assetIndex, baseDir) {
  if (!value) return null;
  if (typeof value === "string") {
    if (assetIndex.has(value)) return { ...assetIndex.get(value) };
    if (value.startsWith("sample:")) return { placeholder: true, alt: value.slice("sample:".length).replaceAll("-", " ") };
    if (/^https?:\/\//i.test(value)) return { uri: value, alt: "学术证据图" };
    return { path: path.resolve(baseDir, value), alt: path.basename(value) };
  }
  if (!isObject(value)) return null;
  const ref = first(value.asset_ref, value.assetRef, value.id_ref, value.ref);
  if (typeof ref === "string" && ref.startsWith("sample:") && !assetIndex.has(ref)) {
    return { ...value, placeholder: true, alt: first(value.alt, value.alt_text, value.caption, ref.slice("sample:".length).replaceAll("-", " ")) };
  }
  const inherited = ref && assetIndex.has(ref) ? assetIndex.get(ref) : {};
  const merged = { ...inherited, ...value };
  if (ref && !assetIndex.has(ref) && !merged.path && !merged.file && !merged.src && !merged.uri) {
    if (/^https?:\/\//i.test(ref)) merged.uri = ref;
    else merged.path = path.isAbsolute(ref) ? ref : path.resolve(baseDir, ref);
  }
  const rawPath = first(merged.path, merged.file, merged.src);
  if (rawPath && !path.isAbsolute(rawPath)) merged.path = path.resolve(baseDir, rawPath);
  return merged;
}

function slideAssetRequests(slide, assetIndex, baseDir) {
  const candidates = [];
  candidates.push(...list(first(slide.images, slide.media, slide.asset_refs, slide.assetRefs, [])));
  const visual = isObject(slide.visual) ? slide.visual : {};
  candidates.push(...list(first(visual.images, visual.assets, visual.asset_refs, visual.assetRefs, [])));
  candidates.push(...list(slide.visuals).filter((item) => item?.include !== false).map((item) => ({
    asset_ref: first(item.asset_ref, item.assetRef),
    alt: first(item.alt_text, item.caption),
    caption: item.caption,
    visual_type: item.type,
    role: item.role,
    fit: item.crop === "cover" ? "cover" : "contain",
  })).filter((item) => item.asset_ref));
  candidates.push(...list(first(renderData(slide).image_refs, renderData(slide).asset_refs, [])));
  for (const value of [slide.image, slide.left_image, slide.right_image, visual.image, visual.left_image, visual.right_image]) {
    if (value) candidates.push(value);
  }
  return candidates.map((item) => normalizeAssetRequest(item, assetIndex, baseDir)).filter(Boolean);
}

async function addImageOrPlaceholder(slide, request, position, context) {
  const { colors, tokens, allowPlaceholder = true } = context;
  const frame = addShape(slide, "roundRect", position, {
    name: `${context.name ?? "media"}-frame`,
    fill: tokens.neutral.surface,
    line: { style: "solid", fill: tokens.neutral.line, width: 1.2 },
    borderRadius: "rounded-lg",
  });
  const inset = 7;
  const imagePosition = {
    left: position.left + inset,
    top: position.top + inset,
    width: position.width - inset * 2,
    height: position.height - inset * 2,
  };
  if (!request || request.placeholder) {
    if (!request && !allowPlaceholder) throw new Error(`Missing required image for ${context.name ?? "slide"}.`);
    addText(slide, first(request?.alt, context.placeholderLabel, "论文图 / 表 / 史料 / 数据视觉"), imagePosition, {
      fontSize: 18,
      fontFamily: fontFor(context.placeholderLabel, tokens),
      color: tokens.neutral.muted,
      alignment: "center",
      verticalAlignment: "middle",
    }, `${context.name ?? "media"}-placeholder`);
    return frame;
  }
  const fit = first(request.fit, context.fit, "contain");
  const alt = cleanText(first(request.alt, request.alt_text, request.caption, request.title, "学术证据图"));
  if (request.uri && /^https?:\/\//i.test(request.uri)) {
    if (!allowPlaceholder) {
      throw new Error(`Remote image URIs are not allowed in a reproducible build (${request.uri}). Download and verify the asset into the project, record its provenance, and reference the local file.`);
    }
    slide.images.add({ uri: request.uri, alt, fit, position: imagePosition });
    return frame;
  }
  const filePath = first(request.path, request.file, request.src);
  if (!filePath) {
    if (!allowPlaceholder) throw new Error(`Image request lacks path/uri for ${context.name ?? "slide"}.`);
    addText(slide, alt || "待选择证据图", imagePosition, {
      fontSize: 18,
      color: colors.muted,
      alignment: "center",
      verticalAlignment: "middle",
    }, `${context.name ?? "media"}-placeholder`);
    return frame;
  }
  const bytes = await fs.readFile(filePath).catch((error) => {
    throw new Error(`Cannot read image ${filePath}: ${error.message}`);
  });
  slide.images.add({
    blob: bytes,
    contentType: contentTypeFor(filePath),
    alt,
    fit,
    position: imagePosition,
  });
  return frame;
}

async function addLogo(slide, brand, position, context) {
  if (brand.logo) {
    if (/^https?:\/\//i.test(brand.logo)) {
      throw new Error(`Remote logo URIs are not allowed (${brand.logo}). Save the verified official asset under project branding before building.`);
    }
    const bytes = await fs.readFile(brand.logo).catch((error) => {
      throw new Error(`Cannot read verified logo ${brand.logo}: ${error.message}`);
    });
    slide.images.add({
      blob: bytes,
      contentType: contentTypeFor(brand.logo),
      alt: brand.logoAlt,
      fit: "contain",
      position,
    });
    return;
  }
  // A generic seal is useful only in the layout gallery to show the logo slot.
  // Formal builds must not fabricate an institutional mark; the adjacent text
  // wordmark remains visible when no verified logo is available.
  if (!context.allowPlaceholder) return;
  const size = Math.min(position.width, position.height);
  const square = {
    left: position.left + (position.width - size) / 2,
    top: position.top + (position.height - size) / 2,
    width: size,
    height: size,
  };
  addShape(slide, "ellipse", square, {
    name: "brand-logo-placeholder",
    fill: context.colors.primary,
    line: { style: "solid", fill: context.colors.primaryDark, width: 1.5 },
  });
  const inset = Math.max(4, size * 0.1);
  addShape(slide, "ellipse", {
    left: square.left + inset, top: square.top + inset,
    width: size - inset * 2, height: size - inset * 2,
  }, {
    name: "brand-logo-placeholder-ring",
    fill: "none",
    line: { style: "solid", fill: context.tokens.neutral.white, width: 1.2 },
  });
  addText(slide, "校徽", square, {
    fontSize: size < 56 ? 10 : 13,
    fontFamily: context.tokens.fonts.zh,
    bold: true,
    color: context.tokens.neutral.white,
    alignment: "center",
    verticalAlignment: "middle",
  }, "brand-logo-label");
}

function setNotes(slide, slideSpec) {
  slide.speakerNotes.textFrame.setText(serializeSpeakerNotes(slideSpec));
  slide.speakerNotes.setVisible(true);
}

async function addGroupContentChrome(slide, slideSpec, context, slideNumber) {
  const { colors, tokens } = context;
  slide.background.fill = tokens.neutral.canvas;
  const marker = addShape(slide, "triangle", { left: 56, top: 25, width: 24, height: 26 }, {
    name: "group-title-marker",
    fill: colors.primary,
    line: { style: "solid", fill: colors.primary, width: 0 },
  });
  marker.rotation = 90;
  const title = slideTitle(slideSpec);
  addText(slide, title, { left: 90, top: 15, width: 910, height: 55 }, {
    fontSize: 31,
    fontFamily: fontFor(title, tokens),
    bold: true,
    color: colors.primary,
    verticalAlignment: "middle",
  }, "slide-title");
  const data = renderData(slideSpec);
  const sectionRecord = context.sectionIndex?.get(slideSpec.section_id);
  const paperNo = cleanText(first(data.paper_no, data.paperNo, slideSpec.paper_no, slideSpec.paperNo, ""));
  const section = cleanText(first(sectionRecord?.short_title, sectionRecord?.title, slideSpec.section_title, slideSpec.sectionTitle, ""));
  const tag = cleanText(first(data.chrome_label, data.chromeLabel, paperNo && `PAPER ${paperNo}`, section, ""));
  if (tag) addPill(slide, tag, { left: 1010, top: 19, width: 204, height: 34 }, colors, tokens, {
    name: "group-context-tag",
    fill: colors.primaryLight,
    line: colors.primaryLight,
    color: colors.primaryDark,
    fontSize: 12,
  });
  addRule(slide, 56, 78, 1168, tokens.neutral.line, 1, "group-title-rule");
  const footerLabel = cleanText(first(data.footer_label, context.spec?.literature?.mode === "multi_paper" ? "MULTI-PAPER REVIEW" : "PAPER REVIEW", ""));
  if (footerLabel) addText(slide, footerLabel, { left: 56, top: 678, width: 260, height: 22 }, {
    fontSize: 11,
    fontFamily: tokens.fonts.en,
    bold: true,
    color: tokens.neutral.subtle,
    verticalAlignment: "middle",
  }, "group-footer-label");
  addShape(slide, "rect", { left: 1236, top: 676, width: 44, height: 44 }, {
    name: "group-slide-number-box",
    fill: colors.primary,
    line: { style: "solid", fill: colors.primary, width: 0 },
  });
  addText(slide, String(slideNumber), { left: 1236, top: 676, width: 44, height: 44 }, {
    fontSize: 14,
    fontFamily: tokens.fonts.en,
    bold: true,
    color: tokens.neutral.white,
    alignment: "center",
  }, "slide-number");
}

function milestoneModeLabel(context) {
  return context.mode === "midterm" ? "中期汇报" : "开题答辩";
}

async function addMilestoneContentChrome(slide, slideSpec, context, slideNumber) {
  const { brand, colors, tokens } = context;
  slide.background.fill = tokens.neutral.canvas;
  const sectionRecord = context.sectionIndex?.get(slideSpec.section_id);
  const sectionIndex = list(context.spec?.sections).findIndex((item) => item?.id === slideSpec.section_id);
  const sectionNo = cleanText(first(
    slideSpec.section_number,
    slideSpec.sectionNumber,
    sectionRecord?.number,
    sectionIndex >= 0 ? String(sectionIndex + 1).padStart(2, "0") : "",
  ));
  const sectionTitle = cleanText(first(
    sectionRecord?.short_title,
    sectionRecord?.title,
    slideSpec.section_title,
    slideSpec.sectionTitle,
    context.mode === "midterm" ? "阶段进展" : "研究方案",
  ));

  addShape(slide, "rect", { left: 34, top: 17, width: 56, height: 38 }, {
    name: "milestone-section-number-box",
    fill: colors.primary,
    line: { style: "solid", fill: colors.primary, width: 0 },
  });
  addText(slide, sectionNo || "·", { left: 34, top: 17, width: 56, height: 38 }, {
    fontSize: 16,
    fontFamily: tokens.fonts.en,
    bold: true,
    color: tokens.neutral.white,
    alignment: "center",
  }, "milestone-section-number");
  addText(slide, sectionTitle, { left: 104, top: 14, width: 470, height: 44 }, {
    fontSize: 19,
    fontFamily: fontFor(sectionTitle, tokens),
    bold: true,
    color: tokens.neutral.text,
  }, "milestone-section-title");
  addPill(slide, milestoneModeLabel(context), { left: 835, top: 18, width: 112, height: 34 }, colors, tokens, {
    name: "milestone-mode-label",
    fill: colors.primaryLight,
    line: colors.primaryLight,
    color: colors.primaryDark,
    fontSize: 12,
  });
  addText(slide, brand.institution, { left: 958, top: 14, width: 238, height: 44 }, {
    fontSize: 13,
    fontFamily: fontFor(brand.institution, tokens),
    bold: true,
    color: colors.primary,
    alignment: "right",
  }, "milestone-institution-wordmark");
  await addLogo(slide, brand, { left: 1206, top: 11, width: 46, height: 46 }, context);
  addRule(slide, 28, 70, 1224, colors.primary, 2, "milestone-header-rule");

  const title = slideTitle(slideSpec);
  addText(slide, title, { left: 56, top: 86, width: 1168, height: 56 }, {
    fontSize: 32,
    fontFamily: fontFor(title, tokens),
    bold: true,
    color: tokens.neutral.text,
  }, "slide-title");
  addRule(slide, 56, 148, 180, colors.secondary, 3, "milestone-title-rule");
  addText(slide, String(slideNumber), { left: 1198, top: 679, width: 42, height: 20 }, {
    fontSize: 11,
    fontFamily: tokens.fonts.en,
    bold: true,
    color: tokens.neutral.subtle,
    alignment: "right",
  }, "slide-number");
}

async function addContentChrome(slide, slideSpec, context, slideNumber) {
  if (context.profile === "group_meeting_literature") {
    await addGroupContentChrome(slide, slideSpec, context, slideNumber);
    return;
  }
  if (context.profile === "proposal_midterm") {
    await addMilestoneContentChrome(slide, slideSpec, context, slideNumber);
    return;
  }
  const { brand, colors, tokens } = context;
  const sectionRecord = context.sectionIndex?.get(slideSpec.section_id);
  const section = cleanText(first(slideSpec.section_title, slideSpec.sectionTitle, slideSpec.section, sectionRecord?.short_title, sectionRecord?.title, ""));
  const sectionNumber = cleanText(first(slideSpec.section_number, slideSpec.sectionNumber, ""));
  await addLogo(slide, brand, { left: 18, top: 7, width: 44, height: 44 }, context);
  addText(slide, brand.institution, { left: 72, top: 8, width: 260, height: 42 }, {
    fontSize: 14,
    fontFamily: fontFor(brand.institution, tokens),
    bold: true,
    color: colors.primary,
  }, "institution-wordmark");
  const allSections = list(context.spec?.sections).filter((item) => cleanText(first(item?.title, item?.short_title)));
  const activeSection = allSections.find((item) => item?.id === slideSpec.section_id);
  if (allSections.length >= 2 && allSections.length <= 6) {
    const visibleSections = allSections;
    const navLeft = 354;
    const navRight = 1220;
    const navWidth = (navRight - navLeft) / visibleSections.length;
    visibleSections.forEach((item, index) => {
      const active = item?.id === slideSpec.section_id;
      const label = cleanText(first(item.short_title, item.title, `章节 ${index + 1}`));
      addShape(slide, "rect", { left: navLeft + index * navWidth, top: 0, width: navWidth, height: 58 }, {
        name: `section-nav-${index + 1}${active ? "-active" : ""}`,
        fill: active ? colors.primary : tokens.neutral.canvas,
        line: { style: "solid", fill: tokens.neutral.canvas, width: 0 },
      });
      addText(slide, label, { left: navLeft + index * navWidth + 8, top: 8, width: navWidth - 16, height: 42 }, {
        fontSize: visibleSections.length >= 6 ? 11 : visibleSections.length === 5 ? 12 : 13,
        fontFamily: fontFor(label, tokens),
        bold: active,
        color: active ? tokens.neutral.white : tokens.neutral.muted,
        alignment: "center",
      }, `section-nav-label-${index + 1}`);
    });
  } else if (allSections.length > 6 && activeSection) {
    const activeIndex = allSections.indexOf(activeSection) + 1;
    const activeLabel = cleanText(first(activeSection.short_title, activeSection.title, "当前章节"));
    addPill(slide, `${String(activeIndex).padStart(2, "0")}/${String(allSections.length).padStart(2, "0")}  ${activeLabel}`, {
      left: 908, top: 11, width: 298, height: 34,
    }, colors, tokens, { name: "section-progress-label", fill: colors.primaryLight, color: colors.primaryDark, fontSize: 13 });
  } else if (section) {
    addPill(slide, `${sectionNumber ? `${sectionNumber}  ` : ""}${section}`, {
      left: 928, top: 11, width: 278, height: 34,
    }, colors, tokens, { name: "section-label", fill: colors.primaryLight, color: colors.primaryDark, fontSize: 13 });
  }
  addRule(slide, 0, 58, 1280, tokens.neutral.black, 1, "header-rule");
  addText(slide, String(slideNumber), { left: 1210, top: 676, width: 32, height: 20 }, {
    fontSize: 12,
    fontFamily: tokens.fonts.en,
    bold: true,
    color: tokens.neutral.subtle,
    alignment: "right",
  }, "slide-number");
  const title = slideTitle(slideSpec);
  addText(slide, title, { left: 64, top: 78, width: 1152, height: 54 }, {
    fontSize: tokens.typeScale.slideTitle,
    fontFamily: fontFor(title, tokens),
    bold: true,
    color: tokens.neutral.text,
    verticalAlignment: "middle",
  }, "slide-title");
  addRule(slide, 64, 139, 300, tokens.neutral.line, 1.5, "title-rule");
}

function addTakeawayBand(slide, takeaway, context, options = {}) {
  if (!takeaway) return;
  const top = options.top ?? 608;
  const height = options.height ?? 56;
  addShape(slide, "roundRect", { left: 64, top, width: 1152, height }, {
    name: "takeaway-band",
    fill: options.fill ?? context.colors.primaryLight,
    line: { style: "solid", fill: options.line ?? context.colors.primaryLight, width: 1 },
    borderRadius: "rounded-lg",
  });
  addText(slide, takeaway, { left: 88, top: top + 5, width: 1104, height: height - 10 }, {
    fontSize: options.fontSize ?? 18,
    fontFamily: fontFor(takeaway, context.tokens),
    bold: options.bold ?? true,
    color: options.color ?? context.colors.primaryDark,
    alignment: options.alignment ?? "left",
  }, "takeaway-text");
}

function addSourceHint(slide, slideSpec, context) {
  const hint = cleanText(first(slideSpec.source_line, slideSpec.sourceLine, slideSpec.caption, ""));
  if (!hint) return;
  addText(slide, hint, { left: 64, top: 678, width: 1100, height: 22 }, {
    fontSize: context.tokens.typeScale.footnote,
    fontFamily: fontFor(hint, context.tokens),
    color: context.tokens.neutral.subtle,
    alignment: "right",
  }, "source-hint");
}

function addGroupCornerMotif(slide, left, top, color, mirrored = false) {
  const widths = [58, 42, 27];
  widths.forEach((width, index) => {
    addShape(slide, "roundRect", {
      left: mirrored ? left + (58 - width) : left,
      top: top + index * 10,
      width,
      height: 5,
    }, {
      name: `group-corner-${mirrored ? "br" : "tl"}-${index + 1}`,
      fill: color,
      line: { style: "solid", fill: color, width: 0 },
      borderRadius: "rounded-full",
    });
  });
}

function groupPaperEntries(spec, slideSpec) {
  const data = renderData(slideSpec);
  const candidates = first(data.papers, slideSpec.papers, spec.literature?.papers, spec.sections, []);
  return list(candidates).map((entry, index) => {
    if (!isObject(entry)) return { number: String(index + 1).padStart(2, "0"), title: cleanText(entry), detail: "" };
    return {
      ...entry,
      number: cleanText(first(entry.number, entry.index, String(index + 1).padStart(2, "0"))),
      title: cleanText(first(entry.short_title, entry.title, entry.label, `论文 ${index + 1}`)),
      detail: cleanText(first(entry.role, entry.citation, entry.venue, entry.detail, "")),
    };
  }).filter((entry) => entry.title);
}

async function renderGroupCover(slide, spec, slideSpec, context) {
  const data = renderData(slideSpec);
  slide.background.fill = context.tokens.neutral.canvas;
  addGroupCornerMotif(slide, 36, 28, context.colors.primary, false);
  addGroupCornerMotif(slide, 1128, 600, context.colors.primary, true);
  addText(slide, cleanText(first(data.kicker, "GROUP MEETING · LITERATURE REVIEW")), {
    left: 74, top: 74, width: 700, height: 34,
  }, {
    fontSize: 13, fontFamily: context.tokens.fonts.en, bold: true,
    color: context.colors.primary, verticalAlignment: "middle",
  }, "group-cover-kicker");
  addShape(slide, "rect", { left: 0, top: 200, width: 1280, height: 274 }, {
    name: "group-cover-band", fill: context.colors.primary,
    line: { style: "solid", fill: context.colors.primary, width: 0 },
  });
  const title = slideTitle(slideSpec) || cleanText(first(spec.title, "组会文献汇报"));
  addText(slide, title, { left: 110, top: 246, width: 1060, height: 104 }, {
    fontSize: 50, fontFamily: fontFor(title, context.tokens), bold: true,
    color: context.tokens.neutral.white, alignment: "center",
  }, "group-cover-title");
  const subtitle = cleanText(first(data.subtitle, slideSpec.content?.subtitle, spec.subtitle, ""));
  if (subtitle) addText(slide, subtitle, { left: 145, top: 360, width: 990, height: 52 }, {
    fontSize: 19, fontFamily: fontFor(subtitle, context.tokens), color: "#F4F6FB", alignment: "center",
  }, "group-cover-subtitle");
  const presenter = cleanText(first(data.presenter, spec.presenter, spec.author, ""));
  const group = cleanText(first(data.research_group, data.researchGroup, spec.research_group, context.brand.department, ""));
  const date = cleanText(first(data.date, spec.date, ""));
  const institution = cleanText(first(context.brand.institution === "学术机构" ? "" : context.brand.institution, ""));
  const meta = [presenter && `汇报人：${presenter}`, group && `课题组：${group}`, date && `日期：${date}`].filter(Boolean);
  const metaWidth = meta.length ? Math.min(320, 1040 / meta.length) : 320;
  const total = metaWidth * meta.length;
  meta.forEach((item, index) => addText(slide, item, {
    left: (1280 - total) / 2 + index * metaWidth, top: 540, width: metaWidth, height: 42,
  }, {
    fontSize: 16, fontFamily: fontFor(item, context.tokens), color: context.tokens.neutral.text, alignment: "center",
  }, `group-cover-meta-${index + 1}`));
  if (institution) addText(slide, institution, { left: 190, top: 635, width: 900, height: 30 }, {
    fontSize: 14, fontFamily: fontFor(institution, context.tokens), color: context.tokens.neutral.muted, alignment: "center",
  }, "group-cover-institution");
}

async function renderPaperAgenda(slide, spec, slideSpec, context, slideNumber) {
  slide.background.fill = context.tokens.neutral.canvas;
  addShape(slide, "rect", { left: 16, top: 16, width: 1248, height: 688 }, {
    name: "paper-agenda-border", fill: "none",
    line: { style: "solid", fill: context.colors.primary, width: 1.2 },
  });
  addShape(slide, "rect", { left: 500, top: 16, width: 280, height: 132 }, {
    name: "paper-agenda-title-block", fill: context.colors.primary,
    line: { style: "solid", fill: context.colors.primary, width: 0 },
  });
  addText(slide, "文献地图", { left: 515, top: 42, width: 250, height: 48 }, {
    fontSize: 38, fontFamily: context.tokens.fonts.zh, bold: true,
    color: context.tokens.neutral.white, alignment: "center",
  }, "paper-agenda-title");
  addText(slide, "PAPERS & QUESTIONS", { left: 515, top: 94, width: 250, height: 28 }, {
    fontSize: 12, fontFamily: context.tokens.fonts.en, bold: true,
    color: "#DDE5F4", alignment: "center",
  }, "paper-agenda-subtitle");
  const papers = groupPaperEntries(spec, slideSpec);
  if (!papers.length) throw new Error(`Paper agenda ${slideSpec.id ?? slideNumber} has no paper or section entries.`);
  if (papers.length > 10) throw new Error(`Paper agenda ${slideSpec.id ?? slideNumber} has ${papers.length} entries. Split it into multiple agenda slides; entries are never truncated.`);
  const data = renderData(slideSpec);
  const embeddedQuestion = papers.find((paper) => /^(?:Q|问)$/i.test(paper.number));
  const synthesisQuestion = cleanText(first(data.synthesis_question, data.synthesisQuestion, embeddedQuestion?.title, spec.literature?.synthesis_question, ""));
  const paperEntries = embeddedQuestion ? papers.filter((paper) => paper !== embeddedQuestion) : papers;
  if (synthesisQuestion && paperEntries.length <= 6) {
    const rows = paperEntries.length;
    const startTop = 218 + Math.max(0, (4 - rows) * 28);
    const rowHeight = Math.min(92, 330 / Math.max(1, rows));
    paperEntries.forEach((paper, index) => {
      const top = startTop + index * rowHeight;
      addShape(slide, "rect", { left: 78, top: top + 5, width: 62, height: 50 }, {
        name: `paper-agenda-number-${index + 1}`, fill: context.colors.primary,
        line: { style: "solid", fill: context.colors.primary, width: 0 },
      });
      addText(slide, paper.number, { left: 78, top: top + 5, width: 62, height: 50 }, {
        fontSize: 21, fontFamily: context.tokens.fonts.en, bold: true,
        color: context.tokens.neutral.white, alignment: "center",
      }, `paper-agenda-number-label-${index + 1}`);
      addText(slide, paper.title, { left: 160, top, width: 536, height: paper.detail ? 36 : 56 }, {
        fontSize: 20, fontFamily: fontFor(paper.title, context.tokens), bold: true,
        color: context.tokens.neutral.text, verticalAlignment: "middle",
      }, `paper-agenda-paper-title-${index + 1}`);
      if (paper.detail) addText(slide, paper.detail, { left: 160, top: top + 34, width: 536, height: 27 }, {
        fontSize: 12, fontFamily: fontFor(paper.detail, context.tokens), color: context.tokens.neutral.muted,
      }, `paper-agenda-paper-detail-${index + 1}`);
    });
    addShape(slide, "roundRect", { left: 790, top: 214, width: 392, height: 330 }, {
      name: "paper-agenda-question-panel", fill: context.colors.primaryLight,
      line: { style: "solid", fill: context.colors.primary, width: 1.2 }, borderRadius: "rounded-lg",
    });
    addPill(slide, "共同问题", { left: 826, top: 242, width: 132, height: 38 }, context.colors, context.tokens, {
      name: "paper-agenda-question-label", fill: context.colors.primary, line: context.colors.primary, color: context.tokens.neutral.white, fontSize: 14,
    });
    addText(slide, synthesisQuestion.replace(/^共同问题[｜|:：]?\s*/, ""), { left: 826, top: 310, width: 320, height: 154 }, {
      fontSize: 26, fontFamily: fontFor(synthesisQuestion, context.tokens), bold: true, color: context.colors.primaryDark, verticalAlignment: "top",
    }, "paper-agenda-question-text");
    const detail = cleanText(first(embeddedQuestion?.detail, data.question_detail, "跨论文比较与综合的主线"));
    addText(slide, detail, { left: 826, top: 486, width: 320, height: 36 }, {
      fontSize: 14, fontFamily: fontFor(detail, context.tokens), color: context.tokens.neutral.muted,
    }, "paper-agenda-question-detail");
  } else {
  const columns = papers.length <= 6 ? 1 : 2;
  const rows = Math.ceil(papers.length / columns);
  const startTop = columns === 1 ? 196 + Math.max(0, (6 - rows) * 22) : 190;
  const rowHeight = columns === 1 ? Math.min(84, 430 / rows) : Math.min(96, 440 / rows);
  const colWidth = columns === 1 ? 1080 : 548;
  papers.forEach((paper, index) => {
    const col = columns === 1 ? 0 : Math.floor(index / rows);
    const row = columns === 1 ? index : index % rows;
    const left = 78 + col * 580;
    const top = startTop + row * rowHeight;
    addShape(slide, "rect", { left, top: top + 5, width: 62, height: 50 }, {
      name: `paper-agenda-number-${index + 1}`, fill: context.colors.primary,
      line: { style: "solid", fill: context.colors.primary, width: 0 },
    });
    addText(slide, paper.number, { left, top: top + 5, width: 62, height: 50 }, {
      fontSize: 21, fontFamily: context.tokens.fonts.en, bold: true,
      color: context.tokens.neutral.white, alignment: "center",
    }, `paper-agenda-number-label-${index + 1}`);
    addText(slide, paper.title, { left: left + 82, top, width: colWidth - 100, height: paper.detail ? 36 : 56 }, {
      fontSize: columns === 1 ? 20 : 17, fontFamily: fontFor(paper.title, context.tokens), bold: true,
      color: context.tokens.neutral.text, verticalAlignment: "middle",
    }, `paper-agenda-paper-title-${index + 1}`);
    if (paper.detail) addText(slide, paper.detail, { left: left + 82, top: top + 34, width: colWidth - 100, height: 27 }, {
      fontSize: 12, fontFamily: fontFor(paper.detail, context.tokens), color: context.tokens.neutral.muted,
    }, `paper-agenda-paper-detail-${index + 1}`);
  });
  }
  addText(slide, String(slideNumber), { left: 1216, top: 674, width: 28, height: 20 }, {
    fontSize: 11, fontFamily: context.tokens.fonts.en, color: context.tokens.neutral.subtle, alignment: "right",
  }, "slide-number");
}

async function renderPaperDivider(slide, spec, slideSpec, context) {
  const data = renderData(slideSpec);
  slide.background.fill = context.tokens.neutral.canvas;
  addShape(slide, "rect", { left: 16, top: 16, width: 1248, height: 688 }, {
    name: "paper-divider-border", fill: "none",
    line: { style: "solid", fill: context.colors.primary, width: 1.2 },
  });
  addShape(slide, "rect", { left: 500, top: 16, width: 280, height: 160 }, {
    name: "paper-divider-number-block", fill: context.colors.primary,
    line: { style: "solid", fill: context.colors.primary, width: 0 },
  });
  const number = cleanText(first(data.paper_no, data.paperNo, "01"));
  addText(slide, number, { left: 520, top: 34, width: 240, height: 72 }, {
    fontSize: 52, fontFamily: context.tokens.fonts.en, bold: true,
    color: context.tokens.neutral.white, alignment: "center",
  }, "paper-divider-number");
  addText(slide, cleanText(first(data.label, "PAPER")), { left: 520, top: 108, width: 240, height: 32 }, {
    fontSize: 15, fontFamily: context.tokens.fonts.en, bold: true,
    color: "#DDE5F4", alignment: "center",
  }, "paper-divider-label");
  const title = slideTitle(slideSpec);
  addText(slide, title, { left: 110, top: 238, width: 1060, height: 104 }, {
    fontSize: 40, fontFamily: fontFor(title, context.tokens), bold: true,
    color: context.tokens.neutral.text, alignment: "center",
  }, "paper-divider-title");
  const citation = cleanText(first(data.citation, slideSpec.content?.subtitle, ""));
  if (citation) addText(slide, citation, { left: 150, top: 356, width: 980, height: 50 }, {
    fontSize: 16, fontFamily: fontFor(citation, context.tokens, true), color: context.tokens.neutral.muted, alignment: "center",
  }, "paper-divider-citation");
  const purpose = cleanText(first(data.purpose, slideTakeaway(slideSpec), ""));
  if (purpose) addText(slide, purpose, { left: 214, top: 470, width: 852, height: 74 }, {
    fontSize: 22, fontFamily: fontFor(purpose, context.tokens), bold: true,
    color: context.colors.primaryDark, alignment: "center",
  }, "paper-divider-purpose");
}

async function renderPaperProfile(slide, slideSpec, context, slideNumber) {
  await addContentChrome(slide, slideSpec, context, slideNumber);
  const data = renderData(slideSpec);
  const paper = isObject(data.paper) ? data.paper : data;
  const metadata = [
    ["来源", first(paper.venue, paper.journal, paper.source)],
    ["作者", first(paper.authors, paper.author)],
    ["年份", first(paper.year, paper.date)],
    ["类型", first(paper.publication_type, paper.type)],
    ["标识", first(paper.doi, paper.pmid, paper.arxiv, paper.identifier)],
  ].map(([label, value]) => [label, cleanText(value)]).filter(([, value]) => value);
  addShape(slide, "roundRect", { left: 56, top: 110, width: 342, height: 430 }, {
    name: "paper-profile-metadata-panel", fill: context.tokens.neutral.surface,
    line: { style: "solid", fill: context.tokens.neutral.line, width: 1 }, borderRadius: "rounded-lg",
  });
  addText(slide, "论文信息", { left: 82, top: 130, width: 290, height: 42 }, {
    fontSize: 23, fontFamily: context.tokens.fonts.zh, bold: true, color: context.colors.primary,
  }, "paper-profile-meta-title");
  const rowTop = 188;
  const rowHeight = Math.min(58, 270 / Math.max(1, metadata.length));
  metadata.forEach(([label, value], index) => {
    const top = rowTop + index * rowHeight;
    addText(slide, label, { left: 82, top, width: 72, height: rowHeight - 4 }, {
      fontSize: 14, fontFamily: context.tokens.fonts.zh, bold: true, color: context.tokens.neutral.muted,
    }, `paper-profile-meta-label-${index + 1}`);
    addText(slide, value, { left: 162, top, width: 208, height: rowHeight - 4 }, {
      fontSize: 15, fontFamily: fontFor(value, context.tokens), color: context.tokens.neutral.text,
    }, `paper-profile-meta-value-${index + 1}`);
    if (index < metadata.length - 1) addRule(slide, 82, top + rowHeight - 2, 288, context.tokens.neutral.line, 1, `paper-profile-meta-rule-${index + 1}`);
  });
  const keywords = list(first(paper.keywords, data.keywords, [])).map(cleanText).filter(Boolean).slice(0, 5);
  keywords.forEach((keyword, index) => addPill(slide, keyword, {
    left: 78 + (index % 2) * 146, top: 458 + Math.floor(index / 2) * 38, width: 132, height: 30,
  }, context.colors, context.tokens, { name: `paper-keyword-${index + 1}`, fontSize: 11 }));
  const title = cleanText(first(paper.title, slideSpec.content?.subtitle, slideTitle(slideSpec)));
  addText(slide, title, { left: 438, top: 112, width: 786, height: 92 }, {
    fontSize: 28, fontFamily: fontFor(title, context.tokens), bold: true,
    color: context.tokens.neutral.text, verticalAlignment: "top",
  }, "paper-profile-paper-title");
  const authorLine = cleanText(first(paper.author_line, paper.authorLine, paper.authors, ""));
  if (authorLine) addText(slide, authorLine, { left: 438, top: 204, width: 786, height: 34 }, {
    fontSize: 14, fontFamily: fontFor(authorLine, context.tokens), color: context.tokens.neutral.muted,
  }, "paper-profile-authors");
  const assets = slideAssetRequests(slideSpec, context.assetIndex, context.baseDir);
  await addImageOrPlaceholder(slide, assets[0], { left: 438, top: 248, width: 786, height: 278 }, {
    ...context, name: "paper-profile-visual", placeholderLabel: "真实论文首页、官网信息或图形摘要",
  });
  const question = cleanText(first(paper.research_question, data.research_question, slideTakeaway(slideSpec), ""));
  const contribution = cleanText(first(paper.one_line_contribution, data.one_line_contribution, slideSpec.content?.callout, ""));
  addShape(slide, "rect", { left: 56, top: 562, width: 1168, height: 82 }, {
    name: "paper-profile-summary-band", fill: context.colors.primaryLight,
    line: { style: "solid", fill: context.colors.primaryLight, width: 0 },
  });
  if (question) addText(slide, `研究问题｜${question}`, { left: 82, top: 570, width: 1116, height: 32 }, {
    fontSize: 17, fontFamily: fontFor(question, context.tokens), bold: true, color: context.colors.primaryDark,
  }, "paper-profile-question");
  if (contribution) addText(slide, `一句话贡献｜${contribution}`, { left: 82, top: 606, width: 1116, height: 28 }, {
    fontSize: 15, fontFamily: fontFor(contribution, context.tokens), color: context.tokens.neutral.text,
  }, "paper-profile-contribution");
}

function groupItems(slideSpec, keys, fallback = []) {
  const data = renderData(slideSpec);
  let values;
  for (const key of keys) {
    if (data[key] != null) {
      values = data[key];
      break;
    }
  }
  values ??= fallback;
  return list(values).map((entry, index) => {
    if (!isObject(entry)) return { number: String(index + 1).padStart(2, "0"), title: cleanText(entry), body: "" };
    return {
      ...entry,
      number: cleanText(first(entry.number, entry.index, String(index + 1).padStart(2, "0"))),
      title: cleanText(first(entry.title, entry.label, entry.claim, entry.question, entry.text, `要点 ${index + 1}`)),
      body: cleanText(first(entry.body, entry.detail, entry.evidence, entry.description, entry.caption, "")),
    };
  });
}

async function renderSelectionRationale(slide, slideSpec, context, slideNumber) {
  await addContentChrome(slide, slideSpec, context, slideNumber);
  const items = groupItems(slideSpec, ["criteria", "items"], [
    { title: "问题相关", body: "直接回应本组当前关心的科学问题。" },
    { title: "证据关键", body: "提供可复用的方法、数据或机制证据。" },
    { title: "值得讨论", body: "结论存在边界、冲突或可验证的延伸。" },
  ]).slice(0, 4);
  const count = items.length;
  const gap = 24;
  const width = (1168 - gap * (count - 1)) / count;
  items.forEach((item, index) => {
    const left = 56 + index * (width + gap);
    addShape(slide, "roundRect", { left, top: 162, width, height: 344 }, {
      name: `selection-card-${index + 1}`, fill: index === 0 ? context.colors.primaryLight : context.tokens.neutral.surface,
      line: { style: "solid", fill: index === 0 ? context.colors.primary : context.tokens.neutral.line, width: 1.2 }, borderRadius: "rounded-lg",
    });
    addText(slide, item.number, { left: left + 22, top: 184, width: 56, height: 42 }, {
      fontSize: 20, fontFamily: context.tokens.fonts.en, bold: true, color: context.colors.primary,
    }, `selection-index-${index + 1}`);
    addText(slide, item.title, { left: left + 22, top: 244, width: width - 44, height: 72 }, {
      fontSize: 23, fontFamily: fontFor(item.title, context.tokens), bold: true, color: context.tokens.neutral.text,
    }, `selection-title-${index + 1}`);
    addRule(slide, left + 22, 330, Math.min(70, width - 44), context.colors.accent, 3, `selection-accent-${index + 1}`);
    addText(slide, item.body, { left: left + 22, top: 356, width: width - 44, height: 116 }, {
      fontSize: 16, fontFamily: fontFor(item.body, context.tokens), color: context.tokens.neutral.muted, verticalAlignment: "top",
    }, `selection-body-${index + 1}`);
  });
  addTakeawayBand(slide, slideTakeaway(slideSpec), context, { top: 548, height: 96, fontSize: 19 });
}

async function renderKnownGapQuestion(slide, slideSpec, context, slideNumber) {
  await addContentChrome(slide, slideSpec, context, slideNumber);
  const data = renderData(slideSpec);
  const items = [
    { label: "已知", value: cleanText(first(data.known, data.context, "现有研究已经建立的共识与证据基础。")), color: context.tokens.neutral.surfaceStrong },
    { label: "缺口", value: cleanText(first(data.gap, "仍未解决的矛盾、空白或证据不足。")), color: "#FFF5E6" },
    { label: "问题", value: cleanText(first(data.question, slideTakeaway(slideSpec), "本篇论文真正要回答的研究问题。")), color: context.colors.primaryLight },
  ];
  const lefts = [56, 448, 840];
  items.forEach((item, index) => {
    addShape(slide, "roundRect", { left: lefts[index], top: 192, width: 328, height: 302 }, {
      name: `known-gap-card-${index + 1}`, fill: item.color,
      line: { style: "solid", fill: index === 1 ? context.colors.accent : context.colors.primary, width: index === 1 ? 1.8 : 1 }, borderRadius: "rounded-lg",
    });
    addPill(slide, item.label, { left: lefts[index] + 24, top: 214, width: 88, height: 34 }, context.colors, context.tokens, {
      name: `known-gap-label-${index + 1}`, fill: index === 1 ? context.colors.accent : context.colors.primary,
      line: index === 1 ? context.colors.accent : context.colors.primary, color: context.tokens.neutral.white,
    });
    addText(slide, item.value, { left: lefts[index] + 24, top: 278, width: 280, height: 174 }, {
      fontSize: index === 2 ? 23 : 20, fontFamily: fontFor(item.value, context.tokens), bold: index === 2,
      color: index === 2 ? context.colors.primaryDark : context.tokens.neutral.text, verticalAlignment: "top",
    }, `known-gap-text-${index + 1}`);
    if (index < 2) addShape(slide, "rightArrow", { left: lefts[index] + 342, top: 326, width: 40, height: 30 }, {
      name: `known-gap-arrow-${index + 1}`, fill: context.colors.secondary,
      line: { style: "solid", fill: context.colors.secondary, width: 0 },
    });
  });
  const boundary = cleanText(first(data.boundary, slideSpec.content?.callout, "研究问题应由缺口自然推出，而不是由模板预设。"));
  addTakeawayBand(slide, boundary, context, { top: 556, height: 76, fontSize: 18 });
}

async function renderSampleDataProfile(slide, slideSpec, context, slideNumber) {
  await addContentChrome(slide, slideSpec, context, slideNumber);
  const data = renderData(slideSpec);
  const metrics = slideMetrics(slideSpec).slice(0, 4);
  const rows = groupItems(slideSpec, ["data_layers", "layers", "items"], [
    { title: "研究对象", body: "样本来源、纳入标准与关键分层。" },
    { title: "测量与数据", body: "观测变量、数据模态与时间尺度。" },
    { title: "质量控制", body: "排除规则、缺失处理与偏倚控制。" },
  ]).slice(0, 4);
  addShape(slide, "roundRect", { left: 56, top: 146, width: 400, height: 454 }, {
    name: "sample-profile-panel", fill: context.colors.primary,
    line: { style: "solid", fill: context.colors.primary, width: 0 }, borderRadius: "rounded-lg",
  });
  addText(slide, cleanText(first(data.sample_label, "样本 / 数据概况")), { left: 86, top: 172, width: 340, height: 44 }, {
    fontSize: 22, fontFamily: context.tokens.fonts.zh, bold: true, color: context.tokens.neutral.white,
  }, "sample-profile-label");
  const fallbackMetrics = [
    { value: "N", label: "样本规模" }, { value: "3", label: "关键数据层" }, { value: "≥2", label: "对照 / 时间点" },
  ];
  const visibleMetrics = metrics.length ? metrics : fallbackMetrics;
  visibleMetrics.forEach((metric, index) => {
    const col = index % 2;
    const row = Math.floor(index / 2);
    const left = 82 + col * 174;
    const top = 240 + row * 128;
    const value = cleanText(first(metric.value, metric.number, "—"));
    const unit = cleanText(first(metric.unit, ""));
    const label = cleanText(first(metric.label, metric.caption, "指标"));
    addText(slide, [value, unit].filter(Boolean).join(" "), { left, top, width: 154, height: 58 }, {
      fontSize: 32, fontFamily: fontFor(value, context.tokens), bold: true, color: context.tokens.neutral.white,
    }, `sample-metric-value-${index + 1}`);
    addText(slide, label, { left, top: top + 60, width: 154, height: 34 }, {
      fontSize: 13, fontFamily: fontFor(label, context.tokens), color: "#DDE5F4",
    }, `sample-metric-label-${index + 1}`);
  });
  rows.forEach((item, index) => {
    const top = 154 + index * 118;
    addText(slide, item.number, { left: 510, top: top + 12, width: 62, height: 48 }, {
      fontSize: 18, fontFamily: context.tokens.fonts.en, bold: true, color: context.colors.primary, alignment: "center",
    }, `data-layer-index-${index + 1}`);
    addText(slide, item.title, { left: 594, top, width: 240, height: 42 }, {
      fontSize: 20, fontFamily: fontFor(item.title, context.tokens), bold: true, color: context.tokens.neutral.text,
    }, `data-layer-title-${index + 1}`);
    addText(slide, item.body, { left: 840, top, width: 364, height: 70 }, {
      fontSize: 16, fontFamily: fontFor(item.body, context.tokens), color: context.tokens.neutral.muted,
    }, `data-layer-body-${index + 1}`);
    if (index < rows.length - 1) addRule(slide, 594, top + 88, 610, context.tokens.neutral.line, 1, `data-layer-rule-${index + 1}`);
  });
  addTakeawayBand(slide, slideTakeaway(slideSpec), context, { top: 612, height: 46, fontSize: 15 });
}

async function renderClaimEvidenceBoundary(slide, slideSpec, context, slideNumber) {
  await addContentChrome(slide, slideSpec, context, slideNumber);
  const data = renderData(slideSpec);
  const claim = cleanText(first(data.claim, slideTakeaway(slideSpec), "论文作者提出的核心主张。"));
  const evidence = groupItems(slideSpec, ["evidence", "items"], [
    { title: "直接证据", body: "最直接支撑主张的结果。" },
    { title: "一致性证据", body: "来自另一方法或样本的支持。" },
  ]).slice(0, 3);
  const boundary = cleanText(first(data.boundary, slideSpec.content?.callout, "证据只支持到这里；更强外推仍待验证。"));
  const claimLabel = cleanText(first(data.claim_label, data.claimLabel, context.profile === "proposal_midterm" ? "研究范围 / 核心界定" : "作者主张"));
  const evidenceLabel = cleanText(first(data.evidence_label, data.evidenceLabel, context.profile === "proposal_midterm" ? "纳入依据" : "证据链"));
  const boundaryLabel = cleanText(first(data.boundary_label, data.boundaryLabel, context.profile === "proposal_midterm" ? "边界与不纳入项" : "汇报者边界判断"));
  const reminder = cleanText(first(data.reminder, context.profile === "proposal_midterm" ? "边界越清楚，结论越可检验" : "作者声称 ≠ 汇报者认同"));
  addShape(slide, "roundRect", { left: 56, top: 160, width: 338, height: 390 }, {
    name: "author-claim-panel", fill: context.colors.primary,
    line: { style: "solid", fill: context.colors.primary, width: 0 }, borderRadius: "rounded-lg",
  });
  addText(slide, claimLabel, { left: 84, top: 184, width: 282, height: 38 }, {
    fontSize: 16, fontFamily: context.tokens.fonts.zh, bold: true, color: "#DDE5F4",
  }, "author-claim-label");
  addText(slide, claim, { left: 84, top: 244, width: 282, height: 226 }, {
    fontSize: 27, fontFamily: fontFor(claim, context.tokens), bold: true, color: context.tokens.neutral.white, verticalAlignment: "top",
  }, "author-claim-text");
  addText(slide, evidenceLabel, { left: 446, top: 164, width: 220, height: 38 }, {
    fontSize: 17, fontFamily: context.tokens.fonts.zh, bold: true, color: context.colors.primary,
  }, "claim-evidence-label");
  evidence.forEach((item, index) => {
    const top = 214 + index * 112;
    addShape(slide, "roundRect", { left: 446, top, width: 418, height: 92 }, {
      name: `claim-evidence-item-${index + 1}`, fill: index === 0 ? context.colors.primaryLight : context.tokens.neutral.surface,
      line: { style: "solid", fill: index === 0 ? context.colors.secondary : context.tokens.neutral.line, width: 1 }, borderRadius: "rounded-lg",
    });
    addText(slide, item.title, { left: 468, top: top + 10, width: 150, height: 32 }, {
      fontSize: 16, fontFamily: fontFor(item.title, context.tokens), bold: true, color: context.tokens.neutral.text,
    }, `claim-evidence-item-title-${index + 1}`);
    addText(slide, item.body, { left: 624, top: top + 10, width: 216, height: 64 }, {
      fontSize: 14, fontFamily: fontFor(item.body, context.tokens), color: context.tokens.neutral.muted,
    }, `claim-evidence-item-body-${index + 1}`);
  });
  addShape(slide, "roundRect", { left: 904, top: 160, width: 320, height: 390 }, {
    name: "claim-boundary-panel", fill: "#FFF7E9",
    line: { style: "solid", fill: context.colors.accent, width: 1.5 }, borderRadius: "rounded-lg",
  });
  addText(slide, boundaryLabel, { left: 930, top: 184, width: 268, height: 38 }, {
    fontSize: 16, fontFamily: context.tokens.fonts.zh, bold: true, color: context.colors.accent,
  }, "claim-boundary-label");
  addText(slide, boundary, { left: 930, top: 250, width: 268, height: 212 }, {
    fontSize: 21, fontFamily: fontFor(boundary, context.tokens), bold: true, color: context.tokens.neutral.text, verticalAlignment: "top",
  }, "claim-boundary-text");
  addText(slide, reminder, { left: 930, top: 486, width: 268, height: 36 }, {
    fontSize: 14, fontFamily: context.tokens.fonts.zh, color: context.tokens.neutral.muted, alignment: "center",
  }, "claim-boundary-reminder");
  addTakeawayBand(slide, cleanText(first(data.verdict, "把论文结论、证据强度和适用边界放在同一页判断。")), context, { top: 594, height: 64, fontSize: 17 });
}

async function renderPaperConclusion(slide, slideSpec, context, slideNumber) {
  await addContentChrome(slide, slideSpec, context, slideNumber);
  const data = renderData(slideSpec);
  const items = [
    { label: "发现了什么", value: cleanText(first(data.finding, slideTakeaway(slideSpec), "论文最核心、最可复述的发现。")) },
    { label: "凭什么相信", value: cleanText(first(data.support, data.evidence, "支撑该发现的关键结果、对照与稳健性证据。")) },
    { label: "尚未证明", value: cleanText(first(data.not_proven, data.boundary, "仍不能由现有证据推出的更强结论。")) },
  ];
  items.forEach((item, index) => {
    const top = 154 + index * 144;
    addShape(slide, "roundRect", { left: 56, top, width: 1168, height: 116 }, {
      name: `paper-conclusion-row-${index + 1}`, fill: index === 0 ? context.colors.primaryLight : index === 2 ? "#FFF7E9" : context.tokens.neutral.surface,
      line: { style: "solid", fill: index === 2 ? context.colors.accent : context.tokens.neutral.line, width: 1 }, borderRadius: "rounded-lg",
    });
    addText(slide, item.label, { left: 82, top: top + 20, width: 180, height: 72 }, {
      fontSize: 18, fontFamily: context.tokens.fonts.zh, bold: true, color: index === 2 ? context.colors.accent : context.colors.primary,
    }, `paper-conclusion-label-${index + 1}`);
    addVerticalRule(slide, 282, top + 22, 72, index === 2 ? context.colors.accent : context.colors.secondary, 2, `paper-conclusion-rule-${index + 1}`);
    addText(slide, item.value, { left: 314, top: top + 14, width: 876, height: 88 }, {
      fontSize: index === 0 ? 23 : 19, fontFamily: fontFor(item.value, context.tokens), bold: index === 0, color: context.tokens.neutral.text,
    }, `paper-conclusion-text-${index + 1}`);
  });
  addTakeawayBand(slide, cleanText(first(data.one_line, "一页完成“发现—证据—边界”的论文收束。")), context, { top: 594, height: 64, fontSize: 17 });
}

async function renderCriticalAppraisal(slide, slideSpec, context, slideNumber) {
  await addContentChrome(slide, slideSpec, context, slideNumber);
  const data = renderData(slideSpec);
  const strengths = groupItems(slideSpec, ["strengths"], ["问题与设计匹配", "关键对照充分", "结论边界清楚"]).slice(0, 4);
  const risks = groupItems(slideSpec, ["risks", "limitations"], ["样本外推受限", "替代解释未排除", "复现信息不完整"]).slice(0, 4);
  const columns = [
    { label: "可信之处", items: strengths, left: 56, fill: context.colors.primaryLight, line: context.colors.primary },
    { label: "需要警惕", items: risks, left: 650, fill: "#FFF7E9", line: context.colors.accent },
  ];
  columns.forEach((column, columnIndex) => {
    addPill(slide, column.label, { left: column.left, top: 154, width: 574, height: 42 }, context.colors, context.tokens, {
      name: `appraisal-header-${columnIndex + 1}`, fill: column.line, line: column.line, color: context.tokens.neutral.white, fontSize: 16,
    });
    column.items.forEach((item, index) => {
      const top = 220 + index * 84;
      addShape(slide, "roundRect", { left: column.left, top, width: 574, height: 68 }, {
        name: `appraisal-row-${columnIndex + 1}-${index + 1}`, fill: column.fill,
        line: { style: "solid", fill: columnIndex === 0 ? context.tokens.neutral.line : column.line, width: 1 }, borderRadius: "rounded-lg",
      });
      addText(slide, item.number, { left: column.left + 18, top: top + 10, width: 42, height: 46 }, {
        fontSize: 13, fontFamily: context.tokens.fonts.en, bold: true, color: column.line, alignment: "center",
      }, `appraisal-index-${columnIndex + 1}-${index + 1}`);
      addText(slide, [item.title, item.body].filter(Boolean).join("｜"), { left: column.left + 70, top: top + 8, width: 480, height: 50 }, {
        fontSize: 16, fontFamily: fontFor(item.title, context.tokens), color: context.tokens.neutral.text,
      }, `appraisal-text-${columnIndex + 1}-${index + 1}`);
    });
  });
  addTakeawayBand(slide, cleanText(first(data.verdict, slideTakeaway(slideSpec), "综合判断：哪些结论可采纳，哪些仍需本组验证。")), context, { top: 586, height: 72, fontSize: 18 });
}

async function renderReproducibilityCheck(slide, slideSpec, context, slideNumber) {
  await addContentChrome(slide, slideSpec, context, slideNumber);
  const items = groupItems(slideSpec, ["checks", "items"], [
    { title: "数据可得", body: "原始数据、纳排规则与预处理。", status: "部分" },
    { title: "方法可复现", body: "参数、代码、软件版本与随机性。", status: "可核" },
    { title: "结果可重算", body: "主要图表与统计口径能够追踪。", status: "待做" },
    { title: "外部可验证", body: "独立样本或替代方法支持。", status: "不足" },
  ]).slice(0, 5);
  const statusColors = {
    "可核": context.colors.success, "充分": context.colors.success, "已完成": context.colors.success,
    complete: context.colors.success, completed: context.colors.success,
    "部分": context.colors.accent, "进行中": context.colors.primary, inProgress: context.colors.primary, in_progress: context.colors.primary,
    "待做": context.colors.warning, "有风险": context.colors.warning, atRisk: context.colors.warning, at_risk: context.colors.warning,
    "不足": context.colors.danger, "阻塞": context.colors.danger, blocked: context.colors.danger,
    "未开始": context.tokens.neutral.subtle, notStarted: context.tokens.neutral.subtle, not_started: context.tokens.neutral.subtle,
  };
  items.forEach((item, index) => {
    const top = 158 + index * 88;
    const status = cleanText(first(item.status, item.value, "待核"));
    const statusColor = statusColors[status] ?? context.colors.primary;
    addText(slide, item.number, { left: 64, top, width: 60, height: 66 }, {
      fontSize: 18, fontFamily: context.tokens.fonts.en, bold: true, color: context.colors.primary, alignment: "center",
    }, `repro-index-${index + 1}`);
    addText(slide, item.title, { left: 142, top, width: 220, height: 66 }, {
      fontSize: 19, fontFamily: fontFor(item.title, context.tokens), bold: true, color: context.tokens.neutral.text,
    }, `repro-title-${index + 1}`);
    addText(slide, item.body, { left: 390, top, width: 610, height: 66 }, {
      fontSize: 16, fontFamily: fontFor(item.body, context.tokens), color: context.tokens.neutral.muted,
    }, `repro-body-${index + 1}`);
    addPill(slide, status, { left: 1038, top: top + 13, width: 150, height: 38 }, context.colors, context.tokens, {
      name: `repro-status-${index + 1}`, fill: mixHex(statusColor, "#FFFFFF", 0.84), line: statusColor, color: statusColor, fontSize: 14,
    });
    if (index < items.length - 1) addRule(slide, 142, top + 76, 1046, context.tokens.neutral.line, 1, `repro-rule-${index + 1}`);
  });
  addTakeawayBand(slide, slideTakeaway(slideSpec), context, { top: 594, height: 64, fontSize: 17 });
}

async function renderConsensusDivergence(slide, slideSpec, context, slideNumber) {
  await addContentChrome(slide, slideSpec, context, slideNumber);
  const data = renderData(slideSpec);
  const columns = [
    { label: "一致结论", items: list(first(data.consensus, [])), fill: context.colors.primaryLight, line: context.colors.primary },
    { label: "冲突结论", items: list(first(data.divergence, [])), fill: "#FFF7E9", line: context.colors.accent },
    { label: "可能原因", items: list(first(data.explanations, data.causes, [])), fill: context.tokens.neutral.surface, line: context.colors.secondary },
  ];
  columns.forEach((column, index) => {
    const left = 56 + index * 396;
    addShape(slide, "roundRect", { left, top: 160, width: 372, height: 400 }, {
      name: `synthesis-column-${index + 1}`, fill: column.fill,
      line: { style: "solid", fill: column.line, width: 1.2 }, borderRadius: "rounded-lg",
    });
    addText(slide, column.label, { left: left + 24, top: 184, width: 324, height: 42 }, {
      fontSize: 21, fontFamily: context.tokens.fonts.zh, bold: true, color: column.line,
    }, `synthesis-label-${index + 1}`);
    const values = (column.items.length ? column.items : [index === 0 ? "多篇论文支持的共同模式" : index === 1 ? "结论方向或效应量并不一致" : "样本、测量、工况或模型不同"]).map(cleanText).filter(Boolean).slice(0, 5);
    addBulletList(slide, values, { left: left + 24, top: 244, width: 324, height: 270 }, {
      fontSize: 17, color: context.tokens.neutral.text, lineSpacing: 1.25,
    }, context.tokens, `synthesis-bullets-${index + 1}`);
  });
  addTakeawayBand(slide, slideTakeaway(slideSpec), context, { top: 594, height: 64, fontSize: 17 });
}

async function renderEvidenceQualityMap(slide, slideSpec, context, slideNumber) {
  await addContentChrome(slide, slideSpec, context, slideNumber);
  const data = renderData(slideSpec);
  const points = list(first(data.points, data.papers, [])).map((entry, index) => isObject(entry) ? entry : { label: cleanText(entry), x: 0.35 + index * 0.12, y: 0.55 }).slice(0, 8);
  const plot = { left: 88, top: 178, width: 760, height: 390 };
  addShape(slide, "rect", plot, { name: "quality-map-surface", fill: context.tokens.neutral.surface, line: { style: "solid", fill: context.tokens.neutral.line, width: 1 } });
  addVerticalRule(slide, plot.left + plot.width / 2, plot.top, plot.height, context.tokens.neutral.line, 1, "quality-map-v-mid");
  addRule(slide, plot.left, plot.top + plot.height / 2, plot.width, context.tokens.neutral.line, 1, "quality-map-h-mid");
  addText(slide, "证据强度 →", { left: plot.left + 250, top: plot.top + plot.height + 8, width: 260, height: 30 }, {
    fontSize: 14, fontFamily: context.tokens.fonts.zh, bold: true, color: context.tokens.neutral.muted, alignment: "center",
  }, "quality-map-x-label");
  addText(slide, "外部适用性", { left: 4, top: plot.top + 150, width: 80, height: 90 }, {
    fontSize: 14, fontFamily: context.tokens.fonts.zh, bold: true, color: context.tokens.neutral.muted, alignment: "center",
  }, "quality-map-y-label");
  const normalizedPoints = points.length ? points : [
    { label: "论文 A", x: 0.72, y: 0.66, size: 32 }, { label: "论文 B", x: 0.48, y: 0.38, size: 28 }, { label: "论文 C", x: 0.30, y: 0.74, size: 26 },
  ];
  normalizedPoints.forEach((point, index) => {
    const x = clamp(Number(first(point.x, point.strength, 0.5)), 0.08, 0.92);
    const y = clamp(Number(first(point.y, point.generalisability, point.applicability, 0.5)), 0.08, 0.92);
    const size = clamp(Number(first(point.size, 30)), 22, 48);
    const left = plot.left + x * plot.width - size / 2;
    const top = plot.top + (1 - y) * plot.height - size / 2;
    addShape(slide, "ellipse", { left, top, width: size, height: size }, {
      name: `quality-point-${index + 1}`, fill: context.colors.chart[index % context.colors.chart.length],
      line: { style: "solid", fill: context.tokens.neutral.white, width: 2 },
    });
    const label = cleanText(first(point.label, point.title, `论文 ${String.fromCharCode(65 + index)}`));
    addText(slide, label, { left: left + size + 6, top: top - 3, width: 128, height: 34 }, {
      fontSize: 13, fontFamily: fontFor(label, context.tokens), bold: true, color: context.tokens.neutral.text,
    }, `quality-point-label-${index + 1}`);
  });
  const legend = groupItems(slideSpec, ["criteria"], [
    { title: "横轴", body: "设计、对照、统计与复现共同决定证据强度。" },
    { title: "纵轴", body: "样本与情境决定结论能否迁移到本组问题。" },
    { title: "用途", body: "优先讨论高证据但外推受限的关键论文。" },
  ]).slice(0, 3);
  legend.forEach((item, index) => {
    const top = 184 + index * 118;
    addText(slide, item.title, { left: 904, top, width: 260, height: 34 }, {
      fontSize: 18, fontFamily: fontFor(item.title, context.tokens), bold: true, color: context.colors.primary,
    }, `quality-legend-title-${index + 1}`);
    addText(slide, item.body, { left: 904, top: top + 40, width: 286, height: 64 }, {
      fontSize: 15, fontFamily: fontFor(item.body, context.tokens), color: context.tokens.neutral.muted,
    }, `quality-legend-body-${index + 1}`);
  });
  addTakeawayBand(slide, slideTakeaway(slideSpec), context, { top: 608, height: 50, fontSize: 16 });
}

async function renderTransferToOurWork(slide, slideSpec, context, slideNumber) {
  await addContentChrome(slide, slideSpec, context, slideNumber);
  const data = renderData(slideSpec);
  const items = [
    { label: "论文给出", title: cleanText(first(data.paper_finding, data.finding, "可复用的机制、方法或证据")), fill: context.tokens.neutral.surface },
    { label: "迁移判断", title: cleanText(first(data.transfer_logic, data.transfer, "哪些前提与本组场景相同，哪些不同")), fill: context.colors.primaryLight },
    { label: "下一步动作", title: cleanText(first(data.next_action, data.action, slideTakeaway(slideSpec), "形成可执行的小实验、分析或决策")), fill: "#FFF7E9" },
  ];
  items.forEach((item, index) => {
    const left = 56 + index * 396;
    addShape(slide, "roundRect", { left, top: 194, width: 348, height: 292 }, {
      name: `transfer-card-${index + 1}`, fill: item.fill,
      line: { style: "solid", fill: index === 2 ? context.colors.accent : context.colors.primary, width: 1.2 }, borderRadius: "rounded-lg",
    });
    addPill(slide, item.label, { left: left + 24, top: 218, width: 126, height: 34 }, context.colors, context.tokens, {
      name: `transfer-label-${index + 1}`, fill: index === 2 ? context.colors.accent : context.colors.primary,
      line: index === 2 ? context.colors.accent : context.colors.primary, color: context.tokens.neutral.white, fontSize: 13,
    });
    addText(slide, item.title, { left: left + 24, top: 282, width: 300, height: 148 }, {
      fontSize: 23, fontFamily: fontFor(item.title, context.tokens), bold: true, color: context.tokens.neutral.text,
    }, `transfer-text-${index + 1}`);
    if (index < 2) addShape(slide, "rightArrow", { left: left + 354, top: 326, width: 36, height: 30 }, {
      name: `transfer-arrow-${index + 1}`, fill: context.colors.secondary,
      line: { style: "solid", fill: context.colors.secondary, width: 0 },
    });
  });
  const caveat = cleanText(first(data.caveat, slideSpec.content?.callout, "迁移前先核对对象、尺度、工况与评价指标是否一致。"));
  addTakeawayBand(slide, caveat, context, { top: 554, height: 82, fontSize: 18 });
}

async function renderDiscussionQuestions(slide, slideSpec, context, slideNumber) {
  await addContentChrome(slide, slideSpec, context, slideNumber);
  const questions = groupItems(slideSpec, ["questions", "items"], [
    "哪个替代解释最值得优先排除？",
    "若迁移到本组对象，首个验证实验应是什么？",
    "哪项证据最可能改变我们的判断？",
  ]).slice(0, 5);
  const rowHeight = questions.length >= 5 ? 76 : questions.length === 4 ? 92 : 112;
  const topStart = questions.length >= 5 ? 146 : 164;
  questions.forEach((item, index) => {
    const top = topStart + index * (rowHeight + 12);
    addShape(slide, "roundRect", { left: 72, top, width: 1136, height: rowHeight }, {
      name: `discussion-row-${index + 1}`, fill: index === 0 ? context.colors.primaryLight : context.tokens.neutral.surface,
      line: { style: "solid", fill: index === 0 ? context.colors.primary : context.tokens.neutral.line, width: 1 }, borderRadius: "rounded-lg",
    });
    addShape(slide, "ellipse", { left: 94, top: top + (rowHeight - 48) / 2, width: 48, height: 48 }, {
      name: `discussion-number-${index + 1}`, fill: index === 0 ? context.colors.primary : context.tokens.neutral.white,
      line: { style: "solid", fill: context.colors.primary, width: 1.2 },
    });
    addText(slide, item.number, { left: 94, top: top + (rowHeight - 48) / 2, width: 48, height: 48 }, {
      fontSize: 14, fontFamily: context.tokens.fonts.en, bold: true, color: index === 0 ? context.tokens.neutral.white : context.colors.primary, alignment: "center",
    }, `discussion-number-text-${index + 1}`);
    addText(slide, [item.title, item.body].filter(Boolean).join("｜"), { left: 172, top: top + 8, width: 1006, height: rowHeight - 16 }, {
      fontSize: questions.length >= 5 ? 17 : 20, fontFamily: fontFor(item.title, context.tokens), bold: index === 0, color: context.tokens.neutral.text,
    }, `discussion-question-${index + 1}`);
  });
}

async function renderDecisionRequest(slide, slideSpec, context, slideNumber) {
  await addContentChrome(slide, slideSpec, context, slideNumber);
  const data = renderData(slideSpec);
  const decision = cleanText(first(data.decision, slideTakeaway(slideSpec), "本次组会希望形成的明确判断或选择。"));
  addShape(slide, "roundRect", { left: 180, top: 150, width: 920, height: 116 }, {
    name: "decision-question", fill: context.colors.primary,
    line: { style: "solid", fill: context.colors.primary, width: 0 }, borderRadius: "rounded-lg",
  });
  addText(slide, decision, { left: 220, top: 168, width: 840, height: 80 }, {
    fontSize: 27, fontFamily: fontFor(decision, context.tokens), bold: true, color: context.tokens.neutral.white, alignment: "center",
  }, "decision-question-text");
  const options = groupItems(slideSpec, ["options", "items"], [
    { title: "方案 A", body: "优点、风险与所需资源" },
    { title: "方案 B", body: "优点、风险与所需资源" },
    { title: "暂缓", body: "先补充哪项证据再决定" },
  ]).slice(0, 4);
  const width = (1088 - 24 * (options.length - 1)) / options.length;
  options.forEach((item, index) => {
    const left = 96 + index * (width + 24);
    addShape(slide, "roundRect", { left, top: 316, width, height: 212 }, {
      name: `decision-option-${index + 1}`, fill: index === 0 ? context.colors.primaryLight : context.tokens.neutral.surface,
      line: { style: "solid", fill: index === 0 ? context.colors.primary : context.tokens.neutral.line, width: 1.2 }, borderRadius: "rounded-lg",
    });
    addText(slide, item.title, { left: left + 20, top: 338, width: width - 40, height: 52 }, {
      fontSize: 21, fontFamily: fontFor(item.title, context.tokens), bold: true, color: context.colors.primaryDark, alignment: "center",
    }, `decision-option-title-${index + 1}`);
    addText(slide, item.body, { left: left + 20, top: 406, width: width - 40, height: 92 }, {
      fontSize: 15, fontFamily: fontFor(item.body, context.tokens), color: context.tokens.neutral.muted, alignment: "center", verticalAlignment: "top",
    }, `decision-option-body-${index + 1}`);
  });
  const criterion = cleanText(first(data.criterion, data.criteria, "建议按科学价值、可验证性与资源成本共同决策。"));
  addTakeawayBand(slide, criterion, context, { top: 574, height: 70, fontSize: 17 });
}

async function renderNextReadingActions(slide, slideSpec, context, slideNumber) {
  await addContentChrome(slide, slideSpec, context, slideNumber);
  const actions = groupItems(slideSpec, ["actions", "items"], [
    { title: "补读关键方法", body: "输出：参数、假设与可复用步骤", owner: "负责人 A" },
    { title: "核对冲突证据", body: "输出：比较矩阵与差异解释", owner: "负责人 B" },
    { title: "形成验证方案", body: "输出：最小实验与判据", owner: "负责人 C" },
  ]).slice(0, 5);
  addShape(slide, "rect", { left: 56, top: 154, width: 1168, height: 44 }, {
    name: "reading-action-header", fill: context.colors.primary,
    line: { style: "solid", fill: context.colors.primary, width: 0 },
  });
  [["下一步", 76, 300], ["预期输出", 402, 520], ["负责人 / 时间", 950, 244]].forEach(([label, left, width], index) => addText(slide, label, {
    left, top: 158, width, height: 34,
  }, { fontSize: 14, fontFamily: context.tokens.fonts.zh, bold: true, color: context.tokens.neutral.white }, `reading-header-${index + 1}`));
  actions.forEach((item, index) => {
    const top = 212 + index * 76;
    const output = cleanText(first(item.body, item.output, "形成可复用记录"));
    const owner = cleanText(first(item.owner, item.assignee, item.date, "待确定"));
    addShape(slide, "rect", { left: 56, top, width: 1168, height: 64 }, {
      name: `reading-action-row-${index + 1}`, fill: index % 2 === 0 ? context.tokens.neutral.surface : context.tokens.neutral.canvas,
      line: { style: "solid", fill: context.tokens.neutral.line, width: 1 },
    });
    addText(slide, item.title, { left: 76, top: top + 8, width: 300, height: 48 }, {
      fontSize: 17, fontFamily: fontFor(item.title, context.tokens), bold: true, color: context.tokens.neutral.text,
    }, `reading-action-title-${index + 1}`);
    addText(slide, output, { left: 402, top: top + 8, width: 520, height: 48 }, {
      fontSize: 15, fontFamily: fontFor(output, context.tokens), color: context.tokens.neutral.muted,
    }, `reading-action-output-${index + 1}`);
    addText(slide, owner, { left: 950, top: top + 8, width: 244, height: 48 }, {
      fontSize: 15, fontFamily: fontFor(owner, context.tokens), bold: true, color: context.colors.primaryDark,
    }, `reading-action-owner-${index + 1}`);
  });
  addTakeawayBand(slide, slideTakeaway(slideSpec), context, { top: 612, height: 46, fontSize: 15 });
}

async function renderGroupClosing(slide, spec, slideSpec, context) {
  const data = renderData(slideSpec);
  slide.background.fill = context.tokens.neutral.canvas;
  addGroupCornerMotif(slide, 36, 28, context.colors.primary, false);
  addGroupCornerMotif(slide, 1128, 600, context.colors.primary, true);
  addShape(slide, "rect", { left: 0, top: 176, width: 1280, height: 302 }, {
    name: "group-closing-band", fill: context.colors.primary,
    line: { style: "solid", fill: context.colors.primary, width: 0 },
  });
  const title = slideTitle(slideSpec) || "讨论与下一步";
  addText(slide, title, { left: 110, top: 216, width: 1060, height: 74 }, {
    fontSize: 46, fontFamily: fontFor(title, context.tokens), bold: true, color: context.tokens.neutral.white, alignment: "center",
  }, "group-closing-title");
  const synthesis = cleanText(first(data.synthesis, slideTakeaway(slideSpec), "用一句话带走本次阅读最重要的判断。"));
  addText(slide, synthesis, { left: 160, top: 310, width: 960, height: 104 }, {
    fontSize: 24, fontFamily: fontFor(synthesis, context.tokens), color: "#F4F6FB", alignment: "center",
  }, "group-closing-synthesis");
  const prompts = list(first(data.prompts, slideSpec.content?.bullets, [])).map(cleanText).filter(Boolean).slice(0, 3);
  const values = prompts.length ? prompts : ["我们接受哪项结论？", "还缺哪项关键证据？", "下一步由谁完成什么？"];
  const width = 330;
  const totalWidth = values.length * width + (values.length - 1) * 24;
  values.forEach((prompt, index) => addPill(slide, prompt, {
    left: (1280 - totalWidth) / 2 + index * (width + 24), top: 540, width, height: 54,
  }, context.colors, context.tokens, { name: `group-closing-prompt-${index + 1}`, fill: context.colors.primaryLight, color: context.colors.primaryDark, fontSize: 15 }));
  const presenter = cleanText(first(data.presenter, spec.presenter, spec.author, ""));
  if (presenter) addText(slide, presenter, { left: 260, top: 636, width: 760, height: 30 }, {
    fontSize: 14, fontFamily: fontFor(presenter, context.tokens), color: context.tokens.neutral.muted, alignment: "center",
  }, "group-closing-presenter");
}

async function renderMilestoneCover(slide, spec, slideSpec, context, longTitle = false) {
  const data = renderData(slideSpec);
  const title = slideTitle(slideSpec) || cleanText(first(spec.title, "研究课题题目"));
  const subtitle = cleanText(first(data.subtitle, slideSpec.subtitle, spec.subtitle, ""));
  const mode = milestoneModeLabel(context);
  const presenter = cleanText(first(data.presenter, spec.presenter, spec.author, ""));
  const advisor = cleanText(first(data.advisor, spec.advisor, ""));
  const institution = cleanText(first(data.institution, context.brand.institution, "学术机构"));
  const department = cleanText(first(data.department, context.brand.department, ""));
  const date = cleanText(first(data.date, spec.date, spec.milestone?.as_of_date, ""));

  slide.background.fill = context.tokens.neutral.canvas;
  addText(slide, mode, { left: 62, top: 36, width: 180, height: 44 }, {
    fontSize: 18,
    fontFamily: context.tokens.fonts.zh,
    bold: true,
    color: context.colors.primary,
  }, "milestone-cover-mode");
  addRule(slide, 62, 91, 194, context.colors.primary, 4, "milestone-cover-mode-rule");
  addText(slide, institution, { left: 830, top: 32, width: 324, height: 48 }, {
    fontSize: 15,
    fontFamily: fontFor(institution, context.tokens),
    bold: true,
    color: context.colors.primary,
    alignment: "right",
  }, "milestone-cover-institution");
  await addLogo(slide, context.brand, { left: 1170, top: 24, width: 62, height: 62 }, context);

  addText(slide, title, { left: 70, top: longTitle ? 150 : 168, width: 1140, height: longTitle ? 172 : 132 }, {
    fontSize: longTitle ? 42 : 52,
    fontFamily: fontFor(title, context.tokens),
    bold: true,
    color: context.tokens.neutral.black,
    verticalAlignment: "bottom",
  }, "milestone-cover-title");
  addRule(slide, 70, longTitle ? 336 : 320, 1140, context.colors.primary, 3, "milestone-cover-title-rule");
  if (subtitle) addText(slide, subtitle, { left: 72, top: longTitle ? 350 : 336, width: 1080, height: 68 }, {
    fontSize: 20,
    fontFamily: fontFor(subtitle, context.tokens),
    bold: true,
    color: context.colors.primary,
  }, "milestone-cover-subtitle");

  addShape(slide, "rect", { left: 0, top: 474, width: 1280, height: 246 }, {
    name: "milestone-cover-footer-band",
    fill: context.colors.primary,
    line: { style: "solid", fill: context.colors.primary, width: 0 },
  });
  addText(slide, context.mode === "midterm" ? "以原计划为基线，报告阶段证据、偏差与下一步" : "从研究问题出发，说明方法、可行性、风险与计划", {
    left: 70, top: 506, width: 1140, height: 42,
  }, {
    fontSize: 18,
    fontFamily: context.tokens.fonts.zh,
    bold: true,
    color: "#EAF0F8",
  }, "milestone-cover-positioning");
  const meta = [
    ["汇报人", presenter || (context.allowPlaceholder ? "示范姓名" : "")],
    ["指导教师", advisor || (context.allowPlaceholder ? "示范导师" : "")],
    [department ? "单位" : "阶段", department || mode],
    ["日期", date || (context.allowPlaceholder ? "20XX 年 X 月" : "")],
  ].filter(([, value]) => value);
  const metaWidth = 1140 / Math.max(1, meta.length);
  meta.forEach(([label, value], index) => {
    const left = 70 + index * metaWidth;
    addText(slide, label, { left, top: 584, width: Math.min(86, metaWidth - 8), height: 26 }, {
      fontSize: 12, fontFamily: context.tokens.fonts.zh, color: "#BFCBE0",
    }, `milestone-cover-meta-label-${index + 1}`);
    addText(slide, value, { left, top: 616, width: Math.max(120, metaWidth - 24), height: 42 }, {
      fontSize: 17, fontFamily: fontFor(value, context.tokens), bold: true, color: context.tokens.neutral.white,
    }, `milestone-cover-meta-value-${index + 1}`);
  });
}

async function renderMilestoneAgenda(slide, spec, slideSpec, context, slideNumber) {
  const sections = list(first(renderData(slideSpec).sections, slideSpec.sections, slideSpec.content?.body, spec.sections, []));
  if (sections.length < 2) throw new Error(`Agenda slide ${slideSpec.id ?? slideNumber} needs at least two sections or should be omitted.`);
  if (sections.length > 10) throw new Error(`Agenda slide ${slideSpec.id ?? slideNumber} has ${sections.length} sections. Split it into two agenda slides; no item is truncated.`);
  slide.background.fill = context.tokens.neutral.canvas;
  addShape(slide, "rect", { left: 0, top: 0, width: 382, height: 720 }, {
    name: "milestone-agenda-panel",
    fill: context.colors.primary,
    line: { style: "solid", fill: context.colors.primary, width: 0 },
  });
  addRule(slide, 52, 94, 112, "#91A5C3", 3, "milestone-agenda-accent");
  addText(slide, "目录", { left: 52, top: 218, width: 270, height: 86 }, {
    fontSize: 54, fontFamily: context.tokens.fonts.zh, bold: true, color: context.tokens.neutral.white,
  }, "milestone-agenda-title");
  addText(slide, "CONTENTS", { left: 54, top: 304, width: 250, height: 42 }, {
    fontSize: 20, fontFamily: context.tokens.fonts.en, bold: true, color: "#D8E1EF",
  }, "milestone-agenda-subtitle");
  addText(slide, `${milestoneModeLabel(context)} · 章节随研究逻辑自适应`, { left: 54, top: 624, width: 272, height: 42 }, {
    fontSize: 13, fontFamily: context.tokens.fonts.zh, color: "#D8E1EF",
  }, "milestone-agenda-mode");

  const compact = sections.length > 6;
  const columns = compact ? 2 : 1;
  const perColumn = Math.ceil(sections.length / columns);
  const columnWidth = compact ? 388 : 764;
  const rowHeight = compact ? 74 : 80;
  const rowGap = compact ? 10 : 14;
  const totalHeight = perColumn * rowHeight + (perColumn - 1) * rowGap;
  const top = 112 + (500 - totalHeight) / 2;
  sections.forEach((section, index) => {
    const column = compact ? Math.floor(index / perColumn) : 0;
    const row = compact ? index % perColumn : index;
    const left = 438 + column * 400;
    const itemTop = top + row * (rowHeight + rowGap);
    const number = cleanText(first(section.number, section.index, String(index + 1).padStart(2, "0")));
    const title = cleanText(first(section.short_title, section.title, section.name, section));
    addText(slide, number, { left, top: itemTop, width: 72, height: rowHeight }, {
      fontSize: compact ? 24 : 29, fontFamily: context.tokens.fonts.en, bold: true, color: context.colors.primary,
    }, `milestone-agenda-number-${index + 1}`);
    addText(slide, title, { left: left + 82, top: itemTop, width: columnWidth - 100, height: rowHeight }, {
      fontSize: compact ? 18 : 23, fontFamily: fontFor(title, context.tokens), bold: true, color: context.tokens.neutral.text,
    }, `milestone-agenda-item-${index + 1}`);
    addRule(slide, left, itemTop + rowHeight - 2, columnWidth - 26, context.tokens.neutral.line, 1, `milestone-agenda-rule-${index + 1}`);
  });
  addText(slide, String(slideNumber), { left: 1200, top: 680, width: 40, height: 20 }, {
    fontSize: 11, fontFamily: context.tokens.fonts.en, color: context.tokens.neutral.subtle, alignment: "right",
  }, "milestone-agenda-page-number");
}

async function renderMilestoneSectionDivider(slide, spec, slideSpec, context) {
  const data = renderData(slideSpec);
  const number = cleanText(first(data.section_number, data.sectionNumber, slideSpec.section_number, slideSpec.sectionNumber, slideSpec.number, "01")).replace(/^PART\s*/i, "");
  const title = cleanText(first(data.section_title, data.sectionTitle, slideSpec.section_title, slideSpec.sectionTitle, slideSpec.title, "章节标题"));
  const subtitle = cleanText(first(data.subtitle, slideSpec.section_subtitle, slideSpec.sectionSubtitle, slideSpec.subtitle, ""));
  const bridge = cleanText(first(data.bridge, slideSpec.bridge, slideSpec.takeaway, ""));
  slide.background.fill = context.tokens.neutral.canvas;
  addText(slide, milestoneModeLabel(context), { left: 62, top: 42, width: 190, height: 40 }, {
    fontSize: 16, fontFamily: context.tokens.fonts.zh, bold: true, color: context.colors.primary,
  }, "milestone-divider-mode");
  addText(slide, context.brand.institution, { left: 882, top: 40, width: 280, height: 42 }, {
    fontSize: 14, fontFamily: fontFor(context.brand.institution, context.tokens), bold: true, color: context.colors.primary, alignment: "right",
  }, "milestone-divider-institution");
  await addLogo(slide, context.brand, { left: 1178, top: 30, width: 58, height: 58 }, context);
  addRule(slide, 62, 106, 1174, context.colors.primary, 2, "milestone-divider-top-rule");
  addText(slide, String(number).padStart(2, "0"), { left: 72, top: 190, width: 250, height: 150 }, {
    fontSize: 92, fontFamily: context.tokens.fonts.en, bold: true, color: context.colors.primary,
  }, "milestone-divider-number");
  addVerticalRule(slide, 350, 202, 248, context.colors.primaryLight, 5, "milestone-divider-vertical-rule");
  addText(slide, title, { left: 402, top: 204, width: 770, height: 92 }, {
    fontSize: 48, fontFamily: fontFor(title, context.tokens), bold: true, color: context.tokens.neutral.text,
  }, "milestone-divider-title");
  if (subtitle) addText(slide, subtitle, { left: 404, top: 304, width: 760, height: 44 }, {
    fontSize: 18, fontFamily: fontFor(subtitle, context.tokens), color: context.colors.primary,
  }, "milestone-divider-subtitle");
  if (bridge) addText(slide, bridge, { left: 404, top: 382, width: 744, height: 92 }, {
    fontSize: 20, fontFamily: fontFor(bridge, context.tokens), color: context.tokens.neutral.muted,
  }, "milestone-divider-bridge");
  addShape(slide, "rect", { left: 0, top: 650, width: 1280, height: 70 }, {
    name: "milestone-divider-footer-band", fill: context.colors.primary,
    line: { style: "solid", fill: context.colors.primary, width: 0 },
  });
}

async function renderMilestoneClosing(slide, spec, slideSpec, context) {
  const data = renderData(slideSpec);
  const title = slideTitle(slideSpec) || "敬请批评指正";
  const takeaway = cleanText(first(slideTakeaway(slideSpec), data.synthesis, "感谢各位专家的审阅与建议。"));
  slide.background.fill = context.tokens.neutral.canvas;
  addText(slide, context.brand.institution, { left: 64, top: 42, width: 430, height: 42 }, {
    fontSize: 15, fontFamily: fontFor(context.brand.institution, context.tokens), bold: true, color: context.colors.primary,
  }, "milestone-closing-institution");
  addRule(slide, 64, 104, 1152, context.colors.primary, 2, "milestone-closing-top-rule");
  addShape(slide, "rect", { left: 0, top: 184, width: 1280, height: 390 }, {
    name: "milestone-closing-band", fill: context.colors.primary,
    line: { style: "solid", fill: context.colors.primary, width: 0 },
  });
  await addLogo(slide, context.brand, { left: 594, top: 136, width: 92, height: 92 }, context);
  addText(slide, title, { left: 118, top: 282, width: 1044, height: 96 }, {
    fontSize: 52, fontFamily: fontFor(title, context.tokens), bold: true, color: context.tokens.neutral.white, alignment: "center",
  }, "milestone-closing-title");
  addRule(slide, 242, 404, 796, "#8EA2C1", 2, "milestone-closing-title-rule");
  addText(slide, takeaway, { left: 176, top: 428, width: 928, height: 74 }, {
    fontSize: 19, fontFamily: fontFor(takeaway, context.tokens), color: "#E5EBF5", alignment: "center",
  }, "milestone-closing-takeaway");
  const presenter = cleanText(first(data.presenter, spec.presenter, spec.author, ""));
  const date = cleanText(first(data.date, spec.date, spec.milestone?.as_of_date, ""));
  addText(slide, [milestoneModeLabel(context), presenter, date].filter(Boolean).join("  ·  "), { left: 180, top: 628, width: 920, height: 34 }, {
    fontSize: 15, fontFamily: fontFor(presenter, context.tokens), color: context.tokens.neutral.muted, alignment: "center",
  }, "milestone-closing-meta");
}

async function renderMilestoneEvaluationFocus(slide, slideSpec, context, slideNumber) {
  await addContentChrome(slide, slideSpec, context, slideNumber);
  const data = renderData(slideSpec);
  const question = cleanText(first(data.question, data.decision, slideTakeaway(slideSpec), "本次评审最需要判断什么？"));
  const rawCriteria = list(first(data.criteria, data.focus_items, data.focusItems, data.checks, data.items, []));
  const criteria = (rawCriteria.length ? rawCriteria : semanticItems(slideSpec, ["criteria", "items"], 3)).map((entry, index) => {
    if (!isObject(entry)) return { title: cleanText(entry), body: "" };
    const verdict = cleanText(first(entry.verdict, ""));
    const evidence = cleanText(first(entry.evidence, ""));
    return {
      ...entry,
      title: cleanText(first(entry.title, entry.label, `判断 ${index + 1}`)),
      body: cleanText(first(entry.body, entry.detail, [verdict, evidence && `依据：${evidence}`].filter(Boolean).join("｜"), "")),
    };
  }).slice(0, 4);
  addShape(slide, "roundRect", { left: 56, top: 184, width: 520, height: 390 }, {
    name: "milestone-focus-question-panel", fill: context.colors.primary,
    line: { style: "solid", fill: context.colors.primary, width: 0 }, borderRadius: "rounded-lg",
  });
  addText(slide, context.mode === "midterm" ? "本次中期汇报的核心判断" : "本次开题评审的核心判断", { left: 88, top: 214, width: 456, height: 42 }, {
    fontSize: 16, fontFamily: context.tokens.fonts.zh, bold: true, color: "#D7E1EF",
  }, "milestone-focus-label");
  addText(slide, question, { left: 88, top: 286, width: 456, height: 214 }, {
    fontSize: 31, fontFamily: fontFor(question, context.tokens), bold: true, color: context.tokens.neutral.white, verticalAlignment: "top",
  }, "milestone-focus-question");
  criteria.forEach((item, index) => {
    const top = 184 + index * 98;
    addText(slide, String(index + 1).padStart(2, "0"), { left: 630, top, width: 54, height: 70 }, {
      fontSize: 16, fontFamily: context.tokens.fonts.en, bold: true, color: context.colors.primary, alignment: "center",
    }, `milestone-focus-index-${index + 1}`);
    addText(slide, item.title, { left: 708, top, width: 460, height: 34 }, {
      fontSize: 20, fontFamily: fontFor(item.title, context.tokens), bold: true, color: context.tokens.neutral.text,
    }, `milestone-focus-title-${index + 1}`);
    addText(slide, item.body, { left: 708, top: top + 38, width: 460, height: 46 }, {
      fontSize: 15, fontFamily: fontFor(item.body, context.tokens), color: context.tokens.neutral.muted,
    }, `milestone-focus-body-${index + 1}`);
    if (index < criteria.length - 1) addRule(slide, 708, top + 88, 460, context.tokens.neutral.line, 1, `milestone-focus-rule-${index + 1}`);
  });
  const request = cleanText(first(data.request, data.verdict, slideSpec.content?.callout, "请围绕证据充分性、方案可行性与风险边界提出建议。"));
  addTakeawayBand(slide, request, context, { top: 610, height: 50, fontSize: 16 });
}

async function renderMilestoneLiteratureLandscape(slide, slideSpec, context, slideNumber) {
  const data = renderData(slideSpec);
  const streams = list(first(data.streams, data.items, [])).map((entry, index) => isObject(entry) ? entry : { title: cleanText(entry) }).slice(0, 6);
  const rows = (streams.length ? streams : [
    { title: "理论解释", consensus: "建立关键关系", limit: "操作化不足" },
    { title: "数据驱动", consensus: "预测表现提升", limit: "外部适用性不清" },
    { title: "机制验证", consensus: "提供因果线索", limit: "样本与情境有限" },
  ]).map((entry) => [
    cleanText(first(entry.title, entry.route, "研究路线")),
    cleanText(first(entry.consensus, entry.finding, entry.evidence, "主要共识")),
    cleanText(first(entry.limit, entry.boundary, entry.gap, "主要边界")),
  ]);
  const temporary = {
    ...slideSpec,
    render_data: { ...data, table: { headers: ["研究路线 / 流派", "形成的共识或证据", "仍未解决的边界"], rows } },
  };
  await renderTableInsight(slide, temporary, context, slideNumber, false);
}

async function renderMilestoneQuestionHypothesis(slide, slideSpec, context, slideNumber) {
  await addContentChrome(slide, slideSpec, context, slideNumber);
  const data = renderData(slideSpec);
  const question = cleanText(first(data.question, "需要回答的研究问题"));
  const hypothesis = cleanText(first(data.hypothesis, slideTakeaway(slideSpec), "可被证据支持或否定的核心假设"));
  const predictions = list(first(data.predictions, data.criteria, [])).map(cleanText).filter(Boolean).slice(0, 4);
  const criterion = cleanText(first(data.criterion, data.boundary, "关键预测失败时，应修正或否定假设。"));
  addShape(slide, "roundRect", { left: 56, top: 180, width: 1168, height: 76 }, {
    name: "hypothesis-question-band", fill: context.tokens.neutral.surface,
    line: { style: "solid", fill: context.tokens.neutral.line, width: 1 }, borderRadius: "rounded-lg",
  });
  addText(slide, `研究问题｜${question}`, { left: 82, top: 190, width: 1116, height: 56 }, {
    fontSize: 20, fontFamily: fontFor(question, context.tokens), bold: true, color: context.tokens.neutral.text,
  }, "hypothesis-question");
  addShape(slide, "roundRect", { left: 56, top: 286, width: 492, height: 258 }, {
    name: "hypothesis-core-panel", fill: context.colors.primary,
    line: { style: "solid", fill: context.colors.primary, width: 0 }, borderRadius: "rounded-lg",
  });
  addText(slide, "核心假设", { left: 84, top: 310, width: 180, height: 34 }, {
    fontSize: 15, fontFamily: context.tokens.fonts.zh, bold: true, color: "#D8E2F0",
  }, "hypothesis-core-label");
  addText(slide, hypothesis, { left: 84, top: 358, width: 436, height: 146 }, {
    fontSize: 27, fontFamily: fontFor(hypothesis, context.tokens), bold: true, color: context.tokens.neutral.white, verticalAlignment: "top",
  }, "hypothesis-core-text");
  const values = predictions.length ? predictions : ["预测一：关键变量按预期方向变化", "预测二：干预后结果同步变化", "预测三：独立数据中方向一致"];
  values.forEach((prediction, index) => {
    const top = 292 + index * 70;
    addShape(slide, "ellipse", { left: 606, top: top + 10, width: 42, height: 42 }, {
      name: `hypothesis-prediction-dot-${index + 1}`, fill: index === 0 ? context.colors.primary : context.colors.primaryLight,
      line: { style: "solid", fill: context.colors.primary, width: 1 },
    });
    addText(slide, String(index + 1), { left: 606, top: top + 10, width: 42, height: 42 }, {
      fontSize: 13, fontFamily: context.tokens.fonts.en, bold: true, color: index === 0 ? context.tokens.neutral.white : context.colors.primary, alignment: "center",
    }, `hypothesis-prediction-index-${index + 1}`);
    addText(slide, prediction, { left: 674, top, width: 514, height: 62 }, {
      fontSize: 17, fontFamily: fontFor(prediction, context.tokens), color: context.tokens.neutral.text,
    }, `hypothesis-prediction-${index + 1}`);
    if (index < values.length - 1) addRule(slide, 674, top + 64, 514, context.tokens.neutral.line, 1, `hypothesis-prediction-rule-${index + 1}`);
  });
  addTakeawayBand(slide, criterion, context, { top: 606, height: 52, fontSize: 16, fill: "#FFF7E9", line: context.colors.warning, color: context.colors.warning });
}

async function renderMilestoneScopeBoundaries(slide, slideSpec, context, slideNumber) {
  await addContentChrome(slide, slideSpec, context, slideNumber);
  const data = renderData(slideSpec);
  const included = list(first(data.included, data.in_scope, [])).map(cleanText).filter(Boolean).slice(0, 6);
  const excluded = list(first(data.excluded, data.out_of_scope, [])).map(cleanText).filter(Boolean).slice(0, 6);
  const columns = [
    { label: "纳入研究范围", items: included.length ? included : ["明确研究对象", "明确场景与工况", "明确可观测时间窗"], fill: context.colors.primaryLight, line: context.colors.primary },
    { label: "暂不纳入 / 外推边界", items: excluded.length ? excluded : ["缺少必要数据的对象", "与核心问题无关的特殊情境", "未经独立验证的外部场景"], fill: "#FFF7E9", line: context.colors.warning },
  ];
  columns.forEach((column, index) => {
    const left = 56 + index * 596;
    addShape(slide, "roundRect", { left, top: 184, width: 568, height: 358 }, {
      name: `scope-column-${index + 1}`, fill: column.fill,
      line: { style: "solid", fill: column.line, width: 1.2 }, borderRadius: "rounded-lg",
    });
    addText(slide, column.label, { left: left + 26, top: 208, width: 516, height: 42 }, {
      fontSize: 21, fontFamily: context.tokens.fonts.zh, bold: true, color: column.line,
    }, `scope-column-label-${index + 1}`);
    addBulletList(slide, column.items, { left: left + 28, top: 270, width: 508, height: 232 }, {
      fontSize: 18, color: context.tokens.neutral.text, lineSpacing: 1.28,
    }, context.tokens, `scope-column-items-${index + 1}`);
  });
  addTakeawayBand(slide, cleanText(first(data.implication, slideTakeaway(slideSpec))), context, { top: 594, height: 64, fontSize: 17 });
}

async function renderMilestoneStudyDesign(slide, slideSpec, context, slideNumber) {
  const data = renderData(slideSpec);
  const design = list(first(data.design, data.items, [])).map((entry, index) => {
    if (!isObject(entry)) return { title: cleanText(entry), body: "" };
    return { number: String(index + 1).padStart(2, "0"), title: cleanText(first(entry.title, `设计 ${index + 1}`)), body: cleanText(first(entry.body, entry.detail, "")) };
  });
  await renderSelectionRationale(slide, { ...slideSpec, render_data: { ...data, items: design } }, context, slideNumber);
}

async function renderMilestoneValidation(slide, slideSpec, context, slideNumber) {
  const data = renderData(slideSpec);
  const validations = list(first(data.validations, data.checks, data.items, [])).map((entry, index) => {
    if (!isObject(entry)) return { title: cleanText(entry), body: "", status: "待核" };
    const body = [cleanText(entry.method), cleanText(entry.criterion), cleanText(entry.evidence)].filter(Boolean).join("｜");
    const statusMap = { complete: "已完成", completed: "已完成", inProgress: "进行中", in_progress: "进行中", atRisk: "有风险", at_risk: "有风险", notStarted: "未开始", not_started: "未开始" };
    return { number: String(index + 1).padStart(2, "0"), title: cleanText(first(entry.target, entry.title, `验证 ${index + 1}`)), body, status: statusMap[entry.status] ?? cleanText(first(entry.status, "待核")) };
  });
  await renderReproducibilityCheck(slide, { ...slideSpec, render_data: { ...data, checks: validations } }, context, slideNumber);
}

async function renderMilestoneFeasibility(slide, slideSpec, context, slideNumber) {
  const data = renderData(slideSpec);
  const dimensions = list(first(data.dimensions, data.criteria, data.items, [])).map((entry, index) => {
    if (!isObject(entry)) return { title: cleanText(entry), body: "" };
    return {
      number: String(index + 1).padStart(2, "0"),
      title: cleanText(first(entry.title, `可行性 ${index + 1}`)),
      body: [cleanText(entry.evidence), cleanText(entry.boundary) && `边界：${cleanText(entry.boundary)}`].filter(Boolean).join("\n"),
    };
  });
  await renderSelectionRationale(slide, { ...slideSpec, render_data: { ...data, items: dimensions } }, context, slideNumber);
}

async function renderMilestoneWorkPackages(slide, slideSpec, context, slideNumber) {
  await addContentChrome(slide, slideSpec, context, slideNumber);
  const data = renderData(slideSpec);
  const objective = cleanText(first(data.objective, data.goal, slideTakeaway(slideSpec), "总目标由相互衔接的工作包共同实现。"));
  const items = semanticItems(slideSpec, ["work_packages", "workPackages", "workpackages", "items"], 4).map((item) => ({
    ...item,
    body: cleanText(first(item.body, item.question && item.output ? `${item.question}\n交付：${item.output}` : item.question, item.output, "")),
  })).slice(0, 5);
  addShape(slide, "roundRect", { left: 56, top: 176, width: 1168, height: 74 }, {
    name: "milestone-objective-band", fill: context.colors.primary,
    line: { style: "solid", fill: context.colors.primary, width: 0 }, borderRadius: "rounded-lg",
  });
  addText(slide, `总目标｜${objective}`, { left: 84, top: 184, width: 1112, height: 58 }, {
    fontSize: 21, fontFamily: fontFor(objective, context.tokens), bold: true, color: context.tokens.neutral.white,
  }, "milestone-objective-text");
  const gap = 16;
  const width = (1168 - gap * Math.max(0, items.length - 1)) / Math.max(1, items.length);
  items.forEach((item, index) => {
    const left = 56 + index * (width + gap);
    addShape(slide, "roundRect", { left, top: 282, width, height: 266 }, {
      name: `milestone-work-package-${index + 1}`,
      fill: index === 0 ? context.colors.primaryLight : context.tokens.neutral.surface,
      line: { style: "solid", fill: index === 0 ? context.colors.primary : context.tokens.neutral.line, width: 1.2 }, borderRadius: "rounded-lg",
    });
    addText(slide, cleanText(first(item.number, String(index + 1).padStart(2, "0"))), { left: left + 18, top: 300, width: 52, height: 34 }, {
      fontSize: 15, fontFamily: context.tokens.fonts.en, bold: true, color: context.colors.primary,
    }, `milestone-work-package-number-${index + 1}`);
    addText(slide, item.title, { left: left + 18, top: 348, width: width - 36, height: 68 }, {
      fontSize: items.length >= 5 ? 18 : 21, fontFamily: fontFor(item.title, context.tokens), bold: true, color: context.tokens.neutral.text, verticalAlignment: "top",
    }, `milestone-work-package-title-${index + 1}`);
    addText(slide, item.body, { left: left + 18, top: 430, width: width - 36, height: 92 }, {
      fontSize: items.length >= 5 ? 14 : 16, fontFamily: fontFor(item.body, context.tokens), color: context.tokens.neutral.muted, verticalAlignment: "top",
    }, `milestone-work-package-body-${index + 1}`);
  });
  const output = cleanText(first(data.output, data.deliverable, slideSpec.content?.callout, "每个工作包都应有可核验的输出与验证方式。"));
  addTakeawayBand(slide, output, context, { top: 592, height: 66, fontSize: 17 });
}

async function renderMilestoneRisk(slide, slideSpec, context, slideNumber) {
  await addContentChrome(slide, slideSpec, context, slideNumber);
  const data = renderData(slideSpec);
  const risks = list(first(data.risks, data.items, [])).map((entry, index) => {
    if (!isObject(entry)) return { risk: cleanText(entry), trigger: "触发条件", response: "应对方案", owner: "责任人" };
    return {
      risk: cleanText(first(entry.risk, entry.title, entry.label, `风险 ${index + 1}`)),
      trigger: cleanText(first(entry.trigger, entry.condition, entry.evidence, "触发条件")),
      response: cleanText(first(entry.response, entry.mitigation, entry.action, entry.body, "应对方案")),
      owner: cleanText(first(entry.owner, entry.status, entry.contingency, "责任 / 状态")),
    };
  }).slice(0, 5);
  const values = risks.length ? risks : [
    { risk: "数据或样本不足", trigger: "关键分层低于最低数量", response: "补充来源并预设替代分析", owner: "数据负责人" },
    { risk: "方法不收敛", trigger: "主要指标未达到验证阈值", response: "切换备选方法并保留失败记录", owner: "方法负责人" },
    { risk: "时间或资源受限", trigger: "里程碑连续两期延迟", response: "压缩非核心范围并调整依赖", owner: "课题负责人" },
  ];
  const tableValues = [["风险 / 合规问题", "触发或判断依据", "预案 / 纠偏措施", "责任与状态"], ...values.map((item) => [item.risk, item.trigger, item.response, item.owner])];
  const table = slide.tables.add({
    rows: values.length + 1,
    columns: 4,
    left: 56,
    top: 182,
    width: 1168,
    height: Math.min(382, 62 + values.length * 62),
    values: tableValues,
  });
  table.styleOptions = { headerRow: true, bandedRows: true, firstColumn: true };
  table.borders.assign({ style: "solid", fill: context.tokens.neutral.line, width: 1 });
  for (let row = 0; row <= values.length; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      const cell = table.getCell(row, column);
      cell.fill = row === 0 ? context.colors.primary : row % 2 === 0 ? context.tokens.neutral.surface : context.tokens.neutral.canvas;
      cell.text.style = {
        fontSize: pptFontSize(row === 0 ? 14 : 15), typeface: context.tokens.fonts.zh,
        bold: row === 0 || column === 0, color: row === 0 ? context.tokens.neutral.white : context.tokens.neutral.text,
        alignment: column === 3 ? "center" : "left", verticalAlignment: "middle",
      };
      registerTextTarget(slide, cell.text, tableValues[row][column], `milestone-risk-cell-${row}-${column}`, row === 0 ? context.tokens.neutral.white : context.tokens.neutral.text);
    }
  }
  addTakeawayBand(slide, slideTakeaway(slideSpec), context, { top: 602, height: 56, fontSize: 16 });
}

function normalizeScheduleTasks(slideSpec) {
  const data = renderData(slideSpec);
  const periods = list(first(data.periods, data.timeline?.periods, ["阶段 1", "阶段 2", "阶段 3", "阶段 4", "阶段 5", "阶段 6"])).map(cleanText).filter(Boolean).slice(0, 10);
  const tasks = list(first(data.tasks, data.work_packages, data.workPackages, data.timeline?.tasks, [])).map((entry, index) => {
    if (!isObject(entry)) return { title: cleanText(entry), start: index, end: index + 1, status: "planned", deliverable: "" };
    return {
      title: cleanText(first(entry.title, entry.label, entry.task, `任务 ${index + 1}`)),
      start: Number(first(entry.start, entry.start_index, entry.from, index)),
      end: Number(first(entry.end, entry.end_index, entry.to, index + 1)),
      status: cleanText(first(entry.status, "planned")),
      deliverable: cleanText(first(entry.deliverable, entry.output, entry.milestone, "")),
    };
  }).slice(0, 7);
  return {
    periods: periods.length ? periods : ["阶段 1", "阶段 2", "阶段 3", "阶段 4"],
    tasks: tasks.length ? tasks : [
      { title: "完成关键数据或材料准备", start: 0, end: 2, status: "planned", deliverable: "数据基线" },
      { title: "实施核心分析 / 实验", start: 1, end: 4, status: "in_progress", deliverable: "阶段结果" },
      { title: "验证、整合与论文输出", start: 3, end: 6, status: "planned", deliverable: "论文 / 系统 / 报告" },
    ],
  };
}

async function renderMilestoneGantt(slide, slideSpec, context, slideNumber, updated = false) {
  await addContentChrome(slide, slideSpec, context, slideNumber);
  const { periods, tasks } = normalizeScheduleTasks(slideSpec);
  const left = 320;
  const top = 212;
  const width = 860;
  const headerHeight = 46;
  const rowHeight = Math.min(58, 330 / Math.max(1, tasks.length));
  const periodWidth = width / periods.length;
  periods.forEach((period, index) => {
    const x = left + index * periodWidth;
    addShape(slide, "rect", { left: x, top, width: periodWidth, height: headerHeight }, {
      name: `milestone-gantt-period-${index + 1}`, fill: index % 2 === 0 ? context.colors.primary : context.colors.primaryDark,
      line: { style: "solid", fill: context.tokens.neutral.white, width: 1 },
    });
    addText(slide, period, { left: x + 2, top, width: periodWidth - 4, height: headerHeight }, {
      fontSize: periods.length > 7 ? 11 : 13, fontFamily: fontFor(period, context.tokens), bold: true, color: context.tokens.neutral.white, alignment: "center",
    }, `milestone-gantt-period-label-${index + 1}`);
  });
  tasks.forEach((task, index) => {
    const y = top + headerHeight + index * rowHeight;
    addText(slide, task.title, { left: 58, top: y, width: 238, height: rowHeight }, {
      fontSize: 15, fontFamily: fontFor(task.title, context.tokens), bold: true, color: context.tokens.neutral.text, alignment: "right",
    }, `milestone-gantt-task-${index + 1}`);
    for (let p = 0; p < periods.length; p += 1) {
      addShape(slide, "rect", { left: left + p * periodWidth, top: y, width: periodWidth, height: rowHeight }, {
        name: `milestone-gantt-grid-${index + 1}-${p + 1}`, fill: index % 2 === 0 ? context.tokens.neutral.surface : context.tokens.neutral.canvas,
        line: { style: "solid", fill: context.tokens.neutral.line, width: 0.6 },
      });
    }
    const start = clamp(task.start, 0, periods.length - 1);
    const end = clamp(Math.max(task.end, start + 1), start + 1, periods.length);
    const statusColor = /complete|完成/.test(task.status) ? context.colors.success
      : /delay|block|risk|延期|阻塞|风险/i.test(task.status) ? context.colors.warning
        : updated ? context.colors.secondary : context.colors.primary;
    const barPosition = { left: left + start * periodWidth + 8, top: y + 14, width: (end - start) * periodWidth - 16, height: Math.max(16, rowHeight - 28) };
    addShape(slide, "roundRect", barPosition, {
      name: `milestone-gantt-bar-${index + 1}`, fill: statusColor,
      line: { style: "solid", fill: statusColor, width: 0 }, borderRadius: "rounded-full",
    });
    if (task.deliverable) addText(slide, task.deliverable, { left: barPosition.left + 8, top: barPosition.top, width: Math.max(24, barPosition.width - 16), height: barPosition.height }, {
      fontSize: barPosition.width < 150 ? 9 : 10, fontFamily: fontFor(task.deliverable, context.tokens), bold: true, color: context.tokens.neutral.white, alignment: "center",
    }, `milestone-gantt-deliverable-${index + 1}`);
  });
  const decision = cleanText(first(renderData(slideSpec).decision, ""));
  const footer = updated && decision ? `待决策｜${decision}` : slideTakeaway(slideSpec);
  addTakeawayBand(slide, footer, context, { top: updated && decision ? 590 : 610, height: updated && decision ? 68 : 50, fontSize: updated && decision ? 14 : 16 });
}

async function renderProgressSnapshot(slide, slideSpec, context, slideNumber) {
  await addContentChrome(slide, slideSpec, context, slideNumber);
  const data = renderData(slideSpec);
  const items = semanticItems(slideSpec, ["work_packages", "workPackages", "workpackages", "milestones", "items"], 4).map((item) => ({
    ...item,
    body: cleanText(first(item.body, item.evidence, item.output, "")),
  })).slice(0, 6);
  const statusColors = {
    completed: context.colors.success, "已完成": context.colors.success,
    complete: context.colors.success,
    in_progress: context.colors.primary, "进行中": context.colors.primary,
    inProgress: context.colors.primary,
    delayed: context.colors.warning, "延期": context.colors.warning,
    atRisk: context.colors.warning, at_risk: context.colors.warning, "有风险": context.colors.warning,
    blocked: context.colors.danger, "阻塞": context.colors.danger,
    planned: context.tokens.neutral.subtle, "未开始": context.tokens.neutral.subtle,
    notStarted: context.tokens.neutral.subtle, not_started: context.tokens.neutral.subtle,
  };
  const statusLabels = {
    completed: "已完成", complete: "已完成",
    in_progress: "进行中", inProgress: "进行中",
    delayed: "延期", atRisk: "有风险", at_risk: "有风险",
    blocked: "阻塞", planned: "未开始", notStarted: "未开始", not_started: "未开始",
  };
  const asOf = cleanText(first(data.as_of_date, data.asOfDate, context.spec?.milestone?.as_of_date, "阶段截止日期"));
  addText(slide, `截至 ${asOf}`, { left: 56, top: 170, width: 320, height: 42 }, {
    fontSize: 18, fontFamily: fontFor(asOf, context.tokens), bold: true, color: context.colors.primary,
  }, "progress-as-of-date");
  items.forEach((item, index) => {
    const top = 226 + index * 62;
    const status = cleanText(first(item.status, item.value, "进行中"));
    const displayStatus = statusLabels[status] ?? status;
    const color = statusColors[status] ?? context.colors.primary;
    addShape(slide, "ellipse", { left: 62, top: top + 16, width: 20, height: 20 }, {
      name: `progress-status-dot-${index + 1}`, fill: color, line: { style: "solid", fill: color, width: 0 },
    });
    addText(slide, item.title, { left: 102, top, width: 300, height: 52 }, {
      fontSize: 18, fontFamily: fontFor(item.title, context.tokens), bold: true, color: context.tokens.neutral.text,
    }, `progress-title-${index + 1}`);
    addText(slide, item.body, { left: 420, top, width: 560, height: 52 }, {
      fontSize: 15, fontFamily: fontFor(item.body, context.tokens), color: context.tokens.neutral.muted,
    }, `progress-body-${index + 1}`);
    addPill(slide, displayStatus, { left: 1036, top: top + 7, width: 146, height: 38 }, context.colors, context.tokens, {
      name: `progress-status-${index + 1}`, fill: mixHex(color, "#FFFFFF", 0.86), line: color, color, fontSize: 13,
    });
    if (index < items.length - 1) addRule(slide, 102, top + 58, 1080, context.tokens.neutral.line, 1, `progress-rule-${index + 1}`);
  });
  addTakeawayBand(slide, slideTakeaway(slideSpec), context, { top: 610, height: 50, fontSize: 16 });
}

async function renderPlanVsActual(slide, slideSpec, context, slideNumber) {
  await addContentChrome(slide, slideSpec, context, slideNumber);
  const data = renderData(slideSpec);
  const rows = list(first(data.rows, data.items, [])).map((entry, index) => {
    if (!isObject(entry)) return [cleanText(entry), "原计划", "当前实际", "偏差 / 判断"];
    return [
      cleanText(first(entry.title, entry.task, entry.label, `任务 ${index + 1}`)),
      cleanText(first(entry.plan, entry.planned, entry.baseline, "原计划")),
      cleanText(first(entry.actual, entry.progress, entry.current, "当前实际")),
      cleanText(first(entry.delta, entry.deviation, entry.variance && entry.impact ? `${entry.variance}｜${entry.impact}` : entry.variance, entry.status, "一致 / 需调整")),
    ];
  }).slice(0, 6);
  const values = rows.length ? rows : [
    ["工作包 A", "完成数据准备", "已完成并通过质控", "按计划"],
    ["工作包 B", "完成核心分析", "已完成主分析，验证中", "轻微延后"],
    ["工作包 C", "启动外部验证", "等待关键样本", "需调整依赖"],
  ];
  const tableValues = [["任务 / 里程碑", "原批准计划", "截至当前的实际", "偏差与判断"], ...values];
  const table = slide.tables.add({ rows: values.length + 1, columns: 4, left: 56, top: 184, width: 1168, height: Math.min(390, 60 + values.length * 62), values: tableValues });
  table.styleOptions = { headerRow: true, bandedRows: true, firstColumn: true };
  table.borders.assign({ style: "solid", fill: context.tokens.neutral.line, width: 1 });
  for (let row = 0; row <= values.length; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      const cell = table.getCell(row, column);
      cell.fill = row === 0 ? context.colors.primary : row % 2 === 0 ? context.tokens.neutral.surface : context.tokens.neutral.canvas;
      cell.text.style = { fontSize: pptFontSize(row === 0 ? 14 : 15), typeface: context.tokens.fonts.zh, bold: row === 0 || column === 0, color: row === 0 ? context.tokens.neutral.white : context.tokens.neutral.text, verticalAlignment: "middle" };
      registerTextTarget(slide, cell.text, tableValues[row][column], `plan-actual-cell-${row}-${column}`, row === 0 ? context.tokens.neutral.white : context.tokens.neutral.text);
    }
  }
  addTakeawayBand(slide, slideTakeaway(slideSpec), context, { top: 610, height: 50, fontSize: 16 });
}

async function renderDeviationCauseAction(slide, slideSpec, context, slideNumber) {
  await addContentChrome(slide, slideSpec, context, slideNumber);
  const data = renderData(slideSpec);
  const rawItems = list(first(data.items, data.deviations, []));
  const singleton = !rawItems.length && (data.baseline || data.actual || data.cause || data.actions)
    ? [{
      deviation: [cleanText(data.baseline) && `原计划：${cleanText(data.baseline)}`, cleanText(data.actual) && `实际：${cleanText(data.actual)}`].filter(Boolean).join("；"),
      cause: cleanText(first(data.cause, "原因待核")),
      action: list(first(data.actions, data.action, [])).map(cleanText).filter(Boolean).join("；"),
    }]
    : [];
  const items = [...rawItems, ...singleton].map((entry) => isObject(entry) ? entry : { deviation: cleanText(entry) }).slice(0, 4);
  const values = items.length ? items : [
    { deviation: "关键样本到位晚于原计划", cause: "外部协作审批时间增加", action: "并行完成替代数据分析，调整验证顺序", evidence: "以项目记录和更新里程碑为准" },
    { deviation: "方法参数需要重新标定", cause: "初始假设与实际数据分布不一致", action: "保留失败记录，按预设备选方案复核", evidence: "以复现实验和质量控制结果为准" },
  ];
  values.forEach((item, index) => {
    const top = 182 + index * 104;
    const cells = [
      ["偏差事实", cleanText(first(item.deviation, item.fact, item.title, "偏差事实"))],
      ["原因解释", cleanText(first(item.cause, item.reason, "原因解释"))],
      ["纠偏行动", cleanText(first(item.action, item.response, item.next_action, "纠偏行动"))],
    ];
    cells.forEach(([label, value], column) => {
      const left = 56 + column * 390;
      addShape(slide, "roundRect", { left, top, width: 358, height: 86 }, {
        name: `deviation-cell-${index + 1}-${column + 1}`,
        fill: column === 0 ? "#FFF7E9" : column === 2 ? context.colors.primaryLight : context.tokens.neutral.surface,
        line: { style: "solid", fill: column === 0 ? context.colors.warning : column === 2 ? context.colors.primary : context.tokens.neutral.line, width: 1 }, borderRadius: "rounded-lg",
      });
      addText(slide, label, { left: left + 16, top: top + 10, width: 92, height: 24 }, {
        fontSize: 11, fontFamily: context.tokens.fonts.zh, bold: true, color: column === 0 ? context.colors.warning : context.colors.primary,
      }, `deviation-label-${index + 1}-${column + 1}`);
      addText(slide, value, { left: left + 16, top: top + 36, width: 326, height: 42 }, {
        fontSize: 14, fontFamily: fontFor(value, context.tokens), bold: column === 2, color: context.tokens.neutral.text,
      }, `deviation-value-${index + 1}-${column + 1}`);
      if (column < 2) addShape(slide, "rightArrow", { left: left + 360, top: top + 29, width: 28, height: 28 }, {
        name: `deviation-arrow-${index + 1}-${column + 1}`, fill: context.colors.secondary, line: { style: "solid", fill: context.colors.secondary, width: 0 },
      });
    });
  });
  const reviewPoint = cleanText(first(data.review_point, data.reviewPoint, ""));
  const footer = [slideTakeaway(slideSpec), reviewPoint && `复查点：${reviewPoint}`].filter(Boolean).join("｜");
  addTakeawayBand(slide, footer, context, { top: 610, height: 50, fontSize: reviewPoint ? 14 : 16 });
}

async function renderCover(slide, spec, slideSpec, context) {
  const data = renderData(slideSpec);
  const body = list(slideSpec.content?.body).map(cleanText).filter(Boolean);
  const authorLine = body.find((line) => /^答辩人[：:]/.test(line));
  const advisorLine = body.find((line) => /^指导教师[：:]/.test(line));
  const footerLine = body.find((line) => line !== authorLine && line !== advisorLine);
  const title = slideTitle(slideSpec) || cleanText(first(spec.title, spec.deck_title, "学术论文题目"));
  const subtitle = cleanText(first(data.subtitle, slideSpec.subtitle, slideSpec.content?.subtitle, spec.subtitle, spec.english_title, ""));
  const author = cleanText(first(data.author, slideSpec.author, spec.author, spec.presenter, ""));
  const advisor = cleanText(first(data.advisor, slideSpec.advisor, spec.advisor, ""));
  const degree = cleanText(first(data.degree, slideSpec.degree, slideSpec.content?.kicker, spec.degree, spec.academic_level, ""));
  const date = cleanText(first(data.date, slideSpec.date, spec.date, ""));
  slide.background.fill = context.tokens.neutral.canvas;
  await addLogo(slide, context.brand, { left: 584, top: 48, width: 112, height: 92 }, context);
  addText(slide, context.brand.institution, { left: 360, top: 142, width: 560, height: 32 }, {
    fontSize: 17,
    fontFamily: fontFor(context.brand.institution, context.tokens),
    bold: true,
    color: context.colors.primaryDark,
    alignment: "center",
  }, "cover-institution");
  addShape(slide, "rect", { left: 0, top: 205, width: 1280, height: 260 }, {
    name: "cover-band",
    fill: context.colors.primary,
    line: { style: "solid", fill: context.colors.primary, width: 0 },
  });
  addText(slide, title, { left: 104, top: 246, width: 1072, height: 100 }, {
    fontSize: context.tokens.typeScale.deckTitle,
    fontFamily: fontFor(title, context.tokens),
    bold: true,
    color: context.tokens.neutral.white,
    alignment: "center",
  }, "cover-title");
  if (subtitle) addText(slide, subtitle, { left: 150, top: 358, width: 980, height: 55 }, {
    fontSize: 20,
    fontFamily: fontFor(subtitle, context.tokens),
    color: "#F4F7FC",
    alignment: "center",
  }, "cover-subtitle");
  const identity = [authorLine || (author && `答辩人：${author}`), advisorLine || (advisor && `指导教师：${advisor}`)].filter(Boolean).join("    ");
  addText(slide, identity, { left: 120, top: 505, width: 1040, height: 42 }, {
    fontSize: 18,
    fontFamily: fontFor(identity, context.tokens),
    bold: true,
    color: context.tokens.neutral.text,
    alignment: "center",
  }, "cover-meta");
  const footer = first(footerLine, [degree, context.brand.department, date].filter(Boolean).join("  |  "));
  addText(slide, footer, { left: 120, top: 606, width: 1040, height: 36 }, {
    fontSize: 15,
    fontFamily: fontFor(footer, context.tokens),
    color: context.tokens.neutral.muted,
    alignment: "center",
  }, "cover-footer");
}

async function renderAgenda(slide, spec, slideSpec, context, slideNumber) {
  slide.background.fill = context.tokens.neutral.canvas;
  await addLogo(slide, context.brand, { left: 20, top: 12, width: 42, height: 42 }, context);
  addText(slide, context.brand.institution, { left: 72, top: 12, width: 300, height: 42 }, {
    fontSize: 14,
    fontFamily: fontFor(context.brand.institution, context.tokens),
    bold: true,
    color: context.colors.primary,
  }, "agenda-institution");
  const sections = list(first(renderData(slideSpec).sections, slideSpec.sections, slideSpec.content?.body, spec.sections, []));
  if (!sections.length) {
    throw new Error(`Agenda slide ${slideSpec.id ?? slideNumber} has no sections. Populate render_data.sections/spec.sections or omit the agenda slide; placeholder chapters are not generated.`);
  }
  const usable = sections;
  if (usable.length > 10) {
    throw new Error(`Agenda slide ${slideSpec.id ?? slideNumber} has ${usable.length} sections. Split it into consecutive agenda slides with at most 10 items each; no section will be truncated.`);
  }

  // Original-template silhouette: a layered left capsule with a flat entry
  // edge and a generous rounded terminus. All shapes remain native/editable.
  const halo = mixHex(context.colors.primary, context.tokens.neutral.white, 0.58);
  addShape(slide, "roundRect", { left: 41, top: 154, width: 414, height: 413 }, {
    name: "agenda-capsule-halo", fill: halo,
    line: { style: "solid", fill: halo, width: 0 }, borderRadius: "rounded-full",
  });
  addShape(slide, "rect", { left: 41, top: 154, width: 207, height: 413 }, {
    name: "agenda-capsule-halo-flat", fill: halo,
    line: { style: "solid", fill: halo, width: 0 },
  });
  addShape(slide, "roundRect", { left: 50, top: 163, width: 373, height: 394 }, {
    name: "agenda-capsule", fill: context.colors.primary,
    line: { style: "solid", fill: context.colors.primary, width: 0 }, borderRadius: "rounded-full",
  });
  addShape(slide, "rect", { left: 50, top: 163, width: 186, height: 394 }, {
    name: "agenda-capsule-flat", fill: context.colors.primary,
    line: { style: "solid", fill: context.colors.primary, width: 0 },
  });
  addText(slide, "目录", { left: 132, top: 282, width: 204, height: 88 }, {
    fontSize: 48,
    fontFamily: context.tokens.fonts.zh,
    bold: true,
    color: context.tokens.neutral.white,
    alignment: "center",
  }, "agenda-title-zh");
  addText(slide, "CONTENTS", { left: 132, top: 374, width: 204, height: 42 }, {
    fontSize: 18,
    fontFamily: context.tokens.fonts.en,
    bold: true,
    color: "#E9EEF8",
    alignment: "center",
  }, "agenda-title-en");

  const compact = usable.length > 6;
  const columns = compact ? 2 : 1;
  const perColumn = Math.ceil(usable.length / columns);
  const rowHeight = compact ? 68 : usable.length === 6 ? 64 : 73;
  const availableHeight = 480;
  const maxStep = compact ? 94 : 102;
  const fittedStep = perColumn > 1 ? (availableHeight - rowHeight) / (perColumn - 1) : 0;
  const rowStep = Math.min(maxStep, fittedStep);
  const groupHeight = rowHeight + rowStep * Math.max(0, perColumn - 1);
  const startTop = 120 + (availableHeight - groupHeight) / 2;
  usable.forEach((section, index) => {
    const label = cleanText(first(section.number, section.index, String(index + 1).padStart(2, "0")));
    const title = cleanText(first(section.short_title, section.title, section.name, section));
    const column = compact ? Math.floor(index / perColumn) : 0;
    const row = compact ? index % perColumn : index;
    const top = startTop + row * rowStep;
    const bandLeft = compact ? 500 + column * 386 : 608;
    const bandWidth = compact ? 366 : 672;
    addShape(slide, "roundRect", { left: bandLeft, top, width: bandWidth, height: rowHeight }, {
      name: `agenda-band-${index + 1}`, fill: context.tokens.neutral.surface,
      line: { style: "solid", fill: context.tokens.neutral.surface, width: 0 }, borderRadius: "rounded-lg",
    });
    const numberSize = compact ? 48 : usable.length === 6 ? 52 : 60;
    const numberTop = top + (rowHeight - numberSize) / 2;
    addShape(slide, "ellipse", { left: bandLeft + 3, top: numberTop - 6, width: numberSize + 12, height: numberSize + 12 }, {
      name: `agenda-number-halo-${index + 1}`, fill: context.tokens.neutral.canvas,
      line: { style: "solid", fill: context.tokens.neutral.canvas, width: 0 },
    });
    addShape(slide, "ellipse", { left: bandLeft + 9, top: numberTop, width: numberSize, height: numberSize }, {
      name: `agenda-dot-${index + 1}`, fill: context.colors.primary,
      line: { style: "solid", fill: context.colors.primary, width: 0 },
    });
    addText(slide, label, { left: bandLeft + 9, top: numberTop, width: numberSize, height: numberSize }, {
      fontSize: compact ? 13 : usable.length === 6 ? 14 : 16,
      fontFamily: context.tokens.fonts.en,
      bold: true,
      color: context.tokens.neutral.white,
      alignment: "center",
    }, `agenda-number-${index + 1}`);
    const textLeft = compact ? bandLeft + 72 : bandLeft + 94;
    addText(slide, title, { left: textLeft, top, width: bandLeft + bandWidth - textLeft - 18, height: rowHeight }, {
      fontSize: compact ? 17 : usable.length === 6 ? 20 : 24,
      fontFamily: fontFor(title, context.tokens),
      bold: true,
      color: context.tokens.neutral.text,
    }, `agenda-title-${index + 1}`);
  });
  addText(slide, String(slideNumber), { left: 1208, top: 674, width: 32, height: 20 }, {
    fontSize: 12, fontFamily: context.tokens.fonts.en, color: context.tokens.neutral.subtle, alignment: "right",
  }, "agenda-page-number");
}

async function renderSectionDivider(slide, spec, slideSpec, context) {
  const sectionNumber = cleanText(first(slideSpec.section_number, slideSpec.sectionNumber, slideSpec.number, slideSpec.content?.kicker, "01")).replace(/^PART\s*/i, "");
  const title = cleanText(first(slideSpec.section_title, slideSpec.sectionTitle, slideSpec.title, slideSpec.content?.title, "章节标题"));
  const subtitle = cleanText(first(slideSpec.section_subtitle, slideSpec.sectionSubtitle, slideSpec.subtitle, slideSpec.content?.subtitle, ""));
  const bridge = cleanText(first(slideSpec.bridge, slideSpec.takeaway, ""));
  slide.background.fill = context.tokens.neutral.canvas;
  await addLogo(slide, context.brand, { left: 20, top: 12, width: 42, height: 42 }, context);
  addText(slide, context.brand.institution, { left: 72, top: 12, width: 400, height: 42 }, {
    fontSize: 14,
    fontFamily: fontFor(context.brand.institution, context.tokens),
    bold: true,
    color: context.colors.primary,
  }, "section-institution");
  addRule(slide, 0, 66, 1280, context.tokens.neutral.black, 1, "section-header-rule");
  addText(slide, `PART ${sectionNumber}`, { left: 0, top: 154, width: 1280, height: 52 }, {
    fontSize: 22,
    fontFamily: context.tokens.fonts.en,
    bold: true,
    color: context.tokens.neutral.muted,
    alignment: "center",
  }, "section-number");
  addShape(slide, "rect", { left: 0, top: 228, width: 1280, height: 224 }, {
    name: "section-band",
    fill: context.colors.primary,
    line: { style: "solid", fill: context.colors.primary, width: 0 },
  });
  addText(slide, title, { left: 100, top: 260, width: 1080, height: 78 }, {
    fontSize: context.tokens.typeScale.sectionTitle,
    fontFamily: fontFor(title, context.tokens),
    bold: true,
    color: context.tokens.neutral.white,
    alignment: "center",
  }, "section-title");
  if (subtitle) addText(slide, subtitle, { left: 130, top: 354, width: 1020, height: 42 }, {
    fontSize: 18,
    fontFamily: fontFor(subtitle, context.tokens),
    color: "#E7EBF4",
    alignment: "center",
  }, "section-subtitle");
  if (bridge) addText(slide, bridge, { left: 160, top: 518, width: 960, height: 66 }, {
    fontSize: 18,
    fontFamily: fontFor(bridge, context.tokens),
    color: context.tokens.neutral.muted,
    alignment: "center",
  }, "section-bridge");
}

async function renderClaimEvidence(slide, slideSpec, context, slideNumber) {
  await addContentChrome(slide, slideSpec, context, slideNumber);
  const data = renderData(slideSpec);
  const claim = slideTakeaway(slideSpec) || "先给出本页的一句话结论";
  const evidenceItems = semanticItems(slideSpec, ["items", "evidence"], 3).slice(0, 4);
  const metrics = slideMetrics(slideSpec).slice(0, 3);
  const assets = slideAssetRequests(slideSpec, context.assetIndex, context.baseDir);
  addText(slide, claim, { left: 82, top: 166, width: 1116, height: 76 }, {
    fontSize: 29,
    fontFamily: fontFor(claim, context.tokens),
    bold: true,
    color: context.colors.primaryDark,
  }, "primary-claim");
  addRule(slide, 82, 252, 90, context.colors.accent, 4, "claim-accent");
  const rowHeight = evidenceItems.length === 4 ? 68 : 82;
  const rowStep = evidenceItems.length === 4 ? 76 : 94;
  evidenceItems.forEach((item, index) => {
    const top = 278 + index * rowStep;
    addShape(slide, "ellipse", { left: 84, top: top + (rowHeight - 48) / 2, width: 48, height: 48 }, {
      name: `evidence-index-${index + 1}`, fill: index === 0 ? context.colors.primary : context.colors.primaryLight,
      line: { style: "solid", fill: context.colors.primary, width: 1.2 },
    });
    addText(slide, String(index + 1).padStart(2, "0"), { left: 84, top: top + (rowHeight - 48) / 2, width: 48, height: 48 }, {
      fontSize: 13, fontFamily: context.tokens.fonts.en, bold: true,
      color: index === 0 ? context.tokens.neutral.white : context.colors.primary, alignment: "center",
    }, `evidence-index-text-${index + 1}`);
    addText(slide, item.title, { left: 154, top, width: 230, height: rowHeight }, {
      fontSize: 18, fontFamily: fontFor(item.title, context.tokens), bold: true, color: context.tokens.neutral.text,
    }, `evidence-title-${index + 1}`);
    addText(slide, item.body || "说明该证据怎样支撑主张，以及它支持到什么范围。", { left: 398, top, width: 380, height: rowHeight }, {
      fontSize: 15, fontFamily: fontFor(item.body, context.tokens), color: context.tokens.neutral.muted,
    }, `evidence-body-${index + 1}`);
    if (index < evidenceItems.length - 1) addRule(slide, 154, top + rowHeight + 5, 624, context.tokens.neutral.line, 1, `evidence-rule-${index + 1}`);
  });
  if (assets.length) {
    await addImageOrPlaceholder(slide, assets[0], { left: 832, top: 278, width: 366, height: 260 }, {
      ...context,
      name: "claim-context-image",
      placeholderLabel: "结论对应的上下文或证据图",
    });
    if (metrics[0]) addKeyNumber(slide, metrics[0], { left: 832, top: 546, width: 366, height: 58 }, context.colors, context.tokens, "metric-1");
  } else if (metrics.length) {
    metrics.forEach((metric, index) => addKeyNumber(slide, metric, {
      left: 832,
      top: 282 + index * 98,
      width: 366,
      height: 86,
    }, context.colors, context.tokens, `metric-${index + 1}`));
  } else {
    addShape(slide, "roundRect", { left: 832, top: 278, width: 366, height: 286 }, {
      name: "evidence-summary",
      fill: context.colors.primaryLight,
      line: { style: "solid", fill: context.colors.primaryLight, width: 1 },
      borderRadius: "rounded-xl",
    });
    addText(slide, "证据综合", { left: 866, top: 304, width: 298, height: 34 }, {
      fontSize: 16, fontFamily: context.tokens.fonts.zh, bold: true, color: context.colors.primary,
    }, "evidence-summary-label");
    const synthesis = cleanText(first(data.synthesis, "材料、结果与边界三类证据共同决定结论的可信度和适用范围。"));
    addText(slide, synthesis, {
      left: 866, top: 352, width: 298, height: 166,
    }, {
      fontSize: 22,
      fontFamily: fontFor(synthesis, context.tokens),
      bold: true,
      color: context.colors.primaryDark,
      verticalAlignment: "top",
    }, "evidence-summary-text");
  }
  const boundary = cleanText(first(data.boundary, slideSpec.content?.callout, "结论只覆盖上述证据共同支持的范围。"));
  addTakeawayBand(slide, boundary, context, { top: 612, height: 46, fontSize: 15 });
}

async function renderSingleImage(slide, slideSpec, context, slideNumber, side) {
  await addContentChrome(slide, slideSpec, context, slideNumber);
  const assets = slideAssetRequests(slideSpec, context.assetIndex, context.baseDir);
  const imageLeft = side === "left" ? 64 : 572;
  const textLeft = side === "left" ? 676 : 64;
  const imageWidth = side === "left" ? 572 : 644;
  const textWidth = side === "left" ? 540 : 478;
  await addImageOrPlaceholder(slide, assets[0], { left: imageLeft, top: 174, width: imageWidth, height: 396 }, {
    ...context,
    name: "primary-evidence-image",
    placeholderLabel: "主证据图",
  });
  const claim = slideTakeaway(slideSpec);
  const bullets = slideBullets(slideSpec).slice(0, 5);
  if (claim) addText(slide, claim, { left: textLeft, top: 180, width: textWidth, height: 98 }, {
    fontSize: 27,
    fontFamily: fontFor(claim, context.tokens),
    bold: true,
    color: context.colors.primaryDark,
    verticalAlignment: "top",
  }, "image-interpretation-claim");
  addBulletList(slide, bullets, { left: textLeft, top: 302, width: textWidth, height: 218 }, {
    fontSize: 18,
    color: context.tokens.neutral.text,
  }, context.tokens, "image-interpretation-bullets");
  const metrics = slideMetrics(slideSpec);
  if (metrics[0]) addKeyNumber(slide, metrics[0], { left: textLeft, top: 512, width: textWidth, height: 90 }, context.colors, context.tokens);
}

async function renderImageCompare(slide, slideSpec, context, slideNumber, caseMode = false) {
  await addContentChrome(slide, slideSpec, context, slideNumber);
  const assets = slideAssetRequests(slideSpec, context.assetIndex, context.baseDir);
  const data = renderData(slideSpec);
  const leftLabel = cleanText(first(data.left_label, slideSpec.left_label, slideSpec.leftLabel, assets[0]?.caption, caseMode ? slideSpec.left_case?.title : "对照 A", "对照 A"));
  const rightLabel = cleanText(first(data.right_label, slideSpec.right_label, slideSpec.rightLabel, assets[1]?.caption, caseMode ? slideSpec.right_case?.title : "对照 B", "对照 B"));
  const imageTop = 218;
  addPill(slide, leftLabel, { left: 84, top: 172, width: 520, height: 34 }, context.colors, context.tokens, {
    name: "compare-left-label",
    fill: context.tokens.neutral.surfaceStrong,
    color: context.tokens.neutral.text,
  });
  addPill(slide, rightLabel, { left: 676, top: 172, width: 520, height: 34 }, context.colors, context.tokens, {
    name: "compare-right-label",
    fill: context.colors.primaryLight,
    color: context.colors.primaryDark,
  });
  await addImageOrPlaceholder(slide, assets[0], { left: 84, top: imageTop, width: 520, height: 302 }, { ...context, name: "compare-left", placeholderLabel: "证据 A" });
  await addImageOrPlaceholder(slide, assets[1], { left: 676, top: imageTop, width: 520, height: 302 }, { ...context, name: "compare-right", placeholderLabel: "证据 B" });
  const leftText = cleanText(first(data.left_text, slideSpec.left_case?.text, slideSpec.left_text, ""));
  const rightText = cleanText(first(data.right_text, slideSpec.right_case?.text, slideSpec.right_text, ""));
  if (leftText) addText(slide, leftText, { left: 88, top: 526, width: 512, height: 62 }, {
    fontSize: 15, fontFamily: fontFor(leftText, context.tokens), color: context.tokens.neutral.muted,
  }, "compare-left-caption");
  if (rightText) addText(slide, rightText, { left: 680, top: 526, width: 512, height: 62 }, {
    fontSize: 15, fontFamily: fontFor(rightText, context.tokens), color: context.tokens.neutral.muted,
  }, "compare-right-caption");
  addTakeawayBand(slide, slideTakeaway(slideSpec), context, { top: 604, height: 54 });
}

async function renderChartInsight(slide, slideSpec, context, slideNumber) {
  await addContentChrome(slide, slideSpec, context, slideNumber);
  const concreteAssets = slideAssetRequests(slideSpec, context.assetIndex, context.baseDir).filter((item) => !item.placeholder);
  if (concreteAssets.length) {
    await addImageOrPlaceholder(slide, concreteAssets[0], { left: 64, top: 178, width: 738, height: 372 }, {
      ...context,
      name: "chart-primary-evidence",
      allowPlaceholder: false,
    });
    if (concreteAssets[1]) {
      await addImageOrPlaceholder(slide, concreteAssets[1], { left: 832, top: 178, width: 384, height: 218 }, {
        ...context,
        name: "chart-secondary-evidence",
        allowPlaceholder: false,
      });
    } else {
      addText(slide, slideTakeaway(slideSpec), { left: 844, top: 190, width: 356, height: 172 }, {
        fontSize: 26,
        fontFamily: fontFor(slideTakeaway(slideSpec), context.tokens),
        bold: true,
        color: context.colors.primaryDark,
        verticalAlignment: "top",
      }, "chart-claim");
    }
    if (concreteAssets[2]) {
      await addImageOrPlaceholder(slide, concreteAssets[2], { left: 832, top: 420, width: 384, height: 118 }, {
        ...context,
        name: "chart-tertiary-evidence",
        allowPlaceholder: false,
      });
    } else {
      const metrics = slideMetrics(slideSpec).slice(0, 2);
      metrics.forEach((metric, index) => addKeyNumber(slide, metric, {
        left: 842 + index * 180,
        top: 420,
        width: 170,
        height: 104,
      }, context.colors, context.tokens, `chart-metric-${index + 1}`));
    }
    addTakeawayBand(slide, slideTakeaway(slideSpec), context, { top: 592, height: 66 });
    return;
  }
  const chart = isObject(renderData(slideSpec).chart) ? renderData(slideSpec).chart : (isObject(slideSpec.chart) ? slideSpec.chart : {});
  const categories = list(first(chart.categories, ["阶段 1", "阶段 2", "阶段 3", "阶段 4"])).map(cleanText);
  let series = list(chart.series).map((entry, index) => ({
    name: cleanText(first(entry?.name, `序列 ${index + 1}`)),
    values: list(entry?.values).map(Number),
    fill: context.colors.chart[index % context.colors.chart.length],
    line: { style: "solid", fill: context.colors.chart[index % context.colors.chart.length], width: 2.5 },
    marker: { symbol: "circle", size: 6 },
  }));
  if (!series.length) series = [{ name: "示例数据", values: [42, 56, 49, 68], fill: context.colors.primary }];
  slide.charts.add(first(chart.type, "bar"), {
    position: { left: 64, top: 178, width: 770, height: 380 },
    categories,
    series,
    hasLegend: series.length > 1,
    legend: { position: "bottom", overlay: false, textStyle: { fill: context.tokens.neutral.muted, fontSize: pptFontSize(13), typeface: context.tokens.fonts.zh } },
    barOptions: { direction: first(chart.direction, "column"), grouping: first(chart.grouping, "clustered"), gapWidth: 42 },
    xAxis: { textStyle: { fill: context.tokens.neutral.muted, fontSize: pptFontSize(13), typeface: context.tokens.fonts.zh }, line: { style: "solid", fill: context.tokens.neutral.line, width: 1 } },
    yAxis: { textStyle: { fill: context.tokens.neutral.muted, fontSize: pptFontSize(12), typeface: context.tokens.fonts.en }, majorGridlines: { style: "solid", fill: context.tokens.neutral.line, width: 1 } },
    dataLabels: { showValue: true, position: "outEnd", textStyle: { fill: context.tokens.neutral.text, fontSize: pptFontSize(12), typeface: context.tokens.fonts.en, bold: true } },
    chartFill: context.tokens.neutral.canvas,
    chartLine: { style: "solid", fill: context.tokens.neutral.canvas, width: 0 },
  });
  const claim = slideTakeaway(slideSpec);
  addText(slide, claim || "用一句话解释趋势，而不是复述坐标轴。", { left: 872, top: 194, width: 328, height: 120 }, {
    fontSize: 26,
    fontFamily: fontFor(claim, context.tokens),
    bold: true,
    color: context.colors.primaryDark,
    verticalAlignment: "top",
  }, "chart-claim");
  const chartBullets = slideBullets(slideSpec).slice(0, 4);
  if (chartBullets.length) {
    addBulletList(slide, chartBullets, { left: 872, top: 338, width: 328, height: 190 }, {
      fontSize: 17,
      color: context.tokens.neutral.text,
    }, context.tokens, "chart-bullets");
  }
  const metric = slideMetrics(slideSpec)[0];
  if (metric) addKeyNumber(slide, metric, { left: 872, top: 516, width: 328, height: 90 }, context.colors, context.tokens);
}

async function renderTableInsight(slide, slideSpec, context, slideNumber, validation = false) {
  await addContentChrome(slide, slideSpec, context, slideNumber);
  const tableSpec = isObject(renderData(slideSpec).table) ? renderData(slideSpec).table : (isObject(slideSpec.table) ? slideSpec.table : {});
  const headers = list(first(tableSpec.headers, renderData(slideSpec).columns, slideSpec.columns, validation ? ["主张 / 要求", "方法", "证据", "结论"] : ["指标", "方案 A", "方案 B", "解释"])).map(cleanText);
  const rowValues = list(first(tableSpec.rows, renderData(slideSpec).rows, slideSpec.rows, validation ? [
    ["核心主张 1", "分析方法", "图/表/式", "支持"],
    ["核心主张 2", "验证方法", "数据/案例", "支持"],
    ["边界条件", "适用性检查", "假设/限制", "需说明"],
  ] : [
    ["指标 1", "基线", "改进值", "解释变化"],
    ["指标 2", "基线", "改进值", "解释变化"],
    ["指标 3", "基线", "改进值", "解释变化"],
  ]));
  const rows = rowValues.map((row) => list(row).map(cleanText));
  const columns = headers.length;
  const values = [headers, ...rows.map((row) => Array.from({ length: columns }, (_, index) => row[index] ?? ""))];
  const height = clamp(58 + rows.length * 58, 260, 390);
  const table = slide.tables.add({
    rows: values.length,
    columns,
    left: 64,
    top: 178,
    width: 1152,
    height,
    values,
  });
  table.styleOptions = { headerRow: true, bandedRows: true, firstColumn: true };
  table.borders.assign({ style: "solid", fill: context.tokens.neutral.line, width: 1 });
  for (let column = 0; column < columns; column += 1) {
    const cell = table.getCell(0, column);
    cell.fill = context.colors.primary;
    cell.text.style = { fontSize: pptFontSize(15), typeface: context.tokens.fonts.zh, bold: true, color: context.tokens.neutral.white, alignment: "center" };
    registerTextTarget(slide, cell.text, values[0][column], `table-cell-0-${column}`, context.tokens.neutral.white);
  }
  for (let row = 1; row < values.length; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const cell = table.getCell(row, column);
      cell.fill = row % 2 === 0 ? context.tokens.neutral.surface : context.tokens.neutral.canvas;
      cell.text.style = {
        fontSize: pptFontSize(rows.length > 6 ? 13 : 15),
        typeface: fontFor(values[row][column], context.tokens),
        bold: column === 0,
        color: column === columns - 1 && validation ? context.colors.primaryDark : context.tokens.neutral.text,
        alignment: column === 0 ? "left" : "center",
      };
      registerTextTarget(slide, cell.text, values[row][column], `table-cell-${row}-${column}`, column === columns - 1 && validation ? context.colors.primaryDark : context.tokens.neutral.text);
    }
  }
  addTakeawayBand(slide, slideTakeaway(slideSpec), context, { top: 604, height: 54 });
}

async function renderFormulaVisual(slide, slideSpec, context, slideNumber) {
  await addContentChrome(slide, slideSpec, context, slideNumber);
  const formula = isObject(slideSpec.formula) ? slideSpec.formula : {};
  const imageRequest = normalizeAssetRequest(first(formula.asset_ref, formula.assetRef, formula.asset_path, formula.assetPath), context.assetIndex, context.baseDir);
  addShape(slide, "roundRect", { left: 64, top: 180, width: 1152, height: 120 }, {
    name: "formula-surface",
    fill: context.tokens.neutral.surface,
    line: { style: "solid", fill: context.tokens.neutral.line, width: 1 },
    borderRadius: "rounded-lg",
  });
  if (imageRequest) {
    await addImageOrPlaceholder(slide, { ...imageRequest, fit: "contain" }, { left: 96, top: 196, width: 1088, height: 88 }, {
      ...context,
      name: "formula-image",
      allowPlaceholder: false,
      fit: "contain",
    });
  } else {
    const latex = cleanText(first(formula.latex, formula.equation, "f(x) = 核心模型 / 约束 / 评价指标"));
    const renderMethod = cleanText(first(formula.render_method, formula.renderMethod));
    const simpleUnicode = renderMethod === "unicode_text" && latex.length <= 120 && !/[\\{}]/.test(latex);
    if (!simpleUnicode) {
      throw new Error(`Formula slide ${slideSpec.id ?? slideNumber} has no rendered asset. Compile LaTeX to SVG/PNG, use a verified source-PDF crop, or explicitly select unicode_text for a short formula.`);
    }
    addText(slide, latex, { left: 96, top: 198, width: 1088, height: 84 }, {
      fontSize: 30,
      fontFamily: context.tokens.fonts.math ?? context.tokens.fonts.serif,
      color: context.tokens.neutral.text,
      alignment: "center",
    }, "formula-unicode-text");
  }
  const plain = cleanText(first(formula.plain_meaning, formula.plainMeaning, slideSpec.plain_meaning, slideTakeaway(slideSpec), "用自然语言解释公式如何支撑结论。"));
  addText(slide, plain, { left: 64, top: 328, width: 472, height: 128 }, {
    fontSize: 27,
    fontFamily: fontFor(plain, context.tokens),
    bold: true,
    color: context.colors.primaryDark,
    verticalAlignment: "top",
  }, "formula-meaning");
  const variableItems = list(first(formula.variables_to_explain, formula.variablesToExplain, formula.variables, [])).map((entry) => {
    if (!isObject(entry)) return cleanText(entry);
    const symbol = cleanText(entry.symbol);
    const meaning = cleanText(entry.meaning);
    const unit = cleanText(entry.unit);
    return `${symbol}${symbol && meaning ? "：" : ""}${meaning}${unit ? `（${unit}）` : ""}`;
  }).filter(Boolean);
  addBulletList(slide, variableItems.length ? variableItems : ["只解释答辩中真正使用的变量", "保留单位、假设和适用边界"], {
    left: 64, top: 474, width: 472, height: 120,
  }, { fontSize: 16, color: context.tokens.neutral.muted }, context.tokens, "formula-variables");
  const assets = slideAssetRequests(slideSpec, context.assetIndex, context.baseDir);
  const linkedVisual = assets.find((asset) => asset.visual_type !== "formula" && asset.path !== imageRequest?.path) ?? assets.find((asset) => asset.path !== imageRequest?.path);
  await addImageOrPlaceholder(slide, linkedVisual, { left: 572, top: 328, width: 644, height: 266 }, {
    ...context,
    name: "formula-linked-visual",
    placeholderLabel: "与公式直接对应的图、曲线或结果",
  });
  addTakeawayBand(slide, slideTakeaway(slideSpec), context, { top: 608, height: 52 });
}

function diagramNodes(slideSpec) {
  const diagram = isObject(slideSpec.diagram) ? slideSpec.diagram : {};
  const raw = list(first(diagram.nodes, slideSpec.nodes, []));
  if (raw.length) return raw.map((node, index) => isObject(node) ? node : { id: `n${index + 1}`, label: cleanText(node) });
  return [
    { id: "n1", label: "输入 / 问题" },
    { id: "n2", label: "方法 / 分析" },
    { id: "n3", label: "验证 / 证据" },
    { id: "n4", label: "结论 / 输出" },
  ];
}

async function renderProcess(slide, slideSpec, context, slideNumber, framework = false) {
  await addContentChrome(slide, slideSpec, context, slideNumber);
  const nodes = diagramNodes(slideSpec).slice(0, framework ? 6 : 5);
  const count = nodes.length;
  const left = 84;
  const right = 1196;
  const gap = 22;
  const width = (right - left - gap * (count - 1)) / count;
  const top = framework ? 258 : 270;
  const height = framework ? 150 : 132;
  // Connecting rules are created before nodes so all relationships remain behind labels.
  for (let index = 0; index < count - 1; index += 1) {
    const x1 = left + width * (index + 1) + gap * index;
    addRule(slide, x1, top + height / 2 - 2, gap, context.colors.secondary, 4, `process-link-${index + 1}`);
    addShape(slide, "rightArrow", { left: x1 + gap - 13, top: top + height / 2 - 8, width: 14, height: 16 }, {
      name: `process-arrow-${index + 1}`,
      fill: context.colors.secondary,
      line: { style: "solid", fill: context.colors.secondary, width: 0 },
    });
  }
  const feedbackEdge = list(slideSpec.diagram?.edges).find((edge) => edge?.relation === "feedback");
  if (feedbackEdge && count >= 3) {
    const nodeIndex = new Map(nodes.map((node, index) => [String(node.id), index]));
    const fromIndex = nodeIndex.get(String(feedbackEdge.from));
    const toIndex = nodeIndex.get(String(feedbackEdge.to));
    const resolvedFrom = Number.isInteger(fromIndex) ? fromIndex : count - 1;
    const resolvedTo = Number.isInteger(toIndex) ? toIndex : 1;
    const fromCenter = left + resolvedFrom * (width + gap) + width / 2;
    const toCenter = left + resolvedTo * (width + gap) + width / 2;
    const railLeft = Math.min(fromCenter, toCenter);
    const railRight = Math.max(fromCenter, toCenter);
    const feedbackY = top + height + 48;
    addShape(slide, "rect", { left: fromCenter, top: top + height, width: 3, height: 48 }, {
      name: "process-feedback-from-leg",
      fill: context.colors.accent,
      line: { style: "solid", fill: context.colors.accent, width: 0 },
    });
    addShape(slide, "rect", { left: railLeft, top: feedbackY, width: railRight - railLeft, height: 3 }, {
      name: "process-feedback-rail",
      fill: context.colors.accent,
      line: { style: "solid", fill: context.colors.accent, width: 0 },
    });
    addShape(slide, "rect", { left: toCenter, top: top + height, width: 3, height: 50 }, {
      name: "process-feedback-to-leg",
      fill: context.colors.accent,
      line: { style: "solid", fill: context.colors.accent, width: 0 },
    });
    const arrowGeometry = toCenter <= fromCenter ? "leftArrow" : "rightArrow";
    const arrowLeft = toCenter <= fromCenter ? toCenter - 14 : toCenter - 2;
    addShape(slide, arrowGeometry, { left: arrowLeft, top: feedbackY - 7, width: 16, height: 16 }, {
      name: "process-feedback-arrow",
      fill: context.colors.accent,
      line: { style: "solid", fill: context.colors.accent, width: 0 },
    });
    const feedbackLabel = cleanText(first(feedbackEdge.label, "校核反馈"));
    addText(slide, feedbackLabel, { left: (railLeft + railRight) / 2 - 80, top: feedbackY + 8, width: 160, height: 24 }, {
      fontSize: 12,
      fontFamily: context.tokens.fonts.zh,
      color: context.colors.warning,
      alignment: "center",
    }, "process-feedback-label");
  }
  nodes.forEach((node, index) => {
    const label = cleanText(first(node.label, node.title, node.text, node.id));
    const detail = cleanText(first(node.detail, ""));
    const nodeLeft = left + index * (width + gap);
    addShape(slide, "roundRect", { left: nodeLeft, top, width, height }, {
      name: `process-node-${cleanText(node.id || index + 1)}`,
      fill: index === count - 1 ? context.colors.primary : context.tokens.neutral.surface,
      line: { style: "solid", fill: index === count - 1 ? context.colors.primary : context.colors.secondary, width: 1.6 },
      borderRadius: "rounded-lg",
    });
    addText(slide, String(index + 1).padStart(2, "0"), { left: nodeLeft + 16, top: top + 12, width: 46, height: 28 }, {
      fontSize: 13,
      fontFamily: context.tokens.fonts.en,
      bold: true,
      color: index === count - 1 ? context.colors.primaryLight : context.colors.primary,
    }, `process-index-${index + 1}`);
    addText(slide, label, { left: nodeLeft + 18, top: top + 40, width: width - 36, height: detail ? 42 : height - 52 }, {
      fontSize: 18,
      fontFamily: fontFor(label, context.tokens),
      bold: true,
      color: index === count - 1 ? context.tokens.neutral.white : context.tokens.neutral.text,
      alignment: "center",
    }, `process-label-${index + 1}`);
    if (detail) addText(slide, detail, { left: nodeLeft + 16, top: top + 82, width: width - 32, height: height - 90 }, {
      fontSize: 12,
      fontFamily: fontFor(detail, context.tokens),
      color: index === count - 1 ? "#EDF1F8" : context.tokens.neutral.muted,
      alignment: "center",
      verticalAlignment: "top",
    }, `process-detail-${index + 1}`);
  });
  const intro = cleanText(first(slideSpec.intro, slideSpec.diagram?.reason, ""));
  if (intro) addText(slide, intro, { left: 84, top: 176, width: 1112, height: 60 }, {
    fontSize: 18, fontFamily: fontFor(intro, context.tokens), color: context.tokens.neutral.muted,
  }, "process-intro");
  addTakeawayBand(slide, slideTakeaway(slideSpec), context, { top: 566, height: 62 });
}

async function renderFramework(slide, slideSpec, context, slideNumber) {
  await addContentChrome(slide, slideSpec, context, slideNumber);
  const nodes = diagramNodes(slideSpec).slice(0, 5);
  const byRole = (role, fallbackIndex) => nodes.find((node) => node.role === role) ?? nodes[fallbackIndex];
  const input = byRole("input", 0);
  const core = byRole("process", 1);
  const output = byRole("output", 2);
  const explicitBoundary = nodes.find((node) => node.role === "context");
  const fallbackBoundary = nodes[3] && nodes[3] !== output && nodes[3].role !== "evidence" ? nodes[3] : null;
  const boundary = explicitBoundary ?? fallbackBoundary;
  const evidence = nodes.find((node) => node.role === "evidence" && ![input, core, output, boundary].includes(node));
  const positions = {
    input: { left: 80, top: 300, width: 260, height: 104 },
    core: { left: 470, top: 270, width: 340, height: 164 },
    output: { left: 940, top: 300, width: 260, height: 104 },
    boundary: { left: 470, top: 492, width: 340, height: 76 },
    evidence: { left: 470, top: 180, width: 340, height: 62 },
  };
  // Draw relationship rails first so node surfaces remain on top.
  addRule(slide, 340, 350, 130, context.colors.secondary, 4, "framework-link-input-core");
  addShape(slide, "rightArrow", { left: 454, top: 342, width: 17, height: 20 }, {
    name: "framework-arrow-input-core",
    fill: context.colors.secondary,
    line: { style: "solid", fill: context.colors.secondary, width: 0 },
  });
  addRule(slide, 810, 350, 130, context.colors.secondary, 4, "framework-link-core-output");
  addShape(slide, "rightArrow", { left: 924, top: 342, width: 17, height: 20 }, {
    name: "framework-arrow-core-output",
    fill: context.colors.secondary,
    line: { style: "solid", fill: context.colors.secondary, width: 0 },
  });
  if (boundary) addShape(slide, "rect", { left: 638, top: 434, width: 4, height: 58 }, {
    name: "framework-link-boundary",
    fill: context.colors.accent,
    line: { style: "solid", fill: context.colors.accent, width: 0 },
  });
  if (evidence) addShape(slide, "rect", { left: 638, top: 242, width: 4, height: 28 }, {
    name: "framework-link-evidence",
    fill: context.colors.secondary,
    line: { style: "solid", fill: context.colors.secondary, width: 0 },
  });
  const renderNode = (node, role, primary = false) => {
    if (!node) return;
    const pos = positions[role];
    const label = cleanText(first(node.label, node.title, node.text, node.id));
    const detail = cleanText(first(node.detail, ""));
    addShape(slide, "roundRect", pos, {
      name: `framework-node-${role}`,
      fill: primary ? context.colors.primary : (role === "boundary" ? "#FFF8E8" : context.tokens.neutral.surface),
      line: { style: "solid", fill: primary ? context.colors.primary : (role === "boundary" ? context.colors.accent : context.colors.secondary), width: 1.6 },
      borderRadius: "rounded-lg",
    });
    addText(slide, label, { left: pos.left + 18, top: pos.top + 10, width: pos.width - 36, height: detail ? 42 : pos.height - 20 }, {
      fontSize: primary ? 22 : 18,
      fontFamily: fontFor(label, context.tokens),
      bold: true,
      color: primary ? context.tokens.neutral.white : context.tokens.neutral.text,
      alignment: "center",
    }, `framework-label-${role}`);
    if (detail) addText(slide, detail, { left: pos.left + 18, top: pos.top + 50, width: pos.width - 36, height: pos.height - 58 }, {
      fontSize: 14,
      fontFamily: fontFor(detail, context.tokens),
      color: primary ? "#EDF1F8" : context.tokens.neutral.muted,
      alignment: "center",
      verticalAlignment: "top",
    }, `framework-detail-${role}`);
  };
  renderNode(input, "input");
  renderNode(core, "core", true);
  renderNode(output, "output");
  renderNode(boundary, "boundary");
  renderNode(evidence, "evidence");
  addTakeawayBand(slide, slideTakeaway(slideSpec), context, { top: 600, height: 56 });
}

async function renderTimeline(slide, slideSpec, context, slideNumber) {
  await addContentChrome(slide, slideSpec, context, slideNumber);
  const events = list(first(renderData(slideSpec).events, slideSpec.events, slideSpec.timeline, slideSpec.diagram?.nodes, slideSpec.bullets, [])).slice(0, 6);
  const normalized = (events.length ? events : ["阶段一", "阶段二", "阶段三", "阶段四"]).map((event, index) => isObject(event) ? event : { title: cleanText(event), label: String(index + 1) });
  const left = 100;
  const right = 1180;
  const y = 350;
  addRule(slide, left, y, right - left, context.tokens.neutral.line, 5, "timeline-rail");
  normalized.forEach((event, index) => {
    const x = left + (right - left) * (normalized.length === 1 ? 0.5 : index / (normalized.length - 1));
    addShape(slide, "ellipse", { left: x - 15, top: y - 15, width: 30, height: 30 }, {
      name: `timeline-node-${index + 1}`,
      fill: index === normalized.length - 1 ? context.colors.accent : context.colors.primary,
      line: { style: "solid", fill: context.tokens.neutral.white, width: 3 },
    });
    const title = cleanText(first(event.title, event.label, event.text));
    const caption = cleanText(first(event.caption, event.description, ""));
    const above = index % 2 === 0;
    addText(slide, title, { left: x - 92, top: above ? y - 116 : y + 32, width: 184, height: 48 }, {
      fontSize: 17,
      fontFamily: fontFor(title, context.tokens),
      bold: true,
      color: context.tokens.neutral.text,
      alignment: "center",
    }, `timeline-title-${index + 1}`);
    if (caption) addText(slide, caption, { left: x - 102, top: above ? y - 164 : y + 82, width: 204, height: 58 }, {
      fontSize: 13,
      fontFamily: fontFor(caption, context.tokens),
      color: context.tokens.neutral.muted,
      alignment: "center",
    }, `timeline-caption-${index + 1}`);
  });
  addTakeawayBand(slide, slideTakeaway(slideSpec), context, { top: 600, height: 56 });
}

async function renderQuoteAnalysis(slide, slideSpec, context, slideNumber) {
  await addContentChrome(slide, slideSpec, context, slideNumber);
  const quoteObject = isObject(slideSpec.content?.quote) ? slideSpec.content.quote : {};
  const quote = cleanText(first(renderData(slideSpec).quote, slideSpec.quote, quoteObject.text, "这里呈现一段短引文、史料原文或关键学术观点。"));
  const analysis = cleanText(first(renderData(slideSpec).analysis, slideSpec.analysis, quoteObject.analysis, slideTakeaway(slideSpec), "这里解释引文如何支持本研究论点。"));
  addShape(slide, "roundRect", { left: 64, top: 180, width: 520, height: 360 }, {
    name: "quote-surface",
    fill: context.tokens.neutral.surface,
    line: { style: "solid", fill: context.tokens.neutral.line, width: 1 },
    borderRadius: "rounded-xl",
  });
  addText(slide, "“", { left: 86, top: 182, width: 80, height: 78 }, {
    fontSize: 68,
    fontFamily: context.tokens.fonts.serif,
    color: context.colors.secondary,
  }, "quote-mark");
  addText(slide, quote, { left: 112, top: 236, width: 424, height: 236 }, {
    fontSize: 24,
    fontFamily: fontFor(quote, context.tokens, true),
    color: context.tokens.neutral.text,
    verticalAlignment: "middle",
  }, "quote-text");
  const sourceLine = cleanText(first(slideSpec.source_line, slideSpec.sourceLine, slideSpec.quote_source, ""));
  if (sourceLine) addText(slide, sourceLine, { left: 112, top: 486, width: 424, height: 34 }, {
    fontSize: 13,
    fontFamily: fontFor(sourceLine, context.tokens),
    color: context.tokens.neutral.subtle,
    alignment: "right",
  }, "quote-source");
  addText(slide, "分析", { left: 640, top: 188, width: 120, height: 34 }, {
    fontSize: 17,
    fontFamily: context.tokens.fonts.zh,
    bold: true,
    color: context.colors.primary,
  }, "analysis-label");
  addText(slide, analysis, { left: 640, top: 234, width: 560, height: 190 }, {
    fontSize: 26,
    fontFamily: fontFor(analysis, context.tokens),
    bold: true,
    color: context.colors.primaryDark,
    verticalAlignment: "top",
  }, "analysis-claim");
  addBulletList(slide, slideBullets(slideSpec).slice(0, 4), { left: 640, top: 442, width: 560, height: 116 }, {
    fontSize: 16,
    color: context.tokens.neutral.muted,
  }, context.tokens, "analysis-bullets");
  addTakeawayBand(slide, slideTakeaway(slideSpec), context, { top: 600, height: 56 });
}

async function renderContribution(slide, slideSpec, context, slideNumber) {
  await addContentChrome(slide, slideSpec, context, slideNumber);
  const contributions = list(first(renderData(slideSpec).contributions, slideSpec.contributions, slideSpec.bullets, slideSpec.content?.bullets, [])).slice(0, 5);
  const normalized = (contributions.length ? contributions : ["问题或对象层贡献", "方法或路径层贡献", "证据或验证层贡献", "理论或实践层贡献"]).map((entry, index) => isObject(entry) ? entry : { title: cleanText(entry), evidence: "对应证据" });
  const top = 178;
  const rowHeight = 82;
  normalized.forEach((entry, index) => {
    const y = top + index * rowHeight;
    addText(slide, String(index + 1).padStart(2, "0"), { left: 74, top: y, width: 72, height: 62 }, {
      fontSize: 25,
      fontFamily: context.tokens.fonts.en,
      bold: true,
      color: context.colors.primary,
      alignment: "center",
    }, `contribution-number-${index + 1}`);
    const title = cleanText(first(entry.title, entry.claim, entry.text));
    const evidence = cleanText(first(entry.evidence, entry.result, entry.source, entry.body, ""));
    const boundary = cleanText(first(entry.boundary, entry.limit, ""));
    const evidenceWithBoundary = [evidence, boundary && `边界：${boundary}`].filter(Boolean).join("｜");
    addText(slide, title, { left: 174, top: y, width: 450, height: 62 }, {
      fontSize: 19,
      fontFamily: fontFor(title, context.tokens),
      bold: true,
      color: context.tokens.neutral.text,
    }, `contribution-title-${index + 1}`);
    addRule(slide, 650, y + 30, 90, context.colors.secondary, 2, `contribution-link-${index + 1}`);
    addText(slide, evidenceWithBoundary || "将贡献绑定到具体结果页或证据", { left: 770, top: y, width: 430, height: 62 }, {
      fontSize: 16,
      fontFamily: fontFor(evidenceWithBoundary, context.tokens),
      color: context.colors.primaryDark,
    }, `contribution-evidence-${index + 1}`);
  });
  addTakeawayBand(slide, slideTakeaway(slideSpec), context, { top: 608, height: 52 });
}

async function renderLimitations(slide, slideSpec, context, slideNumber) {
  await addContentChrome(slide, slideSpec, context, slideNumber);
  const limitations = list(first(renderData(slideSpec).limitations, slideSpec.limitations, slideSpec.bullets, slideSpec.content?.bullets, [])).slice(0, 5);
  const nextSteps = list(first(renderData(slideSpec).next_steps, slideSpec.next_steps, slideSpec.nextSteps, [])).slice(0, 5);
  addPill(slide, "当前边界", { left: 64, top: 178, width: 520, height: 38 }, context.colors, context.tokens, {
    name: "limitations-label",
    fill: context.tokens.neutral.surfaceStrong,
    color: context.tokens.neutral.text,
  });
  addPill(slide, "下一步验证", { left: 676, top: 178, width: 540, height: 38 }, context.colors, context.tokens, {
    name: "next-steps-label",
    fill: context.colors.primaryLight,
    color: context.colors.primaryDark,
  });
  const leftItems = limitations.length ? limitations : ["明确样本、工况、文本范围或模型假设", "区分已验证结论与工程/理论外推"];
  const rightItems = nextSteps.length ? nextSteps : ["补充最能降低不确定性的验证", "给出判据、交付物和完成路径"];
  const pairCount = Math.max(leftItems.length, rightItems.length);
  const rowHeight = pairCount >= 5 ? 62 : 76;
  const rowStep = pairCount >= 5 ? 68 : 88;
  for (let index = 0; index < pairCount; index += 1) {
    const top = 236 + index * rowStep;
    const leftText = cleanText(first(leftItems[index], "待明确的研究边界"));
    const rightText = cleanText(first(rightItems[index], "对应的验证动作与判据"));
    addShape(slide, "roundRect", { left: 64, top, width: 500, height: rowHeight }, {
      name: `limitation-row-${index + 1}`, fill: index % 2 === 0 ? context.tokens.neutral.surface : context.tokens.neutral.canvas,
      line: { style: "solid", fill: context.tokens.neutral.line, width: 1 }, borderRadius: "rounded-lg",
    });
    addText(slide, leftText, { left: 90, top: top + 8, width: 448, height: rowHeight - 16 }, {
      fontSize: 16, fontFamily: fontFor(leftText, context.tokens), bold: true, color: context.tokens.neutral.text,
    }, `limitation-text-${index + 1}`);
    addRule(slide, 580, top + rowHeight / 2, 64, context.colors.secondary, 2, `limitation-arrow-line-${index + 1}`);
    addShape(slide, "rightArrow", { left: 628, top: top + rowHeight / 2 - 9, width: 20, height: 18 }, {
      name: `limitation-arrow-${index + 1}`, fill: context.colors.secondary,
      line: { style: "solid", fill: context.colors.secondary, width: 0 },
    });
    addShape(slide, "roundRect", { left: 664, top, width: 552, height: rowHeight }, {
      name: `next-step-row-${index + 1}`, fill: index % 2 === 0 ? context.colors.primaryLight : context.tokens.neutral.canvas,
      line: { style: "solid", fill: context.colors.secondary, width: 1 }, borderRadius: "rounded-lg",
    });
    addText(slide, rightText, { left: 690, top: top + 8, width: 500, height: rowHeight - 16 }, {
      fontSize: 16, fontFamily: fontFor(rightText, context.tokens), color: context.colors.primaryDark,
    }, `next-step-text-${index + 1}`);
  }
  addTakeawayBand(slide, slideTakeaway(slideSpec), context, { top: 586, height: 72 });
}

async function renderReferences(slide, slideSpec, context, slideNumber) {
  await addContentChrome(slide, slideSpec, context, slideNumber);
  const references = list(first(renderData(slideSpec).references, slideSpec.references, slideSpec.bullets, slideSpec.content?.body, [])).map(cleanText).filter(Boolean);
  const items = references.length ? references : [
    "[1] 作者. 题名. 期刊/出版社, 年份.",
    "[2] 作者. 题名. 期刊/出版社, 年份.",
    "[3] 数据、标准、档案或其他关键来源.",
  ];
  if (items.length > 12) throw new Error(`Reference slide ${slideSpec.id ?? slideNumber} has ${items.length} entries. Split selected references across multiple slides.`);
  const columns = 2;
  const split = Math.ceil(items.length / columns);
  const groupLabels = list(first(renderData(slideSpec).group_labels, renderData(slideSpec).groupLabels, ["理论与方法", "数据、标准与材料"]));
  for (let column = 0; column < columns; column += 1) {
    const subset = items.slice(column * split, (column + 1) * split);
    const left = 64 + column * 612;
    const entryHeight = subset.length >= 6 ? 52 : subset.length === 5 ? 56 : 64;
    const entryStep = subset.length > 1 ? Math.min(82, (354 - entryHeight) / (subset.length - 1)) : 0;
    addPill(slide, cleanText(first(groupLabels[column], `来源分组 ${column + 1}`)), { left, top: 174, width: 552, height: 40 }, context.colors, context.tokens, {
      name: `reference-group-${column + 1}`,
      fill: column === 0 ? context.colors.primary : context.colors.primaryLight,
      color: column === 0 ? context.tokens.neutral.white : context.colors.primaryDark,
      fontSize: 16,
    });
    subset.forEach((item, row) => {
      const top = 232 + row * entryStep;
      const number = column * split + row + 1;
      addText(slide, String(number).padStart(2, "0"), { left: left + 8, top, width: 46, height: entryHeight }, {
        fontSize: 13, fontFamily: context.tokens.fonts.en, bold: true, color: context.colors.primary, alignment: "center",
      }, `reference-number-${number}`);
      addText(slide, item.replace(/^\[?\d+\]?\.?\s*/, ""), { left: left + 64, top, width: 476, height: entryHeight }, {
        fontSize: items.length > 10 ? 13 : 15,
        fontFamily: fontFor(item, context.tokens), color: context.tokens.neutral.text, verticalAlignment: "top",
      }, `reference-entry-${number}`);
      if (row < subset.length - 1) addRule(slide, left + 64, top + entryHeight + 5, 476, context.tokens.neutral.line, 1, `reference-rule-${number}`);
    });
  }
  addTakeawayBand(slide, slideTakeaway(slideSpec), context, { top: 612, height: 46, fontSize: 15 });
}

async function renderFreeEvidence(slide, slideSpec, context, slideNumber) {
  const data = renderData(slideSpec);
  const declaredCustomElements = list(first(data.custom_elements, data.customElements, []));
  const legacyElements = list(data.elements);
  const legacyElementsArePositioned = legacyElements.length > 0 && legacyElements.every((element) => {
    const box = first(element?.position, element?.bounds, element?.box, element);
    return isObject(box) && first(box.left, box.x) != null && first(box.top, box.y) != null
      && first(box.width, box.w) != null && first(box.height, box.h) != null;
  });
  const customElements = declaredCustomElements.length ? declaredCustomElements : legacyElementsArePositioned ? legacyElements : [];
  if (customElements.length) {
    const chrome = cleanText(first(renderData(slideSpec).chrome, "standard")).toLowerCase();
    if (chrome === "standard") {
      await addContentChrome(slide, slideSpec, context, slideNumber);
    } else if (chrome === "minimal") {
      await addLogo(slide, context.brand, { left: 20, top: 12, width: 42, height: 42 }, context);
      addText(slide, slideTitle(slideSpec), { left: 76, top: 20, width: 1110, height: 48 }, {
        fontSize: 28,
        fontFamily: fontFor(slideTitle(slideSpec), context.tokens),
        bold: true,
        color: context.tokens.neutral.text,
      }, "custom-minimal-title");
      addRule(slide, 0, 76, 1280, context.tokens.neutral.line, 1, "custom-minimal-rule");
    } else if (chrome !== "none") {
      throw new Error(`Unsupported free-canvas chrome mode: ${chrome}. Use standard, minimal, or none.`);
    }

    for (let index = 0; index < customElements.length; index += 1) {
      const element = customElements[index];
      if (!isObject(element)) throw new Error(`Free-canvas element ${index + 1} must be an object.`);
      const box = first(element.position, element.bounds, element.box, element);
      const position = {
        left: Number(first(box.left, box.x)),
        top: Number(first(box.top, box.y)),
        width: Number(first(box.width, box.w)),
        height: Number(first(box.height, box.h)),
      };
      if (!Object.values(position).every(Number.isFinite) || position.width <= 0 || position.height <= 0) {
        throw new Error(`Free-canvas element ${index + 1} requires a finite positive left/top/width/height (or x/y/w/h) box.`);
      }
      const type = cleanText(first(element.type, "text")).toLowerCase();
      const name = cleanText(first(element.name, element.id, `custom-element-${index + 1}`));
      if (type === "image") {
        const request = normalizeAssetRequest(first(element.asset_ref, element.assetRef, element.asset, element.path, element.src), context.assetIndex, context.baseDir);
        await addImageOrPlaceholder(slide, request, position, {
          ...context,
          name,
          fit: first(element.fit, "contain"),
          placeholderLabel: first(element.alt, element.alt_text, "自定义证据视觉"),
        });
      } else if (type === "shape") {
        const fill = first(element.fill, element.style?.fill, context.tokens.neutral.surface);
        const line = first(element.line, element.style?.line, { style: "solid", fill: context.tokens.neutral.line, width: 1 });
        addShape(slide, cleanText(first(element.geometry, element.shape, "roundRect")), position, {
          name,
          fill,
          line,
          borderRadius: first(element.borderRadius, element.border_radius, "rounded-lg"),
          rotation: Number(first(element.rotation, 0)),
        });
      } else if (type === "line") {
        addShape(slide, "rect", position, {
          name,
          fill: first(element.color, element.fill, context.colors.primary),
          line: { style: "solid", fill: first(element.color, element.fill, context.colors.primary), width: 0 },
        });
      } else if (type === "text" || type === "metric") {
        const value = cleanText(first(element.text, element.value, element.label, ""));
        const style = isObject(element.style) ? element.style : {};
        addText(slide, value, position, {
          fontSize: Number(first(style.fontSize, style.font_size, element.fontSize, element.font_size, type === "metric" ? 30 : 18)),
          fontFamily: first(style.fontFamily, style.font_family, fontFor(value, context.tokens)),
          bold: Boolean(first(style.bold, element.bold, type === "metric")),
          color: first(style.color, element.color, context.tokens.neutral.text),
          alignment: first(style.alignment, element.alignment, "left"),
          verticalAlignment: first(style.verticalAlignment, style.vertical_alignment, element.verticalAlignment, "top"),
          wrap: first(style.wrap, element.wrap, true),
        }, name);
      } else {
        throw new Error(`Unsupported free-canvas element type "${type}" at element ${index + 1}.`);
      }
    }
    return;
  }

  await addContentChrome(slide, slideSpec, context, slideNumber);
  const assets = slideAssetRequests(slideSpec, context.assetIndex, context.baseDir);
  if (assets.length >= 2) {
    await addImageOrPlaceholder(slide, assets[0], { left: 64, top: 176, width: 550, height: 350 }, { ...context, name: "free-image-1" });
    await addImageOrPlaceholder(slide, assets[1], { left: 640, top: 176, width: 576, height: 350 }, { ...context, name: "free-image-2" });
  } else {
    await addImageOrPlaceholder(slide, assets[0], { left: 64, top: 176, width: 750, height: 386 }, { ...context, name: "free-primary-image", placeholderLabel: "自由证据主画布" });
    addText(slide, slideTakeaway(slideSpec) || "当注册布局不匹配时，从证据关系重新设计，而不是强套模板。", {
      left: 850, top: 190, width: 350, height: 180,
    }, {
      fontSize: 26,
      fontFamily: context.tokens.fonts.zh,
      bold: true,
      color: context.colors.primaryDark,
      verticalAlignment: "top",
    }, "free-evidence-claim");
    addBulletList(slide, slideBullets(slideSpec).slice(0, 4), { left: 850, top: 400, width: 350, height: 160 }, {
      fontSize: 15,
      color: context.tokens.neutral.muted,
    }, context.tokens, "free-evidence-bullets");
  }
  addTakeawayBand(slide, slideTakeaway(slideSpec), context, { top: 598, height: 58 });
}

async function renderThreeColumnOverview(slide, slideSpec, context, slideNumber) {
  await addContentChrome(slide, slideSpec, context, slideNumber);
  const items = semanticItems(slideSpec, ["items", "columns", "evidence_items", "evidenceItems"], 3).slice(0, 3);
  const banner = cleanText(first(renderData(slideSpec).banner, renderData(slideSpec).conclusion, slideTakeaway(slideSpec), "三个并列维度共同界定本页问题"));
  addShape(slide, "roundRect", { left: 146, top: 162, width: 988, height: 54 }, {
    name: "overview-banner", fill: context.colors.primary,
    line: { style: "solid", fill: context.colors.primary, width: 0 }, borderRadius: "rounded-lg",
  });
  addText(slide, banner, { left: 174, top: 169, width: 932, height: 40 }, {
    fontSize: 19, fontFamily: fontFor(banner, context.tokens), bold: true,
    color: context.tokens.neutral.white, alignment: "center",
  }, "overview-banner-text");
  const cardWidth = 354;
  items.forEach((item, index) => {
    const left = 64 + index * 399;
    addShape(slide, "roundRect", { left, top: 238, width: cardWidth, height: 348 }, {
      name: `overview-card-${index + 1}`, fill: context.tokens.neutral.canvas,
      line: { style: "solid", fill: context.colors.secondary, width: 1.4 }, borderRadius: "rounded-lg",
    });
    const marker = cleanText(first(item.value, item.number));
    addText(slide, marker, { left: left + 24, top: 258, width: cardWidth - 48, height: 54 }, {
      fontSize: 28, fontFamily: context.tokens.fonts.en, bold: true,
      color: context.colors.primary, alignment: "center",
    }, `overview-number-${index + 1}`);
    addText(slide, item.title, { left: left + 28, top: 322, width: cardWidth - 56, height: 68 }, {
      fontSize: 20, fontFamily: fontFor(item.title, context.tokens), bold: true,
      color: context.tokens.neutral.text, alignment: "center",
    }, `overview-title-${index + 1}`);
    addRule(slide, left + 96, 401, cardWidth - 192, context.tokens.neutral.line, 1, `overview-rule-${index + 1}`);
    addText(slide, item.body || "补充支撑该维度的证据、边界或解释。", { left: left + 32, top: 420, width: cardWidth - 64, height: 130 }, {
      fontSize: 16, fontFamily: fontFor(item.body, context.tokens), color: context.tokens.neutral.muted,
      alignment: "center", verticalAlignment: "top",
    }, `overview-body-${index + 1}`);
  });
}

async function renderThreeLevelAnalysis(slide, slideSpec, context, slideNumber) {
  await addContentChrome(slide, slideSpec, context, slideNumber);
  const items = semanticItems(slideSpec, ["items", "levels", "branches", "categories"], 3).slice(0, 3);
  const label = cleanText(first(renderData(slideSpec).root_label, renderData(slideSpec).side_label, renderData(slideSpec).label, "分析主轴"));
  addShape(slide, "ellipse", { left: 0, top: 212, width: 220, height: 300 }, {
    name: "analysis-root-disc", fill: context.colors.primary,
    line: { style: "solid", fill: context.colors.primary, width: 0 },
  });
  addText(slide, label, { left: 30, top: 304, width: 146, height: 100 }, {
    fontSize: 22, fontFamily: fontFor(label, context.tokens), bold: true,
    color: context.tokens.neutral.white, alignment: "center",
  }, "analysis-root-label");
  items.forEach((item, index) => {
    const top = 174 + index * 142;
    addShape(slide, "roundRect", { left: 236, top, width: 262, height: 108 }, {
      name: `analysis-topic-${index + 1}`, fill: index === 1 ? context.colors.primary : context.colors.primaryLight,
      line: { style: "solid", fill: context.colors.primary, width: 1.2 }, borderRadius: "rounded-lg",
    });
    addText(slide, item.title, { left: 258, top: top + 16, width: 218, height: 76 }, {
      fontSize: 19, fontFamily: fontFor(item.title, context.tokens), bold: true,
      color: index === 1 ? context.tokens.neutral.white : context.colors.primaryDark, alignment: "center",
    }, `analysis-topic-text-${index + 1}`);
    addRule(slide, 498, top + 53, 54, context.colors.secondary, 2, `analysis-link-${index + 1}`);
    addShape(slide, "roundRect", { left: 552, top, width: 640, height: 108 }, {
      name: `analysis-detail-${index + 1}`, fill: context.tokens.neutral.surface,
      line: { style: "solid", fill: context.tokens.neutral.line, width: 1 }, borderRadius: "rounded-lg",
    });
    addText(slide, item.body || "列出该分支的代表性观点、证据或研究空白。", { left: 578, top: top + 12, width: 588, height: 84 }, {
      fontSize: 16, fontFamily: fontFor(item.body, context.tokens), color: context.tokens.neutral.text,
      verticalAlignment: "middle",
    }, `analysis-detail-text-${index + 1}`);
  });
  addTakeawayBand(slide, slideTakeaway(slideSpec), context, { top: 610, height: 48, fontSize: 16 });
}

async function renderFourPointList(slide, slideSpec, context, slideNumber) {
  await addContentChrome(slide, slideSpec, context, slideNumber);
  const items = semanticItems(slideSpec, ["items", "points"], 4).slice(0, 4);
  items.forEach((item, index) => {
    const top = 170 + index * 105;
    const letter = cleanText(first(item.letter, String.fromCharCode(65 + index)));
    addShape(slide, "ellipse", { left: 82, top: top + 8, width: 68, height: 68 }, {
      name: `point-marker-${index + 1}`, fill: index === 0 ? context.colors.primary : context.colors.primaryLight,
      line: { style: "solid", fill: context.colors.primary, width: 1.5 },
    });
    addText(slide, letter, { left: 82, top: top + 8, width: 68, height: 68 }, {
      fontSize: 23, fontFamily: context.tokens.fonts.en, bold: true,
      color: index === 0 ? context.tokens.neutral.white : context.colors.primary, alignment: "center",
    }, `point-letter-${index + 1}`);
    addText(slide, item.title, { left: 188, top, width: 300, height: 40 }, {
      fontSize: 20, fontFamily: fontFor(item.title, context.tokens), bold: true, color: context.tokens.neutral.text,
    }, `point-title-${index + 1}`);
    addText(slide, item.body || "说明这一点如何影响研究问题、方法选择或结论边界。", { left: 188, top: top + 42, width: 930, height: 44 }, {
      fontSize: 16, fontFamily: fontFor(item.body, context.tokens), color: context.tokens.neutral.muted,
    }, `point-body-${index + 1}`);
    if (index < items.length - 1) addRule(slide, 188, top + 94, 960, context.tokens.neutral.line, 1, `point-rule-${index + 1}`);
  });
  addTakeawayBand(slide, slideTakeaway(slideSpec), context, { top: 606, height: 52, fontSize: 16 });
}

async function renderThreeRowContent(slide, slideSpec, context, slideNumber) {
  await addContentChrome(slide, slideSpec, context, slideNumber);
  const items = semanticItems(slideSpec, ["items", "rows", "modules"], 3).slice(0, 3);
  items.forEach((item, index) => {
    const top = 176 + index * 132;
    addShape(slide, "roundRect", { left: 72, top, width: 150, height: 104 }, {
      name: `row-number-block-${index + 1}`, fill: context.colors.primary,
      line: { style: "solid", fill: context.colors.primary, width: 0 }, borderRadius: "rounded-lg",
    });
    addText(slide, item.number, { left: 72, top: top + 12, width: 150, height: 40 }, {
      fontSize: 25, fontFamily: context.tokens.fonts.en, bold: true, color: context.tokens.neutral.white, alignment: "center",
    }, `row-number-${index + 1}`);
    addText(slide, item.title, { left: 72, top: top + 52, width: 150, height: 38 }, {
      fontSize: 16, fontFamily: fontFor(item.title, context.tokens), bold: true, color: "#EDF1F8", alignment: "center",
    }, `row-title-in-block-${index + 1}`);
    addShape(slide, "roundRect", { left: 244, top, width: 948, height: 104 }, {
      name: `row-content-${index + 1}`, fill: index % 2 === 0 ? context.tokens.neutral.surface : context.colors.primaryLight,
      line: { style: "solid", fill: context.tokens.neutral.line, width: 1 }, borderRadius: "rounded-lg",
    });
    addText(slide, item.body || "用一至两句说明这一研究模块的任务、证据和预期输出。", { left: 276, top: top + 14, width: 884, height: 76 }, {
      fontSize: 18, fontFamily: fontFor(item.body, context.tokens), color: context.tokens.neutral.text,
    }, `row-body-${index + 1}`);
  });
  addTakeawayBand(slide, slideTakeaway(slideSpec), context, { top: 598, height: 58 });
}

async function renderMultiImageEvidence(slide, slideSpec, context, slideNumber) {
  await addContentChrome(slide, slideSpec, context, slideNumber);
  const assets = slideAssetRequests(slideSpec, context.assetIndex, context.baseDir);
  const data = renderData(slideSpec);
  const semantic = semanticItems(slideSpec, ["items", "evidence", "panels"], 0);
  const labels = list(first(data.captions, data.labels, semantic.map((item) => [item.title, item.body].filter(Boolean).join("｜"))));
  const count = clamp(Math.max(assets.length, labels.length, 2), 2, 4);
  const frames = count === 2
    ? [{ left: 64, top: 174, width: 542, height: 316 }, { left: 674, top: 174, width: 542, height: 316 }]
    : count === 3
      ? Array.from({ length: 3 }, (_, index) => ({ left: 64 + index * 390, top: 174, width: 362, height: 294 }))
      : [
        { left: 64, top: 174, width: 552, height: 166 }, { left: 664, top: 174, width: 552, height: 166 },
        { left: 64, top: 392, width: 552, height: 166 }, { left: 664, top: 392, width: 552, height: 166 },
      ];
  const captionTop = (frame, index) => count === 2 ? 500 : count === 3 ? 478 : (index < 2 ? 346 : 564);
  const captionHeight = count === 4 ? 38 : count === 3 ? 78 : 72;
  for (let index = 0; index < count; index += 1) {
    await addImageOrPlaceholder(slide, assets[index], frames[index], { ...context, name: `multi-evidence-${index + 1}`, placeholderLabel: `论文证据图 ${index + 1}` });
    const caption = cleanText(first(labels[index], semantic[index]?.title, assets[index]?.caption, `证据图 ${index + 1} 的说明`));
    addText(slide, caption, { left: frames[index].left + 8, top: captionTop(frames[index], index), width: frames[index].width - 16, height: captionHeight }, {
      fontSize: count === 4 ? 13 : 15, fontFamily: fontFor(caption, context.tokens), color: context.tokens.neutral.muted,
      alignment: "center", verticalAlignment: "top",
    }, `multi-evidence-caption-${index + 1}`);
  }
  const boundary = cleanText(first(data.boundary, ""));
  const summary = [slideTakeaway(slideSpec), boundary && `边界：${boundary}`].filter(Boolean).join("｜");
  addTakeawayBand(slide, summary, context, { top: 602, height: 56, fontSize: boundary ? 15 : 18 });
}

async function renderFourObjectives(slide, slideSpec, context, slideNumber) {
  await addContentChrome(slide, slideSpec, context, slideNumber);
  const items = semanticItems(slideSpec, ["items", "objectives"], 4).slice(0, 4);
  const overallGoal = cleanText(first(renderData(slideSpec).overall_goal, "总目标｜用一句话界定研究要解决的问题"));
  addPill(slide, overallGoal, { left: 170, top: 162, width: 940, height: 48 }, context.colors, context.tokens, {
    name: "objectives-overall-goal", fill: context.colors.primary, color: context.tokens.neutral.white, fontSize: 18,
  });
  items.forEach((item, index) => {
    const left = 64 + index * 292;
    const top = 232;
    addShape(slide, "roundRect", { left, top, width: 260, height: 338 }, {
      name: `objective-card-${index + 1}`, fill: context.tokens.neutral.surface,
      line: { style: "solid", fill: context.colors.primary, width: 1.3 }, borderRadius: "rounded-xl",
    });
    addShape(slide, "ellipse", { left: left + 94, top: top + 28, width: 72, height: 72 }, {
      name: `objective-number-disc-${index + 1}`, fill: context.colors.primary,
      line: { style: "solid", fill: context.colors.primary, width: 0 },
    });
    addText(slide, item.number, { left: left + 94, top: top + 28, width: 72, height: 72 }, {
      fontSize: 23, fontFamily: context.tokens.fonts.en, bold: true,
      color: context.tokens.neutral.white, alignment: "center",
    }, `objective-number-${index + 1}`);
    addText(slide, item.title, { left: left + 24, top: top + 124, width: 212, height: 64 }, {
      fontSize: 20, fontFamily: fontFor(item.title, context.tokens), bold: true,
      color: context.tokens.neutral.text, alignment: "center",
    }, `objective-title-${index + 1}`);
    addRule(slide, left + 54, top + 202, 152, context.colors.secondary, 2, `objective-rule-${index + 1}`);
    addText(slide, item.body || "一句话写清目标、判据或交付物。", { left: left + 30, top: top + 222, width: 200, height: 86 }, {
      fontSize: 15, fontFamily: fontFor(item.body, context.tokens),
      color: context.tokens.neutral.muted, alignment: "center", verticalAlignment: "top",
    }, `objective-body-${index + 1}`);
  });
  addTakeawayBand(slide, slideTakeaway(slideSpec), context, { top: 612, height: 48, fontSize: 16 });
}

async function renderThesisFramework(slide, slideSpec, context, slideNumber) {
  await addContentChrome(slide, slideSpec, context, slideNumber);
  const nodes = diagramNodes(slideSpec).slice(0, 7);
  const root = nodes[0] ?? { label: "研究总目标" };
  const branches = nodes.slice(1, 4);
  while (branches.length < 3) branches.push({ label: `研究模块 ${branches.length + 1}`, detail: "关键任务" });
  const evidence = nodes.slice(4, 7);
  while (evidence.length < 3) evidence.push({ label: `证据输出 ${evidence.length + 1}`, detail: "图 / 表 / 式 / 案例" });
  addShape(slide, "roundRect", { left: 420, top: 166, width: 440, height: 70 }, {
    name: "thesis-root", fill: context.colors.primary,
    line: { style: "solid", fill: context.colors.primary, width: 0 }, borderRadius: "rounded-lg",
  });
  addText(slide, cleanText(root.label), { left: 446, top: 177, width: 388, height: 48 }, {
    fontSize: 22, fontFamily: fontFor(root.label, context.tokens), bold: true, color: context.tokens.neutral.white, alignment: "center",
  }, "thesis-root-label");
  addVerticalRule(slide, 638, 236, 60, context.colors.secondary, 4, "thesis-root-stem");
  addRule(slide, 202, 294, 876, context.colors.secondary, 3, "thesis-branch-rail");
  branches.forEach((node, index) => {
    const left = 72 + index * 414;
    const center = left + 156;
    addShape(slide, "rect", { left: center - 2, top: 294, width: 4, height: 32 }, {
      name: `thesis-branch-stem-${index + 1}`, fill: context.colors.secondary,
      line: { style: "solid", fill: context.colors.secondary, width: 0 },
    });
    addShape(slide, "roundRect", { left, top: 326, width: 312, height: 96 }, {
      name: `thesis-branch-${index + 1}`, fill: context.colors.primaryLight,
      line: { style: "solid", fill: context.colors.primary, width: 1.2 }, borderRadius: "rounded-lg",
    });
    addText(slide, cleanText(node.label), { left: left + 20, top: 338, width: 272, height: 70 }, {
      fontSize: 19, fontFamily: fontFor(node.label, context.tokens), bold: true, color: context.colors.primaryDark, alignment: "center",
    }, `thesis-branch-label-${index + 1}`);
    addShape(slide, "rect", { left: center - 2, top: 422, width: 4, height: 34 }, {
      name: `thesis-evidence-stem-${index + 1}`, fill: context.tokens.neutral.line,
      line: { style: "solid", fill: context.tokens.neutral.line, width: 0 },
    });
    addShape(slide, "roundRect", { left, top: 456, width: 312, height: 102 }, {
      name: `thesis-evidence-${index + 1}`, fill: context.tokens.neutral.surface,
      line: { style: "solid", fill: context.tokens.neutral.line, width: 1 }, borderRadius: "rounded-lg",
    });
    const evidenceText = [cleanText(evidence[index].label), cleanText(evidence[index].detail)].filter(Boolean).join("\n");
    addText(slide, evidenceText, { left: left + 22, top: 468, width: 268, height: 78 }, {
      fontSize: 15, fontFamily: fontFor(evidenceText, context.tokens), color: context.tokens.neutral.text, alignment: "center",
    }, `thesis-evidence-label-${index + 1}`);
  });
  addTakeawayBand(slide, slideTakeaway(slideSpec), context, { top: 604, height: 54, fontSize: 16 });
}

async function renderRadialMethods(slide, slideSpec, context, slideNumber) {
  await addContentChrome(slide, slideSpec, context, slideNumber);
  const items = semanticItems(slideSpec, ["items", "methods"], 4).slice(0, 4);
  const center = cleanText(first(renderData(slideSpec).center, renderData(slideSpec).center_label, slideTakeaway(slideSpec), "共同服务于核心问题"));
  const nodes = [
    { left: 490, top: 168, width: 300, height: 94 },
    { left: 112, top: 328, width: 300, height: 104 },
    { left: 868, top: 328, width: 300, height: 104 },
    { left: 490, top: 500, width: 300, height: 94 },
  ];
  addVerticalRule(slide, 638, 262, 238, context.tokens.neutral.line, 3, "radial-vertical-link");
  addRule(slide, 412, 378, 456, context.tokens.neutral.line, 3, "radial-horizontal-link");
  addShape(slide, "ellipse", { left: 520, top: 304, width: 240, height: 148 }, {
    name: "radial-center", fill: context.colors.primary,
    line: { style: "solid", fill: context.colors.primary, width: 0 },
  });
  addText(slide, center, { left: 540, top: 326, width: 200, height: 104 }, {
    fontSize: 19, fontFamily: fontFor(center, context.tokens), bold: true, color: context.tokens.neutral.white, alignment: "center",
  }, "radial-center-label");
  items.forEach((item, index) => {
    const pos = nodes[index];
    addShape(slide, "roundRect", pos, {
      name: `radial-node-${index + 1}`, fill: context.tokens.neutral.surface,
      line: { style: "solid", fill: context.colors.secondary, width: 1.3 }, borderRadius: "rounded-lg",
    });
    addText(slide, item.title, { left: pos.left + 18, top: pos.top + 8, width: pos.width - 36, height: 38 }, {
      fontSize: 18, fontFamily: fontFor(item.title, context.tokens), bold: true, color: context.colors.primaryDark, alignment: "center",
    }, `radial-title-${index + 1}`);
    addText(slide, item.body || "并行方法或分析维度", { left: pos.left + 18, top: pos.top + 47, width: pos.width - 36, height: pos.height - 54 }, {
      fontSize: 14, fontFamily: fontFor(item.body, context.tokens), color: context.tokens.neutral.muted, alignment: "center",
    }, `radial-body-${index + 1}`);
  });
  addTakeawayBand(slide, slideTakeaway(slideSpec), context, { top: 618, height: 42, fontSize: 15 });
}

async function renderFourStepRibbon(slide, slideSpec, context, slideNumber) {
  await addContentChrome(slide, slideSpec, context, slideNumber);
  const items = semanticItems(slideSpec, ["items", "steps"], 4).slice(0, 4);
  // The staggered cards keep the original template's rhythm, while elbow
  // connectors preserve the actual 1 -> 2 -> 3 -> 4 sequence.
  items.slice(0, -1).forEach((_, index) => {
    const currentLeft = 66 + index * 302;
    const currentTop = index % 2 === 0 ? 220 : 326;
    const nextLeft = 66 + (index + 1) * 302;
    const nextTop = (index + 1) % 2 === 0 ? 220 : 326;
    const startX = currentLeft + 246;
    const startY = currentTop + 87;
    const endY = nextTop + 87;
    const elbowX = startX + (nextLeft - startX) / 2;
    addRule(slide, startX, startY - 2, elbowX - startX, context.colors.secondary, 4, `ribbon-link-a-${index + 1}`);
    addVerticalRule(slide, elbowX - 2, Math.min(startY, endY), Math.abs(endY - startY), context.colors.secondary, 4, `ribbon-link-b-${index + 1}`);
    addRule(slide, elbowX, endY - 2, nextLeft - elbowX - 14, context.colors.secondary, 4, `ribbon-link-c-${index + 1}`);
    addShape(slide, "rightArrow", { left: nextLeft - 16, top: endY - 9, width: 18, height: 18 }, {
      name: `ribbon-arrow-${index + 1}`, fill: context.colors.secondary,
      line: { style: "solid", fill: context.colors.secondary, width: 0 },
    });
  });
  items.forEach((item, index) => {
    const left = 66 + index * 302;
    const top = index % 2 === 0 ? 220 : 326;
    addShape(slide, "roundRect", { left, top, width: 246, height: 174 }, {
      name: `ribbon-step-${index + 1}`, fill: index === 0 ? context.colors.primary : context.colors.primaryLight,
      line: { style: "solid", fill: context.colors.primary, width: 1.2 }, borderRadius: "rounded-xl",
    });
    addText(slide, `STEP ${item.number}`, { left: left + 22, top: top + 18, width: 202, height: 34 }, {
      fontSize: 15, fontFamily: context.tokens.fonts.en, bold: true,
      color: index === 0 ? context.colors.accent : context.colors.primary,
    }, `ribbon-step-number-${index + 1}`);
    addText(slide, item.title, { left: left + 22, top: top + 56, width: 202, height: 54 }, {
      fontSize: 19, fontFamily: fontFor(item.title, context.tokens), bold: true,
      color: index === 0 ? context.tokens.neutral.white : context.tokens.neutral.text,
    }, `ribbon-step-title-${index + 1}`);
    addText(slide, item.body || "说明本步骤的输入、动作与输出。", { left: left + 22, top: top + 112, width: 202, height: 46 }, {
      fontSize: 14, fontFamily: fontFor(item.body, context.tokens),
      color: index === 0 ? "#EDF1F8" : context.tokens.neutral.muted,
    }, `ribbon-step-body-${index + 1}`);
  });
  addTakeawayBand(slide, slideTakeaway(slideSpec), context, { top: 592, height: 64 });
}

async function renderInnovationBrackets(slide, slideSpec, context, slideNumber) {
  await addContentChrome(slide, slideSpec, context, slideNumber);
  const items = semanticItems(slideSpec, ["items", "innovations", "contributions"], 3).map((item, index) => ({
    ...item,
    title: cleanText(first(item.novelty, item.title, `创新 ${index + 1}`)),
    body: cleanText(first(
      item.body,
      item.gap || item.novelty || item.validation
        ? [item.gap && `缺口：${cleanText(item.gap)}`, item.novelty && `新做法：${cleanText(item.novelty)}`, item.validation && `验证：${cleanText(item.validation)}`].filter(Boolean).join("｜")
        : "",
    )),
  })).slice(0, 3);
  const label = cleanText(first(renderData(slideSpec).center, renderData(slideSpec).label, "创新与贡献"));
  addShape(slide, "ellipse", { left: 84, top: 246, width: 230, height: 230 }, {
    name: "innovation-disc", fill: context.colors.primary,
    line: { style: "solid", fill: context.colors.primary, width: 0 },
  });
  addText(slide, label, { left: 106, top: 302, width: 186, height: 116 }, {
    fontSize: 22, fontFamily: fontFor(label, context.tokens), bold: true, color: context.tokens.neutral.white, alignment: "center",
  }, "innovation-disc-label");
  items.forEach((item, index) => {
    const top = 178 + index * 140;
    addRule(slide, 314, top + 55, 80, context.colors.secondary, 3, `innovation-link-${index + 1}`);
    addShape(slide, "roundRect", { left: 394, top, width: 796, height: 110 }, {
      name: `innovation-row-${index + 1}`, fill: index === 1 ? context.colors.primaryLight : context.tokens.neutral.surface,
      line: { style: "solid", fill: context.colors.secondary, width: 1.2 }, borderRadius: "rounded-lg",
    });
    addText(slide, item.number, { left: 416, top: top + 20, width: 68, height: 66 }, {
      fontSize: 25, fontFamily: context.tokens.fonts.en, bold: true, color: context.colors.primary, alignment: "center",
    }, `innovation-number-${index + 1}`);
    addText(slide, item.title, { left: 504, top: top + 12, width: 300, height: 40 }, {
      fontSize: 19, fontFamily: fontFor(item.title, context.tokens), bold: true, color: context.tokens.neutral.text,
    }, `innovation-title-${index + 1}`);
    addText(slide, item.body || "说明相对于已有工作的新增动作，并绑定结果页证据。", { left: 504, top: top + 52, width: 652, height: 46 }, {
      fontSize: 14, fontFamily: fontFor(item.body, context.tokens), color: context.tokens.neutral.muted,
    }, `innovation-body-${index + 1}`);
  });
  addTakeawayBand(slide, slideTakeaway(slideSpec), context, { top: 610, height: 48, fontSize: 16 });
}

async function renderFourResultsCycle(slide, slideSpec, context, slideNumber) {
  await addContentChrome(slide, slideSpec, context, slideNumber);
  const items = semanticItems(slideSpec, ["items", "results"], 4).slice(0, 4);
  const positions = [
    { left: 466, top: 166, width: 348, height: 100 },
    { left: 858, top: 330, width: 350, height: 112 },
    { left: 466, top: 504, width: 348, height: 100 },
    { left: 72, top: 330, width: 350, height: 112 },
  ];
  addVerticalRule(slide, 638, 266, 238, context.tokens.neutral.line, 3, "results-cycle-vertical");
  addRule(slide, 422, 384, 436, context.tokens.neutral.line, 3, "results-cycle-horizontal");
  // A clockwise outer loop makes the claimed cycle explicit rather than
  // relying on decorative radial spokes.
  addRule(slide, 814, 214, 219, context.colors.secondary, 3, "results-cycle-1-2-top");
  addVerticalRule(slide, 1031, 214, 104, context.colors.secondary, 3, "results-cycle-1-2-side");
  addShape(slide, "downArrow", { left: 1022, top: 310, width: 20, height: 22 }, {
    name: "results-cycle-arrow-1-2", fill: context.colors.secondary,
    line: { style: "solid", fill: context.colors.secondary, width: 0 },
  });
  addVerticalRule(slide, 1031, 442, 112, context.colors.secondary, 3, "results-cycle-2-3-side");
  addRule(slide, 814, 552, 219, context.colors.secondary, 3, "results-cycle-2-3-bottom");
  addShape(slide, "leftArrow", { left: 806, top: 543, width: 22, height: 20 }, {
    name: "results-cycle-arrow-2-3", fill: context.colors.secondary,
    line: { style: "solid", fill: context.colors.secondary, width: 0 },
  });
  addRule(slide, 247, 552, 219, context.colors.secondary, 3, "results-cycle-3-4-bottom");
  addVerticalRule(slide, 247, 442, 112, context.colors.secondary, 3, "results-cycle-3-4-side");
  addShape(slide, "upArrow", { left: 238, top: 430, width: 20, height: 22 }, {
    name: "results-cycle-arrow-3-4", fill: context.colors.secondary,
    line: { style: "solid", fill: context.colors.secondary, width: 0 },
  });
  addVerticalRule(slide, 247, 214, 116, context.colors.secondary, 3, "results-cycle-4-1-side");
  addRule(slide, 247, 214, 219, context.colors.secondary, 3, "results-cycle-4-1-top");
  addShape(slide, "rightArrow", { left: 452, top: 205, width: 22, height: 20 }, {
    name: "results-cycle-arrow-4-1", fill: context.colors.secondary,
    line: { style: "solid", fill: context.colors.secondary, width: 0 },
  });
  addText(slide, "闭环方向：1 → 2 → 3 → 4 → 1", { left: 470, top: 270, width: 340, height: 26 }, {
    fontSize: 13, fontFamily: context.tokens.fonts.zh, bold: true,
    color: context.colors.secondary, alignment: "center",
  }, "results-cycle-direction");
  addShape(slide, "diamond", { left: 540, top: 300, width: 200, height: 168 }, {
    name: "results-cycle-center", fill: context.colors.primary,
    line: { style: "solid", fill: context.colors.primary, width: 0 },
  });
  const centerLabel = cleanText(first(renderData(slideSpec).center, "核心结果"));
  addText(slide, centerLabel, { left: 560, top: 342, width: 160, height: 78 }, {
    fontSize: 20, fontFamily: fontFor(centerLabel, context.tokens), bold: true, color: context.tokens.neutral.white, alignment: "center",
  }, "results-cycle-center-label");
  items.forEach((item, index) => {
    const pos = positions[index];
    addShape(slide, "roundRect", pos, {
      name: `result-node-${index + 1}`, fill: context.tokens.neutral.surface,
      line: { style: "solid", fill: context.colors.secondary, width: 1.2 }, borderRadius: "rounded-lg",
    });
    addText(slide, item.title, { left: pos.left + 18, top: pos.top + 8, width: pos.width - 36, height: 38 }, {
      fontSize: 18, fontFamily: fontFor(item.title, context.tokens), bold: true, color: context.colors.primaryDark, alignment: "center",
    }, `result-title-${index + 1}`);
    addText(slide, item.body || "用一个数字或一句证据性结论概括。", { left: pos.left + 18, top: pos.top + 48, width: pos.width - 36, height: pos.height - 56 }, {
      fontSize: 14, fontFamily: fontFor(item.body, context.tokens), color: context.tokens.neutral.muted, alignment: "center",
    }, `result-body-${index + 1}`);
  });
  addTakeawayBand(slide, slideTakeaway(slideSpec), context, { top: 618, height: 42, fontSize: 15 });
}

async function renderTwoImageResults(slide, slideSpec, context, slideNumber) {
  await addContentChrome(slide, slideSpec, context, slideNumber);
  const assets = slideAssetRequests(slideSpec, context.assetIndex, context.baseDir);
  const data = renderData(slideSpec);
  const panels = semanticItems(slideSpec, ["panels", "items"], 2).slice(0, 2);
  const frames = [
    { left: 64, top: 174, width: 550, height: 328 },
    { left: 666, top: 174, width: 550, height: 328 },
  ];
  for (let index = 0; index < 2; index += 1) {
    await addImageOrPlaceholder(slide, assets[index], frames[index], { ...context, name: `result-image-${index + 1}`, placeholderLabel: `结果图 ${index + 1}` });
    addShape(slide, "rect", { left: frames[index].left, top: 510, width: frames[index].width, height: 70 }, {
      name: `result-caption-band-${index + 1}`, fill: index === 0 ? context.colors.primaryDark : context.colors.primary,
      line: { style: "solid", fill: context.colors.primary, width: 0 },
    });
    const label = cleanText(first(index === 0 ? data.left_label : data.right_label, panels[index]?.title, assets[index]?.caption, `结果 ${index + 1}`));
    const conclusion = cleanText(first(index === 0 ? data.left_conclusion : data.right_conclusion, panels[index]?.body, ""));
    const caption = [label, conclusion].filter(Boolean).join("｜");
    addText(slide, caption, { left: frames[index].left + 22, top: 520, width: frames[index].width - 44, height: 50 }, {
      fontSize: 17, fontFamily: fontFor(caption, context.tokens), bold: true, color: context.tokens.neutral.white, alignment: "center",
    }, `result-caption-${index + 1}`);
  }
  addTakeawayBand(slide, slideTakeaway(slideSpec), context, { top: 608, height: 50, fontSize: 16 });
}

async function renderFigureConclusion(slide, slideSpec, context, slideNumber) {
  await addContentChrome(slide, slideSpec, context, slideNumber);
  const assets = slideAssetRequests(slideSpec, context.assetIndex, context.baseDir);
  const data = renderData(slideSpec);
  await addImageOrPlaceholder(slide, assets[0], { left: 64, top: 174, width: 770, height: 404 }, {
    ...context, name: "figure-conclusion-image", placeholderLabel: "承担主要证据的核心图",
  });
  addShape(slide, "roundRect", { left: 866, top: 188, width: 350, height: 374 }, {
    name: "figure-conclusion-panel", fill: context.tokens.neutral.canvas,
    line: { style: "solid", fill: context.colors.primary, width: 1.5 }, borderRadius: "rounded-lg",
  });
  addText(slide, "结论", { left: 894, top: 210, width: 294, height: 38 }, {
    fontSize: 18, fontFamily: context.tokens.fonts.zh, bold: true, color: context.colors.primary,
  }, "figure-conclusion-label");
  const claim = cleanText(first(data.conclusion, slideTakeaway(slideSpec), "用一句可验证的结论解释左侧主图。"));
  addText(slide, claim, { left: 894, top: 258, width: 294, height: 136 }, {
    fontSize: 24, fontFamily: fontFor(claim, context.tokens), bold: true, color: context.colors.primaryDark, verticalAlignment: "top",
  }, "figure-conclusion-claim");
  const metric = slideMetrics(slideSpec)[0];
  if (metric) addKeyNumber(slide, metric, { left: 894, top: 414, width: 294, height: 118 }, context.colors, context.tokens, "figure-conclusion-metric");
  else addBulletList(slide, slideBullets(slideSpec).slice(0, 3), { left: 894, top: 414, width: 294, height: 124 }, {
    fontSize: 15, color: context.tokens.neutral.muted,
  }, context.tokens, "figure-conclusion-bullets");
  const caption = cleanText(first(data.caption, assets[0]?.caption, ""));
  if (caption) addText(slide, caption, { left: 72, top: 584, width: 754, height: 30 }, {
    fontSize: 13, fontFamily: fontFor(caption, context.tokens), color: context.tokens.neutral.subtle, alignment: "center",
  }, "figure-conclusion-caption");
}

async function renderConclusionList(slide, slideSpec, context, slideNumber) {
  await addContentChrome(slide, slideSpec, context, slideNumber);
  const data = renderData(slideSpec);
  const items = semanticItems(slideSpec, ["items", "conclusions", "outcomes"], 4).map((item) => ({
    ...item,
    body: cleanText(first(
      item.body,
      item.deliverable || item.acceptance
        ? [item.deliverable && `交付：${cleanText(item.deliverable)}`, item.acceptance && `验收：${cleanText(item.acceptance)}`].filter(Boolean).join("｜")
        : "",
    )),
  })).slice(0, 6);
  const label = cleanText(first(data.label, data.outcomes ? "预期成果" : "结论"));
  addShape(slide, "ellipse", { left: 0, top: 202, width: 254, height: 340 }, {
    name: "conclusion-arc", fill: context.colors.primary,
    line: { style: "solid", fill: context.colors.primary, width: 0 },
  });
  addText(slide, label, { left: 34, top: 316, width: 150, height: 80 }, {
    fontSize: 30, fontFamily: fontFor(label, context.tokens), bold: true, color: context.tokens.neutral.white, alignment: "center",
  }, "conclusion-arc-label");
  const availableHeight = 430;
  const rowStep = items.length > 1 ? Math.min(98, (availableHeight - 64) / (items.length - 1)) : 0;
  const startTop = 164 + (availableHeight - (64 + rowStep * Math.max(0, items.length - 1))) / 2;
  items.forEach((item, index) => {
    const top = startTop + index * rowStep;
    addShape(slide, "ellipse", { left: 292, top: top + 8, width: 48, height: 48 }, {
      name: `conclusion-dot-${index + 1}`, fill: index === 0 ? context.colors.primary : context.colors.primaryLight,
      line: { style: "solid", fill: context.colors.primary, width: 1.2 },
    });
    addText(slide, String(index + 1), { left: 292, top: top + 8, width: 48, height: 48 }, {
      fontSize: 14, fontFamily: context.tokens.fonts.en, bold: true,
      color: index === 0 ? context.tokens.neutral.white : context.colors.primary, alignment: "center",
    }, `conclusion-index-${index + 1}`);
    addText(slide, item.title, { left: 370, top, width: 280, height: 64 }, {
      fontSize: 18, fontFamily: fontFor(item.title, context.tokens), bold: true, color: context.tokens.neutral.text,
    }, `conclusion-title-${index + 1}`);
    addText(slide, item.body || "给出与结果页对应的证据性结论。", { left: 674, top, width: 500, height: 64 }, {
      fontSize: 14, fontFamily: fontFor(item.body, context.tokens), color: context.tokens.neutral.muted,
    }, `conclusion-body-${index + 1}`);
    if (index < items.length - 1) addRule(slide, 370, top + 64, 804, context.tokens.neutral.line, 1, `conclusion-rule-${index + 1}`);
  });
  addTakeawayBand(slide, slideTakeaway(slideSpec), context, { top: 618, height: 42, fontSize: 15 });
}

async function renderThreeOutlookColumns(slide, slideSpec, context, slideNumber) {
  await addContentChrome(slide, slideSpec, context, slideNumber);
  const items = semanticItems(slideSpec, ["items", "outlook", "directions"], 3).slice(0, 3);
  items.forEach((item, index) => {
    const left = 68 + index * 402;
    addShape(slide, "roundRect", { left, top: 224, width: 360, height: 348 }, {
      name: `outlook-column-${index + 1}`, fill: context.tokens.neutral.canvas,
      line: { style: "solid", fill: context.colors.secondary, width: 1.3 }, borderRadius: "rounded-lg",
    });
    addShape(slide, "roundRect", { left: left + 110, top: 174, width: 140, height: 82 }, {
      name: `outlook-number-tab-${index + 1}`, fill: index === 1 ? context.colors.primary : context.colors.primaryLight,
      line: { style: "solid", fill: context.colors.primary, width: 1.2 }, borderRadius: "rounded-lg",
    });
    addText(slide, item.number, { left: left + 110, top: 188, width: 140, height: 54 }, {
      fontSize: 28, fontFamily: context.tokens.fonts.en, bold: true,
      color: index === 1 ? context.tokens.neutral.white : context.colors.primary, alignment: "center",
    }, `outlook-number-${index + 1}`);
    addText(slide, item.title, { left: left + 30, top: 282, width: 300, height: 72 }, {
      fontSize: 20, fontFamily: fontFor(item.title, context.tokens), bold: true, color: context.tokens.neutral.text, alignment: "center",
    }, `outlook-title-${index + 1}`);
    addRule(slide, left + 110, 370, 140, context.tokens.neutral.line, 1, `outlook-rule-${index + 1}`);
    addText(slide, item.body || "说明后续方向、验证方法与可交付结果。", { left: left + 34, top: 392, width: 292, height: 140 }, {
      fontSize: 16, fontFamily: fontFor(item.body, context.tokens), color: context.tokens.neutral.muted,
      alignment: "center", verticalAlignment: "top",
    }, `outlook-body-${index + 1}`);
  });
  addTakeawayBand(slide, slideTakeaway(slideSpec), context, { top: 610, height: 48, fontSize: 16 });
}

async function renderClosing(slide, spec, slideSpec, context) {
  slide.background.fill = context.tokens.neutral.canvas;
  await addLogo(slide, context.brand, { left: 584, top: 54, width: 112, height: 92 }, context);
  addShape(slide, "rect", { left: 0, top: 200, width: 1280, height: 260 }, {
    name: "closing-band",
    fill: context.colors.primary,
    line: { style: "solid", fill: context.colors.primary, width: 0 },
  });
  const title = slideTitle(slideSpec) || "感谢各位老师，请批评指正";
  addText(slide, title, { left: 110, top: 242, width: 1060, height: 90 }, {
    fontSize: 44,
    fontFamily: fontFor(title, context.tokens),
    bold: true,
    color: context.tokens.neutral.white,
    alignment: "center",
  }, "closing-title");
  const thesisClaim = cleanText(first(slideSpec.thesis_claim, slideSpec.thesisClaim, slideTakeaway(slideSpec), spec.thesis_claim, ""));
  if (thesisClaim) addText(slide, thesisClaim, { left: 142, top: 342, width: 996, height: 72 }, {
    fontSize: 20,
    fontFamily: fontFor(thesisClaim, context.tokens),
    color: "#F1F4FA",
    alignment: "center",
  }, "closing-claim");
  const metrics = slideMetrics(slideSpec).slice(0, 4);
  const metricWidth = metrics.length === 4 ? 250 : 280;
  const metricLeft = metrics.length === 4 ? 100 : 170;
  const metricGap = metrics.length === 4 ? 280 : 330;
  metrics.forEach((metric, index) => addKeyNumber(slide, metric, {
    left: metricLeft + index * metricGap,
    top: 510,
    width: metricWidth,
    height: 98,
  }, context.colors, context.tokens, `closing-metric-${index + 1}`));
  const boundary = cleanText(first(slideSpec.content?.callout, renderData(slideSpec).boundary, ""));
  if (boundary) addText(slide, boundary, { left: 110, top: 608, width: 1060, height: 38 }, {
    fontSize: 12,
    fontFamily: fontFor(boundary, context.tokens),
    color: context.tokens.neutral.muted,
    alignment: "center",
  }, "closing-boundary");
  const author = cleanText(first(slideSpec.author, spec.author, spec.presenter, ""));
  addText(slide, [context.brand.institution, author].filter(Boolean).join("  |  "), { left: 120, top: 670, width: 1040, height: 24 }, {
    fontSize: 14,
    fontFamily: fontFor(author, context.tokens),
    color: context.tokens.neutral.muted,
    alignment: "center",
  }, "closing-footer");
}

async function renderSlide(slide, spec, slideSpec, context, slideNumber) {
  const layoutId = normalizeLayoutId(slideSpec);
  if (context.profile !== "proposal_midterm" && MILESTONE_EXCLUSIVE_LAYOUTS.has(layoutId)) {
    throw new Error(`Layout "${layoutId}" belongs to profile=proposal_midterm, but slide ${slideSpec.id ?? slideNumber} uses profile=${context.profile}. Use that profile or select a layout/free canvas appropriate to the active profile.`);
  }
  if (context.profile === "proposal_midterm") {
    const galleryMode = context.spec?.project_id === "proposal-midterm-layout-library"
      ? cleanText(renderData(slideSpec).mode)
      : "";
    const effectiveMode = ["proposal", "midterm"].includes(galleryMode) ? galleryMode : context.mode;
    if (PROPOSAL_ONLY_LAYOUTS.has(layoutId) && effectiveMode !== "proposal") {
      throw new Error(`Layout "${layoutId}" is proposal-only but slide ${slideSpec.id ?? slideNumber} uses mode=${effectiveMode}.`);
    }
    if (MIDTERM_ONLY_LAYOUTS.has(layoutId) && effectiveMode !== "midterm") {
      throw new Error(`Layout "${layoutId}" is midterm-only but slide ${slideSpec.id ?? slideNumber} uses mode=${effectiveMode}.`);
    }
    context = { ...context, mode: effectiveMode };
  }
  slide.background.fill = context.tokens.neutral.canvas;
  switch (layoutId) {
    case "cover-short-title":
      await renderMilestoneCover(slide, spec, slideSpec, context, false);
      break;
    case "cover-long-title":
      await renderMilestoneCover(slide, spec, slideSpec, context, true);
      break;
    case "agenda-adaptive":
      await renderMilestoneAgenda(slide, spec, slideSpec, context, slideNumber);
      break;
    case "evaluation-focus":
      await renderMilestoneEvaluationFocus(slide, slideSpec, context, slideNumber);
      break;
    case "closing-feedback":
      await renderMilestoneClosing(slide, spec, slideSpec, context);
      break;
    case "context-stakes":
      await renderThreeColumnOverview(slide, slideSpec, context, slideNumber);
      break;
    case "literature-landscape":
      await renderMilestoneLiteratureLandscape(slide, slideSpec, context, slideNumber);
      break;
    case "evidence-gap":
      await renderKnownGapQuestion(slide, slideSpec, context, slideNumber);
      break;
    case "question-hypothesis":
      await renderMilestoneQuestionHypothesis(slide, slideSpec, context, slideNumber);
      break;
    case "objectives-workpackages":
      await renderMilestoneWorkPackages(slide, slideSpec, context, slideNumber);
      break;
    case "conceptual-framework":
      await renderFramework(slide, slideSpec, context, slideNumber);
      break;
    case "scope-boundaries":
      await renderMilestoneScopeBoundaries(slide, slideSpec, context, slideNumber);
      break;
    case "contribution-value":
      await renderContribution(slide, slideSpec, context, slideNumber);
      break;
    case "technical-route":
      await renderProcess(slide, slideSpec, context, slideNumber, false);
      break;
    case "method-architecture":
      await renderFramework(slide, slideSpec, context, slideNumber);
      break;
    case "data-sample-variables":
      await renderSampleDataProfile(slide, slideSpec, context, slideNumber);
      break;
    case "model-formula":
      await renderFormulaVisual(slide, slideSpec, context, slideNumber);
      break;
    case "validation-plan-status":
      await renderMilestoneValidation(slide, slideSpec, context, slideNumber);
      break;
    case "feasibility-resources":
      await renderMilestoneFeasibility(slide, slideSpec, context, slideNumber);
      break;
    case "risk-ethics-contingency":
      await renderMilestoneRisk(slide, slideSpec, context, slideNumber);
      break;
    case "innovation-claims":
      await renderInnovationBrackets(slide, slideSpec, context, slideNumber);
      break;
    case "expected-outcomes":
      await renderConclusionList(slide, slideSpec, context, slideNumber);
      break;
    case "baseline-gantt":
      await renderMilestoneGantt(slide, slideSpec, context, slideNumber, false);
      break;
    case "proposal-decision-check":
      await renderMilestoneEvaluationFocus(slide, slideSpec, context, slideNumber);
      break;
    case "progress-snapshot":
      await renderProgressSnapshot(slide, slideSpec, context, slideNumber);
      break;
    case "plan-vs-actual":
      await renderPlanVsActual(slide, slideSpec, context, slideNumber);
      break;
    case "leading-result-single":
      await renderFigureConclusion(slide, slideSpec, context, slideNumber);
      break;
    case "leading-results-multipanel":
      await renderMultiImageEvidence(slide, slideSpec, context, slideNumber);
      break;
    case "deviation-cause-action":
      await renderDeviationCauseAction(slide, slideSpec, context, slideNumber);
      break;
    case "remaining-work-updated-plan":
      await renderMilestoneGantt(slide, slideSpec, context, slideNumber, true);
      break;
    case "group-cover":
      await renderGroupCover(slide, spec, slideSpec, context);
      break;
    case "paper-agenda":
      await renderPaperAgenda(slide, spec, slideSpec, context, slideNumber);
      break;
    case "paper-divider":
      await renderPaperDivider(slide, spec, slideSpec, context);
      break;
    case "paper-profile":
      await renderPaperProfile(slide, slideSpec, context, slideNumber);
      break;
    case "selection-rationale":
      await renderSelectionRationale(slide, slideSpec, context, slideNumber);
      break;
    case "known-gap-question":
      await renderKnownGapQuestion(slide, slideSpec, context, slideNumber);
      break;
    case "concept-framework":
      await renderFramework(slide, slideSpec, context, slideNumber);
      break;
    case "study-design":
      if (context.profile === "proposal_midterm") await renderMilestoneStudyDesign(slide, slideSpec, context, slideNumber);
      else await renderProcess(slide, slideSpec, context, slideNumber, true);
      break;
    case "method-sequence":
      await renderTimeline(slide, slideSpec, context, slideNumber);
      break;
    case "method-comparison":
      await renderTableInsight(slide, slideSpec, context, slideNumber, false);
      break;
    case "sample-data-profile":
      await renderSampleDataProfile(slide, slideSpec, context, slideNumber);
      break;
    case "single-result-evidence":
      await renderFigureConclusion(slide, slideSpec, context, slideNumber);
      break;
    case "result-compare":
      await renderImageCompare(slide, slideSpec, context, slideNumber, false);
      break;
    case "multi-result-evidence":
      await renderMultiImageEvidence(slide, slideSpec, context, slideNumber);
      break;
    case "table-chart-result":
      await renderChartInsight(slide, slideSpec, context, slideNumber);
      break;
    case "mechanism-explanation":
      await renderSingleImage(slide, slideSpec, context, slideNumber, "left");
      break;
    case "claim-evidence-boundary":
      await renderClaimEvidenceBoundary(slide, slideSpec, context, slideNumber);
      break;
    case "paper-conclusion":
      await renderPaperConclusion(slide, slideSpec, context, slideNumber);
      break;
    case "critical-appraisal":
      await renderCriticalAppraisal(slide, slideSpec, context, slideNumber);
      break;
    case "reproducibility-check":
      await renderReproducibilityCheck(slide, slideSpec, context, slideNumber);
      break;
    case "cross-paper-matrix":
      await renderTableInsight(slide, slideSpec, context, slideNumber, false);
      break;
    case "consensus-divergence":
      await renderConsensusDivergence(slide, slideSpec, context, slideNumber);
      break;
    case "evidence-quality-map":
      await renderEvidenceQualityMap(slide, slideSpec, context, slideNumber);
      break;
    case "research-evolution":
      await renderTimeline(slide, slideSpec, context, slideNumber);
      break;
    case "transfer-to-our-work":
      await renderTransferToOurWork(slide, slideSpec, context, slideNumber);
      break;
    case "discussion-questions":
      await renderDiscussionQuestions(slide, slideSpec, context, slideNumber);
      break;
    case "decision-request":
      await renderDecisionRequest(slide, slideSpec, context, slideNumber);
      break;
    case "next-reading-actions":
      await renderNextReadingActions(slide, slideSpec, context, slideNumber);
      break;
    case "selected-sources":
      await renderReferences(slide, slideSpec, context, slideNumber);
      break;
    case "group-closing":
      await renderGroupClosing(slide, spec, slideSpec, context);
      break;
    case "cover":
      await renderCover(slide, spec, slideSpec, context);
      break;
    case "agenda":
      await renderAgenda(slide, spec, slideSpec, context, slideNumber);
      break;
    case "section-divider":
    case "section":
      if (context.profile === "proposal_midterm") await renderMilestoneSectionDivider(slide, spec, slideSpec, context);
      else await renderSectionDivider(slide, spec, slideSpec, context);
      break;
    case "three-column-overview":
      await renderThreeColumnOverview(slide, slideSpec, context, slideNumber);
      break;
    case "three-level-analysis":
      await renderThreeLevelAnalysis(slide, slideSpec, context, slideNumber);
      break;
    case "four-point-list":
      await renderFourPointList(slide, slideSpec, context, slideNumber);
      break;
    case "three-row-content":
      await renderThreeRowContent(slide, slideSpec, context, slideNumber);
      break;
    case "multi-image-evidence":
      await renderMultiImageEvidence(slide, slideSpec, context, slideNumber);
      break;
    case "four-objectives":
      await renderFourObjectives(slide, slideSpec, context, slideNumber);
      break;
    case "thesis-framework":
      await renderThesisFramework(slide, slideSpec, context, slideNumber);
      break;
    case "radial-methods":
      await renderRadialMethods(slide, slideSpec, context, slideNumber);
      break;
    case "four-step-ribbon":
      await renderFourStepRibbon(slide, slideSpec, context, slideNumber);
      break;
    case "innovation-brackets":
      await renderInnovationBrackets(slide, slideSpec, context, slideNumber);
      break;
    case "four-results-cycle":
      await renderFourResultsCycle(slide, slideSpec, context, slideNumber);
      break;
    case "two-image-results":
      await renderTwoImageResults(slide, slideSpec, context, slideNumber);
      break;
    case "figure-conclusion":
      await renderFigureConclusion(slide, slideSpec, context, slideNumber);
      break;
    case "conclusion-list":
      await renderConclusionList(slide, slideSpec, context, slideNumber);
      break;
    case "three-outlook-columns":
      await renderThreeOutlookColumns(slide, slideSpec, context, slideNumber);
      break;
    case "image-left-text-right":
      await renderSingleImage(slide, slideSpec, context, slideNumber, "left");
      break;
    case "text-left-image-right":
      await renderSingleImage(slide, slideSpec, context, slideNumber, "right");
      break;
    case "image-compare":
      await renderImageCompare(slide, slideSpec, context, slideNumber, false);
      break;
    case "case-compare":
      await renderImageCompare(slide, slideSpec, context, slideNumber, true);
      break;
    case "chart-insight":
      await renderChartInsight(slide, slideSpec, context, slideNumber);
      break;
    case "table-insight":
      await renderTableInsight(slide, slideSpec, context, slideNumber, false);
      break;
    case "validation-matrix":
      await renderTableInsight(slide, slideSpec, context, slideNumber, true);
      break;
    case "formula-visual":
      await renderFormulaVisual(slide, slideSpec, context, slideNumber);
      break;
    case "process":
      await renderProcess(slide, slideSpec, context, slideNumber, false);
      break;
    case "framework":
      await renderFramework(slide, slideSpec, context, slideNumber);
      break;
    case "timeline":
      await renderTimeline(slide, slideSpec, context, slideNumber);
      break;
    case "quote-analysis":
      await renderQuoteAnalysis(slide, slideSpec, context, slideNumber);
      break;
    case "contribution":
      await renderContribution(slide, slideSpec, context, slideNumber);
      break;
    case "limitations":
      await renderLimitations(slide, slideSpec, context, slideNumber);
      break;
    case "references":
      await renderReferences(slide, slideSpec, context, slideNumber);
      break;
    case "free-evidence":
      await renderFreeEvidence(slide, slideSpec, context, slideNumber);
      break;
    case "closing":
      await renderClosing(slide, spec, slideSpec, context);
      break;
    case "claim-evidence":
      await renderClaimEvidence(slide, slideSpec, context, slideNumber);
      break;
    default:
      throw new Error(`Unsupported layout "${layoutId}" on slide ${slideSpec.id ?? slideNumber}. Use a registered layout or family=free_canvas with render_data.custom_elements.`);
  }
  applySlideTextEmphasis(slide, slideSpec, context);
  if (!["cover", "section-divider", "section", "closing", "group-cover", "paper-agenda", "paper-divider", "group-closing", "cover-short-title", "cover-long-title", "agenda-adaptive", "closing-feedback"].includes(layoutId)) addSourceHint(slide, slideSpec, context);
  setNotes(slide, slideSpec);
}

function createSemanticLayouts(_presentation, _colors) {
  // Artifact Tool 26.813 currently cannot export newly authored masters/layouts
  // without an invalid int32 field. Semantic layout identity therefore lives in
  // layout-registry.json and stable element names, while the generated PPTX uses
  // editable slide-local objects. This guard can be removed when the exporter is fixed.
  return {};
}

function layoutFor(slideSpec, layouts) {
  const id = normalizeLayoutId(slideSpec);
  if (id === "cover") return layouts.cover;
  if (id === "agenda") return layouts.agenda;
  if (id === "section-divider" || id === "section") return layouts.section;
  if (id === "closing") return layouts.closing;
  return layouts.content ?? null;
}

export async function createPresentationFromSpec(spec, options = {}) {
  if (!isObject(spec)) throw new Error("Deck spec must be a JSON object.");
  if (!Array.isArray(spec.slides) || spec.slides.length === 0) throw new Error("Deck spec needs a non-empty slides array.");
  const tokens = {
    ...DEFAULT_TOKENS,
    ...(options.tokens ?? {}),
    fonts: { ...DEFAULT_TOKENS.fonts, ...(options.tokens?.fonts ?? {}) },
    typeScale: { ...DEFAULT_TOKENS.typeScale, ...(options.tokens?.typeScale ?? {}) },
    spacing: { ...DEFAULT_TOKENS.spacing, ...(options.tokens?.spacing ?? {}) },
    textEmphasis: {
      ...DEFAULT_TOKENS.textEmphasis,
      ...(options.tokens?.textEmphasis ?? {}),
      roles: {
        ...(DEFAULT_TOKENS.textEmphasis.roles ?? {}),
        ...(options.tokens?.textEmphasis?.roles ?? {}),
      },
    },
    neutral: { ...DEFAULT_TOKENS.neutral, ...(options.tokens?.neutral ?? {}) },
  };
  const resolvedFonts = isObject(spec.theme?.fonts) ? spec.theme.fonts : {};
  if (resolvedFonts.body) tokens.fonts.zh = resolvedFonts.body;
  if (resolvedFonts.latin) tokens.fonts.en = resolvedFonts.latin;
  if (resolvedFonts.math) tokens.fonts.math = resolvedFonts.math;
  const colors = normalizeTheme(options.presets ?? { defaultPreset: "blue", presets: { blue: DEFAULT_THEME } }, spec, options);
  if (colors.background) tokens.neutral.canvas = colors.background;
  if (colors.surface) tokens.neutral.surface = colors.surface;
  if (colors.text) tokens.neutral.text = colors.text;
  if (colors.mutedText) tokens.neutral.muted = colors.mutedText;
  const baseDir = path.resolve(options.baseDir ?? process.cwd());
  const assetIndex = buildAssetIndex(spec, baseDir);
  const brand = normalizeBrand(spec);
  if (!brand.logo) {
    const logoId = first(spec.theme?.verified_logo_asset_id, spec.brand?.logo_asset_id);
    const logoAsset = logoId ? assetIndex.get(logoId) : null;
    if (logoAsset?.path) brand.logo = logoAsset.path;
  }
  if (brand.logo && !/^https?:\/\//i.test(brand.logo)) brand.logo = path.isAbsolute(brand.logo) ? brand.logo : path.resolve(baseDir, brand.logo);
  const presentation = Presentation.create({ slideSize: tokens.slideSize });
  presentation.theme.colorScheme = presentationTheme(colors, tokens);
  const layouts = createSemanticLayouts(presentation, colors);
  const sectionIndex = new Map(list(spec.sections).map((section) => [section?.id, section]));
  const profile = normalizeProfile(options.profile ? { ...spec, profile: options.profile } : spec);
  const mode = profile === "proposal_midterm" ? normalizeMilestoneMode(spec) : null;
  const context = { spec, profile, mode, tokens, colors, brand, baseDir, assetIndex, sectionIndex, allowPlaceholder: options.allowPlaceholder ?? true };
  const slides = [...spec.slides].sort((left, right) => Number(first(left.order, 0)) - Number(first(right.order, 0)));
  for (const [index, slideSpec] of slides.entries()) {
    const slide = presentation.slides.add();
    const semanticLayout = layoutFor(slideSpec, layouts);
    if (semanticLayout) slide.setLayout(semanticLayout);
    await renderSlide(slide, spec, slideSpec, context, index + 1);
  }
  return { presentation, context, slideSpecs: slides };
}

async function writeBlob(filePath, blob) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, new Uint8Array(await blob.arrayBuffer()));
}

export async function renderPresentation(presentation, outDir, options = {}) {
  const absolute = path.resolve(outDir);
  await fs.mkdir(absolute, { recursive: true });
  const slides = [];
  for (const [index, slide] of presentation.slides.items.entries()) {
    const stem = `slide-${String(index + 1).padStart(2, "0")}`;
    const pngPath = path.join(absolute, `${stem}.png`);
    const layoutPath = path.join(absolute, `${stem}.layout.json`);
    await writeBlob(pngPath, await presentation.export({ slide, format: "png", scale: options.scale ?? 1 }));
    const layout = await slide.export({ format: "layout" });
    await fs.writeFile(layoutPath, await layout.text(), "utf8");
    slides.push({ slide: index + 1, png: pngPath, layout: layoutPath });
  }
  const montagePath = path.join(absolute, "deck-montage.webp");
  const montagePngPath = path.join(absolute, "deck-montage.png");
  const sharp = await loadSharp();
  if (sharp) {
    const columns = options.montageColumns ?? 5;
    const thumbWidth = options.montageThumbWidth ?? 320;
    const thumbHeight = options.montageThumbHeight ?? 180;
    const gap = options.montageGap ?? 14;
    const rows = Math.ceil(slides.length / columns);
    const width = columns * thumbWidth + (columns + 1) * gap;
    const height = rows * thumbHeight + (rows + 1) * gap;
    const composites = [];
    for (const [index, item] of slides.entries()) {
      const buffer = await sharp(item.png).resize(thumbWidth, thumbHeight, {
        fit: "contain",
        background: "#EEF1F5",
      }).png().toBuffer();
      composites.push({
        input: buffer,
        left: gap + (index % columns) * (thumbWidth + gap),
        top: gap + Math.floor(index / columns) * (thumbHeight + gap),
      });
    }
    const montage = sharp({ create: { width, height, channels: 4, background: "#E7EBF1" } }).composite(composites);
    await montage.clone().png().toFile(montagePngPath);
    await montage.clone().webp({ quality: 88 }).toFile(montagePath);
  } else {
    await writeBlob(montagePath, await presentation.export({ format: "webp", montage: true, scale: options.scale ?? 1 }));
  }
  return { outDir: absolute, montage: montagePath, montagePng: sharp ? montagePngPath : null, slides };
}

export async function exportPresentation(presentation, outputPath) {
  const absolute = path.resolve(outputPath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  const pptx = await PresentationFile.exportPptx(presentation);
  await pptx.save(absolute);
  const stat = await fs.stat(absolute);
  return { output: absolute, bytes: stat.size, slideCount: presentation.slides.items.length };
}

export async function loadTemplateConfiguration(profile = "final_defense") {
  const normalizedProfile = normalizeProfile({ profile });
  const templateDir = PROFILE_TEMPLATE_DIRS[normalizedProfile];
  const [tokens, presets, registry] = await Promise.all([
    readOptionalJson(path.join(templateDir, "design-tokens.json"), DEFAULT_TOKENS),
    readOptionalJson(path.join(templateDir, "theme-presets.json"), { defaultPreset: "blue", presets: { blue: DEFAULT_THEME } }),
    readOptionalJson(path.join(templateDir, "layout-registry.json"), { layouts: [] }),
  ]);
  return { profile: normalizedProfile, templateDir, tokens, presets, registry };
}

export async function buildPresentationFromFile(specPath, options = {}) {
  const absoluteSpec = path.resolve(specPath);
  const spec = await readJson(absoluteSpec);
  const profile = normalizeProfile(spec);
  const template = await loadTemplateConfiguration(profile);
  const built = await createPresentationFromSpec(spec, {
    ...options,
    profile,
    baseDir: path.dirname(absoluteSpec),
    tokens: template.tokens,
    presets: template.presets,
  });
  return { ...built, spec, specPath: absoluteSpec, template };
}

export const internal = Object.freeze({
  cleanText,
  normalizeProfile,
  normalizeLayoutId,
  normalizeTheme,
  buildAssetIndex,
  normalizeAssetRequest,
  slideAssetRequests,
});
