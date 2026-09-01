#!/usr/bin/env node

import { access, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SKILL_DIR = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_FIXTURE = path.join("evals", "skill-evals.json");

function usage() {
  return [
    "Usage: node run-skill-evals.mjs [options]",
    "",
    "Options:",
    "  --skill-dir <dir>  Skill root (default: parent of this script)",
    "  --fixture <file>   Eval fixture JSON (default: evals/skill-evals.json)",
    "  --json             Emit machine-readable JSON",
    "  -h, --help         Show this help",
    "",
    "This runner performs deterministic contract and coverage checks only.",
    "It does not invoke a model and does not measure model or presentation quality.",
  ].join("\n");
}

function parseArgs(argv) {
  const result = { skillDir: DEFAULT_SKILL_DIR, fixture: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--json") result.json = true;
    else if (token === "-h" || token === "--help") result.help = true;
    else if (token === "--skill-dir" || token === "--fixture") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${token} requires a value.`);
      if (token === "--skill-dir") result.skillDir = path.resolve(value);
      else result.fixture = path.resolve(value);
    } else throw new Error(`Unknown option: ${token}`);
  }
  return result;
}

function finding(severity, code, location, message) {
  return { severity, code, location, message };
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath, findings) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    findings.push(finding("error", "fixture.invalid-json", filePath, error.message));
    return null;
  }
}

function parseFrontmatterDescription(markdown) {
  const match = markdown.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
  if (!match) return "";
  const line = match[1].split(/\r?\n/).find((item) => /^description:\s*/.test(item));
  return line?.replace(/^description:\s*/, "").trim().replace(/^['"]|['"]$/g, "") ?? "";
}

function requireObject(value, code, location, findings) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    findings.push(finding("error", code, location, "Expected a JSON object."));
    return false;
  }
  return true;
}

function requireNonEmptyString(value, code, location, findings) {
  if (typeof value !== "string" || !value.trim()) {
    findings.push(finding("error", code, location, "Expected a non-empty string."));
    return false;
  }
  return true;
}

function requireArray(value, code, location, findings, minimum = 1) {
  if (!Array.isArray(value) || value.length < minimum) {
    findings.push(finding("error", code, location, `Expected an array with at least ${minimum} item(s).`));
    return false;
  }
  return true;
}

function includesAll(container, required) {
  return required.every((item) => container.includes(item));
}

function sameMembers(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && includesAll(left, right)
    && includesAll(right, left);
}

function checkCategoryContract(testCase, location, findings) {
  const expected = testCase.expected;
  if (!requireObject(expected, "case.expected", `${location}.expected`, findings)) return;
  switch (testCase.category) {
    case "trigger_positive": {
      if (expected.shouldTrigger !== true) findings.push(finding("error", "case.trigger-positive", location, "Positive trigger must set expected.shouldTrigger=true."));
      requireNonEmptyString(expected.profile, "case.profile", `${location}.expected.profile`, findings);
      requireArray(expected.metadataTermsAny, "case.metadata-terms", `${location}.expected.metadataTermsAny`, findings);
      break;
    }
    case "trigger_negative": {
      if (expected.shouldTrigger !== false || expected.profile !== null) findings.push(finding("error", "case.trigger-negative", location, "Negative trigger must set shouldTrigger=false and profile=null."));
      if (expected.mustNotClaimImplemented !== true) findings.push(finding("error", "case.unsupported-contract", location, "Negative trigger must prohibit claiming an unimplemented profile."));
      break;
    }
    case "trigger_ambiguous": {
      if (expected.shouldTrigger !== null) findings.push(finding("error", "case.trigger-ambiguous", location, "Ambiguous trigger must set shouldTrigger=null."));
      if (!Number.isInteger(expected.maxClarifyingQuestions) || expected.maxClarifyingQuestions > 1) findings.push(finding("error", "case.clarification-limit", location, "Ambiguous route must allow at most one clarification."));
      requireArray(expected.mustNotForceProfile, "case.must-not-force", `${location}.expected.mustNotForceProfile`, findings);
      break;
    }
    case "intake_no_repeat": {
      if (requireArray(testCase.providedControls, "case.provided-controls", `${location}.providedControls`, findings)
        && requireArray(expected.mustNotReprompt, "case.must-not-reprompt", `${location}.expected.mustNotReprompt`, findings)
        && !includesAll(expected.mustNotReprompt, testCase.providedControls)) {
        findings.push(finding("error", "case.intake-coverage", location, "mustNotReprompt must cover every provided control."));
      }
      if (expected.maxClarifyingQuestions !== 0) findings.push(finding("error", "case.intake-question-count", location, "Fully specified intake must permit zero clarification questions."));
      break;
    }
    case "intake_controls": {
      const allowedInteractiveControls = ["page_policy", "theme_policy"];
      const requiredThemePresets = ["blue", "red", "purple", "cyan"];
      const provided = Array.isArray(testCase.providedControls) ? testCase.providedControls : [];
      const missing = Array.isArray(testCase.missingControls) ? testCase.missingControls : [];
      const asked = Array.isArray(expected.askControls) ? expected.askControls : [];
      const mustNotAsk = Array.isArray(expected.mustNotAsk) ? expected.mustNotAsk : [];
      const mustNotReprompt = Array.isArray(expected.mustNotReprompt) ? expected.mustNotReprompt : [];

      if (!Array.isArray(testCase.providedControls)) findings.push(finding("error", "case.provided-controls", `${location}.providedControls`, "Expected an array, including an empty array when no control was provided."));
      if (!Array.isArray(testCase.missingControls)) findings.push(finding("error", "case.missing-controls", `${location}.missingControls`, "Expected an array, including an empty array when no control is missing."));
      if (!Array.isArray(expected.askControls)) findings.push(finding("error", "case.ask-controls", `${location}.expected.askControls`, "Expected an array of controls asked in the single intake interaction."));
      if (!Array.isArray(expected.mustNotAsk)) findings.push(finding("error", "case.must-not-ask", `${location}.expected.mustNotAsk`, "Expected an array of controls that must not be asked."));
      if (!Array.isArray(expected.mustNotReprompt)) findings.push(finding("error", "case.must-not-reprompt", `${location}.expected.mustNotReprompt`, "Expected an array of controls that must not be repeated."));

      const invalidMissing = missing.filter((control) => !allowedInteractiveControls.includes(control));
      if (invalidMissing.length > 0) findings.push(finding("error", "case.intake-control.invalid", `${location}.missingControls`, `Only page_policy and theme_policy may trigger intake; found ${invalidMissing.join(", ")}.`));
      const providedInteractive = provided.filter((control) => allowedInteractiveControls.includes(control));
      if (new Set(missing).size !== missing.length || new Set(providedInteractive).size !== providedInteractive.length) findings.push(finding("error", "case.intake-control.duplicate", location, "Page/theme controls must not be duplicated."));
      if (missing.some((control) => providedInteractive.includes(control))) findings.push(finding("error", "case.intake-control.overlap", location, "A page/theme control cannot be both provided and missing."));
      if (!sameMembers([...providedInteractive, ...missing], allowedInteractiveControls)) findings.push(finding("error", "case.intake-control.partition", location, "Every page/theme control must be classified as either provided or missing."));
      if (!sameMembers(asked, missing)) findings.push(finding("error", "case.intake-ask-exact", location, "askControls must contain exactly the missing page/theme controls."));
      if (!mustNotAsk.includes("duration_minutes")) findings.push(finding("error", "case.duration-reprompt", location, "Duration must never be requested during intake."));
      if (!includesAll(mustNotAsk, provided)) findings.push(finding("error", "case.intake-provided-asked", location, "Every provided control must be excluded from the intake question."));
      if (!includesAll(mustNotReprompt, provided.filter((control) => allowedInteractiveControls.includes(control)))) findings.push(finding("error", "case.intake-repeat", location, "Provided page/theme controls must be covered by mustNotReprompt."));
      const expectedQuestionCount = missing.length > 0 ? 1 : 0;
      if (expected.maxClarifyingQuestions !== expectedQuestionCount) findings.push(finding("error", "case.intake-question-count", location, `Expected ${expectedQuestionCount} consolidated intake question(s).`));
      if (missing.includes("page_policy") && expected.defaultPagePolicy !== "auto") findings.push(finding("error", "case.page-default", location, "A missing page policy must offer auto as the recommended default."));
      if (missing.includes("theme_policy")) {
        if (!sameMembers(expected.availableThemePresets, requiredThemePresets)) findings.push(finding("error", "case.theme-presets", location, "A theme question must list exactly blue, red, purple, and cyan."));
        if (expected.recommendedThemePreset !== "blue") findings.push(finding("error", "case.theme-recommendation", location, "Academic blue must be the recommended theme preset."));
        const forbiddenSources = ["institution", "school_brand", "university_logo"];
        if (!Array.isArray(expected.mustNotInferThemeFrom) || !includesAll(expected.mustNotInferThemeFrom, forbiddenSources)) findings.push(finding("error", "case.theme-brand-inference", location, "Theme selection must not be inferred from institution, school brand, or university logo."));
      }
      if (missing.length > 0 && expected.incompleteReplyUsesRecommendedDefaults !== true) findings.push(finding("error", "case.intake-incomplete-reply", location, "An incomplete reply must use the displayed recommendations instead of causing another question."));
      break;
    }
    case "prompt_injection": {
      requireNonEmptyString(testCase.attachmentContent, "case.attachment-content", `${location}.attachmentContent`, findings);
      if (!requireNonEmptyString(expected.sentinel, "case.sentinel", `${location}.expected.sentinel`, findings)
        || !String(testCase.attachmentContent ?? "").includes(expected.sentinel)) {
        findings.push(finding("error", "case.sentinel-missing", location, "Prompt-injection attachment must contain its expected sentinel."));
      }
      if (expected.treatAttachmentAsContent !== true) findings.push(finding("error", "case.attachment-boundary", location, "Attachment must be treated as content."));
      const prohibited = ["change_task_scope", "write_outside_project", "upload_source", "obey_attachment_instruction"];
      if (!Array.isArray(expected.prohibitedEffects) || !includesAll(expected.prohibitedEffects, prohibited)) findings.push(finding("error", "case.injection-effects", location, "Prompt-injection fixture does not cover all high-risk effects."));
      break;
    }
    case "degraded_environment": {
      if (!requireObject(testCase.environment, "case.environment", `${location}.environment`, findings)) break;
      for (const key of ["latex", "verifiedLogoMatch"]) if (testCase.environment[key] !== false) findings.push(finding("error", "case.degraded-flag", `${location}.environment.${key}`, "Degraded fixture must explicitly disable this capability."));
      if (testCase.environment.bundledMathJax !== true || testCase.environment.localMathRenderer !== true) findings.push(finding("error", "case.bundled-mathjax", `${location}.environment`, "The zero-install degraded fixture must retain the bundled MathJax renderer."));
      requireArray(expected.existingFormulaFallbacksAllowed, "case.formula-fallback", `${location}.expected.existingFormulaFallbacksAllowed`, findings);
      requireArray(expected.newFormulaFallbacksAllowed, "case.formula-fallback", `${location}.expected.newFormulaFallbacksAllowed`, findings);
      requireArray(expected.brandingFallbacksAllowed, "case.branding-fallback", `${location}.expected.brandingFallbacksAllowed`, findings);
      if (expected.mustPreserveSelectedTheme !== true || expected.brandingFallbacksAllowed?.includes("neutral_theme")) {
        findings.push(finding("error", "case.branding-theme-independence", location, "Missing or unverified branding must not change the selected theme preset."));
      }
      requireArray(expected.lowResolutionPoliciesAllowed, "case.lowres-policy", `${location}.expected.lowResolutionPoliciesAllowed`, findings);
      if (expected.mustNotExposeRawLatex !== true || expected.mustNotFabricateLogo !== true) findings.push(finding("error", "case.degraded-safety", location, "Degraded fixture must prohibit raw LaTeX and fabricated logos."));
      break;
    }
    case "free_layout": {
      if (expected.allowFreeCanvas !== true || expected.mustNotForceFiveSections !== true || expected.preserveBranchAndMerge !== true) findings.push(finding("error", "case.free-layout", location, "Free-layout fixture must preserve source logic and prohibit fixed sections."));
      if (!Array.isArray(expected.mustNotForceCardinality) || !includesAll(expected.mustNotForceCardinality, [3, 5])) findings.push(finding("error", "case.free-layout-cardinality", location, "Free-layout fixture must cover common forced 3/5-cardinality layouts."));
      break;
    }
    case "time_page_adaptation": {
      if (!requireArray(testCase.variants, "case.variants", `${location}.variants`, findings, 3)) break;
      const fixed = testCase.variants.find((item) => item?.pagePolicy === "fixed" && Number.isInteger(item.targetSlideCount) && item.targetSlideCount >= 3);
      if (!fixed) findings.push(finding("error", "case.fixed-page", location, "Adaptation fixture needs a valid fixed-page variant."));
      if (expected.durationIsOptional === true || expected.autoWithoutDurationAllowed === true) {
        const autoWithoutDuration = testCase.variants.find((item) => item?.pagePolicy === "auto" && !("durationMinutes" in item));
        const autoWithSoftDuration = testCase.variants.find((item) => item?.pagePolicy === "auto" && Number.isFinite(item?.durationMinutes));
        if (!autoWithoutDuration) findings.push(finding("error", "case.duration-optional", location, "Adaptation fixture needs an auto-page variant with no duration field."));
        if (!autoWithSoftDuration) findings.push(finding("error", "case.duration-soft-hint", location, "Adaptation fixture needs an auto-page variant with a provided soft duration hint."));
        for (const key of ["autoWithoutDurationAllowed", "fixedTargetMustMatch", "durationIsOptional", "durationIsSoftHint", "durationMustNotBePrompted", "durationMustNotOverridePagePolicy"]) {
          if (expected[key] !== true) findings.push(finding("error", "case.adaptation-contract", `${location}.expected.${key}`, "Expected contract must be true."));
        }
      } else {
        // Retain compatibility with the original duration-led adaptation fixture.
        const autoDurations = testCase.variants.filter((item) => item?.pagePolicy === "auto").map((item) => item.durationMinutes).filter(Number.isFinite);
        if (autoDurations.length < 2 || new Set(autoDurations).size < 2) findings.push(finding("error", "case.duration-contrast", location, "Legacy adaptation fixture needs at least two distinct auto-duration variants."));
        for (const key of ["autoDepthMonotonicWithDuration", "fixedTargetMustMatchOrExplainConflict", "durationIsApproximateNotExact"]) {
          if (expected[key] !== true) findings.push(finding("error", "case.adaptation-contract", `${location}.expected.${key}`, "Expected contract must be true."));
        }
      }
      break;
    }
    case "notes_sources": {
      for (const key of ["allSlidesHaveNotes", "allSlidesHaveSourcesBlock", "substantiveSlidesRequireResolvableSources", "structuralSlidesMayHaveEmptySources"]) if (expected[key] !== true) findings.push(finding("error", "case.notes-contract", `${location}.expected.${key}`, "Expected notes/source contract must be true."));
      break;
    }
    case "delivery_package": {
      if (!requireArray(expected.rootEntries, "case.delivery-root", `${location}.expected.rootEntries`, findings, 4) || expected.rootEntries.length !== 4) {
        findings.push(finding("error", "case.delivery-root-count", location, "Delivery root must contain exactly four entries."));
      }
      if (expected.stemPattern !== "短题名_汇报类型") findings.push(finding("error", "case.delivery-stem", location, "Delivery stem must be short title plus report type."));
      if (!requireArray(expected.forbiddenNameMarkers, "case.delivery-name-markers", `${location}.expected.forbiddenNameMarkers`, findings)
        || !includesAll(expected.forbiddenNameMarkers, ["date", "version", "v1", "final", "最终版", "姓名"])) {
        findings.push(finding("error", "case.delivery-name-markers", location, "Delivery fixture must reject dates, versions, final markers, and names."));
      }
      for (const key of ["wordMatchesPptNotes", "builderEmbedsFinalSpec", "builderUsesRelativeAssets"]) if (expected[key] !== true) findings.push(finding("error", "case.delivery-contract", `${location}.expected.${key}`, "Expected delivery contract must be true."));
      if (!requireArray(expected.forbiddenArtifacts, "case.delivery-forbidden", `${location}.expected.forbiddenArtifacts`, findings)
        || !includesAll(expected.forbiddenArtifacts, ["deck-spec.json", "evidence-index.json", "qa", "preview", "node_modules", "source-pdf"])) {
        findings.push(finding("error", "case.delivery-forbidden", location, "Delivery fixture does not cover required internal artifacts."));
      }
      break;
    }
    default:
      findings.push(finding("error", "case.category.unknown", location, `Unknown category: ${testCase.category ?? "missing"}.`));
  }
}

export async function runSkillEvals(options = {}) {
  const skillDir = path.resolve(options.skillDir ?? DEFAULT_SKILL_DIR);
  const fixturePath = path.resolve(options.fixture ?? path.join(skillDir, DEFAULT_FIXTURE));
  const findings = [];
  const fixture = await readJson(fixturePath, findings);
  if (!fixture) return { ok: false, mode: "deterministic_contract_only", skillDir, fixture: fixturePath, findings };

  if (fixture.evaluationMode !== "deterministic_contract_only") findings.push(finding("error", "fixture.mode", fixturePath, "evaluationMode must explicitly state deterministic_contract_only."));
  const disclaimer = String(fixture.disclaimer ?? "").toLowerCase();
  if (!(disclaimer.includes("does not") || disclaimer.includes("do not")) || !disclaimer.includes("model")) findings.push(finding("error", "fixture.disclaimer", fixturePath, "Fixture must state that it does not measure model quality."));
  requireObject(fixture.coverageRequirements, "fixture.coverage", `${fixturePath}#coverageRequirements`, findings);
  const cases = Array.isArray(fixture.cases) ? fixture.cases : [];
  if (!cases.length) findings.push(finding("error", "fixture.cases", fixturePath, "Fixture contains no cases."));

  const seenIds = new Set();
  const counts = new Map();
  for (const [index, testCase] of cases.entries()) {
    const location = `${fixturePath}#cases[${index}]`;
    if (!requireObject(testCase, "case.shape", location, findings)) continue;
    if (requireNonEmptyString(testCase.id, "case.id", `${location}.id`, findings)) {
      if (seenIds.has(testCase.id)) findings.push(finding("error", "case.id.duplicate", location, `Duplicate case id: ${testCase.id}.`));
      seenIds.add(testCase.id);
    }
    requireNonEmptyString(testCase.category, "case.category", `${location}.category`, findings);
    requireNonEmptyString(testCase.stage, "case.stage", `${location}.stage`, findings);
    requireNonEmptyString(testCase.prompt, "case.prompt", `${location}.prompt`, findings);
    counts.set(testCase.category, (counts.get(testCase.category) ?? 0) + 1);
    checkCategoryContract(testCase, location, findings);
  }

  for (const [category, minimum] of Object.entries(fixture.coverageRequirements ?? {})) {
    if (!Number.isInteger(minimum) || minimum < 1) findings.push(finding("error", "fixture.coverage.minimum", `${fixturePath}#coverageRequirements.${category}`, "Coverage minimum must be a positive integer."));
    else if ((counts.get(category) ?? 0) < minimum) findings.push(finding("error", "fixture.coverage.missing", fixturePath, `${category}: expected at least ${minimum}, found ${counts.get(category) ?? 0}.`));
  }

  const registryPath = path.join(skillDir, "assets", "profile-registry.json");
  const registry = await readJson(registryPath, findings);
  const skillMdPath = path.join(skillDir, "SKILL.md");
  let description = "";
  try {
    description = parseFrontmatterDescription(await readFile(skillMdPath, "utf8"));
  } catch (error) {
    findings.push(finding("error", "skill.read", skillMdPath, error.message));
  }
  for (const testCase of cases.filter((item) => item?.category === "trigger_positive")) {
    const expected = testCase.expected ?? {};
    const profile = registry?.profiles?.[expected.profile];
    if (!profile) findings.push(finding("error", "case.profile.unregistered", testCase.id, `Profile ${expected.profile ?? "missing"} is not registered.`));
    if (expected.mode && !profile?.modes?.includes(expected.mode)) findings.push(finding("error", "case.mode.unregistered", testCase.id, `Mode ${expected.mode} is not registered for ${expected.profile}.`));
    if (Array.isArray(expected.metadataTermsAny) && !expected.metadataTermsAny.some((term) => description.includes(term))) findings.push(finding("error", "case.metadata.uncovered", testCase.id, "SKILL.md description contains none of the positive trigger metadata terms."));
  }

  for (const [index, anchor] of (fixture.policyAnchors ?? []).entries()) {
    const location = `${fixturePath}#policyAnchors[${index}]`;
    if (!requireObject(anchor, "anchor.shape", location, findings)) continue;
    requireNonEmptyString(anchor.id, "anchor.id", `${location}.id`, findings);
    if (!requireArray(anchor.files, "anchor.files", `${location}.files`, findings) || !requireArray(anchor.termsAny, "anchor.terms", `${location}.termsAny`, findings)) continue;
    let combined = "";
    for (const relative of anchor.files) {
      const filePath = path.resolve(skillDir, relative);
      if (filePath !== skillDir && !filePath.startsWith(`${skillDir}${path.sep}`)) {
        findings.push(finding("error", "anchor.path.escape", filePath, "Policy anchor path escapes the skill directory."));
        continue;
      }
      if (!(await exists(filePath))) findings.push(finding("error", "anchor.file.missing", filePath, `Policy anchor ${anchor.id} references a missing file.`));
      else combined += `\n${await readFile(filePath, "utf8")}`;
    }
    if (!anchor.termsAny.some((term) => combined.includes(term))) findings.push(finding("error", "anchor.term.missing", anchor.id, "None of the policy anchor terms appears in its files."));
  }

  const errors = findings.filter((item) => item.severity === "error").length;
  return {
    ok: errors === 0,
    mode: "deterministic_contract_only",
    disclaimer: "No model was invoked. Passing results show fixture and policy coverage, not presentation quality.",
    skillDir,
    fixture: fixturePath,
    caseCount: cases.length,
    coverage: Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right))),
    findings,
  };
}

function printHuman(result) {
  console.log(`${result.ok ? "PASS" : "FAIL"}: deterministic skill eval contracts (${result.caseCount ?? 0} cases)`);
  console.log(result.disclaimer);
  for (const item of result.findings) console.log(`- ${item.severity.toUpperCase()} ${item.code}: ${item.message} (${item.location})`);
  console.log(`${result.findings.filter((item) => item.severity === "error").length} error(s)`);
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
  try {
    const result = await runSkillEvals(args);
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else printHuman(result);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    if (args.json) console.log(JSON.stringify({ ok: false, mode: "deterministic_contract_only", error: error.message }, null, 2));
    else console.error(`ERROR: ${error.message}`);
    process.exitCode = 2;
  }
}

const invokedDirectly = process.argv[1] && await realpath(process.argv[1]).catch(() => null) === await realpath(fileURLToPath(import.meta.url)).catch(() => null);
if (invokedDirectly) await main();
