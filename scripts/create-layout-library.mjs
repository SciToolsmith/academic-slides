#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildDeck } from "./build.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(SCRIPT_DIR, "..");
const PROFILE_REGISTRY_PATH = path.join(SKILL_DIR, "assets", "profile-registry.json");

function usage() {
  return [
    "Usage: node create-layout-library.mjs [options]",
    "",
    "Options:",
    "  --profile <id>  Academic profile from assets/profile-registry.json",
    "  -h, --help      Show this help",
  ].join("\n");
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--profile") {
      if (!argv[index + 1]) throw new Error("--profile requires a profile id.");
      result.profile = argv[++index];
    } else if (arg === "-h" || arg === "--help") result.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return result;
}

function resolveSkillPath(relativePath, field, baseDir = SKILL_DIR) {
  if (typeof relativePath !== "string" || !relativePath.trim()) throw new Error(`Profile field ${field} must be a non-empty path relative to the skill root.`);
  const normalized = relativePath.replaceAll("\\", "/");
  const rootRelative = /^(assets|references|scripts|schemas|agents)\//.test(normalized);
  const absolute = path.resolve(rootRelative ? SKILL_DIR : baseDir, relativePath);
  if (absolute !== SKILL_DIR && !absolute.startsWith(`${SKILL_DIR}${path.sep}`)) throw new Error(`Profile field ${field} resolves outside the skill root.`);
  return absolute;
}

async function loadProfileRegistry() {
  const registry = JSON.parse(await fs.readFile(PROFILE_REGISTRY_PATH, "utf8"));
  if (!registry?.profiles || typeof registry.profiles !== "object" || Array.isArray(registry.profiles)) throw new Error("profile-registry.json must contain a profiles object.");
  return registry;
}

export async function createLayoutLibrary(profileId) {
  const registry = await loadProfileRegistry();
  const selectedProfile = profileId ?? registry.defaultProfile;
  const profile = registry.profiles[selectedProfile];
  if (!profile) throw new Error(`Unknown profile: ${selectedProfile}. Available profiles: ${Object.keys(registry.profiles).join(", ")}.`);
  const assetDir = resolveSkillPath(profile.assetDirectory, "assetDirectory");
  const spec = resolveSkillPath(profile.librarySpec, "librarySpec", assetDir);
  const output = resolveSkillPath(profile.layoutLibrary, "layoutLibrary", assetDir);
  const preview = resolveSkillPath(profile.preview, "preview", assetDir);
  const previewDir = path.join(assetDir, "previews");
  const report = path.join(assetDir, "layout-library.build.json");
  await fs.mkdir(assetDir, { recursive: true });
  await fs.mkdir(previewDir, { recursive: true });
  const result = await buildDeck({ spec, output, previewDir, report, theme: "blue", allowPlaceholders: true });
  if (result.montagePng) {
    await fs.mkdir(path.dirname(preview), { recursive: true });
    if (path.resolve(result.montagePng) !== path.resolve(preview)) await fs.copyFile(result.montagePng, preview);
  }
  return { profile: selectedProfile, ...result };
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
    const result = await createLayoutLibrary(args.profile);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`LAYOUT LIBRARY BUILD FAILED: ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) await main();
