#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_MAX_TEXT_CHARS = 240;
const DIRECT_ASSET_KEYS = new Set([
  "path", "file", "src", "uri", "asset", "image", "left_image", "right_image",
  "logo_path", "logoPath", "asset_path", "assetPath", "verified_logo_asset_id",
  "logo_asset_id", "logoAssetId",
]);
const PRIMARY_ASSET_KEYS = new Set(["asset_ref", "assetRef"]);
const FALLBACK_ASSET_KEYS = new Set(["fallback_asset_ref", "fallbackAssetRef"]);
const ASSET_LIST_KEYS = new Set(["asset_refs", "assetRefs", "image_refs", "imageRefs", "images", "media"]);
const SKIPPED_ASSET_BRANCHES = new Set(["speaker_notes", "speakerNotes", "sources", "evidence_refs", "evidenceRefs"]);

function usage() {
  return [
    "Usage: node build-deck-map.mjs --spec <deck-spec.json> [options]",
    "",
    "Options:",
    "  --output <deck-map.json>  Write the map to this exact path",
    "  --force                   Replace that exact output path if it exists",
    "  --compact                 Serialize without indentation",
    `  --max-text-chars <n>      Maximum retained purpose/takeaway text (default: ${DEFAULT_MAX_TEXT_CHARS})`,
    "  -h, --help                Show this help",
    "",
    "Without --output the deck map is printed to stdout and no file is changed.",
  ].join("\n");
}

