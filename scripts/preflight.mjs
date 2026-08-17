#!/usr/bin/env node

import { access, readFile, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SKILL_DIR = path.resolve(SCRIPT_DIR, "..");
const MIN_NODE_MAJOR = 18;

function usage() {
  return [
    "Usage: node preflight.mjs [options]",
    "",
    "Options:",
    "  --skill-dir <dir>  Skill root (default: parent of this script)",
    "  --strict           Exit nonzero on warnings as well as required failures",
    "  --json             Emit machine-readable JSON",
    "  -h, --help         Show this help",
    "",
    "Preflight is read-only and never installs packages or system tools.",
  ].join("\n");
}

function parseArgs(argv) {
  const result = { skillDir: DEFAULT_SKILL_DIR, strict: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--strict") result.strict = true;
    else if (token === "--json") result.json = true;
    else if (token === "-h" || token === "--help") result.help = true;
    else if (token === "--skill-dir") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error("--skill-dir requires a value.");
      result.skillDir = path.resolve(value);
    } else throw new Error(`Unknown option: ${token}`);
  }
  return result;
}

async function executablePath(command) {
  if (path.isAbsolute(command)) {
    try {
      await access(command, fsConstants.X_OK);
      return command;
    } catch {
      return null;
    }
  }
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      try {
        await access(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // Continue through PATH without mutating the environment.
      }
    }
  }
  return null;
}

async function commandCheck(id, command, versionArgs, options = {}) {
  const resolved = await executablePath(command);
  if (!resolved) return { id, kind: "command", required: options.required ?? false, available: false, command, path: null, version: null };
  let version = null;
  try {
    const result = await execFileAsync(resolved, versionArgs, { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 10_000 });
    version = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().split(/\r?\n/).find(Boolean) ?? null;
  } catch (error) {
    version = `${error.stdout ?? ""}\n${error.stderr ?? ""}`.trim().split(/\r?\n/).find(Boolean) ?? null;
  }
  return { id, kind: "command", required: options.required ?? false, available: true, command, path: resolved, version };
}

async function texResourceCheck(id, resource, kpsewhichPath) {
  if (!kpsewhichPath) return { id, kind: "tex-resource", required: false, available: false, resource, path: null };
  try {
    const { stdout } = await execFileAsync(kpsewhichPath, [resource], { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 10_000 });
    const resolved = stdout.trim();
    return { id, kind: "tex-resource", required: false, available: Boolean(resolved), resource, path: resolved || null };
  } catch {
    return { id, kind: "tex-resource", required: false, available: false, resource, path: null };
  }
}

async function packageVersion(entryPath, packageName) {
  let directory = path.dirname(entryPath);
  while (directory !== path.dirname(directory)) {
    const packagePath = path.join(directory, "package.json");
    try {
      const data = JSON.parse(await readFile(packagePath, "utf8"));
      if (data.name === packageName) return data.version ?? null;
    } catch {
      // Keep walking to the package root.
    }
    directory = path.dirname(directory);
  }
  return null;
}

async function packageCheck(id, packageName, required = false) {
  const resolvers = [require];
  if (process.env.RUNTIME_NODE_MODULES) {
    resolvers.push(createRequire(path.join(path.resolve(process.env.RUNTIME_NODE_MODULES), "__academic_slides_runtime__.cjs")));
  }
  for (const resolver of resolvers) {
    try {
      const entry = resolver.resolve(packageName);
      return { id, kind: "node-package", required, available: true, package: packageName, path: entry, version: await packageVersion(entry, packageName) };
    } catch {
      // Try the explicitly supplied bundled runtime before reporting absence.
    }
  }
  return { id, kind: "node-package", required, available: false, package: packageName, path: null, version: null };
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))];
}

function normalizeFontName(value) {
  return String(value).toLowerCase().replace(/[\s_-]+/g, "").replace(/[^a-z0-9\u3400-\u9fff]/g, "");
}

async function matchFont(fcMatchPath, requested) {
  if (!fcMatchPath) return { requested, status: "unknown", resolvedFamily: null, file: null, exact: null };
  try {
    const { stdout } = await execFileAsync(fcMatchPath, ["-f", "%{family}\t%{file}\n", requested], { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 10_000 });
    const [family = "", file = ""] = stdout.trim().split("\t");
    const requestedName = normalizeFontName(requested);
    const exact = family.split(",").some((item) => normalizeFontName(item) === requestedName);
    return { requested, status: exact ? "resolved" : "substituted", resolvedFamily: family || null, file: file || null, exact };
  } catch (error) {
    return { requested, status: "unknown", resolvedFamily: null, file: null, exact: null, detail: error.message };
  }
}

