#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { buildSpeakerScriptFromSpec } from "../scripts/build-speaker-script.mjs";
import {
  isWordQaRuntimeUnavailable,
  renderWordForQa,
  selectPythonRuntime,
} from "../scripts/render-word-qa.mjs";

const execFileAsync = promisify(execFile);
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(TEST_DIR, "..");
const SAMPLE_SPEC = path.join(SKILL_DIR, "assets", "group-meeting-literature-universal", "sample-deck-spec.json");

function decodeXml(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'");
}

function paragraphs(documentXml) {
  return [...documentXml.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)].map((match) => ({
    xml: match[0],
    text: decodeXml([...match[0].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((item) => item[1]).join("")),
  }));
}

async function archiveText(archive, entry) {
  return (await execFileAsync("unzip", ["-p", archive, entry], {
    encoding: "utf8",
    maxBuffer: 30 * 1024 * 1024,
  })).stdout;
}

async function main() {
  await assert.rejects(
    selectPythonRuntime([process.execPath], SAMPLE_SPEC),
    (error) => isWordQaRuntimeUnavailable(error)
      && /pdf2image and Pillow/.test(error.message)
      && error.diagnostics.length === 1,
    "an executable that cannot load render_docx.py dependencies must be rejected with a stable unavailable-runtime error",
  );

  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "paper-club-ppt-word-render-"));
  try {
    const spec = JSON.parse(await fs.readFile(SAMPLE_SPEC, "utf8"));
    spec.slides = spec.slides.slice(0, 27).map((slide, index) => ({ ...slide, order: index + 1 }));
    const output = path.join(temporary, "示例研究_组会汇报_发言稿.docx");
    await buildSpeakerScriptFromSpec(spec, output);

    const documentXml = await archiveText(output, "word/document.xml");
    const docParagraphs = paragraphs(documentXml);
    assert.equal(docParagraphs.length, 28);
    assert.equal(docParagraphs[0].text, "示例研究 组会汇报发言稿");
    assert.equal(docParagraphs.slice(1).filter((item) => /^第\d+页：/.test(item.text)).length, 27);
    assert.doesNotMatch(documentXml, /\[\/?Sources\]|过渡：|PPT 备注/);
    assert.ok((documentXml.match(/[\u3400-\u9FFF]/g) ?? []).length > 500, "DOCX should retain substantial editable CJK text");

    let rendered;
    try {
      rendered = await renderWordForQa({ input: output, outputDir: path.join(temporary, "render") });
    } catch (error) {
      if (isWordQaRuntimeUnavailable(error)
        || /Cannot locate Documents Skill render_docx\.py|spawn soffice ENOENT/.test(error.message)) {
        console.log(`word-render-qa.test.mjs: STRUCTURE PASS; VISUAL SKIP (${error.message})`);
        return;
      }
      throw error;
    }
    assert.equal(rendered.cjkStatus, "visible", rendered.warnings.join(" "));
    assert.ok(rendered.renderedCjkFonts.length > 0);
    assert.ok(rendered.pageCount >= 1 && rendered.pageCount <= 3, `27-slide group-meeting sample should remain within the three-page soft target; rendered ${rendered.pageCount}`);
    for (const page of rendered.pages) assert.ok((await fs.stat(page)).size > 100_000, `${path.basename(page)} should contain substantive visible text`);
    if (process.platform === "darwin") {
      assert.ok(rendered.nativePreview, "Darwin QA should also produce a native QuickLook thumbnail");
      assert.ok((await fs.stat(rendered.nativePreview)).size > 100_000);
    }

    console.log(`word-render-qa.test.mjs: PASS (${rendered.pageCount} pages; ${rendered.renderedCjkFonts.join(", ")})`);
  } finally {
    if (process.env.KEEP_WORD_QA_TMP === "1") console.log(`word-qa-temp: ${temporary}`);
    else await fs.rm(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
