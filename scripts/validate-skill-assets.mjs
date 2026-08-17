#!/usr/bin/env node

import { access, readFile, readdir, realpath, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SKILL_DIR = path.resolve(SCRIPT_DIR, "..");
const REQUIRED_SCRIPTS = [
  "validate-project.mjs",
  "validate-deck-spec.mjs",
  "build-outline.mjs",
  "create-layout-library.mjs",
  "create-group-meeting-layout-library.mjs",
  "create-proposal-midterm-layout-library.mjs",
  "index-university-logos.mjs",
  "find-university-logo.mjs",
  "validate-skill-assets.mjs",
  "preflight.mjs",
  "package-skill.mjs",
  "run-skill-evals.mjs",
  "speaker-notes.mjs",
  "build-speaker-script.mjs",
  "create-project-builder.mjs",
  "stage-delivery.mjs",
];
const RELEASE_ONLY_SCRIPTS = ["build.mjs"];
const REQUIRED_SCHEMAS = ["project-config.schema.json", "deck-spec.schema.json", "figures-manifest.schema.json", "paper-index.schema.json", "evidence-index.schema.json", "milestone-analysis.schema.json"];
const REQUIRED_EVALS = ["skill-evals.json"];
const REQUIRED_TESTS = ["p0-security-and-evidence.test.mjs", "logo-match-safety.test.mjs", "proposal-midterm-contract.test.mjs", "text-emphasis.test.mjs", "delivery-contract.test.mjs"];
const PROFILE_REGISTRY_PATH = path.join("assets", "profile-registry.json");
const PROFILE_ASSET_FIELDS = ["layoutLibrary", "layoutRegistry", "templateMap", "designTokens", "themePresets", "librarySpec", "preview"];

function usage() {
  return [
    "Usage: node validate-skill-assets.mjs [skill-directory] [options]",
    "",
    "Options:",
    "  --profile <name>  Validation level: scaffold|release (default: release)",
    "  --strict          Treat warnings as errors",
    "  --json            Emit machine-readable JSON",
    "  -h, --help        Show this help",
  ].join("\n");
}

function parseArgs(argv) {
  const result = { profile: "release", strict: false, json: false };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--strict") result.strict = true;
    else if (arg === "--json") result.json = true;
    else if (arg === "--profile") {
      const profile = argv[++index];
      if (!["scaffold", "release"].includes(profile)) throw new Error("--profile must be scaffold or release.");
      result.profile = profile;
    } else if (arg === "-h" || arg === "--help") result.help = true;
    else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else positional.push(arg);
  }
  if (positional.length > 1) throw new Error("Provide at most one skill directory.");
  result.skillDir = positional[0];
  return result;
}

function issue(severity, code, file, message) {
  return { severity, code, file, message };
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(filePath) {
  try {
    return (await stat(filePath)).isDirectory();
  } catch {
    return false;
  }
}

async function walk(directory) {
  if (!(await isDirectory(directory))) return [];
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await walk(full)));
    else if (entry.isFile()) output.push(full);
  }
  return output;
}

async function requireFile(filePath, findings, code = "file.missing") {
  if (!(await exists(filePath))) {
    findings.push(issue("error", code, filePath, "Required file is missing."));
    return false;
  }
  const info = await stat(filePath);
  if (!info.isFile() || info.size === 0) {
    findings.push(issue("error", "file.empty", filePath, "Required file is empty or not a regular file."));
    return false;
  }
  return true;
}

async function checkJson(filePath, findings) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    findings.push(issue("error", "json.invalid", filePath, error.message));
    return null;
  }
}