async function inspectFonts(skillDir, fcMatchPath) {
  const registryPath = path.join(skillDir, "assets", "profile-registry.json");
  let registry;
  try {
    registry = JSON.parse(await readFile(registryPath, "utf8"));
  } catch (error) {
    return { resolver: fcMatchPath ? "fc-match" : "unavailable", profiles: [], findings: [{ severity: "warning", code: "fonts.registry", message: error.message }] };
  }
  const profiles = [];
  const findings = [];
  for (const [profileId, profile] of Object.entries(registry.profiles ?? {})) {
    const tokenPath = path.resolve(skillDir, profile.assetDirectory ?? "", profile.designTokens ?? "design-tokens.json");
    let tokens;
    try {
      tokens = JSON.parse(await readFile(tokenPath, "utf8"));
    } catch (error) {
      findings.push({ severity: "warning", code: "fonts.tokens", message: `${profileId}: ${error.message}` });
      continue;
    }
    const configured = tokens.fonts ?? {};
    const roles = {
      zh: uniqueStrings([configured.zh, ...(configured.zhFallbacks ?? []), "PingFang SC", "Noto Sans CJK SC", "Source Han Sans SC", "Heiti SC", "Arial Unicode MS"]),
      latin: uniqueStrings([configured.en, "Arial", "Helvetica", "Aptos"]),
      math: uniqueStrings([configured.math, "Latin Modern Math", "STIX Two Math", "STIX Math", "Cambria Math"]),
    };
    const roleReports = {};
    for (const [role, candidates] of Object.entries(roles)) {
      const matches = [];
      for (const candidate of candidates) matches.push(await matchFont(fcMatchPath, candidate));
      const preferred = candidates[0] ?? null;
      const verified = matches.find((item) => item.exact) ?? null;
      roleReports[role] = {
        preferred,
        preferredStatus: matches[0]?.status ?? "unknown",
        preferredResolvedFamily: matches[0]?.resolvedFamily ?? null,
        configuredFallbacks: role === "zh" ? configured.zhFallbacks ?? [] : [],
        candidates,
        verifiedRecommendation: verified?.requested ?? null,
        recommendation: verified
          ? `Use ${verified.requested} when ${preferred} is not available.`
          : "Font resolution is unknown; keep editable text and verify substitutions in the target PowerPoint environment.",
        matches,
      };
    }
    profiles.push({ profile: profileId, designTokens: path.relative(skillDir, tokenPath).split(path.sep).join("/"), roles: roleReports });
  }
  if (!fcMatchPath) findings.push({ severity: "warning", code: "fonts.resolver.unavailable", message: "fc-match is unavailable; font resolution is reported as unknown and is not a release blocker." });
  return {
    resolver: fcMatchPath ? "fc-match" : "unavailable",
    note: "Font checks are advisory. Microsoft YaHei is not required; Chinese candidates include PingFang SC, Noto Sans CJK SC, and Source Han Sans SC.",
    profiles,
    findings,
  };
}

function available(checks, id) {
  return checks.find((item) => item.id === id)?.available === true;
}

