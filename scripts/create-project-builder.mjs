#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
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

function usage() {
  return [
    "Usage: node create-project-builder.mjs --spec <deck-spec.json> --output <项目名.mjs> --pptx-name <项目名.pptx> --docx-name <项目名_发言稿.docx> [--theme <name>]",
    "",
    "Theme: blue | red | purple | cyan. When supplied, it is embedded in the project MJS.",
    "The generated project builder embeds the final spec and uses only delivery-relative assets.",
  ].join("\n");
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "-h" || token === "--help") result.help = true;
    else if (["--spec", "--output", "--pptx-name", "--docx-name", "--theme"].includes(token)) {
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

function builderSource(spec, names, themePreset) {
  const serialized = JSON.stringify(spec, null, 2).replaceAll("</script>", "<\\/script>");
  const specSha256 = canonicalSpecHash(spec);
  return `#!/usr/bin/env node

// academic-slides-delivery: ${JSON.stringify({ contract_version: 2, generator: "academic-slides/create-project-builder", stem: names.stem, pptx: names.pptx, docx: names.docx, theme: themePreset, artifact_purpose: spec.artifact_purpose ?? "production", spec_sha256: specSha256 })}

// 项目构建入口。默认同时生成 PPTX 与 Word 发言稿。
// 运行：node ${names.builder}\n// 可选：node ${names.builder} --pptx | --docx | --all
// 需要已安装 academic-slides Skill，或设置 ACADEMIC_SLIDES_SKILL_DIR。

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

async function exists(filePath) {
  try { await fs.access(filePath); return true; } catch { return false; }
}

async function locateSkill() {
  const candidates = [
    process.env.ACADEMIC_SLIDES_SKILL_DIR,
    path.join(PROJECT_DIR, "academic-slides"),
    path.join(PROJECT_DIR, "..", "academic-slides"),
    path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "skills", "academic-slides"),
  ].filter(Boolean).map((item) => path.resolve(item));
  for (const candidate of candidates) {
    if (await exists(path.join(candidate, "scripts", "presentation-core.mjs"))
      && await exists(path.join(candidate, "scripts", "validate-deck-spec.mjs"))
      && await exists(path.join(candidate, "scripts", "validate-scientific-design.mjs"))) return candidate;
  }
  throw new Error("找不到 academic-slides Skill。请安装该 Skill，或设置 ACADEMIC_SLIDES_SKILL_DIR。");
}

async function main() {
  const actualSpecSha256 = crypto.createHash("sha256").update(JSON.stringify(deckSpec)).digest("hex");
  if (actualSpecSha256 !== expectedSpecSha256) throw new Error("项目规格完整性校验失败；请重新生成项目 MJS。");
  const flags = new Set(process.argv.slice(2));
  const unknown = [...flags].filter((flag) => !["--pptx", "--docx", "--all"].includes(flag));
  if (unknown.length) throw new Error(\`未知参数：\${unknown.join(", ")}\`);
  const buildPptx = flags.size === 0 || flags.has("--all") || flags.has("--pptx");
  const buildDocx = flags.size === 0 || flags.has("--all") || flags.has("--docx");
  const skillDir = await locateSkill();
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
  const designValidation = scientific.validateScientificDesign(deckSpec, { strict: true });
  if (!designValidation.ok) {
    const summary = designValidation.issues.slice(0, 8).map((item) =>
      \`\${item.code} \${item.path}: \${item.message}\`
    ).join("\\n");
    throw new Error(\`科学设计校验未通过（\${designValidation.summary.errors} 个错误）：\\n\${summary}\`);
  }
  const core = await import(pathToFileURL(path.join(skillDir, "scripts", "presentation-core.mjs")).href);
  const word = await import(pathToFileURL(path.join(skillDir, "scripts", "build-speaker-script.mjs")).href);
  const outputs = {};
  if (buildPptx) {
    const template = await core.loadTemplateConfiguration(deckSpec.profile || "final_defense");
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
  if (buildDocx) outputs.docx = await word.buildSpeakerScriptFromSpec(deckSpec, path.join(PROJECT_DIR, ${JSON.stringify(names.docx)}));
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
  await fs.writeFile(output, builderSource(spec, names, themePreset), { encoding: "utf8", mode: 0o755 });
  return { output, pptxName: names.pptx, docxName: names.docx, theme: themePreset, bytes: (await fs.stat(output)).size };
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
