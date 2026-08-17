#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(SCRIPT_DIR, "..");
const STATE_FILENAME = ".academic-slides-build-state.json";
const PREVIEW_DIRNAME = ".academic-slides-preview";
const THEMES = new Set(["blue", "red", "purple", "cyan"]);
const RELEVANT_SOURCE_FILES = [
  "scripts/build-project.mjs",
  "scripts/build.mjs",
  "scripts/build-speaker-script.mjs",
  "scripts/create-project-builder.mjs",
  "scripts/presentation-core.mjs",
  "scripts/speaker-notes.mjs",
  "scripts/validate-deck-spec.mjs",
  "scripts/validate-scientific-design.mjs",
  "schemas/deck-spec.schema.json",
  "assets/profile-registry.json",
];

function usage() {
  return [
    "Usage: node build-project.mjs --spec <deck-spec.json> --output-dir <dir> --stem <name> [options]",
    "",
    "Options:",
    "  --theme <name>  blue | red | purple | cyan",
    "  --render        Render one internal slide preview after the build",
    "  --force         Ignore a matching build signature",
    "  -h, --help      Show this help",
  ].join("\n");
}

function parseArgs(argv) {
  const result = { render: false, force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "-h" || token === "--help") result.help = true;
    else if (token === "--render") result.render = true;
    else if (token === "--force") result.force = true;
    else if (["--spec", "--output-dir", "--stem", "--theme"].includes(token)) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${token} requires a value.`);
      result[token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    } else throw new Error(`Unknown option: ${token}`);
  }
  return result;
}

function validateStem(value) {
  const stem = String(value ?? "").trim();
  if (!stem || [".", ".."].includes(stem) || path.basename(stem) !== stem || /[\\/:*?"<>|]/.test(stem)) {
    throw new Error("--stem must be a simple filename stem without path separators.");
  }
  return stem;
}

async function isFile(filePath) {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function isNonEmptyDirectory(directoryPath) {
  try {
    return (await fs.readdir(directoryPath)).length > 0;
  } catch {
    return false;
  }
}

function collectStrings(value, output = []) {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, output));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => collectStrings(item, output));
  return output;
}

async function referencedLocalFiles(spec, specDir) {
  const candidates = new Set();
  for (const raw of collectStrings(spec)) {
    const value = raw.trim();
    if (!value || /^(?:https?|mailto|doi):/i.test(value)) continue;
    const candidate = path.isAbsolute(value) ? path.normalize(value) : path.resolve(specDir, value);
    if (await isFile(candidate)) candidates.add(candidate);
  }
  return [...candidates].sort((left, right) => left.localeCompare(right, "en"));
}

async function profileConfigurationFiles(spec) {
  const registryPath = path.join(SKILL_DIR, "assets", "profile-registry.json");
  const registry = JSON.parse(await fs.readFile(registryPath, "utf8"));
  const profileId = String(spec?.profile || registry.defaultProfile || "final_defense");
  const profile = registry.profiles?.[profileId];
  if (!profile?.assetDirectory) return [];
  const templateDir = path.resolve(SKILL_DIR, profile.assetDirectory);
  if (templateDir !== SKILL_DIR && !templateDir.startsWith(`${SKILL_DIR}${path.sep}`)) {
    throw new Error(`Profile ${profileId} resolves outside the Skill directory.`);
  }
  const files = ["design-tokens.json", "theme-presets.json", "layout-registry.json"]
    .map((filename) => path.join(templateDir, filename));
  const existing = [];
  for (const filePath of files) if (await isFile(filePath)) existing.push(filePath);
  return existing;
}

async function updateHashWithFile(hash, label, filePath) {
  hash.update(`\n${label}\0`);
  hash.update(await fs.readFile(filePath));
}

export async function computeProjectSignature(options) {
  const specPath = path.resolve(options.spec);
  const specBytes = await fs.readFile(specPath);
  const spec = JSON.parse(specBytes.toString("utf8"));
  const hash = crypto.createHash("sha256");
  hash.update("academic-slides-project-build:v1\0");
  hash.update(`stem=${options.stem}\0theme=${options.theme ?? ""}\0`);
  hash.update("spec\0");
  hash.update(specBytes);

  const localFiles = await referencedLocalFiles(spec, path.dirname(specPath));
  for (const filePath of localFiles) {
    const relative = path.relative(path.dirname(specPath), filePath);
    const label = relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
      ? `asset:${relative.split(path.sep).join("/")}`
      : `external-asset:${path.basename(filePath)}`;
    await updateHashWithFile(hash, label, filePath);
  }

  const sourceFiles = [
    ...RELEVANT_SOURCE_FILES.map((relativePath) => path.join(SKILL_DIR, relativePath)),
    ...await profileConfigurationFiles(spec),
  ];
  for (const filePath of [...new Set(sourceFiles)].sort((left, right) => left.localeCompare(right, "en"))) {
    if (await isFile(filePath)) await updateHashWithFile(hash, `skill:${path.relative(SKILL_DIR, filePath)}`, filePath);
  }
  return { signature: hash.digest("hex"), spec, referencedAssets: localFiles };
}

async function loadState(statePath) {
  try {
    const state = JSON.parse(await fs.readFile(statePath, "utf8"));
    return state && typeof state === "object" ? state : null;
  } catch {
    return null;
  }
}

async function writeJsonAtomically(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(5).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fs.rename(temporary, filePath);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

function defaultBuilders() {
  let deckModule;
  let wordModule;
  let projectBuilderModule;
  return {
    async createProjectBuilder(args) {
      projectBuilderModule ??= import("./create-project-builder.mjs");
      return (await projectBuilderModule).createProjectBuilder(args);
    },
    async buildDeck(args) {
      deckModule ??= import("./build.mjs");
      return (await deckModule).buildDeck(args);
    },
    async buildSpeakerScriptFromFile(specPath, outputPath) {
      wordModule ??= import("./build-speaker-script.mjs");
      return (await wordModule).buildSpeakerScriptFromFile(specPath, outputPath);
    },
  };
}

function outputPaths(outputDir, stem) {
  return {
    pptx: path.join(outputDir, `${stem}.pptx`),
    docx: path.join(outputDir, `${stem}_发言稿.docx`),
    mjs: path.join(outputDir, `${stem}.mjs`),
  };
}

async function outputsExist(outputs) {
  return (await Promise.all(Object.values(outputs).map(isFile))).every(Boolean);
}

export async function buildProject(options, injectedBuilders = null) {
  if (!options?.spec) throw new Error("--spec is required.");
  if (!options?.outputDir) throw new Error("--output-dir is required.");
  const stem = validateStem(options.stem);
  const theme = options.theme ? String(options.theme).trim().toLowerCase() : null;
  if (theme && !THEMES.has(theme)) throw new Error(`Unsupported --theme "${options.theme}". Use blue, red, purple, or cyan.`);

  const specPath = path.resolve(options.spec);
  const outputDir = path.resolve(options.outputDir);
  await fs.mkdir(outputDir, { recursive: true });
  const outputs = outputPaths(outputDir, stem);
  const statePath = path.join(outputDir, STATE_FILENAME);
  const previewDir = path.join(outputDir, PREVIEW_DIRNAME);
  const signatureInfo = await computeProjectSignature({ spec: specPath, stem, theme });
  const previous = await loadState(statePath);
  const renderSatisfied = options.render !== true || (previous?.rendered === true && await isNonEmptyDirectory(previewDir));
  if (options.force !== true
    && previous?.signature === signatureInfo.signature
    && renderSatisfied
    && await outputsExist(outputs)) {
    return {
      ok: true,
      cached: true,
      signature: signatureInfo.signature,
      outputs,
      previewDir: previous.rendered === true ? previewDir : null,
    };
  }

  const builders = injectedBuilders ?? defaultBuilders();
  const workDir = path.join(outputDir, `.academic-slides-build-${process.pid}-${crypto.randomBytes(5).toString("hex")}`);
  const workOutputs = outputPaths(workDir, stem);
  const workPreviewDir = path.join(workDir, PREVIEW_DIRNAME);
  await fs.mkdir(workDir, { recursive: true });
  let deckReport;
  let wordReport;
  let builderReport;
  try {
    // Portability and scientific-design checks in createProjectBuilder are cheap.
    // Run them before the expensive presentation render, but keep the generated
    // MJS in an internal transaction directory until every artifact succeeds.
    builderReport = await builders.createProjectBuilder({
      spec: specPath,
      output: workOutputs.mjs,
      pptxName: path.basename(outputs.pptx),
      docxName: path.basename(outputs.docx),
      theme: theme ?? undefined,
    });
    deckReport = await builders.buildDeck({
      spec: specPath,
      output: workOutputs.pptx,
      theme: theme ?? undefined,
      previewDir: options.render === true ? workPreviewDir : undefined,
    });
    wordReport = await builders.buildSpeakerScriptFromFile(specPath, workOutputs.docx);
    if (!(await outputsExist(workOutputs))) throw new Error("Project build did not create all three required outputs.");
    if (options.render === true && !(await isNonEmptyDirectory(workPreviewDir))) {
      throw new Error("--render completed without producing preview files.");
    }

    for (const key of ["pptx", "docx", "mjs"]) await fs.rename(workOutputs[key], outputs[key]);
    if (options.render === true) {
      await fs.rm(previewDir, { recursive: true, force: true });
      await fs.rename(workPreviewDir, previewDir);
    } else {
      await fs.rm(previewDir, { recursive: true, force: true });
    }
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
  if (!(await outputsExist(outputs))) throw new Error("Project build did not publish all three required outputs.");

  const state = {
    schema_version: 1,
    signature: signatureInfo.signature,
    spec: specPath,
    stem,
    theme,
    outputs: Object.fromEntries(Object.entries(outputs).map(([key, value]) => [key, path.basename(value)])),
    rendered: options.render === true,
    referenced_asset_count: signatureInfo.referencedAssets.length,
    completed_at: new Date().toISOString(),
  };
  await writeJsonAtomically(statePath, state);
  return {
    ok: true,
    cached: false,
    signature: signatureInfo.signature,
    outputs,
    previewDir: options.render === true ? previewDir : null,
    reports: {
      deck: { ...deckReport, output: outputs.pptx, previewDir: options.render === true ? previewDir : null },
      word: { ...wordReport, output: outputs.docx },
      builder: { ...builderReport, output: outputs.mjs },
    },
  };
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
    console.log(JSON.stringify(await buildProject(args), null, 2));
  } catch (error) {
    console.error(`PROJECT BUILD FAILED: ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}

const direct = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (direct) await main();

export { parseArgs };
