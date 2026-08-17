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

function slideTitle(slide, page) {
  return text(
    slide?.content?.title,
    text(slide?.render_data?.title, text(slide?.title, text(slide?.takeaway, `第 ${page} 页`))),
  );
}

function resolveDocumentFonts() {
  const explicit = text(process.env.ACADEMIC_SLIDES_CJK_FONT);
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

function textParagraphs(docx, value, style = "speakerBody") {
  const { Paragraph, TextRun } = docx;
  const blocks = text(value).split(/\n\s*\n/).map((item) => item.trim()).filter(Boolean);
  return blocks.map((block) => {
    const lines = block.split(/\n/);
    const children = [];
    lines.forEach((line, index) => {
      if (index) children.push(new TextRun({ break: 1 }));
      children.push(new TextRun({ text: line }));
    });
    return new Paragraph({ style, children });
  });
}

export async function buildSpeakerScriptFromSpec(spec, outputPath) {
  if (!spec || typeof spec !== "object" || !Array.isArray(spec.slides) || !spec.slides.length) {
    throw new Error("Deck spec needs a non-empty slides array.");
  }
  const docx = await loadDocx();
  const {
    AlignmentType,
    Document,
    Footer,
    HeadingLevel,
    LevelFormat,
    Packer,
    PageNumber,
    Paragraph,
    TextRun,
  } = docx;
  const fonts = resolveDocumentFonts();
  const children = [];
  const deckTitle = text(spec.title, "学术汇报");
  children.push(new Paragraph({
    style: "scriptTitle",
    children: [new TextRun({ text: deckTitle }), new TextRun({ text: "发言稿", break: 1 })],
  }));
  children.push(new Paragraph({
    style: "scriptMeta",
    children: [new TextRun({ text: `共 ${spec.slides.length} 页｜PPT 备注与本稿由同一内容源生成` })],
  }));

  const slides = [...spec.slides].sort((left, right) => Number(left?.order ?? 0) - Number(right?.order ?? 0));
  for (const [index, slide] of slides.entries()) {
    const page = index + 1;
    const notes = normalizeSpeakerNotes(slide);
    children.push(new Paragraph({
      style: "slideHeading",
      heading: HeadingLevel.HEADING_1,
      keepNext: true,
      children: [new TextRun({ text: `P${String(page).padStart(2, "0")}｜${slideTitle(slide, page)}` })],
    }));
    children.push(...textParagraphs(docx, notes.script));
    if (notes.transition) children.push(new Paragraph({
      style: "transition",
      children: [new TextRun({ text: "过渡：", bold: true }), new TextRun({ text: notes.transition, italics: true })],
    }));
    children.push(new Paragraph({ children: [] }), new Paragraph({ children: [] }));
    children.push(new Paragraph({ style: "sourcesMarker", children: [new TextRun({ text: "[Sources]", bold: true })] }));
    for (const source of notes.sources) children.push(new Paragraph({
      style: "sourceItem",
      numbering: { reference: "sources", level: 0 },
      children: [new TextRun({ text: source })],
    }));
    children.push(new Paragraph({ style: "sourcesMarker", children: [new TextRun({ text: "[/Sources]", bold: true })] }));
  }

  const document = new Document({
    creator: "Academic Slides",
    lastModifiedBy: "Academic Slides",
    title: `${deckTitle} 发言稿`,
    description: "与演示文稿逐页备注同步生成的发言稿。",
    styles: {
      default: {
        document: {
          run: { font: fonts.body, size: 22, color: "17213A" },
          paragraph: { spacing: { after: 120, line: 280, lineRule: "auto" } },
        },
      },
      paragraphStyles: [
        {
          id: "scriptTitle", name: "Script Title", basedOn: "Normal", next: "Normal", quickFormat: true,
          run: { font: fonts.body, size: 40, bold: true, color: "25345B" },
          paragraph: { spacing: { before: 0, after: 100, line: 300, lineRule: "auto" }, alignment: AlignmentType.LEFT },
        },
        {
          id: "scriptMeta", name: "Script Meta", basedOn: "Normal", next: "Normal", quickFormat: true,
          run: { font: fonts.body, size: 19, color: "5D667A" },
          paragraph: { spacing: { before: 0, after: 280, line: 260, lineRule: "auto" } },
        },
        {
          id: "slideHeading", name: "Slide Heading", basedOn: "Normal", next: "speakerBody", quickFormat: true,
          run: { font: fonts.body, size: 30, bold: true, color: "364A7C" },
          paragraph: { spacing: { before: 260, after: 120, line: 280, lineRule: "auto" }, keepNext: true, outlineLevel: 0 },
        },
        {
          id: "speakerBody", name: "Speaker Body", basedOn: "Normal", next: "speakerBody", quickFormat: true,
          run: { font: fonts.body, size: 22, color: "17213A" },
          paragraph: { spacing: { before: 0, after: 120, line: 300, lineRule: "auto" } },
        },
        {
          id: "transition", name: "Transition", basedOn: "Normal", next: "Normal", quickFormat: true,
          run: { font: fonts.body, size: 20, color: "5D667A" },
          paragraph: { spacing: { before: 40, after: 100, line: 280, lineRule: "auto" } },
        },
        {
          id: "sourcesMarker", name: "Sources Marker", basedOn: "Normal", next: "sourceItem", quickFormat: true,
          run: { font: "Arial", size: 18, color: "5D667A" },
          paragraph: { spacing: { before: 0, after: 50, line: 240, lineRule: "auto" } },
        },
        {
          id: "sourceItem", name: "Source Item", basedOn: "Normal", next: "sourceItem", quickFormat: true,
          run: { font: fonts.body, size: 18, color: "5D667A" },
          paragraph: { spacing: { before: 0, after: 40, line: 240, lineRule: "auto" } },
        },
      ],
    },
    numbering: {
      config: [{
        reference: "sources",
        levels: [{
          level: 0,
          format: LevelFormat.BULLET,
          text: "•",
          alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 540, hanging: 270 }, spacing: { after: 40, line: 240, lineRule: "auto" } } },
        }],
      }],
    },
    sections: [{
      properties: {
        page: {
          size: { width: 12240, height: 15840 },
          margin: { top: 1080, right: 1260, bottom: 1080, left: 1260, header: 708, footer: 708 },
        },
      },
      footers: {
        default: new Footer({ children: [new Paragraph({
          alignment: AlignmentType.RIGHT,
          children: [
            new TextRun({ text: "第 ", font: fonts.body, color: "8A93A5", size: 18 }),
            new TextRun({ children: [PageNumber.CURRENT], font: fonts.body, color: "8A93A5", size: 18 }),
            new TextRun({ text: " 页", font: fonts.body, color: "8A93A5", size: 18 }),
          ],
        })] }),
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