function parseFrontmatter(markdown) {
  const match = markdown.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
  if (!match) return null;
  const values = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (field) values[field[1]] = field[2].trim().replace(/^['"]|['"]$/g, "");
  }
  return values;
}

async function checkPptx(filePath, findings) {
  if (!(await requireFile(filePath, findings))) return;
  const content = await readFile(filePath);
  if (content.length < 10_000 || content.subarray(0, 2).toString("binary") !== "PK") findings.push(issue("error", "pptx.invalid", filePath, "Template is not a plausible PPTX archive."));
}

async function checkScripts(skillDir, findings, release) {
  for (const filename of [...REQUIRED_SCRIPTS, ...(release ? RELEASE_ONLY_SCRIPTS : [])]) {
    const filePath = path.join(skillDir, "scripts", filename);
    if (!(await requireFile(filePath, findings, "script.missing"))) continue;
    try {
      await execFileAsync(process.execPath, ["--check", filePath], { encoding: "utf8" });
    } catch (error) {
      findings.push(issue("error", "script.syntax", filePath, error.stderr?.trim() || error.message));
    }
  }
}

async function checkSchemas(skillDir, findings) {
  for (const filename of REQUIRED_SCHEMAS) {
    const filePath = path.join(skillDir, "schemas", filename);
    if (!(await requireFile(filePath, findings, "schema.missing"))) continue;
    const schema = await checkJson(filePath, findings);
    if (schema && !schema.$schema) findings.push(issue("warning", "schema.dialect", filePath, "Schema does not declare $schema."));
    if (schema && !schema.type && !schema.$ref && !schema.allOf) findings.push(issue("warning", "schema.root", filePath, "Schema root has no type, $ref, or allOf."));
  }
}

async function checkEvals(skillDir, findings, release) {
  const evalDir = path.join(skillDir, "evals");
  for (const filename of REQUIRED_EVALS) {
    const filePath = path.join(evalDir, filename);
    if (!(await requireFile(filePath, findings, "eval.missing"))) continue;
    const fixture = await checkJson(filePath, findings);
    if (!fixture) continue;
    if (fixture.evaluationMode !== "deterministic_contract_only") findings.push(issue(release ? "error" : "warning", "eval.mode", filePath, "Eval fixture must identify itself as deterministic_contract_only."));
    if (!Array.isArray(fixture.cases) || fixture.cases.length === 0) findings.push(issue(release ? "error" : "warning", "eval.cases", filePath, "Eval fixture must contain cases."));
  }
}

async function runJsonGate(command, commandArgs, findings, code, file, predicate, failureMessage) {
  try {
    const { stdout } = await execFileAsync(command, commandArgs, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024, timeout: 120_000 });
    const result = JSON.parse(stdout);
    if (!predicate(result)) findings.push(issue("error", code, file, failureMessage(result)));
  } catch (error) {
    let detail = error.stderr?.trim() || error.stdout?.trim() || error.message;
    try {
      const parsed = JSON.parse(error.stdout ?? "");
      detail = parsed.findings?.map((item) => `${item.code}: ${item.message}`).join("; ") || parsed.error || detail;
    } catch {
      // Preserve the command error when stdout is not JSON.
    }
    findings.push(issue("error", code, file, detail));
  }
}

async function checkReleaseGates(skillDir, findings) {
  for (const filename of REQUIRED_TESTS) {
    const testPath = path.join(skillDir, "tests", filename);
    if (!(await requireFile(testPath, findings, "test.missing"))) continue;
    try {
      await execFileAsync(process.execPath, [testPath], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024, timeout: 120_000 });
    } catch (error) {
      findings.push(issue("error", "release.test", testPath, error.stderr?.trim() || error.stdout?.trim() || error.message));
    }
  }

  const evalRunner = path.join(skillDir, "scripts", "run-skill-evals.mjs");
  if (await exists(evalRunner)) {
    await runJsonGate(
      process.execPath,
      [evalRunner, "--skill-dir", skillDir, "--json"],
      findings,
      "release.evals",
      evalRunner,
      (result) => result.ok === true && result.mode === "deterministic_contract_only",
      (result) => `Deterministic eval contracts failed: ${result.findings?.map((item) => item.code).join(", ") || "unknown failure"}.`,
    );
  }

  const preflight = path.join(skillDir, "scripts", "preflight.mjs");
  if (await exists(preflight)) {
    await runJsonGate(
      process.execPath,
      [preflight, "--skill-dir", skillDir, "--json"],
      findings,
      "release.preflight",
      preflight,
      (result) => result.ready === true && result.installsPerformed === false,
      (result) => `Preflight is not release-ready: ${result.findings?.map((item) => item.code).join(", ") || "unknown failure"}.`,
    );
  }

  const packager = path.join(skillDir, "scripts", "package-skill.mjs");
  if (await exists(packager)) {
    await runJsonGate(
      process.execPath,
      [packager, "--skill-dir", skillDir, "--check", "--json"],
      findings,
      "release.package",
      packager,
      (result) => result.ok === true && result.checkOnly === true && result.portabilityScan?.issueCount === 0,
      (result) => `Package gate failed: ${result.findings?.map((item) => item.code).join(", ") || "unknown failure"}.`,
    );
  }
}

