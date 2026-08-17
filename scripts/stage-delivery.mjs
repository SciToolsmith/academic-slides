#!/usr/bin/env node

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(SCRIPT_DIR, "..");
const DELIVERY_TYPES = ["本科答辩", "硕士答辩", "博士答辩", "开题答辩", "中期汇报", "组会汇报"];
const DATE_NAME_PATTERN = /(?:19|20)\d{2}(?:(?:[-_.\/年])\d{1,2}(?:(?:[-_.\/月])\d{1,2}日?)?|\d{4})?/;
const REVISION_NAME_PATTERN = /(?:最终|终版|终稿|定稿|最新版|修订版|final|latest|version|版本\s*\d*|rev(?:ision)?\s*\d+|v\s*\d+(?:\.\d+)*(?=$|[_\-\s]|版|修改|修订|更新|稿))/i;
const LOCAL_PATH_PATTERN = /(?:^|[\s"'=(:])(?:\/(?:Users|Volumes|home|tmp|private(?:\/var|\/tmp)?|var\/folders|root|mnt|media|workspace|etc|opt|usr|Applications|Library)\/|~[\\/]|\$HOME[\\/]|[A-Za-z]:[\\/]|\\\\[^\\\s]+\\[^\\\s]+|(?:file|smb):\/{2,3})/im;
const GENERAL_POSIX_PATH_PATTERN = /(?:^|[\s"'=(:;,])\/(?!\/|>)(?:[^\s"'<>\/]+\/)*[^\s"'<>\/]+\.[A-Za-z0-9]{1,10}/m;
const NETWORK_PATH_PATTERN = /(?:^|[\s"'=(:;,])(?:\/\/[^\/\s"'<>]+\/[^\s"'<>]+|\\\\[^\\\s"'<>]+\\[^\s"'<>]+)/m;
const SAFE_PUBLIC_URL_PATTERN = /\b(?:https?|mailto):[^\s"'<>]+/gi;
const SAFE_API_ROUTE_PATTERN = /\/api\/v\d+(?:\.\d+)?(?:\/[A-Za-z0-9._~{}:-]+)*/gi;
const PATH_TRAVERSAL_PATTERN = /(?:^|[\\/])\.\.(?:[\\/]|$)/;
const INTERNAL_FILE_PATTERN = /(?:project-config|deck-spec|evidence-index|source-manifest|thesis-analysis|milestone-analysis|paper-index|build-report|qa-report|inspect)\.(?:json|md|txt)/i;
const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:sk|gh[opusr])[-_][A-Za-z0-9_-]{20,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{20,}/i,
  /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*["']?[A-Za-z0-9._~+\/-]{12,}/i,
  /[?&](?:X-Amz-Signature|Signature|sig|token|access_token)=[^&#\s]{12,}/i,
];
const ALLOWED_ASSET_ROOTS = new Set(["figures", "formulas", "branding", "data"]);
const FORBIDDEN_SEGMENTS = new Set(["node_modules", "qa", "tmp", "cache", "previews", "preview", "source", "working", ".git"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".svg"]);
const FORMULA_EXTENSIONS = new Set([".tex", ".svg", ".png"]);
const DATA_EXTENSIONS = new Set([".csv", ".xlsx"]);
const TEXT_EXTENSIONS = new Set([".mjs", ".js", ".md", ".txt", ".csv", ".tex", ".svg", ".json", ".yaml", ".yml", ".xml", ".rels"]);
const INTERNAL_ASSET_NAME = /(?:manifest|contact[-_ ]?sheet|montage|preview|thumbnail|build|inspect|issues?|report|metadata|\.meta\.)/i;
const FORBIDDEN_ARCHIVE_ENTRY = /(?:^|\/)(?:vbaProject\.bin|activeX\/|embeddings\/|customXml\/|.*oleObject.*)/i;

function usage() {
  return [
    "Usage: node stage-delivery.mjs --output <短题名_汇报类型> --mjs <项目.mjs> [--assets <已筛选素材目录>] [--forbidden-term <姓名或学号>] [--force]",
    "",
    "The project MJS is executed inside a clean staging directory so PPTX and Word are guaranteed to share one source.",
  ].join("\n");
}

function parseArgs(argv) {
  const result = { force: false, forbiddenTerms: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--force") result.force = true;
    else if (token === "-h" || token === "--help") result.help = true;
    else if (["--output", "--mjs", "--assets", "--forbidden-term"].includes(token)) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${token} requires a value.`);
      if (token === "--forbidden-term") result.forbiddenTerms.push(value);
      else result[token.slice(2)] = value;
    } else throw new Error(`Unknown option: ${token}`);
  }
  return result;
}

export function validateDeliveryStem(stem, forbiddenTerms = []) {
  const raw = String(stem ?? "");
  const value = raw.trim();
  if (!value || value.length > 80) throw new Error("Delivery name must contain a concise short title and report type.");
  if (raw !== value || /[\u0000-\u001F\u007F]/.test(value)) throw new Error("Delivery name must not contain surrounding whitespace or control characters.");
  if (/[\\/:*?"<>|]/.test(value) || value.startsWith(".") || value.endsWith(".")) throw new Error(`Unsafe delivery name: ${value}`);
  if (DATE_NAME_PATTERN.test(value) || REVISION_NAME_PATTERN.test(value)) {
    throw new Error("Delivery name must not contain a date, version, final/latest marker, or revision marker.");
  }
  for (const term of forbiddenTerms.map((item) => String(item).trim()).filter(Boolean)) {
    if (value.toLocaleLowerCase().includes(term.toLocaleLowerCase())) throw new Error(`Delivery name contains a forbidden identity term: ${term}`);
  }
  const type = DELIVERY_TYPES.find((item) => value.endsWith(`_${item}`));
  if (!type || value === type || value === `_${type}`) throw new Error(`Delivery name must end with one supported type: ${DELIVERY_TYPES.join("、")}`);
  return value;
}

async function exists(filePath) {
  try { await fs.access(filePath); return true; } catch { return false; }
}

async function requireRegularFile(filePath, extension) {
  const absolute = path.resolve(filePath);
  const info = await fs.lstat(absolute).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink() || info.size === 0 || path.extname(absolute).toLowerCase() !== extension) {
    throw new Error(`Expected a non-empty, non-symlink ${extension} file: ${filePath}`);
  }
  return absolute;
}

function assertSafeOutput(output) {
  const resolved = path.resolve(output);
  const blocked = new Set([path.parse(resolved).root, os.homedir(), process.cwd()]);
  if (blocked.has(resolved) || path.dirname(resolved) === resolved) throw new Error(`Unsafe delivery target: ${resolved}`);
  return resolved;
}

function assetBlockReason(relativePath, isDirectory = false) {
  const normalized = relativePath.split(path.sep).join("/");
  const segments = normalized.split("/").filter(Boolean);
  const lowerSegments = segments.map((segment) => segment.toLocaleLowerCase());
  const root = lowerSegments[0];
  if (!segments.length || !ALLOWED_ASSET_ROOTS.has(root)) return "unsupported-asset-root";
  if (lowerSegments.some((segment) => FORBIDDEN_SEGMENTS.has(segment))) return "internal-directory";
  if (isDirectory) {
    if (root === "figures") return segments.length === 1 || (segments.length === 2 && ["original", "ready"].includes(lowerSegments[1])) ? null : "unsupported-figure-directory";
    return segments.length === 1 ? null : "nested-asset-directory";
  }
  const basename = segments.at(-1);
  const extension = path.extname(basename).toLocaleLowerCase();
  if (INTERNAL_ASSET_NAME.test(basename) || basename === ".DS_Store") return "internal-file";
  if (root === "figures") {
    if (segments.length === 2 && basename === "论文图片说明.md") return null;
    if (segments.length !== 3 || !["original", "ready"].includes(lowerSegments[1]) || !IMAGE_EXTENSIONS.has(extension)) return "unsupported-figure-file";
    return null;
  }
  if (root === "formulas") return FORMULA_EXTENSIONS.has(extension) ? null : "unsupported-formula-file";
  if (root === "branding") return IMAGE_EXTENSIONS.has(extension) ? null : "unsupported-brand-file";
  if (root === "data") return DATA_EXTENSIONS.has(extension) ? null : "unsupported-data-file";
  return "unsupported-asset-file";
}

async function copyAssets(source, target) {
  if (!source) return [];
  const root = path.resolve(source);
  const rootInfo = await fs.lstat(root).catch(() => null);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) throw new Error(`Assets directory must be a real directory, not a symlink: ${source}`);
  const copied = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute);
      if (entry.isSymbolicLink()) throw new Error(`Symlink is not allowed in delivery assets: ${relative}`);
      const reason = assetBlockReason(relative, entry.isDirectory());
      if (reason) throw new Error(`Asset is not allowed in the customer package (${reason}): ${relative}`);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) {
        const destination = path.join(target, relative);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.copyFile(absolute, destination);
        copied.push(relative.split(path.sep).join("/"));
      }
    }
  }
  await visit(root);
  return copied.sort();
}

async function validateAssetTree(root) {
  const rootInfo = await fs.lstat(root).catch(() => null);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) throw new Error(`Delivery assets must be a real directory: ${root}`);
  async function visit(directory) {
    let fileCount = 0;
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute);
      if (entry.isSymbolicLink()) throw new Error(`Symlink is not allowed in delivery assets: ${relative}`);
      const reason = assetBlockReason(relative, entry.isDirectory());
      if (reason) throw new Error(`Asset is not allowed in the customer package (${reason}): ${relative}`);
      if (entry.isDirectory()) fileCount += await visit(absolute);
      else if (!entry.isFile()) throw new Error(`Unsupported asset entry: ${relative}`);
      else fileCount += 1;
    }
    if (directory !== root && fileCount === 0) throw new Error(`Empty asset directory is not allowed in the customer package: ${path.relative(root, directory)}`);
    return fileCount;
  }
  await visit(root);
}

function scanText(value, location, options = {}) {
  const decoded = value.replaceAll("&amp;", "&").replaceAll("&#38;", "&");
  if (PATH_TRAVERSAL_PATTERN.test(decoded)) throw new Error(`Path traversal leaked into ${location}.`);
  const withoutPublicUrls = decoded.replace(SAFE_PUBLIC_URL_PATTERN, "").replace(SAFE_API_ROUTE_PATTERN, "");
  const generalPosixLeak = !options.packageXml && GENERAL_POSIX_PATH_PATTERN.test(withoutPublicUrls);
  if (LOCAL_PATH_PATTERN.test(withoutPublicUrls) || generalPosixLeak || NETWORK_PATH_PATTERN.test(withoutPublicUrls)) {
    throw new Error(`Local absolute path leaked into ${location}.`);
  }
  if (INTERNAL_FILE_PATTERN.test(withoutPublicUrls)) throw new Error(`Internal work-product filename leaked into ${location}.`);
  for (const pattern of SECRET_PATTERNS) if (pattern.test(decoded)) throw new Error(`Credential or signed secret leaked into ${location}.`);
}

function validateOfficeMetadata(value, location) {
  const allowed = new Set(["", "Academic Slides", "Walnut Exporter", "Artifact Tool", "PptxGenJS"]);
  for (const tag of ["dc:creator", "cp:lastModifiedBy"]) {
    const match = value.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
    const content = match?.[1]?.replace(/<[^>]+>/g, "").trim() ?? "";
    if (content && !allowed.has(content)) throw new Error(`Private Office author metadata leaked into ${location}.`);
  }
}

function validateExternalRelationships(value, location) {
  for (const match of value.matchAll(/<Relationship\b([^>]+)>?/gi)) {
    const attributes = match[1];
    if (!/TargetMode=["']External["']/i.test(attributes)) continue;
    const target = attributes.match(/Target=["']([^"']+)["']/i)?.[1] ?? "";
    const type = attributes.match(/Type=["']([^"']+)["']/i)?.[1] ?? "";
    if (!type.endsWith("/hyperlink") || !/^(?:https?:|mailto:)/i.test(target)) {
      throw new Error(`Unapproved external Office relationship in ${location}: ${target || "<unknown>"}`);
    }
  }
}

async function archiveEntries(filePath) {
  const { stdout } = await execFileAsync("unzip", ["-Z1", filePath], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024, timeout: 30_000 });
  return stdout.split(/\r?\n/).filter(Boolean);
}

async function scanArchive(filePath) {
  try {
    const entries = await archiveEntries(filePath);
    const blocked = entries.find((entry) => FORBIDDEN_ARCHIVE_ENTRY.test(entry));
    if (blocked) throw new Error(`Forbidden macro, OLE, embedded package, ActiveX, or custom XML entry: ${blocked}`);
    for (const entry of entries.filter((item) => /\.(?:xml|rels|txt|json)$/i.test(item))) {
      const unzipPattern = entry.replaceAll("[", "[[]").replaceAll("*", "[*]").replaceAll("?", "[?]");
      const result = await execFileAsync("unzip", ["-p", filePath, unzipPattern], { encoding: "buffer", maxBuffer: 30 * 1024 * 1024, timeout: 30_000 });
      const value = Buffer.from(result.stdout).toString("utf8");
      const location = `${path.basename(filePath)}::${entry}`;
      scanText(value, location, { packageXml: true });
      if (/docProps\/core\.xml$/i.test(entry)) validateOfficeMetadata(value, location);
      if (entry.toLocaleLowerCase().endsWith(".rels")) validateExternalRelationships(value, location);
    }
  } catch (error) {
    if (/leaked|Forbidden|Unapproved/.test(error.message)) throw error;
    throw new Error(`Cannot inspect Office archive ${filePath}: ${error.message}`);
  }
}

async function scanDelivery(directory) {
  async function visit(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symlink leaked into delivery: ${path.relative(directory, absolute)}`);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) {
        const extension = path.extname(entry.name).toLowerCase();
        if (TEXT_EXTENSIONS.has(extension)) scanText(await fs.readFile(absolute, "utf8"), path.relative(directory, absolute));
        if ([".pptx", ".docx", ".xlsx"].includes(extension)) await scanArchive(absolute);
        if ([".png", ".jpg", ".jpeg", ".webp"].includes(extension)) {
          const metadataText = (await fs.readFile(absolute)).toString("latin1");
          if (LOCAL_PATH_PATTERN.test(metadataText) || NETWORK_PATH_PATTERN.test(metadataText)) throw new Error(`Local path metadata leaked into ${path.relative(directory, absolute)}.`);
          for (const pattern of SECRET_PATTERNS) if (pattern.test(metadataText)) throw new Error(`Credential metadata leaked into ${path.relative(directory, absolute)}.`);
        }
      }
    }
  }
  await visit(directory);
}

async function readBuilderContract(filePath) {
  const source = await fs.readFile(filePath, "utf8");
  const line = source.match(/^\/\/ academic-slides-delivery:\s*(\{[^\r\n]+\})\s*$/m)?.[1];
  if (!line) throw new Error("Project MJS does not contain an academic-slides delivery contract header.");
  let contract;
  try { contract = JSON.parse(line); } catch { throw new Error("Project MJS delivery contract header is invalid JSON."); }
  return contract;
}

function assertBuilderContract(contract, stem) {
  const expected = { stem, pptx: `${stem}.pptx`, docx: `${stem}_发言稿.docx` };
  if (!contract || contract.stem !== expected.stem || contract.pptx !== expected.pptx || contract.docx !== expected.docx) {
    throw new Error(`Project MJS output contract does not match delivery stem ${stem}.`);
  }
}

async function assertRootContract(directory, stem) {
  const actual = (await fs.readdir(directory)).sort();
  const expected = [`${stem}.mjs`, `${stem}.pptx`, `${stem}_发言稿.docx`, "assets"].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Delivery root contract failed. Expected ${expected.join(", ")}; found ${actual.join(", ")}.`);
}

async function runProjectBuilder(mjsPath, directory) {
  await execFileAsync(process.execPath, [mjsPath, "--all"], {
    cwd: directory,
    env: {
      ...process.env,
      ACADEMIC_SLIDES_SKILL_DIR: process.env.ACADEMIC_SLIDES_SKILL_DIR || SKILL_DIR,
    },
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
    timeout: 300_000,
  });
}

export async function stageDelivery(args) {
  if (!args.output || !args.mjs) throw new Error("--output and --mjs are required.");
  const output = assertSafeOutput(args.output);
  const stem = validateDeliveryStem(path.basename(output), args.forbiddenTerms);
  const mjs = await requireRegularFile(args.mjs, ".mjs");
  assertBuilderContract(await readBuilderContract(mjs), stem);
  const parent = path.dirname(output);
  await fs.mkdir(parent, { recursive: true });
  const outputExists = await exists(output);
  if (outputExists && !args.force) throw new Error(`Delivery target already exists: ${output}. Use --force to replace this exact target.`);

  const temporary = await fs.mkdtemp(path.join(parent, ".delivery-stage-"));
  const previous = `${temporary}.previous`;
  let previousMoved = false;
  try {
    const stagedMjs = path.join(temporary, `${stem}.mjs`);
    await fs.copyFile(mjs, stagedMjs);
    const assetsTarget = path.join(temporary, "assets");
    await fs.mkdir(assetsTarget, { recursive: true });
    const assets = await copyAssets(args.assets, assetsTarget);
    await runProjectBuilder(stagedMjs, temporary);
    await requireRegularFile(path.join(temporary, `${stem}.pptx`), ".pptx");
    await requireRegularFile(path.join(temporary, `${stem}_发言稿.docx`), ".docx");
    await validateAssetTree(assetsTarget);
    await assertRootContract(temporary, stem);
    await scanDelivery(temporary);

    if (outputExists) {
      await fs.rename(output, previous);
      previousMoved = true;
    }
    try {
      await fs.rename(temporary, output);
    } catch (error) {
      if (previousMoved) await fs.rename(previous, output);
      throw error;
    }
    if (previousMoved) await fs.rm(previous, { recursive: true, force: true });
    return { output, stem, files: [`${stem}.pptx`, `${stem}.mjs`, `${stem}_发言稿.docx`, "assets/"], assets };
  } catch (error) {
    if (await exists(temporary)) await fs.rm(temporary, { recursive: true, force: true });
    if (previousMoved && !(await exists(output)) && await exists(previous)) await fs.rename(previous, output);
    throw error;
  }
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
    console.log(JSON.stringify(await stageDelivery(args), null, 2));
  } catch (error) {
    console.error(`DELIVERY FAILED: ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}

const direct = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (direct) await main();

export { parseArgs, copyAssets, validateAssetTree, scanDelivery, readBuilderContract, assertBuilderContract };
