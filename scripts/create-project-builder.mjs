#!/usr/bin/env node

import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateDeckSpecFile } from "./validate-deck-spec.mjs";
import { validateScientificDesignFile } from "./validate-scientific-design.mjs";

const ABSOLUTE_FILE_PATTERN = /^(?:\/(?!\/)|[A-Za-z]:[\\/]|\\\\|~[\\/]|\$HOME[\\/]|(?:file|smb):\/{2,3})/i;
const KNOWN_ABSOLUTE_ROOT_PATTERN = /(?:^|[\s"'=(:;,])\/(?:Users|Volumes|home|tmp|private|var|root|mnt|media|workspace|etc|opt|usr|Applications|Library)(?:\/|$)/m;
const POSIX_ABSOLUTE_PATH_PATTERN = /(?:^|[\s"'=(:;,])\/(?!\/|>)(?:[^\s"'<>\/]+\/)*[^\s"'<>\/]+\.[A-Za-z0-9]{1,10}/m;
const NETWORK_PATH_PATTERN = /(?:^|[\s"'=(:;,])(?:\/\/[^\/\s"'<>]+\/[^\s"'<>]+|\\\\[^\\\s"'<>]+\\[^\s"'<>]+)/m;
const WINDOWS_OR_URI_PATH_PATTERN = /(?:^|[\s"'=(:;,])(?:[A-Za-z]:[\\/]|~[\\/]|\$HOME[\\/]|(?:file|smb):\/{2,3})/im;
const RELATIVE_FILE_PATH_PATTERN = /(?:^|[\s"'=(:;,])(?:\.{1,2}[\\/]|[^\s"'<>\\/]+[\\/])(?:[^\s"'<>\\/]+[\\/])*[^\s"'<>\\/]+\.[A-Za-z0-9]{1,10}/m;
const SAFE_PUBLIC_URL_PATTERN = /\b(?:https?|mailto):[^\s"'<>]+/gi;
const SAFE_API_ROUTE_PATTERN = /\/api\/v\d+(?:\.\d+)?(?:\/[A-Za-z0-9._~{}:-]+)*/gi;
const PATH_TRAVERSAL_PATTERN = /(?:^|[\\/])\.\.(?:[\\/]|$)/;
const BARE_DOI_PATTERN = /\b10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+/gi;
const PATH_FIELD_PATTERN = /^(?:path|file|src|uri|.*_path)$/i;
const SUPPORTED_THEME_PRESETS = new Set(["blue", "red", "purple", "cyan"]);
const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);
const DELIVERY_MODES = new Set(["pptx_with_notes", "presenter_pack", "rebuildable_pack"]);

export function normalizeDeliveryMode(value = "rebuildable_pack") {
  if (!DELIVERY_MODES.has(value)) throw new Error(`Unknown delivery mode: ${value}. Use pptx_with_notes, presenter_pack, or rebuildable_pack.`);
  return value;
}

export function deliveryNeedsWord(mode) {
  return normalizeDeliveryMode(mode) !== "pptx_with_notes";
}

export async function resolveDeliveryMode(options = {}, projectDir = null) {
  if (options.deliveryMode != null) return normalizeDeliveryMode(options.deliveryMode);
  if (projectDir) {
    for (const name of ["project-config.json", "project.config.json", "project.json"]) {
      let source;
      try { source = await fs.readFile(path.join(projectDir, name), "utf8"); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      return normalizeDeliveryMode(JSON.parse(source).output?.delivery_mode ?? "rebuildable_pack");
    }
  }
  return "rebuildable_pack";
}

async function runtimePackageVersion(name, skillDir) {
  const resolver = createRequire(path.join(skillDir, "scripts", "runtime-probe.cjs"));
  let entry;
  try { entry = resolver.resolve(name); } catch { /* Try the explicit bundled runtime. */ }
  if (entry) {
    for (let current = path.dirname(entry); current !== path.dirname(current); current = path.dirname(current)) {
      try {
        const manifest = JSON.parse(await fs.readFile(path.join(current, "package.json"), "utf8"));
        if (manifest.name === name) return manifest.version ?? null;
      } catch { /* Continue to the package root. */ }
    }
  }
  for (const root of [process.env.RUNTIME_NODE_MODULES, path.resolve(path.dirname(process.execPath), "..", "node_modules")].filter(Boolean)) {
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(root, ...name.split("/"), "package.json"), "utf8"));
      if (manifest.name === name) return manifest.version ?? null;
    } catch { /* Report unavailable explicitly below. */ }
  }
  return null;
}

export async function captureBuildManifest(options = {}) {
  const skillDir = path.resolve(options.skillDir ?? SKILL_DIR);
  const deliveryMode = normalizeDeliveryMode(options.deliveryMode);
  const profile = options.profile ?? "group_meeting_literature";
  const files = [
    "scripts/create-project-builder.mjs", "scripts/presentation-core.mjs", "scripts/speaker-notes.mjs",
    "scripts/validate-deck-spec.mjs", "scripts/validate-scientific-design.mjs", "scripts/validate-scientific-content.mjs",
    "schemas/deck-spec.schema.json", "assets/profile-registry.json",
    ...(deliveryNeedsWord(deliveryMode) ? ["scripts/build-speaker-script.mjs"] : []),
  ];
  const registry = JSON.parse(await fs.readFile(path.join(skillDir, "assets", "profile-registry.json"), "utf8"));
  const configuration = registry.profiles?.[profile];
  if (!configuration?.assetDirectory) throw new Error(`Unknown build profile: ${profile}`);
  const templateDir = path.resolve(skillDir, configuration.assetDirectory);
  if (!templateDir.startsWith(`${skillDir}${path.sep}`)) throw new Error("Build profile escapes the skill directory.");
  for (const name of [configuration.designTokens, configuration.themePresets, configuration.layoutRegistry, configuration.templateMap].filter(Boolean).sort()) {
    files.push(path.relative(skillDir, path.join(templateDir, name)).split(path.sep).join("/"));
  }
  const hashes = {};
  for (const file of [...new Set(files)].sort()) hashes[file] = crypto.createHash("sha256").update(await fs.readFile(path.join(skillDir, file))).digest("hex");
  const packages = {};
  for (const name of ["@oai/artifact-tool", "sharp", ...(deliveryNeedsWord(deliveryMode) ? ["docx"] : [])]) packages[name] = await runtimePackageVersion(name, skillDir);
  let gitCommit = null;
  let gitDirty = null;
  try {
    const result = await execFileAsync("git", ["-C", skillDir, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 5_000 });
    if (/^[a-f0-9]{40,64}$/i.test(result.stdout.trim())) gitCommit = result.stdout.trim();
    const status = await execFileAsync("git", ["-C", skillDir, "status", "--porcelain", "--", "."], { encoding: "utf8", timeout: 5_000 });
    gitDirty = status.stdout.trim().length > 0;
  } catch { /* Installed ZIP skills can still be pinned by their file hashes. */ }
  return {
    manifest_version: 1, profile, delivery_mode: deliveryMode, skill_git_commit: gitCommit, skill_git_dirty: gitDirty,
    files: hashes,
    runtime: { node: process.versions.node, platform: process.platform, arch: process.arch, packages, cjk_font: process.env.PAPER_CLUB_PPT_CJK_FONT ?? null },
    reproducibility: "File hashes identify the actual snapshot; Git metadata is provenance only. Runtime versions are pinned, but fonts and Office rendering still need verification on the target system.",
  };
}

export async function verifyBuildManifest(expected, options = {}) {
  if (!expected || expected.manifest_version !== 1 || !expected.files || !expected.runtime) throw new Error("BUILD_MANIFEST_MISSING: legacy snapshots do not pin their build environment. Use stage-delivery.mjs --migrate to validate and create a new snapshot; then repeat visual QA.");
  const needsWord = deliveryNeedsWord(expected.delivery_mode) && deliveryNeedsWord(options.deliveryMode ?? expected.delivery_mode);
  const actual = await captureBuildManifest({ ...options, profile: expected.profile, deliveryMode: needsWord ? expected.delivery_mode : "pptx_with_notes" });
  const changed = [...new Set([...Object.keys(expected.files), ...Object.keys(actual.files)])]
    .filter((name) => needsWord || name !== "scripts/build-speaker-script.mjs")
    .filter((name) => expected.files[name] !== actual.files[name]);
  const runtimeForMode = (runtime) => ({ ...runtime, packages: Object.fromEntries(Object.entries(runtime.packages ?? {}).filter(([name]) => needsWord || name !== "docx")) });
  if (JSON.stringify(runtimeForMode(expected.runtime)) !== JSON.stringify(runtimeForMode(actual.runtime))) changed.push("runtime versions or font selection");
  if (changed.length) throw new Error(`BUILD_ENVIRONMENT_DRIFT: ${changed.join(", ")}. Restore the recorded skill/runtime, or run stage-delivery.mjs --migrate to create a new snapshot and repeat visual QA. Migration does not reproduce the old environment.`);
  return { ok: true, skill_git_commit: expected.skill_git_commit, checked_files: Object.keys(expected.files).length };
}

function usage() {
  return [
    "Usage: node create-project-builder.mjs --spec <deck-spec.json> --output <项目名.mjs> --pptx-name <项目名.pptx> --docx-name <项目名_发言稿.docx> [--theme <name>]",
    "",
    "Theme: blue | red | purple | cyan. When supplied, it is embedded in the project MJS.",
    "The generated project builder embeds the final spec and uses only delivery-relative assets.",
    "  --delivery-mode <mode>  pptx_with_notes | presenter_pack | rebuildable_pack (legacy default)",
  ].join("\n");
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "-h" || token === "--help") result.help = true;
    else if (["--spec", "--output", "--pptx-name", "--docx-name", "--theme", "--delivery-mode"].includes(token)) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${token} requires a value.`);
      result[token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    } else throw new Error(`Unknown option: ${token}`);
  }
  return result;
}

function safeBasename(value, extension) {
  const candidate = String(value ?? "").trim();
  if (!candidate || path.basename(candidate) !== candidate || !candidate.toLowerCase().endsWith(extension)) {
    throw new Error(`Expected a simple ${extension} filename, got: ${candidate || "<empty>"}`);
  }
  return candidate;
}

function normalizeAssetPath(value) {
  const candidate = String(value ?? "").trim();
  if (!candidate || candidate !== value || candidate.includes("\\") || ABSOLUTE_FILE_PATTERN.test(candidate)) {
    throw new Error(`Delivery asset path must be package-relative: ${value || "<empty>"}`);
  }
  const segments = candidate.split("/");
  if (segments[0] !== "assets" || segments.length < 3 || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`Delivery asset path must stay inside assets/: ${candidate}`);
  }
  return segments.join("/");
}

function looksLikeFileReference(value) {
  return ABSOLUTE_FILE_PATTERN.test(value)
    || value.includes("\\")
    || value.startsWith("./")
    || value.startsWith("../")
    || /(?:^|\/)\.\.(?:\/|$)/.test(value)
    || /\.[A-Za-z0-9]{2,8}(?:$|[?#])/.test(value);
}

function containsLocalPath(value) {
  const raw = String(value);
  if (PATH_TRAVERSAL_PATTERN.test(raw)) return true;
  const withoutPublicUrls = raw.replace(SAFE_PUBLIC_URL_PATTERN, "").replace(SAFE_API_ROUTE_PATTERN, "").replace(BARE_DOI_PATTERN, "");
  return KNOWN_ABSOLUTE_ROOT_PATTERN.test(withoutPublicUrls)
    || POSIX_ABSOLUTE_PATH_PATTERN.test(withoutPublicUrls)
    || NETWORK_PATH_PATTERN.test(withoutPublicUrls)
    || WINDOWS_OR_URI_PATH_PATTERN.test(withoutPublicUrls)
    || RELATIVE_FILE_PATH_PATTERN.test(withoutPublicUrls);
}

function stripInternalFields(value, depth = 0) {
  if (Array.isArray(value)) return value.map((item) => stripInternalFields(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "decision_log" || key === "qa") continue;
    if (key === "path" && typeof item === "string" && typeof value.citation === "string") {
      output[key] = null;
      continue;
    }
    if (typeof item === "string" && PATH_FIELD_PATTERN.test(key)) {
      output[key] = normalizeAssetPath(item);
      continue;
    }
    output[key] = stripInternalFields(item, depth + 1);
  }
  return output;
}

function assertPortable(value, location = "spec", key = "") {
  if (typeof value === "string") {
    if (PATH_FIELD_PATTERN.test(key)) {
      normalizeAssetPath(value);
      return;
    }
    if (/(?:asset_ref|fallback_asset_ref)$/i.test(key) && looksLikeFileReference(value)) {
      normalizeAssetPath(value);
      return;
    }
    if (containsLocalPath(value)) {
      throw new Error(`${location} contains a path outside the delivery package: ${value}`);
    }
    return;
  }
  if (Array.isArray(value)) value.forEach((item, index) => assertPortable(item, `${location}[${index}]`, key));
  else if (value && typeof value === "object") {
    for (const [childKey, item] of Object.entries(value)) assertPortable(item, `${location}.${childKey}`, childKey);
  }
}

function normalizeThemePreset(value) {
  if (value === undefined || value === null || value === "") return null;
  const preset = String(value).trim().toLowerCase();
  if (!SUPPORTED_THEME_PRESETS.has(preset)) {
    throw new Error(`Unsupported theme preset "${value}". Use blue, red, purple, or cyan.`);
  }
  return preset;
}

function canonicalSpecHash(spec) {
  return crypto.createHash("sha256").update(JSON.stringify(spec)).digest("hex");
}

function builderSource(spec, names, themePreset, buildManifest) {
  const serialized = JSON.stringify(spec, null, 2).replaceAll("</script>", "<\\/script>");
  const specSha256 = canonicalSpecHash(spec);
  return `#!/usr/bin/env node

// paper-club-ppt-delivery: ${JSON.stringify({ contract_version: 3, generator: "paper-club-ppt/create-project-builder", stem: names.stem, pptx: names.pptx, docx: names.docx, theme: themePreset, artifact_purpose: spec.artifact_purpose ?? "production", spec_sha256: specSha256, delivery_mode: buildManifest.delivery_mode, build_manifest: buildManifest })}

// 项目构建入口。默认同时生成 PPTX 与 Word 发言稿。
// 运行：node ${names.builder}\n// 可选：node ${names.builder} --pptx | --docx | --all
// 需要已安装 paper-club-ppt Skill，或设置 PAPER_CLUB_PPT_SKILL_DIR。
// 这是封存快照。修改内容前用 --export-spec <spec.json> 导出，再由 Skill 验证并生成新快照。
// --check-environment 只核对环境；版本漂移时恢复原环境，或使用 stage-delivery.mjs --migrate 后重新做视觉 QA。

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROJECT_DIR = path.dirname(fileURLToPath(import.meta.url));
const deckSpec = ${serialized};
const themePreset = ${JSON.stringify(themePreset)};
const expectedSpecSha256 = ${JSON.stringify(specSha256)};
const buildManifest = ${JSON.stringify(buildManifest, null, 2)};

async function exists(filePath) {
  try { await fs.access(filePath); return true; } catch { return false; }
}

async function locateSkill() {
  const candidates = [
    process.env.PAPER_CLUB_PPT_SKILL_DIR,
    path.join(PROJECT_DIR, "paper-club-ppt"),
    path.join(PROJECT_DIR, "..", "paper-club-ppt"),
    path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "skills", "paper-club-ppt"),
  ].filter(Boolean).map((item) => path.resolve(item));
  for (const candidate of candidates) {
    if (await exists(path.join(candidate, "scripts", "presentation-core.mjs"))
      && await exists(path.join(candidate, "scripts", "validate-deck-spec.mjs"))
      && await exists(path.join(candidate, "scripts", "validate-scientific-design.mjs"))) return candidate;
  }
  throw new Error("找不到 paper-club-ppt Skill。请安装该 Skill，或设置 PAPER_CLUB_PPT_SKILL_DIR。");
}

async function main() {
  const actualSpecSha256 = crypto.createHash("sha256").update(JSON.stringify(deckSpec)).digest("hex");
  if (actualSpecSha256 !== expectedSpecSha256) throw new Error("项目规格完整性校验失败；请从原始快照用 --export-spec 导出，修改后验证并重新生成项目 MJS。");
  const argv = process.argv.slice(2);
  if (argv[0] === "--export-spec") {
    if (argv.length !== 2 || argv[1].startsWith("--")) throw new Error("--export-spec requires one new output filename.");
    await fs.writeFile(path.resolve(argv[1]), JSON.stringify(deckSpec, null, 2) + "\\n", { flag: "wx" });
    console.log("Exported editable specification. Validate it and generate a new snapshot after changes.");
    return;
  }
  const flags = new Set(argv);
  const unknown = [...flags].filter((flag) => !["--pptx", "--docx", "--all", "--check-environment"].includes(flag));
  if (unknown.length) throw new Error(\`未知参数：\${unknown.join(", ")}\`);
  if (flags.has("--docx") && buildManifest.delivery_mode === "pptx_with_notes") throw new Error("This snapshot contains no Word build. Generate a presenter_pack or rebuildable_pack snapshot first.");
  const buildPptx = flags.size === 0 || flags.has("--all") || flags.has("--pptx");
  const buildDocx = buildManifest.delivery_mode !== "pptx_with_notes" && (flags.size === 0 || flags.has("--all") || flags.has("--docx"));
  const skillDir = await locateSkill();
  // Check pinned code before importing anything from the installed Skill.
  for (const [relative, expectedHash] of Object.entries(buildManifest.files)) {
    const bytes = await fs.readFile(path.join(skillDir, relative)).catch(() => null);
    if (!bytes || crypto.createHash("sha256").update(bytes).digest("hex") !== expectedHash) {
      throw new Error(\`BUILD_ENVIRONMENT_DRIFT: \${relative}. Restore the recorded skill/runtime, or use stage-delivery.mjs --migrate and repeat visual QA.\`);
    }
  }
  const manifestTools = await import(pathToFileURL(path.join(skillDir, "scripts", "create-project-builder.mjs")).href);
  await manifestTools.verifyBuildManifest(buildManifest, { skillDir });
  if (flags.has("--check-environment")) { console.log(JSON.stringify({ ok: true, environment_pinned: true })); return; }
  const deckValidator = await import(pathToFileURL(path.join(skillDir, "scripts", "validate-deck-spec.mjs")).href);
  const deckValidation = await deckValidator.validateDeckSpec(deckSpec, {
    strict: true,
    requireSchema: true,
    schemaPath: path.join(skillDir, "schemas", "deck-spec.schema.json"),
  });
  const deckErrors = deckValidation.issues.filter((item) => item.severity === "error");
  if (deckErrors.length) {
    const summary = deckErrors.slice(0, 8).map((item) =>
      \`\${item.code} \${item.path}: \${item.message}\`
    ).join("\\n");
    throw new Error(\`deck-spec 校验未通过（\${deckErrors.length} 个错误）：\\n\${summary}\`);
  }
  const scientific = await import(pathToFileURL(path.join(skillDir, "scripts", "validate-scientific-design.mjs")).href);
  const designValidation = await scientific.validateScientificDesignAssets(deckSpec, { strict: true, baseDir: PROJECT_DIR });
  if (!designValidation.ok) {
    const summary = designValidation.issues.slice(0, 8).map((item) =>
      \`\${item.code} \${item.path}: \${item.message}\`
    ).join("\\n");
    throw new Error(\`科学设计校验未通过（\${designValidation.summary.errors} 个错误）：\\n\${summary}\`);
  }
  const outputs = {};
  if (buildPptx) {
    const core = await import(pathToFileURL(path.join(skillDir, "scripts", "presentation-core.mjs")).href);
    const template = await core.loadTemplateConfiguration(deckSpec.profile || "group_meeting_literature");
    const built = await core.createPresentationFromSpec(deckSpec, {
      profile: deckSpec.profile,
      baseDir: PROJECT_DIR,
      tokens: template.tokens,
      presets: template.presets,
      theme: themePreset || undefined,
      allowPlaceholder: false,
    });
    const pptxPath = path.join(PROJECT_DIR, ${JSON.stringify(names.pptx)});
    outputs.pptx = await core.exportPresentation(built.presentation, pptxPath);
    await fs.rm(\`\${pptxPath}.inspect.ndjson\`, { force: true });
  }
  if (buildDocx) {
    const word = await import(pathToFileURL(path.join(skillDir, "scripts", "build-speaker-script.mjs")).href);
    outputs.docx = await word.buildSpeakerScriptFromSpec(deckSpec, path.join(PROJECT_DIR, ${JSON.stringify(names.docx)}));
  }
  console.log(JSON.stringify({ ok: true, ...outputs }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
`;
}

export async function createProjectBuilder(options) {
  const themePreset = normalizeThemePreset(options.theme);
  const specPath = path.resolve(options.spec);
  const raw = JSON.parse(await fs.readFile(specPath, "utf8"));
  if ((raw.artifact_purpose ?? "production") === "layout_gallery") {
    throw new Error("layout_gallery specifications may build internal layout libraries with build.mjs, but cannot create a customer project MJS.");
  }
  const validation = await validateDeckSpecFile(specPath, { strict: true, requireSchema: true });
  const errors = validation.issues.filter((item) => item.severity === "error");
  if (errors.length) throw new Error(`deck-spec validation failed before project builder generation (${errors.length} issue(s)).`);
  const scientific = await validateScientificDesignFile(specPath, { strict: true });
  if (!scientific.ok) {
    throw new Error(`scientific-design validation failed before project builder generation (${scientific.summary.errors} error(s)).`);
  }
  const spec = stripInternalFields(raw);
  assertPortable(spec);
  const deliveryMode = normalizeDeliveryMode(options.deliveryMode);
  const buildManifest = options.buildManifest ?? await captureBuildManifest({ profile: spec.profile, deliveryMode });
  if (buildManifest.delivery_mode !== deliveryMode || buildManifest.profile !== (spec.profile ?? "group_meeting_literature")) throw new Error("Build manifest does not match the project profile and delivery mode.");
  if (options.buildManifest) await verifyBuildManifest(buildManifest, { deliveryMode: options.verifyDeliveryMode ?? deliveryMode });
  const output = path.resolve(options.output);
  const names = {
    builder: safeBasename(path.basename(output), ".mjs"),
    pptx: safeBasename(options.pptxName, ".pptx"),
    docx: safeBasename(options.docxName, ".docx"),
  };
  names.stem = path.basename(names.builder, ".mjs");
  if (names.pptx !== `${names.stem}.pptx` || names.docx !== `${names.stem}_发言稿.docx`) {
    throw new Error(`Project builder outputs must share the builder stem ${names.stem}.`);
  }
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, builderSource(spec, names, themePreset, buildManifest), { encoding: "utf8", mode: 0o755 });
  return { output, pptxName: names.pptx, docxName: names.docx, deliveryMode, buildManifest, theme: themePreset, bytes: (await fs.stat(output)).size };
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
  if (!args.spec || !args.output || !args.pptxName || !args.docxName) {
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  try {
    console.log(JSON.stringify(await createProjectBuilder(args), null, 2));
  } catch (error) {
    console.error(`PROJECT BUILDER FAILED: ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}

const direct = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (direct) await main();

export { parseArgs, stripInternalFields, assertPortable };
