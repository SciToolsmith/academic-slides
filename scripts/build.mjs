#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildPresentationFromFile,
  exportPresentation,
  renderPresentation,
} from "./presentation-core.mjs";
import { validateDeckSpecFile } from "./validate-deck-spec.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

function usage() {
  return [
    "Usage: node build.mjs --spec <deck-spec.json> --output <deck.pptx> [options]",
    "",
    "Options:",
    "  --preview-dir <dir>     Render every slide PNG, layout JSON, and montage",
    "  --theme <name>          blue | red | purple | cyan",
    "  --primary-color <hex>   Override the primary color",
    "  --strict-assets         Fail on missing assets (default; retained for clarity)",
    "  --allow-placeholders    Permit empty visual placeholders for layout prototyping only",
    "  --report <file>         Write a machine-readable build report",
    "  -h, --help              Show this help",
  ].join("\n");
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "-h" || token === "--help") result.help = true;
    else if (token === "--strict-assets") result.strictAssets = true;
    else if (token === "--allow-placeholders") result.allowPlaceholders = true;
    else if (["--spec", "--output", "--preview-dir", "--theme", "--primary-color", "--report"].includes(token)) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${token} requires a value.`);
      result[token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    } else throw new Error(`Unknown option: ${token}`);
  }
  return result;
}

export async function buildDeck(args) {
  if (!args.spec) throw new Error("--spec is required.");
  if (!args.output) throw new Error("--output is required.");
  if (args.theme && args.primaryColor) throw new Error("Use either --theme or --primary-color, not both.");
  const validation = await validateDeckSpecFile(args.spec, { strict: true, requireSchema: true });
  const validationErrors = validation.issues.filter((item) => item.severity === "error");
  if (validationErrors.length) {
    const summary = validationErrors.slice(0, 12).map((item) => `${item.code} ${item.path}: ${item.message}`).join("\n");
    throw new Error(`deck-spec validation failed before build (${validationErrors.length} issue(s)):\n${summary}`);
  }
  const built = await buildPresentationFromFile(args.spec, {
    theme: args.theme,
    primaryColor: args.primaryColor,
    allowPlaceholder: args.allowPlaceholders === true ? true : false,
  });
  const exported = await exportPresentation(built.presentation, args.output);
  const preview = args.previewDir ? await renderPresentation(built.presentation, args.previewDir) : null;
  const report = {
    ok: true,
    profile: built.context.profile,
    templateId: built.template?.registry?.templateId ?? built.context.profile,
    templateDir: built.template?.templateDir ?? null,
    spec: built.specPath,
    output: exported.output,
    bytes: exported.bytes,
    slideCount: exported.slideCount,
    theme: built.context.colors.presetName,
    primary: built.context.colors.primary,
    previewDir: preview?.outDir ?? null,
    montage: preview?.montage ?? null,
    montagePng: preview?.montagePng ?? null,
    builtAt: new Date().toISOString(),
  };
  if (args.report) {
    const reportPath = path.resolve(args.report);
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    report.report = reportPath;
  }
  return report;
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
    console.log(JSON.stringify(await buildDeck(args), null, 2));
  } catch (error) {
    console.error(`BUILD FAILED: ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}

const direct = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (direct) await main();

export { parseArgs };