function parseArgs(argv) {
  const result = { force: false, compact: false, maxTextChars: DEFAULT_MAX_TEXT_CHARS };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--force") result.force = true;
    else if (token === "--compact") result.compact = true;
    else if (token === "-h" || token === "--help") result.help = true;
    else if (["--spec", "--output", "--max-text-chars"].includes(token)) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${token} requires a value.`);
      if (token === "--max-text-chars") result.maxTextChars = positiveInteger(value, token);
      else result[token.slice(2)] = value;
    } else throw new Error(`Unknown option: ${token}`);
  }
  return result;
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 40) throw new Error(`${label} must be an integer of at least 40.`);
  return parsed;
}

function cleanString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function compactText(value, maximum = DEFAULT_MAX_TEXT_CHARS) {
  const cleaned = cleanString(value)?.replace(/\s+/g, " ") ?? null;
  if (!cleaned || cleaned.length <= maximum) return cleaned;
  return `${cleaned.slice(0, Math.max(1, maximum - 1)).trimEnd()}…`;
}

function stringValues(value) {
  if (typeof value === "string") return cleanString(value) ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") return cleanString(item) ? [item.trim()] : [];
    if (!item || typeof item !== "object") return [];
    for (const key of ["asset_ref", "assetRef", "path", "file", "src", "uri", "id_ref", "ref"]) {
      if (cleanString(item[key])) return [item[key].trim()];
    }
    return [];
  });
}

function jsonPointer(parent, key) {
  const escaped = String(key).replaceAll("~", "~0").replaceAll("/", "~1");
  return `${parent}/${escaped}`;
}

/**
 * Collect renderer-facing asset references without treating evidence metadata as
 * render dependencies. Primary/fallback references in the same object share a
 * group so an available fallback can satisfy a missing primary during audit.
 */
export function collectSelectedAssetOccurrences(deck) {
  const occurrences = [];
  const visit = (value, pointer = "$") => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, jsonPointer(pointer, index)));
      return;
    }
    if (value.include === false) return;

    const primary = [];
    const fallback = [];
    for (const [key, item] of Object.entries(value)) {
      if (PRIMARY_ASSET_KEYS.has(key)) primary.push(...stringValues(item).map((ref) => ({ ref, key })));
      else if (FALLBACK_ASSET_KEYS.has(key)) fallback.push(...stringValues(item).map((ref) => ({ ref, key })));
    }
    const group = `${pointer}#asset-group`;
    for (const item of primary) occurrences.push({
      ref: item.ref,
      role: "primary",
      pointer: jsonPointer(pointer, item.key),
      group,
      fallback_refs: [...new Set(fallback.map((entry) => entry.ref))],
    });
    for (const item of fallback) occurrences.push({
      ref: item.ref,
      role: "fallback",
      pointer: jsonPointer(pointer, item.key),
      group,
      fallback_refs: [],
    });

    for (const [key, item] of Object.entries(value)) {
      if (SKIPPED_ASSET_BRANCHES.has(key) || PRIMARY_ASSET_KEYS.has(key) || FALLBACK_ASSET_KEYS.has(key)) continue;
      if (DIRECT_ASSET_KEYS.has(key)) {
        for (const ref of stringValues(item)) occurrences.push({
          ref,
          role: "primary",
          pointer: jsonPointer(pointer, key),
          group: `${jsonPointer(pointer, key)}#asset-group`,
          fallback_refs: [],
        });
        continue;
      }
      if (ASSET_LIST_KEYS.has(key)) {
        const entries = Array.isArray(item) ? item : [item];
        for (const [index, entry] of entries.entries()) {
          const entryPointer = `${jsonPointer(pointer, key)}/${index}`;
          if (typeof entry === "string") {
            for (const ref of stringValues(entry)) occurrences.push({
              ref,
              role: "primary",
              pointer: entryPointer,
              group: `${entryPointer}#asset-group`,
              fallback_refs: [],
            });
          } else visit(entry, entryPointer);
        }
        continue;
      }
      visit(item, jsonPointer(pointer, key));
    }
  };

  visit({ slides: deck?.slides ?? [], theme: deck?.theme ?? {}, brand: deck?.brand ?? {} });
  const seen = new Set();
  return occurrences.filter((item) => {
    const key = `${item.pointer}\u0000${item.role}\u0000${item.ref}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function addRef(output, value) {
  const ref = cleanString(value);
  if (ref) output.add(ref);
}

function collectEvidenceRefs(slide) {
  const refs = new Set();
  for (const ref of slide?.evidence_refs ?? slide?.evidenceRefs ?? []) addRef(refs, ref);
  for (const bullet of slide?.content?.bullets ?? []) for (const ref of bullet?.evidence_refs ?? bullet?.evidenceRefs ?? []) addRef(refs, ref);
  for (const metric of slide?.content?.metrics ?? []) addRef(refs, metric?.evidence_ref ?? metric?.evidenceRef);
  addRef(refs, slide?.content?.quote?.source_ref ?? slide?.content?.quote?.sourceRef);
  for (const visual of slide?.visuals ?? []) for (const ref of visual?.source_refs ?? visual?.sourceRefs ?? []) addRef(refs, ref);
  for (const ref of slide?.formula?.source_refs ?? slide?.formula?.sourceRefs ?? []) addRef(refs, ref);
  for (const ref of slide?.diagram?.source_refs ?? slide?.diagram?.sourceRefs ?? []) addRef(refs, ref);
  for (const node of slide?.diagram?.nodes ?? []) for (const ref of node?.source_refs ?? node?.sourceRefs ?? []) addRef(refs, ref);
  for (const source of slide?.speaker_notes?.sources ?? slide?.speakerNotes?.sources ?? []) addRef(refs, source?.source_id ?? source?.sourceId);
  return [...refs].sort();
}

function slideLabel(slide, maximum) {
  return compactText(
    slide?.content?.title
      ?? slide?.title
      ?? slide?.render_data?.title
      ?? slide?.renderData?.title
      ?? slide?.takeaway
      ?? slide?.purpose
      ?? slide?.id,
    maximum,
  );
}

function slideMap(slide, index, options) {
  const notes = slide?.speaker_notes ?? slide?.speakerNotes ?? {};
  const occurrences = collectSelectedAssetOccurrences({ slides: [slide] });
  const assetRefs = [...new Set(occurrences.map((item) => item.ref))].sort();
  const evidenceRefs = collectEvidenceRefs(slide);
  const sourceIds = [...new Set((notes.sources ?? []).map((item) => cleanString(item?.source_id ?? item?.sourceId)).filter(Boolean))].sort();
  const formula = slide?.formula?.include === true ? {
    include: true,
    equation_ref: cleanString(slide.formula.equation_ref ?? slide.formula.equationRef),
    role: cleanString(slide.formula.role),
    asset_ref: cleanString(slide.formula.asset_ref ?? slide.formula.assetRef ?? slide.formula.asset_path ?? slide.formula.assetPath),
    fallback_asset_ref: cleanString(slide.formula.fallback_asset_ref ?? slide.formula.fallbackAssetRef),
  } : null;
  const diagram = slide?.diagram?.include === true ? {
    include: true,
    type: cleanString(slide.diagram.type),
    direction: cleanString(slide.diagram.direction),
    node_count: Array.isArray(slide.diagram.nodes) ? slide.diagram.nodes.length : 0,
    edge_count: Array.isArray(slide.diagram.edges) ? slide.diagram.edges.length : 0,
  } : null;
  return {
    id: cleanString(slide?.id) ?? `slide-${index + 1}`,
    order: Number.isInteger(slide?.order) ? slide.order : index + 1,
    kind: cleanString(slide?.kind) ?? "body",
    section_id: cleanString(slide?.section_id ?? slide?.sectionId),
    label: slideLabel(slide, options.maxTextChars),
    priority: cleanString(slide?.priority),
    purpose: compactText(slide?.purpose, options.maxTextChars),
    audience_question: compactText(slide?.audience_question ?? slide?.audienceQuestion, options.maxTextChars),
    takeaway: compactText(slide?.takeaway, options.maxTextChars),
    layout: {
      family: cleanString(slide?.layout?.family),
      variant: cleanString(slide?.layout?.variant),
      density: cleanString(slide?.layout?.density),
      relationship_topology: cleanString(slide?.relationship_topology ?? slide?.relationshipTopology ?? slide?.render_data?.relationship_topology),
    },
    evidence_refs: evidenceRefs,
    asset_refs: assetRefs,
    formula,
    diagram,
    notes_summary: {
      estimated_seconds: Number.isFinite(Number(notes.estimated_seconds ?? notes.estimatedSeconds)) ? Number(notes.estimated_seconds ?? notes.estimatedSeconds) : null,
      source_ids: sourceIds,
    },
    qa_summary: {
      status: cleanString(slide?.qa?.status),
      issue_count: Array.isArray(slide?.qa?.issues) ? slide.qa.issues.length : 0,
    },
  };
}

function sectionMap(section, index, slideMaps, maximum) {
  const id = cleanString(section?.id) ?? `section-${index + 1}`;
  return {
    id,
    order: Number.isInteger(section?.order) ? section.order : index + 1,
    title: compactText(section?.title, maximum),
    short_title: compactText(section?.short_title ?? section?.shortTitle, Math.min(maximum, 100)),
    role: cleanString(section?.role),
    audience_role: cleanString(section?.audience_role ?? section?.audienceRole),
    show_in_agenda: section?.show_in_agenda ?? section?.showInAgenda ?? null,
    show_in_navigation: section?.show_in_navigation ?? section?.showInNavigation ?? null,
    slide_ids: slideMaps.filter((slide) => slide.section_id === id).map((slide) => slide.id),
  };
}

function selectedSourceIndex(deck, slideMaps, maximum) {
  const used = new Set(slideMaps.flatMap((slide) => slide.evidence_refs));
  return (deck?.sources ?? [])
    .filter((source) => used.has(cleanString(source?.id)))
    .map((source) => ({
      id: cleanString(source?.id),
      type: cleanString(source?.type),
      document_id: cleanString(source?.document_id ?? source?.documentId),
      title: compactText(source?.title, maximum),
      verification_status: cleanString(source?.verification_status ?? source?.verificationStatus),
    }));
}

export function buildDeckMap(deckSpec, options = {}) {
  if (!deckSpec || typeof deckSpec !== "object" || Array.isArray(deckSpec)) throw new Error("deckSpec must be a JSON object.");
  if (!Array.isArray(deckSpec.slides)) throw new Error("deckSpec.slides must be an array.");
  const maxTextChars = positiveInteger(options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS, "maxTextChars");
  const slides = deckSpec.slides.map((slide, index) => slideMap(slide, index, { maxTextChars }));
  const sections = (deckSpec.sections ?? []).map((section, index) => sectionMap(section, index, slides, maxTextChars));
  const selectedAssetRefs = [...new Set(slides.flatMap((slide) => slide.asset_refs))].sort();
  const evidenceRefs = [...new Set(slides.flatMap((slide) => slide.evidence_refs))].sort();
  const map = {
    schema_version: "1.0",
    kind: "academic-slides-deck-map",
    project_id: cleanString(deckSpec.project_id ?? deckSpec.projectId),
    title: compactText(deckSpec.title, maxTextChars),
    profile: cleanString(deckSpec.profile),
    language: cleanString(deckSpec.language),
    artifact_purpose: cleanString(deckSpec.artifact_purpose ?? deckSpec.artifactPurpose),
    theme: {
      preset: cleanString(deckSpec.theme?.preset),
      mode: cleanString(deckSpec.theme?.mode),
    },
    timing_summary: {
      target_slide_count: Number.isFinite(Number(deckSpec.timing?.target_slide_count)) ? Number(deckSpec.timing.target_slide_count) : null,
      target_seconds: Number.isFinite(Number(deckSpec.timing?.target_seconds)) ? Number(deckSpec.timing.target_seconds) : null,
      estimated_seconds: slides.reduce((sum, slide) => sum + (slide.notes_summary.estimated_seconds ?? 0), 0),
    },
    counts: {
      sections: sections.length,
      slides: slides.length,
      substantive_slides: slides.filter((slide) => !["title", "agenda", "section", "closing"].includes(slide.kind)).length,
      appendix_slides: slides.filter((slide) => slide.kind === "appendix").length,
      selected_asset_refs: selectedAssetRefs.length,
      evidence_refs: evidenceRefs.length,
    },
    selected_asset_refs: selectedAssetRefs,
    evidence_refs: evidenceRefs,
    sections,
    slides,
    source_index: selectedSourceIndex(deckSpec, slides, maxTextChars),
  };
  if (options.sourceSha256 || Number.isInteger(options.sourceBytes)) {
    map.source_spec = {
      sha256: options.sourceSha256 ?? null,
      size_bytes: Number.isInteger(options.sourceBytes) ? options.sourceBytes : null,
    };
  }
  return map;
}

export function serializeDeckMap(deckMap, options = {}) {
  return options.compact === true ? JSON.stringify(deckMap) : `${JSON.stringify(deckMap, null, 2)}\n`;
}

export async function buildDeckMapFile(specPath, options = {}) {
  const resolvedSpec = path.resolve(specPath);
  const source = await readFile(resolvedSpec, "utf8");
  let deckSpec;
  try {
    deckSpec = JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid deck spec JSON at ${resolvedSpec}: ${error.message}`);
  }
  const sourceBuffer = Buffer.from(source);
  const sourceSha256 = createHash("sha256").update(sourceBuffer).digest("hex");
  const deckMap = buildDeckMap(deckSpec, {
    ...options,
    sourceBytes: sourceBuffer.byteLength,
    sourceSha256,
  });
  const serialized = serializeDeckMap(deckMap, options);
  return {
    deckMap,
    serialized,
    specPath: resolvedSpec,
    specBytes: sourceBuffer.byteLength,
    specSha256: sourceSha256,
    mapBytes: Buffer.byteLength(serialized),
    ratio: sourceBuffer.byteLength === 0 ? null : Buffer.byteLength(serialized) / sourceBuffer.byteLength,
  };
}

