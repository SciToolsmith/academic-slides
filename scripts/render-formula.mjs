#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_MATHJAX_VERSION = "3.2.2";
const BUNDLED_MATHJAX_ENTRY = path.join(SCRIPT_DIR, "vendor", "mathjax", BUNDLED_MATHJAX_VERSION, "es5", "node-main.js");
let bundledMathJaxPromise = null;

const MAX_EXPRESSION_LENGTH = 12_000;
const SAFE_MATH_COMMANDS = new Set([
  "alpha", "beta", "gamma", "delta", "epsilon", "varepsilon", "zeta", "eta", "theta", "vartheta", "iota", "kappa", "lambda", "mu", "nu", "xi", "omicron", "pi", "varpi", "rho", "varrho", "sigma", "varsigma", "tau", "upsilon", "phi", "varphi", "chi", "psi", "omega",
  "Gamma", "Delta", "Theta", "Lambda", "Xi", "Pi", "Sigma", "Upsilon", "Phi", "Psi", "Omega",
  "frac", "dfrac", "tfrac", "sqrt", "sum", "prod", "coprod", "int", "iint", "iiint", "oint", "lim", "limsup", "liminf", "log", "ln", "exp", "sin", "cos", "tan", "cot", "sec", "csc", "sinh", "cosh", "tanh", "det", "gcd", "min", "max", "inf", "sup", "arg", "ker", "dim", "Pr",
  "operatorname", "substack", "overset", "underset", "stackrel", "binom", "dbinom", "tbinom", "boxed", "overbrace", "underbrace", "overrightarrow", "overleftarrow",
  "mathbf", "mathrm", "mathit", "mathsf", "mathtt", "mathcal", "mathbb", "mathfrak", "boldsymbol", "bm", "text", "textnormal", "textrm", "textit", "textbf",
  "vec", "hat", "widehat", "bar", "overline", "underline", "tilde", "widetilde", "dot", "ddot", "dddot", "breve", "check", "acute", "grave",
  "left", "right", "middle", "mid", "vert", "Vert", "big", "Big", "bigg", "Bigg", "bigl", "bigr", "Bigl", "Bigr", "biggl", "biggr", "Biggl", "Biggr", "lbrace", "rbrace", "langle", "rangle", "lvert", "rvert", "lVert", "rVert", "lfloor", "rfloor", "lceil", "rceil",
  "le", "leq", "ge", "geq", "ne", "neq", "approx", "sim", "simeq", "cong", "equiv", "propto", "ll", "gg", "prec", "succ", "preceq", "succeq",
  "in", "notin", "ni", "subset", "supset", "subseteq", "supseteq", "cup", "cap", "setminus", "emptyset", "varnothing",
  "cdot", "times", "div", "pm", "mp", "ast", "star", "circ", "bullet", "oplus", "ominus", "otimes", "oslash", "odot", "wedge", "vee",
  "to", "rightarrow", "leftarrow", "leftrightarrow", "Rightarrow", "Leftarrow", "Leftrightarrow", "longrightarrow", "longleftarrow", "longleftrightarrow", "Longrightarrow", "Longleftarrow", "Longleftrightarrow", "mapsto", "longmapsto", "uparrow", "downarrow", "partial", "nabla", "infty", "forall", "exists", "neg", "land", "lor",
  "ldots", "cdots", "vdots", "ddots", "dots", "prime", "Re", "Im", "angle", "degree", "perp", "parallel", "therefore", "because", "ell", "hbar", "imath", "jmath", "wp", "aleph",
  "mathop", "mathbin", "mathrel", "mathord", "mathinner", "mathopen", "mathclose", "mathpunct", "limits", "nolimits", "displaystyle", "textstyle", "scriptstyle", "scriptscriptstyle", "mod", "bmod", "pmod", "colon", "not", "phantom", "vphantom", "hphantom",
  "begin", "end", "tag", "qquad", "quad", "enspace", "thinspace", "medspace", "thickspace", "negthinspace",
]);
const SAFE_SYMBOL_COMMANDS = new Set(["\\", "{", "}", "_", "%", "#", "$", "&", ",", ";", ":", "!", "|", "/", " "]);
const SAFE_ENVIRONMENTS = new Set(["matrix", "smallmatrix", "pmatrix", "bmatrix", "Bmatrix", "vmatrix", "Vmatrix", "cases", "aligned", "alignedat", "gathered", "split", "array"]);
const DANGEROUS_TEX_COMMANDS = new Set([
  "input", "include", "includegraphics", "usepackage", "documentclass", "openin", "closein", "read", "readline", "openout", "closeout", "write", "immediate", "special", "catcode", "csname", "endcsname", "def", "edef", "gdef", "xdef", "let", "futurelet", "expandafter", "afterassignment", "aftergroup", "newcommand", "renewcommand", "providecommand", "newenvironment", "renewenvironment", "newread", "newwrite", "loop", "repeat", "toks", "everyjob", "everypar", "jobname", "meaning", "show", "message", "errmessage", "shipout", "pdfobj", "pdfxform", "pdfannot", "pdfcatalog", "pdfinfo", "pdfliteral", "pdfextension", "directlua", "luaexec", "shellescape", "write18", "enddocument",
]);

