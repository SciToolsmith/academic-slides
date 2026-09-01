#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { bundledMathJaxCheck } from "../scripts/preflight.mjs";
import { renderMathJaxSvg } from "../scripts/render-formula.mjs";

const execFileAsync = promisify(execFile);
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(TEST_DIR, "..");

const formulas = [
  String.raw`\mathcal{L}(\theta)=\frac{1}{N}\sum_{i=1}^{N}\lVert f_\theta(x_i)-y_i\rVert_2^2+\lambda\lVert\theta\rVert_1`,
  String.raw`\begin{aligned}\hat{y}_i &= f_\theta(x_i) \\ \mathcal{L} &= \frac{1}{N}\sum_{i=1}^{N}(\hat{y}_i-y_i)^2\end{aligned}`,
  String.raw`f(x)=\begin{cases}x^2,&x\ge 0\\-x,&x<0\end{cases}`,
  String.raw`\mathbb{E}_{(x,y)\sim p_{\mathrm{data}}}\!\left[\log p_\theta(y\mid x)\right]`,
];

for (const formula of formulas) {
  const svg = await renderMathJaxSvg(formula, { color: "2255AA", svgFontSize: 32 });
  assert.match(svg, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(svg, /<svg\b[^>]*\bwidth="[0-9.]+px"[^>]*\bheight="[0-9.]+px"/);
  assert.match(svg, /\bviewBox="[^"]+"/);
  assert.match(svg, /<path\b/);
  assert.match(svg, /#2255AA/);
  assert.doesNotMatch(svg, /currentColor|<text\b|data-mml-node="merror"|data-mjx-error=|\b(?:href|xlink:href)="https?:|url\(\s*https?:/i);
}

const deterministicFormula = String.raw`\frac{a+b}{c+d}`;
assert.equal(
  await renderMathJaxSvg(deterministicFormula),
  await renderMathJaxSvg(deterministicFormula),
  "Bundled MathJax SVG output must be deterministic within one process",
);

await assert.rejects(
  () => renderMathJaxSvg(String.raw`\bm{x}`),
  /does not support one or more commands/,
  "Commands accepted by the shared safety gate but unsupported by MathJax must fail visibly",
);
await assert.rejects(
  () => renderMathJaxSvg(String.raw`\text{中文}+x`),
  /ASCII TeX source/,
  "Unicode text must not silently introduce system-font-dependent SVG text",
);
await assert.rejects(
  () => renderMathJaxSvg(String.raw`\input{/etc/passwd}`),
  /Unsafe LaTeX expression/,
);

const integrity = await bundledMathJaxCheck(SKILL_DIR);
assert.equal(integrity.available, true, `Bundled MathJax integrity failed: ${JSON.stringify(integrity)}`);
assert.deepEqual(integrity.missing, []);
assert.deepEqual(integrity.mismatched, []);

const cliDir = await mkdtemp(path.join(os.tmpdir(), "paper-club-ppt-mathjax-cli-"));
try {
  const { stdout } = await execFileAsync(process.execPath, [
    path.join(SKILL_DIR, "scripts", "render-formula.mjs"),
    "--renderer", "mathjax",
    "--latex", String.raw`E=mc^2`,
    "--output-dir", cliDir,
    "--name", "cli-smoke",
  ], { encoding: "utf8", timeout: 30_000 });
  const report = JSON.parse(stdout);
  assert.equal(report.renderer, "bundled-mathjax-svg");
  await access(path.join(cliDir, "cli-smoke.tex"));
  const cliSvg = await readFile(path.join(cliDir, "cli-smoke.svg"), "utf8");
  assert.match(cliSvg, /<path\b/);
  assert.doesNotMatch(cliSvg, /<text\b/);
} finally {
  await rm(cliDir, { recursive: true, force: true });
}

console.log("PASS mathjax-formula-render: common academic formulas render as deterministic, self-contained path SVG and unsupported inputs fail closed.");