async function checkReferences(skillDir, findings, release) {
  const referenceDir = path.join(skillDir, "references");
  const markdownFiles = (await walk(referenceDir)).filter((file) => path.extname(file).toLowerCase() === ".md");
  if (markdownFiles.length === 0) findings.push(issue(release ? "error" : "warning", "references.empty", referenceDir, "No reference Markdown files are present."));
  for (const file of markdownFiles) {
    const content = await readFile(file, "utf8");
    if (content.trim().length < 100) findings.push(issue("warning", "reference.thin", file, "Reference file is unusually short."));
    if (/\[TODO|TODO:|PLACEHOLDER/i.test(content)) findings.push(issue(release ? "error" : "warning", "reference.todo", file, "Reference still contains TODO or placeholder text."));
  }
}

async function checkLogoCatalog(skillDir, findings, release) {
  const logoDir = path.join(skillDir, "assets", "branding", "university-logos");
  if (!(await isDirectory(logoDir))) return;
  const files = await walk(logoDir);
  const logoFiles = files.filter((file) => [".svg", ".png", ".jpg", ".jpeg", ".webp", ".pdf"].includes(path.extname(file).toLowerCase()));
  const catalogPath = path.join(logoDir, "catalog.json");
  if (logoFiles.length === 0) {
    if (await exists(catalogPath)) findings.push(issue(release ? "error" : "warning", "logos.catalog.orphaned", catalogPath, "Logo catalog exists without bundled logo assets."));
    return;
  }
  if (!(await exists(catalogPath))) {
    findings.push(issue(release ? "error" : "warning", "logos.catalog.missing", catalogPath, "Logo files exist but catalog.json has not been generated."));
    return;
  }
  if (!(await requireFile(catalogPath, findings, "logos.catalog.missing"))) return;
  const catalog = await checkJson(catalogPath, findings);
  if (!catalog) return;
  if (!Array.isArray(catalog.logos)) findings.push(issue("error", "logos.catalog.shape", catalogPath, "Catalog must contain a logos array."));
  else {
    const catalogFiles = new Set(catalog.logos.map((entry) => entry?.file).filter(Boolean));
    for (const logoFile of logoFiles) {
      const relative = path.relative(logoDir, logoFile).split(path.sep).join("/");
      if (!catalogFiles.has(relative)) findings.push(issue("error", "logos.catalog.unindexed", logoFile, "Logo file is missing from catalog.json."));
    }
    for (const entry of catalog.logos) {
      if (!entry?.file) continue;
      const absolute = path.resolve(logoDir, entry.file);
      if (!(await exists(absolute))) findings.push(issue("error", "logos.catalog.dangling", absolute, "Catalog entry points to a missing logo file."));
      const sourceUrl = entry?.source?.url ?? entry?.source_url;
      const verificationStatus = String(entry?.source?.verification_status ?? entry?.verification_status ?? "").toLowerCase();
      if (!sourceUrl || !["verified", "official", "current-official"].includes(verificationStatus)) {
        findings.push(issue(release ? "error" : "warning", "logos.catalog.provenance", absolute, "Bundled logo assets require an official source URL and verified status."));
      }
    }
  }
}

function resolveRegisteredPath(skillDir, relativePath, findings, profileId, field, baseDir = skillDir) {
  if (typeof relativePath !== "string" || !relativePath.trim()) {
    findings.push(issue("error", "profile.path.missing", path.join(skillDir, PROFILE_REGISTRY_PATH), `${profileId}.${field} must be a non-empty path relative to the skill root.`));
    return null;
  }
  const normalized = relativePath.replaceAll("\\", "/");
  const rootRelative = /^(assets|references|scripts|schemas|agents)\//.test(normalized);
  const absolute = path.resolve(rootRelative ? skillDir : baseDir, relativePath);
  if (absolute !== skillDir && !absolute.startsWith(`${skillDir}${path.sep}`)) {
    findings.push(issue("error", "profile.path.escape", absolute, `${profileId}.${field} resolves outside the skill directory.`));
    return null;
  }
  return absolute;
}

function layoutIdFromSlide(slide) {
  return slide?.layout?.variant ?? slide?.layout?.layout_id ?? slide?.layout?.id ?? slide?.layout_id ?? null;
}

function templateMapEntries(templateMap) {
  if (Array.isArray(templateMap?.referenceHeritage?.sourceSlideMap)) return templateMap.referenceHeritage.sourceSlideMap;
  if (Array.isArray(templateMap?.layouts)) return templateMap.layouts;
  if (Array.isArray(templateMap?.layoutMap)) return templateMap.layoutMap;
  return [];
}

async function requireRegisteredFile(filePath, findings, release, profileId) {
  if (!(await exists(filePath))) {
    findings.push(issue(release ? "error" : "warning", "profile.asset.missing", filePath, `Required asset for profile ${profileId} is missing.`));
    return false;
  }
  const info = await stat(filePath);
  if (!info.isFile() || info.size === 0) {
    findings.push(issue("error", "profile.asset.empty", filePath, `Required asset for profile ${profileId} is empty or not a regular file.`));
    return false;
  }
  return true;
}

async function inspectLayoutLibrary(pptxPath, sample, findings, profileId) {
  if (!sample?.slides || !(await exists(pptxPath))) return;
  try {
    const { stdout: listing } = await execFileAsync("unzip", ["-Z1", pptxPath], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
    const files = listing.split(/\r?\n/);
    const slideCount = files.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length;
    const notesCount = files.filter((name) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name)).length;
    if (slideCount !== sample.slides.length) findings.push(issue("error", "profile.slide.count", pptxPath, `${profileId}: PPTX has ${slideCount} slides but library spec has ${sample.slides.length}.`));
    if (notesCount !== slideCount) findings.push(issue("error", "profile.notes.count", pptxPath, `${profileId}: PPTX has ${slideCount} slides but ${notesCount} notes slides.`));
    const noteFiles = files.filter((name) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name));
    const noteXmlParts = await Promise.all(noteFiles.map(async (name) => ({
      name,
      xml: (await execFileAsync("unzip", ["-p", pptxPath, name], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 })).stdout,
    })));
    for (const note of noteXmlParts) {
      const sourceOpen = (note.xml.match(/\[Sources\]/g) ?? []).length;
      const sourceClose = (note.xml.match(/\[\/Sources\]/g) ?? []).length;
      if (sourceOpen !== 1 || sourceClose !== 1) findings.push(issue("error", "profile.notes.sources", `${pptxPath}:${note.name}`, `${profileId}: expected exactly one [Sources] block; found ${sourceOpen} opening and ${sourceClose} closing markers.`));
    }
  } catch (error) {
    findings.push(issue("error", "profile.pptx.inspect", pptxPath, `${profileId}: could not inspect PPTX parts: ${error.message}`));
  }
}