/** Write only the explicitly named file. Existing files require force=true. */
export async function writeDeckMapFile(specPath, outputPath, options = {}) {
  if (!outputPath) throw new Error("outputPath is required.");
  const built = await buildDeckMapFile(specPath, options);
  const resolvedOutput = path.resolve(outputPath);
  await mkdir(path.dirname(resolvedOutput), { recursive: true });
  const temporary = path.join(path.dirname(resolvedOutput), `.${path.basename(resolvedOutput)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, built.serialized, { encoding: "utf8", flag: "wx" });
    if (options.force !== true) {
      // An atomic hard link publishes the completed temporary file only when
      // the exact destination does not exist. It never truncates a prior map.
      await link(temporary, resolvedOutput);
      await unlink(temporary);
    } else {
      await rename(temporary, resolvedOutput);
    }
  } catch (error) {
    await unlink(temporary).catch(() => {});
    if (error?.code === "EEXIST") throw new Error(`Deck-map output already exists: ${resolvedOutput}. Use --force to replace this exact file.`);
    throw error;
  }
  return { ...built, output: resolvedOutput };
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
  if (!args.spec) {
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  try {
    if (!args.output) {
      const result = await buildDeckMapFile(args.spec, args);
      process.stdout.write(result.serialized);
      return;
    }
    const result = await writeDeckMapFile(args.spec, args.output, args);
    console.log(JSON.stringify({
      status: "pass",
      ok: true,
      output: result.output,
      spec_bytes: result.specBytes,
      deck_map_bytes: result.mapBytes,
      deck_map_to_spec_ratio: result.ratio,
    }, null, args.compact ? 0 : 2));
  } catch (error) {
    console.error(`DECK MAP FAILED: ${error.message}`);
    process.exitCode = 1;
  }
}

const invokedDirectly = process.argv[1]
  && await realpath(process.argv[1]).catch(() => null) === await realpath(fileURLToPath(import.meta.url)).catch(() => null);
if (invokedDirectly) await main();
