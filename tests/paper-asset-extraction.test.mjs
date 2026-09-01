#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { detectCaptions, extractPaperAssets } from "../scripts/extract-paper-assets.mjs";

function pdfEscape(value) {
  return String(value).replace(/([\\()])/g, "\\$1");
}

function text(x, y, size, value) {
  return `BT /F1 ${size} Tf ${x} ${y} Td (${pdfEscape(value)}) Tj ET`;
}

function buildSyntheticPdf() {
  const firstPage = [
    text(54, 752, 15, "Synthetic research paper"),
    "0.92 g 70 500 472 170 re f 0 G 1.5 w 70 500 472 170 re S",
    text(245, 580, 13, "METHOD BODY"),
    text(72, 470, 12, "Figure 1: Method overview"),
    text(72, 430, 12, "Table 1: Summary metrics"),
    "0.85 G 1 w 72 330 m 540 330 l S 72 300 m 540 300 l S 72 270 m 540 270 l S",
    text(88, 310, 11, "Metric A        Metric B        Metric C"),
    text(88, 280, 11, "0.82            0.91            0.76"),
  ].join("\n");
  const secondPage = [
    text(72, 754, 12, "Figure 2: Edge case"),
    "0.90 g 70 430 472 250 re f 0 G 1.5 w 70 430 472 250 re S",
    text(250, 550, 13, "EDGE BODY"),
    text(72, 80, 10, "Footer text"),
  ].join("\n");
  const objects = new Map([
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [2, "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>"],
    [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>"],
    [4, `<< /Length ${Buffer.byteLength(firstPage, "latin1")} >>\nstream\n${firstPage}\nendstream`],
    [5, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>"],
    [6, `<< /Length ${Buffer.byteLength(secondPage, "latin1")} >>\nstream\n${secondPage}\nendstream`],
    [7, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"],
  ]);
  const chunks = [Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "latin1")];
  const offsets = [0];
  let offset = chunks[0].length;
  for (let id = 1; id <= objects.size; id += 1) {
    offsets[id] = offset;
    const chunk = Buffer.from(`${id} 0 obj\n${objects.get(id)}\nendobj\n`, "latin1");
    chunks.push(chunk);
    offset += chunk.length;
  }
  const xrefOffset = offset;
  const xref = ["xref", `0 ${objects.size + 1}`, "0000000000 65535 f "];
  for (let id = 1; id <= objects.size; id += 1) xref.push(`${String(offsets[id]).padStart(10, "0")} 00000 n `);
  xref.push("trailer", `<< /Size ${objects.size + 1} /Root 1 0 R >>`, "startxref", String(xrefOffset), "%%EOF", "");
  chunks.push(Buffer.from(xref.join("\n"), "latin1"));
  return Buffer.concat(chunks);
}

function cropExcludesCaption(asset) {
  const crop = asset.crop.bbox;
  const caption = asset.source.caption_bbox;
  if (!crop) return false;
  const cropBottom = crop.y + crop.height;
  const captionBottom = caption.y + caption.height;
  return cropBottom <= caption.y || crop.y >= captionBottom;
}

const captionFixture = [{
  number: 1,
  width: 612,
  height: 792,
  lines: [
    { blockIndex: 0, blockLineCount: 1, text: "Fig. 4. Autocorrelation spectrum", xMin: 40, yMin: 100, xMax: 210, yMax: 110 },
    { blockIndex: 1, blockLineCount: 12, text: "Fig. 4 shows the schematic diagram", xMin: 40, yMin: 200, xMax: 240, yMax: 210 },
    { blockIndex: 2, blockLineCount: 2, text: "TABLE II", xMin: 130, yMin: 300, xMax: 180, yMax: 310 },
    { blockIndex: 2, blockLineCount: 2, text: "FAULT CHARACTER FREQUENCY", xMin: 80, yMin: 312, xMax: 250, yMax: 322 },
    { blockIndex: 3, blockLineCount: 1, text: "Fig. 21.", xMin: 40, yMin: 400, xMax: 75, yMax: 410 },
    { blockIndex: 4, blockLineCount: 1, text: "Measured vibration signal.", xMin: 82, yMin: 400, xMax: 220, yMax: 410 },
  ],
}];
const captionDetections = detectCaptions(captionFixture);
assert.deepEqual(captionDetections.map((item) => item.label), ["Figure 4", "Table II", "Figure 21"]);
assert.equal(captionDetections[0].title, "Autocorrelation spectrum", "prose references must not duplicate a numbered caption");
assert.equal(captionDetections[1].title, "FAULT CHARACTER FREQUENCY", "Roman-numbered table headings must retain the title line");
assert.equal(captionDetections[2].title, "Measured vibration signal.", "a split same-line caption title must be joined across text blocks");

const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "paper-club-ppt-paper-assets-test-"));
try {
  const pdfPath = path.join(fixtureDir, "synthetic-paper.pdf");
  await writeFile(pdfPath, buildSyntheticPdf());

  const allResult = await extractPaperAssets({
    pdfPath,
    outputDir: path.join(fixtureDir, "all"),
    materialize: "auto",
    autoLimit: 40,
    dpi: 120,
    generatedAt: "2026-01-01T00:00:00.000Z",
  });
  const { manifest } = allResult;
  assert.equal(manifest.summary.detected_count, 3);
  assert.equal(manifest.summary.figure_count, 2);
  assert.equal(manifest.summary.table_count, 1);
  assert.equal(manifest.summary.materialized_count, 3);
  assert.equal(manifest.summary.failed_count, 0);
  assert.equal(manifest.policy.effective_materialization, "all");
  assert.deepEqual(manifest.assets.map((asset) => asset.id), ["figure-1", "table-1", "figure-2"]);
  assert.deepEqual(manifest.assets.map((asset) => path.basename(asset.crop.file)), [
    "Figure_1_Method_overview.png",
    "Table_1_Summary_metrics.png",
    "Figure_2_Edge_case.png",
  ]);

  for (const asset of manifest.assets) {
    assert.equal(asset.crop.caption_excluded, true, `${asset.id} should declare caption-free geometry`);
    assert.equal(cropExcludesCaption(asset), true, `${asset.id} crop geometry must not overlap its caption`);
    const outputPath = path.join(path.dirname(allResult.manifestPath), asset.crop.file);
    const data = await readFile(outputPath);
    assert.deepEqual([...data.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.ok((await stat(outputPath)).size > 100, `${asset.id} crop should be a non-empty PNG`);
  }

  const edge = manifest.assets.find((asset) => asset.id === "figure-2");
  assert.equal(edge.crop.degraded_once, true, "A caption too near the page top should reverse direction exactly once.");
  assert.equal(edge.crop.confidence, "low");
  assert.equal(manifest.summary.degraded_once_count, 1);
  assert.equal(manifest.summary.low_confidence_count, 1);
  const guide = await readFile(allResult.markdownPath, "utf8");
  assert.match(guide, /## Figure 1 — Method overview/);
  assert.match(guide, /简介：Method overview/);

  const selectedResult = await extractPaperAssets({
    pdfPath,
    outputDir: path.join(fixtureDir, "selected"),
    materialize: "auto",
    autoLimit: 2,
    selectedIds: ["figure-1"],
    dpi: 120,
    generatedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(selectedResult.manifest.policy.effective_materialization, "selected");
  assert.equal(selectedResult.manifest.summary.materialized_count, 1);
  assert.equal(selectedResult.manifest.summary.indexed_only_count, 2);
  assert.equal(selectedResult.manifest.assets.find((asset) => asset.id === "table-1").crop.status, "indexed_only");
  assert.equal(selectedResult.manifest.policy.table_extraction, "faithful_crop_only");
} finally {
  await rm(fixtureDir, { recursive: true, force: true });
}

console.log("PASS paper-asset-extraction: captions are fully indexed, stable caption-free crops are materialized under budget, and low-confidence geometry degrades once without OCR loops.");
