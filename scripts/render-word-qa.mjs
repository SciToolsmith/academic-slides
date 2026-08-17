#!/usr/bin/env node

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const CJK_PATTERN = /[\u3400-\u9FFF\uF900-\uFAFF]/g;
const CJK_FONT_PATTERN = /(?:hiragino|pingfang|heiti|songti|sourcehan|notosanscjk|notoserifcjk|yahei|simsun|simhei|arialunicode|wenquanyi|hanazono)/i;

function usage() {
  return [
    "Usage: node render-word-qa.mjs --input <发言稿.docx> --output-dir <qa-dir> [options]",
    "",
    "Options:",
    "  --renderer <render_docx.py>  Documents Skill renderer (auto-discovered in Codex)",
    "  --python <python>             Workspace Python executable (auto-discovered when possible)",
    "  --no-native-preview          Skip the macOS QuickLook cross-check",
    "  -h, --help                   Show this help",
  ].join("\n");
}

function parseArgs(argv) {
  const result = { nativePreview: true };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--no-native-preview") result.nativePreview = false;
    else if (token === "-h" || token === "--help") result.help = true;
    else if (["--input", "--output-dir", "--renderer", "--python"].includes(token)) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${token} requires a value.`);
      result[token.slice(2).replaceAll("-", "_")] = value;
    } else throw new Error(`Unknown option: ${token}`);
  }
  return result;
}

async function exists(filePath) {
  if (!filePath) return false;
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findExecutable(name) {
  return (await findExecutables(name))[0] ?? null;
}

async function findExecutables(name) {
  const suffixes = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  const matches = [];
  for (const directory of String(process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const suffix of suffixes) {
      const candidate = path.join(directory, `${name}${suffix}`);
      if (await exists(candidate)) matches.push(candidate);
    }
  }
  return [...new Set(matches.map((candidate) => path.resolve(candidate)))];
}

async function resolveDocumentsRenderer(explicit) {
  for (const candidate of [explicit, process.env.DOCUMENTS_RENDER_DOCX]) {
    if (await exists(candidate)) return path.resolve(candidate);
  }
  const cacheRoot = path.join(os.homedir(), ".codex", "plugins", "cache", "openai-primary-runtime", "documents");
  const versions = await fs.readdir(cacheRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of versions.filter((item) => item.isDirectory()).sort((left, right) => right.name.localeCompare(left.name))) {
    const candidate = path.join(cacheRoot, entry.name, "skills", "documents", "render_docx.py");
    if (await exists(candidate)) return candidate;
  }
  throw new Error("Cannot locate Documents Skill render_docx.py. Pass --renderer or set DOCUMENTS_RENDER_DOCX.");
}

async function bundledPythonCandidates() {
  const executable = process.platform === "win32" ? "python.exe" : "python3";
  const roots = [
    process.env.CODEX_RUNTIMES_DIR,
    process.env.CODEX_RUNTIME_ROOT,
    path.join(os.homedir(), ".cache", "codex-runtimes"),
  ].filter(Boolean);
  const candidates = [];
  for (const root of [...new Set(roots.map((item) => path.resolve(item)))]) {
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    const runtimeEntries = entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .sort((left, right) => {
        const leftPrimary = left.name === "codex-primary-runtime" ? 1 : 0;
        const rightPrimary = right.name === "codex-primary-runtime" ? 1 : 0;
        return rightPrimary - leftPrimary || right.name.localeCompare(left.name);
      });
    for (const entry of runtimeEntries) {
      candidates.push(path.join(root, entry.name, "dependencies", "python", "bin", executable));
    }
  }
  return candidates;
}

function unavailableRuntimeError(diagnostics) {
  const checked = diagnostics.length > 0
    ? diagnostics.map(({ candidate, reason }) => `${candidate} (${reason})`).join("; ")
    : "no candidate executables found";
  const error = new Error(
    `WORD_QA_RUNTIME_UNAVAILABLE: no Python runtime with the Documents renderer dependencies `
    + `(pdf2image and Pillow) is available. Checked: ${checked}`,
  );
  error.code = "WORD_QA_RUNTIME_UNAVAILABLE";
  error.diagnostics = diagnostics;
  return error;
}

export function isWordQaRuntimeUnavailable(error) {
  return error?.code === "WORD_QA_RUNTIME_UNAVAILABLE"
    || String(error?.message ?? "").startsWith("WORD_QA_RUNTIME_UNAVAILABLE:");
}

async function probePythonRuntime(candidate, renderer) {
  if (!(await exists(candidate))) return { ok: false, reason: "not found" };
  const probe = [
    "import pathlib, sys",
    "import pdf2image",
    "from PIL import Image",
    "source = pathlib.Path(sys.argv[1]).read_bytes()",
    "compile(source, sys.argv[1], 'exec')",
  ].join("; ");
  try {
    await execFileAsync(candidate, ["-c", probe, renderer], {
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      timeout: 15_000,
    });
    return { ok: true, reason: "ready" };
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message || "dependency probe failed")
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .at(-1);
    return { ok: false, reason: detail || "dependency probe failed" };
  }
}

export async function selectPythonRuntime(candidates, renderer) {
  const diagnostics = [];
  const uniqueCandidates = [...new Set(candidates.filter(Boolean).map((candidate) => path.resolve(candidate)))];
  for (const candidate of uniqueCandidates) {
    const result = await probePythonRuntime(candidate, renderer);
    if (result.ok) return candidate;
    diagnostics.push({ candidate, reason: result.reason });
  }
  throw unavailableRuntimeError(diagnostics);
}

async function resolvePython(explicit, renderer) {
  const executable = process.platform === "win32" ? "python.exe" : "python3";
  const siblingPython = path.resolve(
    path.dirname(process.execPath),
    "..",
    "..",
    "python",
    "bin",
    executable,
  );
  const pathPythons = [
    ...(await findExecutables("python3")),
    ...(await findExecutables("python")),
  ];
  return selectPythonRuntime([
    explicit,
    process.env.WORKSPACE_PYTHON,
    siblingPython,
    ...(await bundledPythonCandidates()),
    ...pathPythons,
  ], renderer);
}

async function resolveLibreOfficeFontconfig(sofficePath, pythonPath) {
  if (await exists(process.env.FONTCONFIG_FILE)) return path.resolve(process.env.FONTCONFIG_FILE);
  const candidates = [];
  for (const start of [sofficePath, pythonPath].filter(Boolean)) {
    let current = path.dirname(path.resolve(start));
    for (let depth = 0; current && depth < 8; depth += 1) {
      candidates.push(
        path.join(current, "Resources", "fontconfig", "fonts.conf"),
        path.join(current, "native", "libreoffice-headless", "libreoffice", "LibreOfficeDev.app", "Contents", "Resources", "fontconfig", "fonts.conf"),
        path.join(current, "native", "libreoffice-headless", "libreoffice", "LibreOffice.app", "Contents", "Resources", "fontconfig", "fonts.conf"),
        path.join(current, "etc", "fonts", "fonts.conf"),
      );
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  const filesystemRoot = path.parse(process.cwd()).root;
  candidates.push(
    path.join(filesystemRoot, "Applications", "LibreOffice.app", "Contents", "Resources", "fontconfig", "fonts.conf"),
    path.join(filesystemRoot, "etc", "fonts", "fonts.conf"),
  );
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  return null;
}

async function archiveText(archive, entry) {
  const result = await execFileAsync("unzip", ["-p", archive, entry], {
    encoding: "utf8",
    maxBuffer: 30 * 1024 * 1024,
    timeout: 30_000,
  });
  return result.stdout;
}

function normalizeFontName(value) {
  return String(value ?? "").replace(/[^a-z0-9]/gi, "").toLocaleLowerCase("en-US");
}

async function inspectDocument(input) {
  const [documentXml, stylesXml] = await Promise.all([
    archiveText(input, "word/document.xml"),
    archiveText(input, "word/styles.xml"),
  ]);
  const cjkCharacters = (documentXml.match(CJK_PATTERN) ?? []).length;
  const declaredFonts = [...new Set(
    [...stylesXml.matchAll(/w:eastAsia="([^"]+)"/g), ...documentXml.matchAll(/w:eastAsia="([^"]+)"/g)]
      .map((match) => match[1]),
  )];
  return { cjkCharacters, declaredFonts };
}

async function inspectPdfFonts(pdfPath) {
  const pdffonts = await findExecutable("pdffonts");
  if (!pdffonts || !(await exists(pdfPath))) return { available: false, fonts: [] };
  const result = await execFileAsync(pdffonts, [pdfPath], { encoding: "utf8", maxBuffer: 5 * 1024 * 1024, timeout: 30_000 });
  const lines = result.stdout.split(/\r?\n/).slice(2).map((line) => line.trim()).filter(Boolean);
  return { available: true, fonts: lines.map((line) => line.split(/\s+/)[0]).filter(Boolean) };
}

function renderedCjkFonts(actualFonts, declaredFonts) {
  const declaredKeys = declaredFonts.map(normalizeFontName).filter(Boolean);
  return actualFonts.filter((font) => {
    const key = normalizeFontName(font);
    return CJK_FONT_PATTERN.test(key) || declaredKeys.some((declared) => key.includes(declared) || declared.includes(key));
  });
}

async function quickLookThumbnail(input, outputDir) {
  if (process.platform !== "darwin") return null;
  const qlmanage = await findExecutable("qlmanage");
  if (!qlmanage) return null;
  const target = path.join(outputDir, "quicklook");
  await fs.mkdir(target, { recursive: true });
  await execFileAsync(qlmanage, ["-t", "-s", "1600", "-o", target, input], {
    encoding: "utf8",
    maxBuffer: 5 * 1024 * 1024,
    timeout: 30_000,
  });
  const png = (await fs.readdir(target)).find((name) => name.endsWith(".png"));
  return png ? path.join(target, png) : null;
}

export async function renderWordForQa(options = {}) {
  const input = path.resolve(options.input ?? "");
  const outputDir = path.resolve(options.outputDir ?? "");
  if (!(await exists(input)) || path.extname(input).toLocaleLowerCase() !== ".docx") throw new Error(`Expected a DOCX input: ${options.input ?? "<missing>"}`);
  if (!options.outputDir) throw new Error("outputDir is required.");
  const existing = await fs.readdir(outputDir).catch(() => []);
  if (existing.length > 0) throw new Error(`Word QA output directory must be empty: ${outputDir}`);
  await fs.mkdir(outputDir, { recursive: true });

  const renderer = await resolveDocumentsRenderer(options.renderer);
  const [python, soffice, documentInfo] = await Promise.all([
    resolvePython(options.python, renderer),
    findExecutable("soffice"),
    inspectDocument(input),
  ]);
  const fontconfig = await resolveLibreOfficeFontconfig(soffice, python);
  const env = { ...process.env };
  if (fontconfig) env.FONTCONFIG_FILE = fontconfig;
  await execFileAsync(python, [renderer, input, "--output_dir", outputDir, "--emit_pdf"], {
    env,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    timeout: 120_000,
  });

  const pages = (await fs.readdir(outputDir)).filter((name) => /^page-\d+\.png$/i.test(name)).sort();
  if (pages.length === 0) throw new Error("Documents Skill renderer produced no Word page PNGs.");
  const pdfPath = path.join(outputDir, `${path.basename(input, path.extname(input))}.pdf`);
  const pdfFonts = await inspectPdfFonts(pdfPath);
  const cjkFonts = renderedCjkFonts(pdfFonts.fonts, documentInfo.declaredFonts);
  const nativePreview = options.nativePreview === false ? null : await quickLookThumbnail(input, outputDir);
  const cjkStatus = documentInfo.cjkCharacters === 0
    ? "not-applicable"
    : !pdfFonts.available ? "manual-check-required"
      : cjkFonts.length > 0 ? "visible" : "runtime-limited";
  const warnings = [];
  if (!fontconfig && documentInfo.cjkCharacters > 0) warnings.push("No LibreOffice fontconfig file was found; CJK rendering may depend on the host runtime.");
  if (cjkStatus === "runtime-limited") warnings.push(
    "The DOCX contains CJK text, but the LibreOffice PDF uses no declared or recognized CJK font. This is a QA runtime font-resolution limitation; inspect the native QuickLook/Word rendering before delivery.",
  );

  return {
    input,
    outputDir,
    renderer,
    python,
    fontconfig,
    pages: pages.map((name) => path.join(outputDir, name)),
    pageCount: pages.length,
    pdf: (await exists(pdfPath)) ? pdfPath : null,
    nativePreview,
    cjkCharacters: documentInfo.cjkCharacters,
    declaredFonts: documentInfo.declaredFonts,
    renderedFonts: pdfFonts.fonts,
    renderedCjkFonts: cjkFonts,
    cjkStatus,
    warnings,
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
  if (!args.input || !args.output_dir) {
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  try {
    const result = await renderWordForQa({
      input: args.input,
      outputDir: args.output_dir,
      renderer: args.renderer,
      python: args.python,
      nativePreview: args.nativePreview,
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.cjkStatus === "runtime-limited") process.exitCode = 3;
  } catch (error) {
    console.error(`WORD QA RENDER FAILED: ${error.stack || error.message}`);
    process.exitCode = isWordQaRuntimeUnavailable(error) ? 4 : 1;
  }
}

const direct = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (direct) await main();

export { parseArgs, resolveLibreOfficeFontconfig };