async function checkRegisteredProfile(skillDir, profileId, profile, findings, release) {
  const registryFile = path.join(skillDir, PROFILE_REGISTRY_PATH);
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    findings.push(issue("error", "profile.invalid", registryFile, `Profile ${profileId} must be an object.`));
    return;
  }
  if (profile.id !== profileId) findings.push(issue("error", "profile.id.mismatch", registryFile, `Profile key ${profileId} must have id=${profileId}.`));
  const profileModes = Array.isArray(profile.modes) ? profile.modes : [];
  if (new Set(profileModes).size !== profileModes.length) findings.push(issue("error", "profile.mode.duplicate", registryFile, `${profileId}.modes contains duplicate values.`));
  for (const [index, mode] of profileModes.entries()) if (typeof mode !== "string" || !mode.trim()) findings.push(issue("error", "profile.mode.invalid", registryFile, `${profileId}.modes[${index}] must be a non-empty string.`));
  const assetDir = resolveRegisteredPath(skillDir, profile.assetDirectory, findings, profileId, "assetDirectory");
  if (assetDir && !(await isDirectory(assetDir))) findings.push(issue(release ? "error" : "warning", "profile.directory", assetDir, `Asset directory for profile ${profileId} is missing.`));
  const referencePath = resolveRegisteredPath(skillDir, profile.reference, findings, profileId, "reference");
  if (referencePath) await requireRegisteredFile(referencePath, findings, release, profileId);

  const paths = {};
  for (const field of PROFILE_ASSET_FIELDS) paths[field] = resolveRegisteredPath(skillDir, profile[field], findings, profileId, field, assetDir ?? skillDir);
  const requiredPaths = new Set();
  for (const [index, relativePath] of (Array.isArray(profile.requiredFiles) ? profile.requiredFiles : []).entries()) {
    const absolute = resolveRegisteredPath(skillDir, relativePath, findings, profileId, `requiredFiles[${index}]`, assetDir ?? skillDir);
    if (absolute) requiredPaths.add(absolute);
  }
  for (const field of PROFILE_ASSET_FIELDS) if (paths[field]) requiredPaths.add(paths[field]);
  for (const filePath of requiredPaths) {
    if (!(await requireRegisteredFile(filePath, findings, release, profileId))) continue;
    if (path.extname(filePath).toLowerCase() === ".pptx") await checkPptx(filePath, findings);
    else if (path.extname(filePath).toLowerCase() === ".json") await checkJson(filePath, findings);
  }

  if (!paths.layoutRegistry || !paths.templateMap || !paths.librarySpec || !paths.layoutLibrary) return;
  const coreFiles = [paths.layoutRegistry, paths.templateMap, paths.librarySpec, paths.layoutLibrary];
  const coreAvailable = await Promise.all(coreFiles.map(exists));
  if (!coreAvailable.every(Boolean)) return;
  const [layoutRegistry, templateMap, sample] = await Promise.all([
    checkJson(paths.layoutRegistry, findings),
    checkJson(paths.templateMap, findings),
    checkJson(paths.librarySpec, findings),
  ]);
  const registryIds = layoutRegistry?.layouts?.map((item) => item?.id).filter(Boolean) ?? [];
  const sampleIds = sample?.slides?.map(layoutIdFromSlide).filter(Boolean) ?? [];
  const mapIds = templateMapEntries(templateMap).map((item) => item?.layoutId ?? item?.id).filter(Boolean);
  const expectedLayoutCount = Number.isInteger(profile.expectedLayoutCount)
    ? profile.expectedLayoutCount
    : registryIds.length;
  if (!Number.isInteger(expectedLayoutCount) || expectedLayoutCount <= 0) findings.push(issue("error", "profile.layout.expected", registryFile, `${profileId}: expectedLayoutCount must be a positive integer or null with a non-empty layout registry.`));
  const severity = release ? "error" : "warning";
  const checkUnique = (ids, file, label) => {
    if (new Set(ids).size !== ids.length) findings.push(issue("error", "profile.layout.duplicate", file, `${profileId}: ${label} contains duplicate layout IDs.`));
  };
  checkUnique(registryIds, paths.layoutRegistry, "layout registry");
  checkUnique(sampleIds, paths.librarySpec, "library spec");
  checkUnique(mapIds, paths.templateMap, "template map");
  for (const [file, label, ids] of [
    [paths.layoutRegistry, "layout registry", registryIds],
    [paths.librarySpec, "library spec", sampleIds],
    [paths.templateMap, "template map", mapIds],
  ]) {
    if (Number.isInteger(expectedLayoutCount) && ids.length !== expectedLayoutCount) findings.push(issue(severity, "profile.layout.count", file, `${profileId}: ${label} must contain ${expectedLayoutCount} layout IDs; found ${ids.length}.`));
  }
  for (const [index, layout] of (layoutRegistry?.layouts ?? []).entries()) {
    if (!Array.isArray(layout?.supportedModes)) continue;
    if (profileModes.length === 0 && layout.supportedModes.length > 0) findings.push(issue("error", "profile.layout.mode.unexpected", paths.layoutRegistry, `${profileId}: layouts[${index}].supportedModes is set but the profile registers no modes.`));
    for (const mode of layout.supportedModes) if (!profileModes.includes(mode)) findings.push(issue("error", "profile.layout.mode.unknown", paths.layoutRegistry, `${profileId}: layout ${layout?.id ?? index} refers to unregistered mode ${mode}.`));
  }
  const missingFrom = (left, right) => left.filter((id) => !right.includes(id));
  for (const [code, file, ids] of [
    ["spec", paths.librarySpec, sampleIds],
    ["map", paths.templateMap, mapIds],
  ]) {
    const missing = missingFrom(registryIds, ids);
    const extra = missingFrom(ids, registryIds);
    if (missing.length || extra.length) findings.push(issue(severity, `profile.layout.${code}.mismatch`, file, `${profileId}: layout IDs differ from registry. Missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"}.`));
    else if (ids.some((id, index) => id !== registryIds[index])) findings.push(issue(severity, `profile.layout.${code}.order`, file, `${profileId}: layout ID order differs from the layout registry.`));
  }
  await inspectLayoutLibrary(paths.layoutLibrary, sample, findings, profileId);
}