function usage() {
  return [
    "Usage: node render-formula.mjs --latex <expression> --output-dir <dir> --name <slug> [options]",
    "       node render-formula.mjs --input <expression.tex> --output-dir <dir> --name <slug> [options]",
    "",
    "Options:",
    "  --renderer <auto|latex|mathjax>  Formula renderer (default: auto)",
    "  --engine <auto|pdflatex|xelatex> LaTeX engine (default: auto)",
    "  --color <RRGGBB>                 Formula color (default: 17213A)",
    "  --dpi <number>                   Transparent PNG resolution (default: 600)",
    "  --svg-font-size <number>         Natural SVG em size in px (default: 32)",
    "  --validate-only                  Validate expression safety without requiring LaTeX",
    "  -h, --help                       Show this help",
  ].join("\n");
}

function parseArgs(argv) {
  const args = { renderer: "auto", engine: "auto", color: "17213A", dpi: 600, svgFontSize: 32 };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "-h" || token === "--help") args.help = true;
    else if (token === "--validate-only") args.validateOnly = true;
    else if (["--latex", "--input", "--output-dir", "--name", "--renderer", "--engine", "--color", "--dpi", "--svg-font-size"].includes(token)) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${token} requires a value.`);
      args[token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    } else throw new Error(`Unknown option: ${token}`);
  }
  if (args.help) return args;
  if ((args.latex ? 1 : 0) + (args.input ? 1 : 0) !== 1) throw new Error("Use exactly one of --latex or --input.");
  if (!args.validateOnly && (!args.outputDir || !args.name)) throw new Error("--output-dir and --name are required unless --validate-only is used.");
  if (args.name && !/^[a-zA-Z0-9._-]+$/.test(args.name)) throw new Error("--name may contain only letters, digits, dot, underscore, and hyphen.");
  if (!/^(auto|latex|mathjax)$/.test(args.renderer)) throw new Error("--renderer must be auto, latex, or mathjax.");
  if (!/^(auto|pdflatex|xelatex)$/.test(args.engine)) throw new Error("--engine must be auto, pdflatex, or xelatex.");
  args.color = String(args.color).replace(/^#/, "").toUpperCase();
  if (!/^[0-9A-F]{6}$/.test(args.color)) throw new Error("--color must be a six-digit hex value.");
  args.dpi = Number(args.dpi);
  if (!Number.isFinite(args.dpi) || args.dpi < 144 || args.dpi > 1200) throw new Error("--dpi must be between 144 and 1200.");
  args.svgFontSize = Number(args.svgFontSize);
  if (!Number.isFinite(args.svgFontSize) || args.svgFontSize < 12 || args.svgFontSize > 96) throw new Error("--svg-font-size must be between 12 and 96.");
  return args;
}

function run(command, commandArgs, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, { cwd: options.cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeoutMs = options.timeoutMs ?? 60_000;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, code, stdout, stderr: timedOut ? `${stderr}\nCommand timed out after ${timeoutMs} ms.` : stderr });
    });
  });
}

async function available(command) {
  const result = await run("/usr/bin/env", ["sh", "-c", "command -v \"$1\" >/dev/null 2>&1", "formula-tool", command]);
  return result.ok;
}

function normalizeExpression(value) {
  let expression = String(value).trim();
  if (expression.startsWith("$$") && expression.endsWith("$$")) expression = expression.slice(2, -2).trim();
  else if (expression.startsWith("\\[") && expression.endsWith("\\]")) expression = expression.slice(2, -2).trim();
  else if (expression.startsWith("$") && expression.endsWith("$")) expression = expression.slice(1, -1).trim();
  if (!expression) throw new Error("Formula expression is empty.");
  return expression;
}

function assertBalancedBraces(expression) {
  let depth = 0;
  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth < 0) throw new Error("Unsafe LaTeX expression: closing brace has no matching opening brace.");
    }
  }
  if (depth !== 0) throw new Error("Unsafe LaTeX expression: braces are not balanced.");
}

function validateEnvironments(expression) {
  const stack = [];
  const environmentPattern = /\\(begin|end)\s*\{([^{}]+)\}/g;
  let match;
  while ((match = environmentPattern.exec(expression)) !== null) {
    const [, action, environment] = match;
    if (!SAFE_ENVIRONMENTS.has(environment)) throw new Error(`Unsafe LaTeX expression: environment ${environment} is not allowed.`);
    if (action === "begin") stack.push(environment);
    else if (stack.pop() !== environment) throw new Error(`Unsafe LaTeX expression: environment ${environment} is not properly nested.`);
  }
  if (stack.length) throw new Error(`Unsafe LaTeX expression: environment ${stack.at(-1)} is not closed.`);
  const beginEndCount = [...expression.matchAll(/\\(?:begin|end)\b/g)].length;
  const parsedCount = [...expression.matchAll(environmentPattern)].length;
  if (beginEndCount !== parsedCount) throw new Error("Unsafe LaTeX expression: malformed environment declaration.");
}

export function validateMathExpression(value) {
  const expression = normalizeExpression(value);
  if (expression.length > MAX_EXPRESSION_LENGTH) throw new Error(`Unsafe LaTeX expression: length exceeds ${MAX_EXPRESSION_LENGTH} characters.`);
  if (/[^\t\n\r\x20-\uFFFF]/u.test(expression)) throw new Error("Unsafe LaTeX expression: contains disallowed control characters.");
  if (/\^\^[0-9A-Fa-f]{2}|\^\^./.test(expression)) throw new Error("Unsafe LaTeX expression: TeX ^^ character escapes are not allowed.");
  if (/(^|[^\\])%/.test(expression)) throw new Error("Unsafe LaTeX expression: TeX comments are not allowed.");
  if (/(^|[^\\])\$/.test(expression)) throw new Error("Unsafe LaTeX expression: nested math delimiters are not allowed.");
  assertBalancedBraces(expression);

  const commandPattern = /\\([A-Za-z@]+|.)/g;
  let commandMatch;
  while ((commandMatch = commandPattern.exec(expression)) !== null) {
    const command = commandMatch[1];
    const normalized = command.toLowerCase();
    if (DANGEROUS_TEX_COMMANDS.has(normalized) || normalized.startsWith("pdf") || normalized.startsWith("lua")) {
      throw new Error(`Unsafe LaTeX expression: command \\${command} is forbidden.`);
    }
    if (command.length === 1 && !/[A-Za-z@]/.test(command)) {
      if (!SAFE_SYMBOL_COMMANDS.has(command)) throw new Error(`Unsafe LaTeX expression: symbol command \\${command} is not allowed.`);
    } else if (!SAFE_MATH_COMMANDS.has(command)) {
      throw new Error(`Unsafe LaTeX expression: command \\${command} is not in the safe math allowlist.`);
    }
  }
  validateEnvironments(expression);
  return expression;
}

function texDocument(expression, color) {
  return [
    "\\documentclass[border=2pt]{standalone}",
    "\\usepackage{amsmath,amssymb,bm}",
    "\\usepackage{xcolor}",
    "\\usepackage{iftex}",
    "\\ifXeTeX",
    "\\usepackage{fontspec}",
    "\\usepackage{xeCJK}",
    "\\setCJKmainfont{FandolHei-Regular.otf}",
    "\\fi",
    "\\begin{document}",
    `\\color[HTML]{${color}}`,
    "\\begin{minipage}{0.98\\linewidth}",
    "\\centering",
    `\\[${expression}\\]`,
    "\\end{minipage}",
    "\\end{document}",
    "",
  ].join("\n");
}

export function latexCompilerArgs(tempDir, texFile) {
  return ["-no-shell-escape", "-interaction=nonstopmode", "-halt-on-error", `-output-directory=${tempDir}`, texFile];
}

async function chooseEngines(requested, expression) {
  const hasUnicode = /[^\x00-\x7F]/.test(expression);
  if (requested !== "auto") {
    if (hasUnicode && requested !== "xelatex") throw new Error("Unicode formula text requires xelatex; pdflatex would silently lose glyphs.");
    return (await available(requested)) ? [requested] : [];
  }
  const preferred = hasUnicode ? ["xelatex"] : ["pdflatex", "xelatex"];
  for (const engine of preferred) if (await available(engine)) return [engine];
  return [];
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function loadBundledMathJax() {
  if (!bundledMathJaxPromise) {
    bundledMathJaxPromise = Promise.resolve().then(async () => {
      await access(BUNDLED_MATHJAX_ENTRY);
      const loader = require(BUNDLED_MATHJAX_ENTRY);
      return loader.init({
        loader: { load: ["input/tex-full", "output/svg"] },
        svg: { fontCache: "none" },
      });
    });
  }
  return bundledMathJaxPromise;
}

function makePortableSvg(serialized, expression, color, svgFontSize) {
  const svgMatch = serialized.match(/<svg\b[\s\S]*?<\/svg>/);
  if (!svgMatch) throw new Error("Bundled MathJax did not return an SVG element.");
  let svg = svgMatch[0];
  if (/data-mml-node="merror"|data-mjx-error=|<merror\b/i.test(svg)) throw new Error("Bundled MathJax reported an invalid or unsupported expression.");
  if (/<text\b/i.test(svg)) throw new Error("Bundled MathJax would require a non-path system-font glyph. Use XeLaTeX or a faithful source-PDF crop for Unicode/CJK formula text.");

  const viewBox = svg.match(/\bviewBox="([^"]+)"/i)?.[1]?.trim().split(/[\s,]+/).map(Number);
  if (!viewBox || viewBox.length !== 4 || viewBox.some((value) => !Number.isFinite(value)) || viewBox[2] <= 0 || viewBox[3] <= 0) {
    throw new Error("Bundled MathJax returned an SVG without a valid viewBox.");
  }
  const widthPx = (viewBox[2] / 1000) * svgFontSize;
  const heightPx = (viewBox[3] / 1000) * svgFontSize;
  const hexColor = `#${color}`;
  const opening = svg.match(/^<svg\b[^>]*>/)?.[0];
  if (!opening) throw new Error("Bundled MathJax returned malformed SVG markup.");
  const portableOpening = opening
    .replace(/\s(?:style|width|height|color|preserveAspectRatio)="[^"]*"/gi, "")
    .replace(/^<svg\b/, `<svg width="${widthPx.toFixed(2)}px" height="${heightPx.toFixed(2)}px" color="${hexColor}" preserveAspectRatio="xMidYMid meet"`);
  svg = `${portableOpening}<title>${escapeXml(expression)}</title>${svg.slice(opening.length)}`
    .replaceAll("currentColor", hexColor);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${svg}\n`;
}

async function optionalSharp() {
  const resolvers = [require];
  if (process.env.RUNTIME_NODE_MODULES) {
    resolvers.push(createRequire(path.join(path.resolve(process.env.RUNTIME_NODE_MODULES), "__paper_club_ppt_runtime__.cjs")));
  }
  for (const resolver of resolvers) {
    try {
      const loaded = resolver("sharp");
      return loaded.default ?? loaded;
    } catch {
      // SVG remains the primary artifact when the optional PNG renderer is absent.
    }
  }
  return null;
}

export async function renderMathJaxSvg(expression, options = {}) {
  const normalized = validateMathExpression(expression);
  if (/[^\x00-\x7F]/.test(normalized)) {
    throw new Error("Bundled MathJax only accepts ASCII TeX source so that every visible glyph remains a self-contained SVG path. Use XeLaTeX or a source-PDF crop for Unicode/CJK text.");
  }
  const color = String(options.color ?? "17213A").replace(/^#/, "").toUpperCase();
  const svgFontSize = Number(options.svgFontSize ?? 32);
  if (!/^[0-9A-F]{6}$/.test(color)) throw new Error("MathJax SVG color must be a six-digit hex value.");
  if (!Number.isFinite(svgFontSize) || svgFontSize < 12 || svgFontSize > 96) throw new Error("MathJax SVG font size must be between 12 and 96 px.");
  const mathjax = await loadBundledMathJax();
  const mathml = mathjax.tex2mml(normalized, { display: true });
  if (/<merror\b|data-mjx-error=|<mtext\b[^>]*mathcolor="red"[^>]*>\s*\\/i.test(mathml)) {
    throw new Error("Bundled MathJax does not support one or more commands in this expression. Use local LaTeX or a faithful source-PDF crop.");
  }
  const node = mathjax.tex2svg(normalized, { display: true });
  const serialized = mathjax.startup.adaptor.outerHTML(node);
  return makePortableSvg(serialized, normalized, color, svgFontSize);
}

async function renderWithMathJax(args, expression, fallbackFrom = null) {
  const outDir = path.resolve(args.outputDir);
  await mkdir(outDir, { recursive: true });
  const finalTex = path.join(outDir, `${args.name}.tex`);
  const finalSvg = path.join(outDir, `${args.name}.svg`);
  const finalPng = path.join(outDir, `${args.name}.png`);
  const svg = await renderMathJaxSvg(expression, { color: args.color, svgFontSize: args.svgFontSize });
  await writeFile(finalTex, texDocument(expression, args.color), "utf8");
  await writeFile(finalSvg, svg, "utf8");

  const sharp = await optionalSharp();
  let pngWritten = false;
  if (sharp) {
    await sharp(Buffer.from(svg), { density: args.dpi }).png().toFile(finalPng);
    pngWritten = true;
  }
  return {
    ok: true,
    renderer: "bundled-mathjax-svg",
    mathJaxVersion: BUNDLED_MATHJAX_VERSION,
    svgBackend: "mathjax-svg-paths",
    expression,
    fallbackFrom,
    outputs: { tex: finalTex, svg: finalSvg, png: pngWritten ? finalPng : null },
    recommendedAssetRef: finalSvg,
    compatibilityAssetRef: pngWritten ? finalPng : null,
    warnings: pngWritten ? [] : ["Optional sharp runtime was unavailable, so only the primary SVG was generated."],
  };
}

async function renderWithLatex(args, expression, engines) {
  const outDir = path.resolve(args.outputDir);
  await mkdir(outDir, { recursive: true });
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "academic-formula-"));
  const tempTex = path.join(tempDir, `${args.name}.tex`);
  const finalTex = path.join(outDir, `${args.name}.tex`);
  const finalSvg = path.join(outDir, `${args.name}.svg`);
  const finalPng = path.join(outDir, `${args.name}.png`);
  try {
    await writeFile(tempTex, texDocument(expression, args.color), "utf8");
    await copyFile(tempTex, finalTex);
    let engineUsed = null;
    let compileResult = null;
    for (const engine of engines) {
      compileResult = await run(engine, latexCompilerArgs(tempDir, tempTex), { cwd: tempDir });
      if (compileResult.ok) {
        engineUsed = engine;
        break;
      }
    }
    if (!engineUsed) throw new Error(`LaTeX compilation failed after ${engines.length} engine attempt(s).\n${compileResult?.stderr || compileResult?.stdout || ""}`);
    const sourcePdf = path.join(tempDir, `${args.name}.pdf`);
    await access(sourcePdf);
    const croppedPdf = path.join(tempDir, `${args.name}.crop.pdf`);
    let pdfForOutput = sourcePdf;
    if (await available("pdfcrop")) {
      const crop = await run("pdfcrop", ["--margins", "2", sourcePdf, croppedPdf], { cwd: tempDir });
      if (crop.ok) pdfForOutput = croppedPdf;
    }

    let svgBackend = null;
    if (await available("dvisvgm")) {
      const svg = await run("dvisvgm", ["--pdf", "--no-fonts", "--bbox=min", `--output=${finalSvg}`, pdfForOutput], { cwd: tempDir });
      if (svg.ok) svgBackend = "dvisvgm-paths";
    }
    if (!svgBackend && await available("pdftocairo")) {
      const svg = await run("pdftocairo", ["-svg", pdfForOutput, finalSvg], { cwd: tempDir });
      if (svg.ok) svgBackend = "pdftocairo-svg";
    }
    if (!svgBackend) throw new Error("LaTeX compiled, but no working dvisvgm or pdftocairo SVG backend is available.");

    let pngWritten = false;
    if (await available("pdftocairo")) {
      const pngBase = path.join(outDir, args.name);
      const png = await run("pdftocairo", ["-png", "-singlefile", "-transp", "-r", String(args.dpi), pdfForOutput, pngBase], { cwd: tempDir });
      pngWritten = png.ok;
    }
    if (!pngWritten) throw new Error("SVG was generated, but transparent PNG generation failed; install or expose pdftocairo before delivery.");

    return {
      ok: true,
      renderer: "local-latex",
      engine: engineUsed,
      svgBackend,
      expression,
      outputs: { tex: finalTex, svg: finalSvg, png: finalPng },
      recommendedAssetRef: finalSvg,
      compatibilityAssetRef: finalPng,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function renderFormula(args) {
  const normalizedArgs = {
    renderer: "auto",
    engine: "auto",
    color: "17213A",
    dpi: 600,
    svgFontSize: 32,
    ...args,
  };
  const raw = normalizedArgs.input ? await readFile(path.resolve(normalizedArgs.input), "utf8") : normalizedArgs.latex;
  const expression = validateMathExpression(raw);
  if (normalizedArgs.renderer === "mathjax") return renderWithMathJax(normalizedArgs, expression);

  const engines = await chooseEngines(normalizedArgs.engine, expression);
  if (engines.length) {
    try {
      return await renderWithLatex(normalizedArgs, expression, engines);
    } catch (error) {
      if (normalizedArgs.renderer === "latex") throw error;
      return renderWithMathJax(normalizedArgs, expression, `local LaTeX failed: ${error.message.split("\n")[0]}`);
    }
  }
  if (normalizedArgs.renderer === "latex") throw new Error("No local pdflatex/xelatex compiler is available.");
  return renderWithMathJax(normalizedArgs, expression, "no local pdflatex/xelatex compiler was available");
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(usage());
      return;
    }
    if (args.validateOnly) {
      const raw = args.input ? await readFile(path.resolve(args.input), "utf8") : args.latex;
      console.log(JSON.stringify({ ok: true, expression: validateMathExpression(raw) }, null, 2));
      return;
    }
    console.log(JSON.stringify(await renderFormula(args), null, 2));
  } catch (error) {
    console.error(`FORMULA RENDER FAILED: ${error.message}`);
    process.exitCode = 1;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) await main();

export { parseArgs, renderFormula };
