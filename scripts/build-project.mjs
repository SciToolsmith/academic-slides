#!/usr/bin/env node

import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateProject } from "./validate-project.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(SCRIPT_DIR, "..");
const STATE_FILENAME = ".academic-slides-build-state.json";
const PREVIEW_DIRNAME = ".academic-slides-preview";
const THEMES = new Set(["blue", "red", "purple", "cyan"]);
const LOCK_OWNER_FILENAME = "owner.json";
const LOCK_POLL_MS = 50;
const LOCK_WAIT_MS = 2 * 60 * 60 * 1000;
const LOCK_ORPHAN_STALE_MS = 60 * 1000;
const LOCK_REMOTE_STALE_MS = 6 * 60 * 60 * 1000;
const LOCK_ABSOLUTE_STALE_MS = 24 * 60 * 60 * 1000;
const LOCK_HEARTBEAT_MS = 30 * 1000;
const IN_PROCESS_LOCKS = new Map();
const REQUIRE = createRequire(import.meta.url);
const RELEVANT_SOURCE_FILES = [
  "scripts/build-project.mjs",
  "scripts/build.mjs",
  "scripts/build-speaker-script.mjs",
  "scripts/create-project-builder.mjs",
  "scripts/presentation-core.mjs",
  "scripts/speaker-notes.mjs",
  "scripts/validate-deck-spec.mjs",
  "scripts/validate-scientific-design.mjs",
  "scripts/validate-scientific-content.mjs",
  "scripts/validate-project.mjs",
  "schemas/deck-spec.schema.json",
  "schemas/evidence-index.schema.json",
  "schemas/paper-index.schema.json",
  "schemas/paper-assets.schema.json",
  "schemas/project-config.schema.json",
  "assets/profile-registry.json",
];
const RENDERER_SOURCE_ASSET_TYPES = new Set([
  "brand_asset", "thesis_figure", "thesis_table", "thesis_formula", "paper_text",
  "paper_figure", "paper_table", "paper_formula", "paper_supplement",
  "bibliographic_metadata", "venue_metric", "user_material", "other",
]);
const CORE_RUNTIME_DEPENDENCIES = [
  { name: "@oai/artifact-tool", files: ["package.json", "dist/artifact_tool.mjs"] },
  { name: "docx", files: ["package.json", "dist/index.mjs"] },
  { name: "sharp", files: ["package.json", "lib/index.js"] },
];

