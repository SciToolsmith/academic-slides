#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

function usage() {
  return [
    "Usage: node build-figure-guide.mjs <figures.manifest.json> [output.md] [options]",
    "",
    "Options:",
    "  --force   Replace an existing Markdown guide",
    "  --check   Exit non-zero when the existing guide is missing or stale",
    "  --stdout  Print Markdown instead of writing a file",
    "  -h, --help",
  ].join("\n");
}

function parseArgs(argv) {
  const result = { force: false, check: false, stdout: false, positional: [] };
  for (const arg of argv) {
    if (arg === "--force") result.force = true;
    else if (arg === "--check") result.check = true;
    else if (arg === "--stdout") result.stdout = true;
    else if (arg === "-h" || arg === "--help") result.help = true;
    else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else result.positional.push(arg);
  }
  if (result.positional.length > 2) throw new Error("Provide a manifest and optional output path.");
  return result;
}

function naturalFigureKey(value) {
  return String(value ?? "").split(/(\d+)/).map((part) => /^\d+$/.test(part) ? Number(part) : part);
}

function compareFigure(left, right) {
  const a = naturalFigureKey(left.figure_number);
  const b = naturalFigureKey(right.figure_number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if (a[index] === b[index]) continue;
    if (a[index] == null) return -1;
    if (b[index] == null) return 1;
    return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

function clean(value) {
  return String(value ?? "").trim();
}

function imageTarget(filePath, outputPath) {
  if (!filePath) return null;
  const absolute = path.resolve(filePath);
  const relative = path.relative(path.dirname(outputPath), absolute);
  return relative.startsWith("..") ? absolute : relative;
}

function renderGuide(manifest, outputPath) {
  const figures = [...(manifest.figures ?? [])].sort(compareFigure);
  const lines = [
    "# 论文图片说明",
    "",
    `- 项目：${clean(manifest.project_id)}`,
    `- 来源文档：${clean(manifest.source_document_id)}`,
    `- 图片记录：${figures.length}`,
    `- 提取核对：${clean(manifest.extraction_summary?.status)}`,
    "",
    "> 本文档由 `figures.manifest.json` 生成。图片全部提取不等于全部上 PPT；应按结论与证据需要选择。",
    "",
  ];
  for (const figure of figures) {
    const original = figure.file?.original;
    const target = imageTarget(original?.path, outputPath);
    lines.push(`## 图${clean(figure.figure_number)} ${clean(figure.title)}`, "");
    if (target) lines.push(`![图${clean(figure.figure_number)} ${clean(figure.title)}](<${target}>)`, "");
    lines.push(
      `- 论文章节：${clean(figure.chapter) || "未记录"}${figure.section ? `｜${clean(figure.section)}` : ""}`,
      `- 位置：PDF 第 ${figure.source?.pdf_page ?? "?"} 页｜论文页 ${figure.source?.printed_page ?? "?"}`,
      `- 图片内容：${clean(figure.description)}`,
      `- 论文作用：${clean(figure.role_in_thesis)}`,
    );
    const claims = (figure.supported_claims ?? []).map((item) => clean(item.claim)).filter(Boolean);
    lines.push(`- 可支撑结论：${claims.length ? claims.join("；") : "仅作背景或待核验"}`);
    lines.push(`- PPT 价值：${clean(figure.ppt_use?.priority)}｜${clean(figure.ppt_use?.rationale)}`);
    lines.push(`- 建议版式：${clean(figure.ppt_use?.suggested_layout) || "按内容决定"}`);
    lines.push(`- 使用提醒：${clean(figure.ppt_use?.presentation_notes) || "保持原图比例与证据边界"}`);
    const issues = (figure.quality?.issues ?? []).map(clean).filter(Boolean);
    lines.push(`- 质量：${clean(figure.quality?.clarity)}｜${clean(figure.quality?.resolution_status)}${issues.length ? `｜${issues.join("；")}` : ""}`);
    lines.push(`- 文件：${clean(original?.path)}`, "");
  }
  return `${lines.join("\n").trim()}\n`;
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
  const [manifestArg, outputArg] = args.positional;
  if (!manifestArg) {
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  const manifestPath = path.resolve(manifestArg);
  const outputPath = path.resolve(outputArg ?? path.join(path.dirname(manifestPath), "论文图片说明.md"));
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const markdown = renderGuide(manifest, outputPath);
  if (args.stdout) {
    process.stdout.write(markdown);
    return;
  }
  let existing = null;
  try {
    existing = await fs.readFile(outputPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (args.check) {
    if (existing !== markdown) {
      console.error(`STALE: ${outputPath}`);
      process.exitCode = 1;
    } else console.log(`CURRENT: ${outputPath}`);
    return;
  }
  if (existing != null && !args.force) throw new Error(`Output exists: ${outputPath}. Use --force to replace it.`);
  await fs.writeFile(outputPath, markdown, "utf8");
  console.log(`WROTE: ${outputPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();

export { renderGuide };