async function checkProfiles(skillDir, findings, release) {
  const registryPath = path.join(skillDir, PROFILE_REGISTRY_PATH);
  if (!(await requireRegisteredFile(registryPath, findings, release, "registry"))) return;
  const registry = await checkJson(registryPath, findings);
  if (!registry) return;
  if (!registry.profiles || typeof registry.profiles !== "object" || Array.isArray(registry.profiles) || Object.keys(registry.profiles).length === 0) {
    findings.push(issue("error", "profile.registry.shape", registryPath, "profile-registry.json must contain a non-empty profiles object."));
    return;
  }
  if (!registry.profiles[registry.defaultProfile]) findings.push(issue("error", "profile.registry.default", registryPath, `defaultProfile=${registry.defaultProfile ?? "missing"} is not registered.`));
  const fallback = registry.backwardCompatibility?.missingDeckProfile;
  if (fallback && !registry.profiles[fallback]) findings.push(issue("error", "profile.registry.fallback", registryPath, `backwardCompatibility.missingDeckProfile=${fallback} is not registered.`));
  for (const [profileId, profile] of Object.entries(registry.profiles)) await checkRegisteredProfile(skillDir, profileId, profile, findings, release);
}

export async function validateSkillAssets(skillPath, options = {}) {
  const skillDir = path.resolve(skillPath);
  const findings = [];
  const release = (options.profile ?? "release") === "release";
  if (!(await isDirectory(skillDir))) return { ok: false, skill: skillDir, profile: options.profile, issues: [issue("error", "skill.missing", skillDir, "Skill directory does not exist.")] };

  const skillMd = path.join(skillDir, "SKILL.md");
  if (await requireFile(skillMd, findings, "skill.md.missing")) {
    const markdown = await readFile(skillMd, "utf8");
    const frontmatter = parseFrontmatter(markdown);
    if (!frontmatter) findings.push(issue("error", "skill.frontmatter", skillMd, "SKILL.md needs YAML frontmatter."));
    else {
      if (frontmatter.name !== "academic-slides") findings.push(issue("error", "skill.name", skillMd, `Expected name: academic-slides; received: ${frontmatter.name ?? "missing"}.`));
      if (!frontmatter.description || frontmatter.description.length < 30) findings.push(issue("error", "skill.description", skillMd, "Description is missing or too short to trigger reliably."));
    }
    if (/\[TODO|TODO:|PLACEHOLDER/i.test(markdown)) findings.push(issue(release ? "error" : "warning", "skill.todo", skillMd, "SKILL.md still contains TODO or placeholder text."));
  }
  const agentYaml = path.join(skillDir, "agents", "openai.yaml");
  if (!(await exists(agentYaml))) findings.push(issue(release ? "error" : "warning", "agent.metadata", agentYaml, "agents/openai.yaml is missing."));

  await checkScripts(skillDir, findings, release);
  await checkSchemas(skillDir, findings);
  await checkEvals(skillDir, findings, release);
  await checkReferences(skillDir, findings, release);
  await checkProfiles(skillDir, findings, release);
  await checkLogoCatalog(skillDir, findings, release);
  if (release) await checkReleaseGates(skillDir, findings);

  for (const file of await walk(skillDir)) {
    if (path.basename(file) === ".DS_Store") findings.push(issue("warning", "asset.ds-store", file, "Remove macOS metadata before packaging."));
    if (path.extname(file).toLowerCase() === ".json") await checkJson(file, findings);
  }
  if (options.strict) for (const item of findings) if (item.severity === "warning") item.severity = "error";
  return { ok: !findings.some((item) => item.severity === "error"), skill: skillDir, profile: options.profile ?? "release", issues: findings };
}

function printHuman(result) {
  console.log(`${result.ok ? "PASS" : "FAIL"}: ${result.skill} [profile=${result.profile}]`);
  for (const item of result.issues) console.log(`- ${item.severity.toUpperCase()} ${item.code}: ${item.message} (${item.file})`);
  const errors = result.issues.filter((item) => item.severity === "error").length;
  const warnings = result.issues.filter((item) => item.severity === "warning").length;
  console.log(`${errors} error(s), ${warnings} warning(s)`);
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
    const result = await validateSkillAssets(args.skillDir ?? DEFAULT_SKILL_DIR, args);
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else printHuman(result);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    if (args.json) console.log(JSON.stringify({ ok: false, error: error.message }, null, 2));
    else console.error(`ERROR: ${error.message}`);
    process.exitCode = 2;
  }
}

const invokedDirectly = process.argv[1] && await realpath(process.argv[1]).catch(() => null) === await realpath(fileURLToPath(import.meta.url)).catch(() => null);
if (invokedDirectly) await main();
