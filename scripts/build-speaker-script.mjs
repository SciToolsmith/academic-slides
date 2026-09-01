#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { normalizeSpeakerNotes } from "./speaker-notes.mjs";
import { validateDeckSpecFile } from "./validate-deck-spec.mjs";

function usage() {
  return [
    "Usage: node build-speaker-script.mjs --spec <deck-spec.json> --output <发言稿.docx>",
    "",
    "Creates the customer-facing Word script from the same speaker_notes used by the PPTX.",
  ].join("\n");
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "-h" || token === "--help") result.help = true;
    else if (["--spec", "--output"].includes(token)) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${token} requires a value.`);
      result[token.slice(2)] = value;
    } else throw new Error(`Unknown option: ${token}`);
  }
  return result;
}

async function loadDocx() {
  const attempts = [
    () => import("docx"),
    ...[
      process.env.RUNTIME_NODE_MODULES,
      path.resolve(path.dirname(process.execPath), "..", "node_modules"),
    ].filter(Boolean).map((modulesDir) => () => import(pathToFileURL(path.join(modulesDir, "docx", "dist", "index.mjs")).href)),
  ];
  const errors = [];
  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch (error) {
      errors.push(error?.message ?? String(error));
    }
  }
  throw new Error(`Cannot load docx. Run with the bundled workspace Node runtime or set RUNTIME_NODE_MODULES. ${errors.join(" | ")}`);
}

function text(value, fallback = "") {
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  return fallback;
}

function resolveDocumentFonts() {
  const explicit = text(process.env.PAPER_CLUB_PPT_CJK_FONT);
  let cjk = explicit;
  if (!cjk && process.platform === "win32") cjk = "Microsoft YaHei";
  if (!cjk && process.platform === "darwin") cjk = "Hiragino Sans GB";
  if (!cjk) cjk = "Noto Sans CJK SC";
  return {
    cjk,
    // Some DOCX renderers classify CJK runs as hAnsi unless every script slot
    // resolves to the same family. A single CJK-capable family avoids tofu while
    // Word can still substitute it on systems where that exact font is absent.
    body: { ascii: cjk, hAnsi: cjk, eastAsia: cjk, cs: cjk, hint: "eastAsia" },
  };
}

function scriptDocumentTitle(spec, outputPath) {
  const outputStem = path.basename(outputPath, path.extname(outputPath)).replace(/_发言稿$/u, "");
  if (outputStem && outputStem !== "发言稿") return `${outputStem.replace(/_+/g, " ")}发言稿`;
  return `${text(spec.title, "文献组会")} 组会汇报发言稿`;
}

function compactSpeakerText(notes) {
  const script = text(notes.script);
  const transition = text(notes.transition);
  if (!transition || script.includes(transition)) return script;
  return [script, transition].filter(Boolean).join(" ");
}

export async function buildSpeakerScriptFromSpec(spec, outputPath) {
  if (!spec || typeof spec !== "object" || !Array.isArray(spec.slides) || !spec.slides.length) {
    throw new Error("Deck spec needs a non-empty slides array.");
  }
  const docx = await loadDocx();
  const {
    AlignmentType,
    Document,
    Packer,
    Paragraph,
    TextRun,
  } = docx;
  const fonts = resolveDocumentFonts();
  const children = [];
  const documentTitle = scriptDocumentTitle(spec, outputPath);
  children.push(new Paragraph({
    style: "scriptTitle",
    children: [new TextRun({ text: documentTitle })],
  }));

  const slides = [...spec.slides].sort((left, right) => Number(left?.order ?? 0) - Number(right?.order ?? 0));
  for (const [index, slide] of slides.entries()) {
    const page = index + 1;
    const notes = normalizeSpeakerNotes(slide);
    children.push(new Paragraph({
      style: "speakerBody",
      children: [
        new TextRun({ text: `第${page}页：`, bold: true }),
        new TextRun({ text: compactSpeakerText(notes) }),
      ],
    }));
  }

  const document = new Document({
    creator: "Paper Club PPT",
    lastModifiedBy: "Paper Club PPT",
    title: documentTitle,
    description: "与演示文稿逐页讲稿同源生成的紧凑发言稿。",
    styles: {
      default: {
        document: {
          run: { font: fonts.body, size: 20, color: "17213A" },
          paragraph: { spacing: { after: 200, line: 252, lineRule: "auto" } },
        },
      },
      paragraphStyles: [
        {
          id: "scriptTitle", name: "Script Title", basedOn: "Normal", next: "Normal", quickFormat: true,
          run: { font: fonts.body, size: 32, bold: true, color: "17213A" },
          paragraph: { spacing: { before: 0, after: 240, line: 240, lineRule: "auto" }, alignment: AlignmentType.CENTER },
        },
        {
          id: "speakerBody", name: "Speaker Body", basedOn: "Normal", next: "speakerBody", quickFormat: true,
          run: { font: fonts.body, size: 20, color: "17213A" },
          paragraph: { spacing: { before: 0, after: 200, line: 252, lineRule: "auto" } },
        },
      ],
    },
    sections: [{
      properties: {
        page: {
          size: { width: 11906, height: 16838 },
          margin: { top: 850, right: 850, bottom: 850, left: 850 },
        },
      },
      children,
    }],
  });
  const absolute = path.resolve(outputPath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, await Packer.toBuffer(document));
  const info = await fs.stat(absolute);
  return { output: absolute, bytes: info.size, slideCount: slides.length };
}

export async function buildSpeakerScriptFromFile(specPath, outputPath) {
  const validation = await validateDeckSpecFile(specPath, { strict: true, requireSchema: true });
  const errors = validation.issues.filter((item) => item.severity === "error");
  if (errors.length) throw new Error(`deck-spec validation failed before Word generation (${errors.length} issue(s)).`);
  const spec = JSON.parse(await fs.readFile(path.resolve(specPath), "utf8"));
  return buildSpeakerScriptFromSpec(spec, outputPath);
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
  if (!args.spec || !args.output) {
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  try {
    console.log(JSON.stringify(await buildSpeakerScriptFromFile(args.spec, args.output), null, 2));
  } catch (error) {
    console.error(`WORD BUILD FAILED: ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}

const direct = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (direct) await main();

export { parseArgs };
