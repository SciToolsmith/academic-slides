#!/usr/bin/env node

import { access, copyFile, lstat, mkdir, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SKILL_DIR = path.resolve(SCRIPT_DIR, "..");
const HOST_LIMITS = Object.freeze({ totalBytes: 50 * 1024 * 1024, fileCount: 500, singleFileBytes: 25 * 1024 * 1024 });
const ARCHIVE_TEXT_EXTENSIONS = new Set([".xml", ".rels", ".txt", ".json", ".md", ".yaml", ".yml"]);

function usage() {
  return [
    "Usage: node package-skill.mjs [options]",
    "",
    "Options:",
    "  --skill-dir <dir>  Source skill root (default: parent of this script)",
    "  --output <dir>     Staging directory (default: ../staging/academic-slides)",
    "  --archive <file>   Also create a zip archive from the staging directory",
    "  --check            Validate the prospective package without writing it",
    "  --force            Replace the exact output/archive target if it exists",
    "  --json             Emit machine-readable JSON",
    "  -h, --help         Show this help",
    "",
    "Hosted skill limits enforced: 50 MB total, 500 files, 25 MB per file.",
  ].join("\n");
}

function parseArgs(argv) {
  const result = { skillDir: DEFAULT_SKILL_DIR, output: null, archive: null, check: false, force: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--check") result.check = true;
    else if (token === "--force") result.force = true;
    else if (token === "--json") result.json = true;
    else if (token === "-h" || token === "--help") result.help = true;
    else if (["--skill-dir", "--output", "--archive"].includes(token)) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${token} requires a value.`);
      if (token === "--skill-dir") result.skillDir = path.resolve(value);
      else if (token === "--output") result.output = path.resolve(value);
      else result.archive = path.resolve(value);
    } else throw new Error(`Unknown option: ${token}`);
  }
  result.skillDir = path.resolve(result.skillDir);
  result.output ??= path.resolve(path.dirname(result.skillDir), "staging", "academic-slides");
  return result;
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function normalizeRelative(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function exclusionReason(relativePath) {
  const normalized = normalizeRelative(relativePath);
  const segments = normalized.split("/");
  const basename = segments.at(-1);
  if ([".git", "node_modules", "examples", "tmp", "qa", "dist", "staging"].some((name) => segments.includes(name))) return "development-directory";
  if (segments.includes("previews")) return "per-slide-previews";
  if (basename === ".DS_Store") return "os-metadata";
  if (basename === "build-report.json" || basename.endsWith(".build.json") || basename.endsWith(".inspect.ndjson")) return "build-or-inspection-report";
  if (basename.endsWith(".tmp") || basename.endsWith(".temp")) return "temporary-file";
  return null;
}

async function collectFiles(skillDir) {
  const included = [];
  const excluded = [];
  const symlinks = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(skillDir, absolute);
      const reason = exclusionReason(relative);
      if (reason) {
        excluded.push({ path: normalizeRelative(relative), reason });
        continue;
      }
      if (entry.isSymbolicLink()) {
        symlinks.push(normalizeRelative(relative));
        continue;
      }
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) {
        const info = await stat(absolute);
        included.push({ absolute, relative: normalizeRelative(relative), size: info.size, mode: info.mode });
      }
    }
  }
  await visit(skillDir);
  included.sort((left, right) => left.relative.localeCompare(right.relative));
  excluded.sort((left, right) => left.path.localeCompare(right.path));
  return { included, excluded, symlinks };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function scanText(text, usernames) {
  const matches = new Set();
  const pathPatterns = [
    /\/(?:Users|Volumes|home|private\/var|var\/folders)\/[^\s"'<>)}\]]+/g,
    /file:\/{2,3}[^\s"'<>)}\]]+/gi,
    /[A-Za-z]:\\Users\\[^\s"'<>)}\]]+/g,
  ];
  for (const pattern of pathPatterns) for (const match of text.match(pattern) ?? []) matches.add(match);
  for (const username of usernames) {
    const pattern = new RegExp(`(^|[^A-Za-z0-9_-])${escapeRegex(username)}([^A-Za-z0-9_-]|$)`, "g");
    if (pattern.test(text)) matches.add(`username:${username}`);
  }
  return [...matches].slice(0, 20);
}

async function scanPptx(file, usernames) {
  const findings = [];
  try {
    const { stdout } = await execFileAsync("unzip", ["-Z1", file.absolute], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, timeout: 30_000 });
    const entries = stdout.split(/\r?\n/).filter((entry) => ARCHIVE_TEXT_EXTENSIONS.has(path.extname(entry).toLowerCase()));
    for (const entry of entries) {
      const unzipPattern = entry.replaceAll("[", "[[]").replaceAll("*", "[*]").replaceAll("?", "[?]");
      const result = await execFileAsync("unzip", ["-p", file.absolute, unzipPattern], { encoding: "buffer", maxBuffer: 25 * 1024 * 1024, timeout: 30_000 });
      const matches = scanText(Buffer.from(result.stdout).toString("latin1"), usernames);
      if (matches.length) findings.push({ file: `${file.relative}::${entry}`, matches });
    }
  } catch (error) {
    findings.push({ file: file.relative, matches: [], inspectionError: error.message });
  }
  return findings;
}

async function scanPortablePaths(files) {
  const dynamicUsernames = uniqueUsernames([os.userInfo().username, process.env.USER, process.env.LOGNAME]);
  const findings = [];
  for (const file of files) {
    const raw = await readFile(file.absolute);
    const matches = scanText(raw.toString("latin1"), dynamicUsernames);
    if (matches.length) findings.push({ file: file.relative, matches });
    if (path.extname(file.relative).toLowerCase() === ".pptx") findings.push(...(await scanPptx(file, dynamicUsernames)));
  }
  return findings;
}

function uniqueUsernames(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length >= 4).filter((value) => !["root", "user", "codex", "runner"].includes(value.toLowerCase())))];
}

function summarize(files) {
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  const largest = [...files].sort((left, right) => right.size - left.size)[0] ?? null;
  return { fileCount: files.length, totalBytes, largestFile: largest ? { path: largest.relative, bytes: largest.size } : null };
}

function limitFindings(summary) {
  const findings = [];
  if (summary.fileCount > HOST_LIMITS.fileCount) findings.push({ severity: "error", code: "limit.file-count", message: `${summary.fileCount} files exceed the hosted limit of ${HOST_LIMITS.fileCount}.` });
  if (summary.totalBytes > HOST_LIMITS.totalBytes) findings.push({ severity: "error", code: "limit.total-size", message: `${summary.totalBytes} bytes exceed the hosted limit of ${HOST_LIMITS.totalBytes}.` });
  if ((summary.largestFile?.bytes ?? 0) > HOST_LIMITS.singleFileBytes) findings.push({ severity: "error", code: "limit.single-file", message: `${summary.largestFile.path} exceeds the per-file limit of ${HOST_LIMITS.singleFileBytes} bytes.` });
  return findings;
}

function assertSafeTarget(target, skillDir, label) {
  const resolved = path.resolve(target);
  const blocked = new Set([path.parse(resolved).root, os.homedir(), skillDir, path.dirname(skillDir)]);
  if (blocked.has(resolved)) throw new Error(`${label} is too broad or overlaps the source skill: ${resolved}`);
  if (resolved.startsWith(`${skillDir}${path.sep}`)) throw new Error(`${label} must be outside the source skill directory.`);
  return resolved;
}

async function prepareTarget(target, skillDir, force, directory) {
  const safe = assertSafeTarget(target, skillDir, directory ? "Output directory" : "Archive");
  if (await exists(safe)) {
    if (!force) throw new Error(`${directory ? "Output directory" : "Archive"} already exists; use --force to replace the exact target: ${safe}`);
    await rm(safe, { recursive: directory, force: true });
  }
  return safe;
}

async function copyStaging(files, output) {
  await mkdir(output, { recursive: true });
  for (const file of files) {
    const destination = path.join(output, file.relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(file.absolute, destination);
  }
}

async function createArchive(output, archive) {
  await mkdir(path.dirname(archive), { recursive: true });
  await execFileAsync("zip", ["-q", "-r", archive, path.basename(output)], { cwd: path.dirname(output), encoding: "utf8", maxBuffer: 10 * 1024 * 1024, timeout: 120_000 });
  return (await lstat(archive)).size;
}

export async function packageSkill(options = {}) {
  const skillDir = path.resolve(options.skillDir ?? DEFAULT_SKILL_DIR);
  const output = path.resolve(options.output ?? path.resolve(path.dirname(skillDir), "staging", "academic-slides"));
  const archive = options.archive ? path.resolve(options.archive) : null;
  const findings = [];
  if (archive && (archive === output || archive.startsWith(`${output}${path.sep}`))) throw new Error("Archive must be outside the staging directory to avoid recursive packaging.");
  if (!(await exists(skillDir))) return { ok: false, skillDir, output, archive, checkOnly: Boolean(options.check), findings: [{ severity: "error", code: "skill.missing", message: "Skill directory does not exist." }] };

  const { included, excluded, symlinks } = await collectFiles(skillDir);
  const summary = summarize(included);
  findings.push(...limitFindings(summary));
  for (const symlink of symlinks) findings.push({ severity: "error", code: "package.symlink", message: `Symlinks are not portable and are not packaged: ${symlink}` });
  const portability = await scanPortablePaths(included);
  for (const item of portability) {
    if (item.inspectionError) findings.push({ severity: "error", code: "package.archive-inspection", message: `${item.file}: ${item.inspectionError}` });
    else findings.push({ severity: "error", code: "package.machine-path", message: `${item.file}: ${item.matches.join(", ")}` });
  }

  let stagingCreated = false;
  let archiveBytes = null;
  if (!findings.some((item) => item.severity === "error") && !options.check) {
    const safeOutput = await prepareTarget(output, skillDir, Boolean(options.force), true);
    const safeArchive = archive ? await prepareTarget(archive, skillDir, Boolean(options.force), false) : null;
    await copyStaging(included, safeOutput);
    stagingCreated = true;
    if (safeArchive) {
      archiveBytes = await createArchive(safeOutput, safeArchive);
      if (archiveBytes > HOST_LIMITS.totalBytes) findings.push({ severity: "error", code: "limit.archive-size", message: `Archive size ${archiveBytes} exceeds ${HOST_LIMITS.totalBytes} bytes.` });
    }
  }

  return {
    ok: !findings.some((item) => item.severity === "error"),
    skillDir,
    output,
    archive,
    checkOnly: Boolean(options.check),
    stagingCreated,
    archiveBytes,
    limits: HOST_LIMITS,
    package: summary,
    excludedCount: excluded.length,
    excludedByReason: excluded.reduce((result, item) => ({ ...result, [item.reason]: (result[item.reason] ?? 0) + 1 }), {}),
    portabilityScan: { scannedFiles: included.length, issueCount: portability.length },
    findings,
  };
}

function printHuman(result) {
  console.log(`${result.ok ? "PASS" : "FAIL"}: ${result.checkOnly ? "package check" : "skill staging package"}`);
  console.log(`- files: ${result.package?.fileCount ?? 0}/${result.limits?.fileCount ?? HOST_LIMITS.fileCount}`);
  console.log(`- total: ${result.package?.totalBytes ?? 0}/${result.limits?.totalBytes ?? HOST_LIMITS.totalBytes} bytes`);
  if (result.package?.largestFile) console.log(`- largest: ${result.package.largestFile.path} (${result.package.largestFile.bytes}/${result.limits.singleFileBytes} bytes)`);
  console.log(`- excluded: ${result.excludedCount ?? 0}; portability issues: ${result.portabilityScan?.issueCount ?? 0}`);
  if (result.stagingCreated) console.log(`- staging: ${result.output}`);
  if (result.archiveBytes != null) console.log(`- archive: ${result.archive} (${result.archiveBytes} bytes)`);
  for (const item of result.findings) console.log(`- ${item.severity.toUpperCase()} ${item.code}: ${item.message}`);
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
    const result = await packageSkill(args);
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