function usage() {
  return [
    "Usage: node build-project.mjs --spec <deck-spec.json> --output-dir <dir> --stem <name> [options]",
    "",
    "Options:",
    "  --theme <name>  blue | red | purple | cyan",
    "  --project-dir <dir>  Validate the complete source/evidence/outline/deck project before building",
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
    else if (["--spec", "--output-dir", "--stem", "--theme", "--project-dir"].includes(token)) {
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

const DIRECT_FILE_KEYS = new Set([
  "path", "file", "src", "logo_path", "logoPath", "image", "left_image", "right_image",
  "asset_ref", "assetRef", "fallback_asset_ref", "fallbackAssetRef",
]);
const FILE_LIST_KEYS = new Set(["image_refs", "asset_refs"]);

function collectRenderFileCandidates(value, output = [], parentKey = "") {
  if (typeof value === "string") {
    if (DIRECT_FILE_KEYS.has(parentKey) || FILE_LIST_KEYS.has(parentKey)) output.push(value);
  } else if (Array.isArray(value)) {
    value.forEach((item) => collectRenderFileCandidates(item, output, parentKey));
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) collectRenderFileCandidates(item, output, key);
  }
  return output;
}

async function referencedLocalFiles(spec, specDir) {
  const candidates = new Set();
  // Sources, citations, and speaker notes are evidence metadata rather than
  // render dependencies. Restrict cache hashing to declared assets, slide
  // payloads, and only those source records whose IDs are actually consumed as
  // renderer assets. This keeps unused source PDFs out of the hot cache path.
  const renderCandidates = collectRenderFileCandidates({
    assets: spec?.assets,
    slides: spec?.slides,
    theme: spec?.theme,
    brand: spec?.brand,
  });
  const referencedIds = new Set(renderCandidates.map((value) => value.trim()).filter(Boolean));
  for (const source of Array.isArray(spec?.sources) ? spec.sources : []) {
    const id = String(source?.id ?? "").trim();
    const type = String(source?.type ?? "").trim();
    if (id && referencedIds.has(id) && RENDERER_SOURCE_ASSET_TYPES.has(type) && typeof source?.path === "string") {
      renderCandidates.push(source.path);
    }
  }
  for (const raw of renderCandidates) {
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

async function nearestPackageJson(entryPath, expectedName) {
  let current = path.dirname(entryPath);
  while (true) {
    const candidate = path.join(current, "package.json");
    if (await isFile(candidate)) {
      try {
        const manifest = JSON.parse(await fs.readFile(candidate, "utf8"));
        if (manifest?.name === expectedName) return candidate;
      } catch {
        // Keep walking when an unrelated or malformed manifest is encountered.
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function coreRuntimeFingerprintFiles() {
  const files = new Map();
  const roots = [
    process.env.RUNTIME_NODE_MODULES,
    path.resolve(path.dirname(process.execPath), "..", "node_modules"),
  ].filter(Boolean).map((value) => path.resolve(value));
  for (const dependency of CORE_RUNTIME_DEPENDENCIES) {
    for (const root of roots) {
      for (const relativePath of dependency.files) {
        const filePath = path.join(root, ...dependency.name.split("/"), relativePath);
        if (await isFile(filePath)) files.set(filePath, `runtime:${dependency.name}:${relativePath}`);
      }
    }
    try {
      const entryPath = REQUIRE.resolve(dependency.name);
      if (await isFile(entryPath)) files.set(entryPath, `runtime:${dependency.name}:resolved-entry`);
      const manifestPath = await nearestPackageJson(entryPath, dependency.name);
      if (manifestPath) files.set(manifestPath, `runtime:${dependency.name}:resolved-package.json`);
    } catch {
      // The explicit bundled runtime candidates above remain authoritative.
    }
  }
  return [...files.entries()]
    .map(([filePath, label]) => ({ filePath, label }))
    .sort((left, right) => left.label.localeCompare(right.label, "en") || left.filePath.localeCompare(right.filePath, "en"));
}

async function updateHashWithFile(hash, label, filePath) {
  hash.update(`\n${label}\0`);
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
}

async function hashFile(filePath) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function artifactRecord(filePath, relativeTo = path.dirname(filePath)) {
  const info = await fs.stat(filePath);
  if (!info.isFile() || info.size <= 0) throw new Error(`Expected a non-empty build artifact: ${filePath}`);
  return {
    file: path.relative(relativeTo, filePath).split(path.sep).join("/") || path.basename(filePath),
    bytes: info.size,
    sha256: await hashFile(filePath),
  };
}

async function artifactMatches(filePath, record) {
  if (!record || typeof record !== "object") return false;
  try {
    const info = await fs.stat(filePath);
    if (!info.isFile() || info.size <= 0 || info.size !== record.bytes) return false;
    return await hashFile(filePath) === record.sha256;
  } catch {
    return false;
  }
}

async function listFilesRecursively(directoryPath) {
  const output = [];
  async function visit(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) output.push(full);
    }
  }
  try {
    await visit(directoryPath);
  } catch {
    return [];
  }
  return output.sort((left, right) => left.localeCompare(right, "en"));
}

async function previewArtifactRecords(directoryPath) {
  const files = await listFilesRecursively(directoryPath);
  return Promise.all(files.map((filePath) => artifactRecord(filePath, directoryPath)));
}

async function outputsMatchState(outputs, state) {
  if (state?.schema_version !== 2 || !state.output_artifacts) return false;
  for (const [key, filePath] of Object.entries(outputs)) {
    if (!(await artifactMatches(filePath, state.output_artifacts[key]))) return false;
  }
  return true;
}

async function previewMatchesState(previewDir, state) {
  if (state?.rendered !== true || !Array.isArray(state.preview_artifacts) || state.preview_artifacts.length === 0) return false;
  for (const record of state.preview_artifacts) {
    if (!(await artifactMatches(path.join(previewDir, record.file), record))) return false;
  }
  const actualFiles = await listFilesRecursively(previewDir);
  return actualFiles.length === state.preview_artifacts.length;
}

export async function computeProjectSignature(options) {
  const specPath = path.resolve(options.spec);
  const specBytes = await fs.readFile(specPath);
  const spec = JSON.parse(specBytes.toString("utf8"));
  const hash = crypto.createHash("sha256");
  hash.update("academic-slides-project-build:v3\0");
  hash.update(`stem=${options.stem}\0theme=${options.theme ?? ""}\0`);
  hash.update(`node=${process.version}\0exec=${process.execPath}\0platform=${process.platform}\0arch=${process.arch}\0`);
  hash.update(`runtime=${process.env.RUNTIME_NODE_MODULES ?? ""}\0cjk-font=${process.env.ACADEMIC_SLIDES_CJK_FONT ?? ""}\0`);
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
  for (const dependency of await coreRuntimeFingerprintFiles()) {
    await updateHashWithFile(hash, dependency.label, dependency.filePath);
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

async function pathExists(filePath) {
  try {
    await fs.lstat(filePath);
    return true;
  } catch {
    return false;
  }
}

export function projectLockPath(outputDir, stem) {
  const key = crypto.createHash("sha256").update(String(stem)).digest("hex").slice(0, 16);
  return path.join(path.resolve(outputDir), `.academic-slides-build-lock-${key}`);
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function lockIdentity(lockDir) {
  try {
    const info = await fs.lstat(lockDir);
    let owner = null;
    let ownerMtime = 0;
    try {
      const ownerPath = path.join(lockDir, LOCK_OWNER_FILENAME);
      owner = JSON.parse(await fs.readFile(ownerPath, "utf8"));
      ownerMtime = (await fs.stat(ownerPath)).mtimeMs;
    } catch {
      // An interrupted mkdir/write is treated as an orphan after a short grace period.
    }
    return {
      fingerprint: `${info.dev}:${info.ino}`,
      owner,
      ageMs: Math.max(0, Date.now() - Math.max(info.mtimeMs, ownerMtime)),
    };
  } catch {
    return null;
  }
}

function lockIsStale(identity) {
  if (!identity) return false;
  const owner = identity.owner;
  if (!owner || typeof owner !== "object" || typeof owner.token !== "string") {
    return identity.ageMs > LOCK_ORPHAN_STALE_MS;
  }
  if (owner.hostname === os.hostname() && Number.isInteger(owner.pid)) {
    if (!processIsAlive(owner.pid)) return true;
    return identity.ageMs > LOCK_ABSOLUTE_STALE_MS;
  }
  return identity.ageMs > LOCK_REMOTE_STALE_MS;
}

async function evictStaleLock(lockDir, expectedIdentity) {
  const reaperDir = `${lockDir}.reaper`;
  try {
    await fs.mkdir(reaperDir);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    try {
      const ageMs = Date.now() - (await fs.stat(reaperDir)).mtimeMs;
      if (ageMs > LOCK_ORPHAN_STALE_MS) await fs.rm(reaperDir, { recursive: true, force: true });
    } catch {
      // A competing reaper may already have completed.
    }
    return false;
  }
  const tombstone = `${lockDir}.stale-${process.pid}-${crypto.randomBytes(5).toString("hex")}`;
  try {
    const currentIdentity = await lockIdentity(lockDir);
    if (!currentIdentity || currentIdentity.fingerprint !== expectedIdentity.fingerprint || !lockIsStale(currentIdentity)) return false;
    try {
      await fs.rename(lockDir, tombstone);
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
    const movedIdentity = await lockIdentity(tombstone);
    if (!movedIdentity || movedIdentity.fingerprint !== expectedIdentity.fingerprint) {
      if (!(await pathExists(lockDir))) await fs.rename(tombstone, lockDir).catch(() => {});
      return false;
    }
    await fs.rm(tombstone, { recursive: true, force: true });
    return true;
  } finally {
    await fs.rm(reaperDir, { recursive: true, force: true });
  }
}

async function acquireProjectFileLock(lockDir) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  const token = crypto.randomBytes(16).toString("hex");
  while (true) {
    try {
      await fs.mkdir(lockDir);
      const ownerPath = path.join(lockDir, LOCK_OWNER_FILENAME);
      try {
        await fs.writeFile(ownerPath, `${JSON.stringify({
          schema_version: 1,
          token,
          pid: process.pid,
          hostname: os.hostname(),
          created_at: new Date().toISOString(),
        }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      } catch (error) {
        await fs.rm(lockDir, { recursive: true, force: true });
        throw error;
      }
      const heartbeat = setInterval(() => {
        const now = new Date();
        fs.utimes(ownerPath, now, now).catch(() => {});
      }, LOCK_HEARTBEAT_MS);
      heartbeat.unref?.();
      return { lockDir, ownerPath, token, heartbeat };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const identity = await lockIdentity(lockDir);
      if (identity && lockIsStale(identity) && await evictStaleLock(lockDir, identity)) continue;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for project build lock: ${lockDir}`);
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
  }
}

async function releaseProjectFileLock(lock) {
  clearInterval(lock.heartbeat);
  try {
    const owner = JSON.parse(await fs.readFile(lock.ownerPath, "utf8"));
    if (owner?.token === lock.token) await fs.rm(lock.lockDir, { recursive: true, force: true });
  } catch {
    // A missing/replaced lock is never removed on behalf of another owner.
  }
}

async function withProjectLock(outputDir, stem, task) {
  const lockDir = projectLockPath(outputDir, stem);
  const previous = IN_PROCESS_LOCKS.get(lockDir) ?? Promise.resolve();
  let releaseQueue;
  const gate = new Promise((resolve) => { releaseQueue = resolve; });
  const tail = previous.catch(() => {}).then(() => gate);
  IN_PROCESS_LOCKS.set(lockDir, tail);
  await previous.catch(() => {});
  let fileLock;
  try {
    fileLock = await acquireProjectFileLock(lockDir);
    return await task();
  } finally {
    if (fileLock) await releaseProjectFileLock(fileLock);
    releaseQueue();
    if (IN_PROCESS_LOCKS.get(lockDir) === tail) IN_PROCESS_LOCKS.delete(lockDir);
  }
}

export async function publishArtifactsTransactionally(items, backupDir) {
  await fs.mkdir(backupDir, { recursive: true });
  const backedUp = [];
  const published = [];
  try {
    for (const [index, item] of items.entries()) {
      if (!(await pathExists(item.target))) continue;
      const backup = path.join(backupDir, `${String(index).padStart(2, "0")}-${path.basename(item.target)}`);
      await fs.rename(item.target, backup);
      backedUp.push({ target: item.target, backup });
    }
    for (const item of items) {
      if (!item.source) continue;
      await fs.rename(item.source, item.target);
      published.push(item.target);
    }
  } catch (error) {
    for (const target of [...published].reverse()) await fs.rm(target, { recursive: true, force: true });
    for (const item of [...backedUp].reverse()) {
      if (await pathExists(item.target)) await fs.rm(item.target, { recursive: true, force: true });
      await fs.rename(item.backup, item.target);
    }
    throw error;
  }
}

export async function buildProject(options, injectedBuilders = null) {
  const startedAt = performance.now();
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
  return withProjectLock(outputDir, stem, async () => {
  let projectValidation = null;
  const explicitProjectDir = options.projectDir ? path.resolve(options.projectDir) : null;
  const specDirectory = path.dirname(specPath);
  const autoProjectDir = explicitProjectDir == null && await Promise.any([
    "project-config.json", "project.config.json", "project.json",
  ].map(async (filename) => (await isFile(path.join(specDirectory, filename))) ? specDirectory : Promise.reject(new Error("missing")))).catch(() => null);
  const validationProjectDir = explicitProjectDir ?? autoProjectDir;
  if (validationProjectDir) {
    projectValidation = await validateProject(validationProjectDir, { stage: "deck", strict: false, requireSchemas: true });
    if (path.resolve(projectValidation.paths?.deckSpec ?? "") !== specPath) {
      throw new Error(`Project validation resolved a different deck spec (${projectValidation.paths?.deckSpec ?? "missing"}) than --spec (${specPath}). Set paths.deck_spec in project-config.json.`);
    }
    if (!projectValidation.ok) {
      const errors = projectValidation.issues.filter((item) => item.severity === "error");
      throw new Error(`Cross-file project validation failed (${errors.length} error(s)): ${errors.slice(0, 8).map((item) => item.code).join(", ")}.`);
    }
  }
  const signatureStartedAt = performance.now();
  const signatureInfo = await computeProjectSignature({ spec: specPath, stem, theme });
  const signatureMs = Math.round(performance.now() - signatureStartedAt);
  const previous = await loadState(statePath);
  const outputIntegritySatisfied = await outputsMatchState(outputs, previous);
  const renderSatisfied = options.render !== true || await previewMatchesState(previewDir, previous);
  if (options.force !== true
    && previous?.signature === signatureInfo.signature
    && renderSatisfied
    && outputIntegritySatisfied) {
    return {
      ok: true,
      cached: true,
      signature: signatureInfo.signature,
      outputs,
      previewDir: previous.rendered === true ? previewDir : null,
      metrics: {
        total_ms: Math.round(performance.now() - startedAt),
        signature_ms: signatureMs,
        cache_hit: true,
      },
      projectValidation,
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
  const stageMetrics = {};
  try {
    // Portability and scientific-design checks in createProjectBuilder are cheap.
    // Run them before the expensive presentation render, but keep the generated
    // MJS in an internal transaction directory until every artifact succeeds.
    let stageStartedAt = performance.now();
    builderReport = await builders.createProjectBuilder({
      spec: specPath,
      output: workOutputs.mjs,
      pptxName: path.basename(outputs.pptx),
      docxName: path.basename(outputs.docx),
      theme: theme ?? undefined,
    });
    stageMetrics.project_builder_ms = Math.round(performance.now() - stageStartedAt);
    stageStartedAt = performance.now();
    deckReport = await builders.buildDeck({
      spec: specPath,
      output: workOutputs.pptx,
      theme: theme ?? undefined,
      previewDir: options.render === true ? workPreviewDir : undefined,
    });
    stageMetrics.deck_and_preview_ms = Math.round(performance.now() - stageStartedAt);
    stageStartedAt = performance.now();
    wordReport = await builders.buildSpeakerScriptFromFile(specPath, workOutputs.docx);
    stageMetrics.word_ms = Math.round(performance.now() - stageStartedAt);
    if (!(await outputsExist(workOutputs))) throw new Error("Project build did not create all three required outputs.");
    const outputArtifacts = {};
    for (const [key, filePath] of Object.entries(workOutputs)) outputArtifacts[key] = await artifactRecord(filePath, workDir);
    const previewArtifacts = options.render === true ? await previewArtifactRecords(workPreviewDir) : [];
    if (options.render === true && previewArtifacts.length === 0) {
      throw new Error("--render completed without producing preview files.");
    }
    const state = {
      schema_version: 2,
      signature: signatureInfo.signature,
      spec: specPath,
      stem,
      theme,
      outputs: Object.fromEntries(Object.entries(outputs).map(([key, value]) => [key, path.basename(value)])),
      output_artifacts: outputArtifacts,
      rendered: options.render === true,
      preview_artifacts: previewArtifacts,
      referenced_asset_count: signatureInfo.referencedAssets.length,
      completed_at: new Date().toISOString(),
    };
    const pendingStatePath = path.join(workDir, STATE_FILENAME);
    await fs.writeFile(pendingStatePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    stageStartedAt = performance.now();
    await publishArtifactsTransactionally([
      ...["pptx", "docx", "mjs"].map((key) => ({ source: workOutputs[key], target: outputs[key] })),
      { source: options.render === true ? workPreviewDir : null, target: previewDir },
      { source: pendingStatePath, target: statePath },
    ], path.join(workDir, ".rollback"));
    stageMetrics.publish_ms = Math.round(performance.now() - stageStartedAt);
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
  if (!(await outputsExist(outputs))) throw new Error("Project build did not publish all three required outputs.");

  const totalMs = Math.round(performance.now() - startedAt);
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
      projectValidation,
    },
    metrics: {
      total_ms: totalMs,
      signature_ms: signatureMs,
      cache_hit: false,
      ...stageMetrics,
    },
  };
  });
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