export async function runPreflight(options = {}) {
  const skillDir = path.resolve(options.skillDir ?? DEFAULT_SKILL_DIR);
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
  const node = {
    id: "node",
    kind: "runtime",
    required: true,
    available: Number.isInteger(nodeMajor) && nodeMajor >= MIN_NODE_MAJOR,
    path: process.execPath,
    version: process.versions.node,
    requirement: `>=${MIN_NODE_MAJOR}`,
  };
  const kpsewhich = await commandCheck("kpsewhich", "kpsewhich", ["--version"]);
  const checks = [
    node,
    await packageCheck("artifact-tool", "@oai/artifact-tool", true),
    await packageCheck("sharp", "sharp", true),
    await packageCheck("docx", "docx", true),
    await commandCheck("pdftoppm", "pdftoppm", ["-v"], { required: true }),
    await commandCheck("pdfinfo", "pdfinfo", ["-v"], { required: true }),
    await commandCheck("pdftocairo", "pdftocairo", ["-v"], { required: true }),
    await commandCheck("unzip", "unzip", ["-v"], { required: true }),
    await commandCheck("zip", "zip", ["-v"], { required: true }),
    await commandCheck("fc-match", "fc-match", ["--version"]),
    await commandCheck("pdflatex", "pdflatex", ["--version"]),
    await commandCheck("xelatex", "xelatex", ["--version"]),
    await commandCheck("dvisvgm", "dvisvgm", ["--version"]),
    kpsewhich,
    await texResourceCheck("xecjk", "xeCJK.sty", kpsewhich.path),
    await texResourceCheck("fandol-hei", "FandolHei-Regular.otf", kpsewhich.path),
    await packageCheck("mathjax-full", "mathjax-full"),
    await packageCheck("mathjax", "mathjax"),
    await packageCheck("katex", "katex"),
  ];

  const latexEngine = available(checks, "pdflatex") || available(checks, "xelatex");
  const svgBackend = available(checks, "dvisvgm") || available(checks, "pdftocairo");
  const pngBackend = available(checks, "pdftocairo");
  const localMathRenderer = available(checks, "mathjax-full") || available(checks, "mathjax") || available(checks, "katex");
  const sourcePdfCrop = available(checks, "pdftocairo") || available(checks, "pdftoppm");
  const primaryFormula = latexEngine && svgBackend && pngBackend;
  const cjkFormula = available(checks, "xelatex") && available(checks, "xecjk") && available(checks, "fandol-hei");
  const fonts = await inspectFonts(skillDir, checks.find((item) => item.id === "fc-match" && item.available)?.path ?? null);
  const formula = {
    primary: {
      available: primaryFormula,
      method: "local-latex-to-path-svg-and-transparent-png",
      detail: primaryFormula
        ? "A local pdflatex/xelatex engine and verified SVG/PNG backends are available."
        : "The complete local LaTeX SVG/PNG pipeline is unavailable.",
    },
    unicodeCjk: {
      available: cjkFormula,
      method: cjkFormula ? "xelatex-with-xecjk-and-fandol-path-font" : null,
      detail: cjkFormula
        ? "Unicode and Chinese text inside formulas can be rendered without relying on the system presentation font."
        : "Unicode/CJK formula text must be removed, faithfully cropped from the source PDF, or reported; pdflatex is not a safe fallback.",
    },
    existingFormulaFallback: {
      reliable: sourcePdfCrop,
      method: sourcePdfCrop ? "high-resolution crop from the source PDF" : null,
      detail: sourcePdfCrop ? "Existing equations can be preserved faithfully from the source PDF." : "No Poppler raster/vector crop backend is available.",
    },
    newFormulaFallback: {
      reliable: localMathRenderer,
      method: localMathRenderer ? "trusted local MathJax/KaTeX renderer" : null,
      detail: localMathRenderer
        ? "A local renderer can handle new verified LaTeX expressions."
        : "Without the primary LaTeX pipeline, complex new formulas must be blocked or reported; raw LaTeX is not an acceptable fallback.",
    },
  };

  const findings = [];
  for (const item of checks.filter((check) => check.required && !check.available)) findings.push({ severity: "error", code: `required.${item.id}`, message: `${item.id} is unavailable.` });
  if (!primaryFormula && sourcePdfCrop) findings.push({ severity: "warning", code: "formula.primary.unavailable", message: "Local LaTeX formula rendering is unavailable; faithful source-PDF crops remain available for existing formulas." });
  if (!primaryFormula && !localMathRenderer) findings.push({ severity: "warning", code: "formula.new.unavailable", message: "No reliable renderer for complex new formulas is available; block or report those formulas instead of exposing raw LaTeX." });
  if (!primaryFormula && !sourcePdfCrop) findings.push({ severity: "error", code: "formula.existing.unavailable", message: "Neither the primary LaTeX pipeline nor a reliable source-PDF crop fallback is available." });
  if (available(checks, "xelatex") && !cjkFormula) findings.push({ severity: "warning", code: "formula.cjk.unavailable", message: "XeLaTeX exists, but xeCJK or FandolHei-Regular.otf is unavailable; Unicode/CJK formula text cannot be rendered safely." });
  findings.push(...fonts.findings);

  const ready = !findings.some((item) => item.severity === "error");
  const ok = ready && !(options.strict && findings.some((item) => item.severity === "warning"));
  return {
    ok,
    ready,
    readOnly: true,
    installsPerformed: false,
    skillDir,
    platform: { os: process.platform, arch: process.arch },
    checks,
    formula,
    fonts,
    findings,
  };
}

function printHuman(result) {
  console.log(`${result.ok ? "PASS" : "FAIL"}: academic-slides preflight`);
  for (const item of result.checks) console.log(`- ${item.available ? "OK" : "MISSING"} ${item.id}${item.version ? `: ${item.version}` : ""}${item.path ? ` (${item.path})` : ""}`);
  console.log(`- FORMULA primary=${result.formula.primary.available ? "available" : "unavailable"}; unicode-cjk=${result.formula.unicodeCjk.available ? "available" : "unavailable"}; existing-fallback=${result.formula.existingFormulaFallback.reliable ? "reliable" : "unavailable"}; new-fallback=${result.formula.newFormulaFallback.reliable ? "reliable" : "unavailable"}`);
  for (const profile of result.fonts.profiles) {
    const summary = Object.entries(profile.roles).map(([role, report]) => `${role}=${report.preferredStatus}:${report.preferred}${report.verifiedRecommendation && report.verifiedRecommendation !== report.preferred ? `->${report.verifiedRecommendation}` : ""}`).join(", ");
    console.log(`- FONTS ${profile.profile}: ${summary}`);
  }
  for (const item of result.findings) console.log(`- ${item.severity.toUpperCase()} ${item.code}: ${item.message}`);
  console.log("No dependencies were installed or modified.");
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
    const result = await runPreflight(args);
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else printHuman(result);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    if (args.json) console.log(JSON.stringify({ ok: false, readOnly: true, installsPerformed: false, error: error.message }, null, 2));
    else console.error(`ERROR: ${error.message}`);
    process.exitCode = 2;
  }
}

const invokedDirectly = process.argv[1] && await realpath(process.argv[1]).catch(() => null) === await realpath(fileURLToPath(import.meta.url)).catch(() => null);
if (invokedDirectly) await main();
