#!/usr/bin/env node

import { access, readFile, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readJsonFile, validateDeckSpecFile, validateJsonValue } from "./validate-deck-spec.mjs";
import { validateScientificContent } from "./validate-scientific-content.mjs";
import { validateScientificDesignFile } from "./validate-scientific-design.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(SCRIPT_DIR, "..");
const PROFILE_REGISTRY_PATH = path.join(SKILL_DIR, "assets", "profile-registry.json");
const FINAL_PROFILE = "final_defense";
const PROPOSAL_MIDTERM_PROFILE = "proposal_midterm";
const GROUP_MEETING_PROFILE = "group_meeting_literature";
const STAGES = ["config", "source", "assets", "outline", "deck", "final"];

function usage() {
  return [
    "Usage: node validate-project.mjs <project-directory> [options]",
    "",
    "Options:",
    "  --stage <name>       auto|config|source|assets|outline|deck|final (default: auto)",
    "  --strict             Treat warnings as errors",
    "  --require-schemas    Fail when bundled schemas are missing",
    "  --json               Emit machine-readable JSON",
    "  -h, --help           Show this help",
  ].join("\n");
}

function parseArgs(argv) {
  const result = { stage: "auto", strict: false, requireSchemas: false, json: false };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--strict") result.strict = true;
    else if (arg === "--require-schemas") result.requireSchemas = true;
    else if (arg === "--json") result.json = true;
    else if (arg === "--stage") {
      const stage = argv[++index];
      if (!stage || !["auto", ...STAGES].includes(stage)) throw new Error(`Unknown stage: ${stage ?? ""}`);
      result.stage = stage;
    } else if (arg === "-h" || arg === "--help") result.help = true;
    else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else positional.push(arg);
  }
  if (positional.length > 1) throw new Error("Provide exactly one project directory.");
  result.projectDir = positional[0];
  return result;
}

function finding(severity, code, file, message, options = {}) {
  const result = { severity, code, file, message };
  if (options.strictExempt === true) result.strict_exempt = true;
  return result;
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(filePath) {
  try {
    return (await stat(filePath)).isDirectory();
  } catch {
    return false;
  }
}

function valueAt(object, dottedPath) {
  return dottedPath.split(".").reduce((current, key) => current?.[key], object);
}

function configuredPath(projectDir, config, candidates, fallback) {
  for (const candidate of candidates) {
    const value = valueAt(config, candidate);
    if (typeof value === "string" && value.trim()) return path.resolve(projectDir, value);
  }
  return path.resolve(projectDir, fallback);
}

async function findConfig(projectDir) {
  for (const filename of ["project-config.json", "project.config.json", "project.json"]) {
    const candidate = path.join(projectDir, filename);
    if (await exists(candidate)) return candidate;
  }
  return path.join(projectDir, "project-config.json");
}

async function loadProfileRegistry(findings) {
  if (!(await exists(PROFILE_REGISTRY_PATH))) {
    findings.push(finding("error", "profile.registry.missing", PROFILE_REGISTRY_PATH, "Bundled profile-registry.json is missing."));
    return null;
  }
  try {
    const registry = await readJsonFile(PROFILE_REGISTRY_PATH);
    if (!registry?.profiles || typeof registry.profiles !== "object" || Array.isArray(registry.profiles)) {
      findings.push(finding("error", "profile.registry.invalid", PROFILE_REGISTRY_PATH, "Profile registry must contain a profiles object."));
      return null;
    }
    return registry;
  } catch (error) {
    findings.push(finding("error", "profile.registry.invalid", PROFILE_REGISTRY_PATH, error.message));
    return null;
  }
}

function projectProfile(config, registry) {
  return config.presentation?.type ?? registry?.defaultProfile ?? FINAL_PROFILE;
}

function deckProfile(deck, registry) {
  return deck?.profile
    ?? deck?.presentation_profile
    ?? deck?.presentation?.type
    ?? registry?.backwardCompatibility?.missingDeckProfile
    ?? FINAL_PROFILE;
}

async function validateJsonAgainstBundledSchema(jsonPath, schemaName, findings, requireSchema) {
  const schemaPath = path.join(SKILL_DIR, "schemas", schemaName);
  if (!(await exists(schemaPath))) {
    findings.push(finding(requireSchema ? "error" : "warning", "schema.missing", schemaPath, `Bundled schema is missing: ${schemaName}`));
    return null;
  }
  try {
    const [value, schema] = await Promise.all([readJsonFile(jsonPath), readJsonFile(schemaPath)]);
    const schemaIssues = [];
    validateJsonValue(value, schema, { rootSchema: schema, issues: schemaIssues });
    for (const item of schemaIssues) findings.push(finding(item.severity, `schema.${item.code}`, jsonPath, `${item.path}: ${item.message}`));
    return value;
  } catch (error) {
    findings.push(finding("error", "json.invalid", jsonPath, error.message));
    return null;
  }
}

async function sourceFiles(sourcePath) {
  if (!(await exists(sourcePath))) return [];
  const info = await stat(sourcePath);
  if (info.isFile()) return [sourcePath];
  const entries = await readdir(sourcePath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && [".pdf", ".docx", ".pptx", ".tex", ".md", ".txt"].includes(path.extname(entry.name).toLowerCase()))
    .map((entry) => path.join(sourcePath, entry.name));
}

async function validateGroupSources(projectDir, config, findings) {
  const documents = Array.isArray(config.input?.documents) ? config.input.documents : [];
  const byId = new Map(documents.map((document) => [document?.id, document]));
  const focalDocumentIds = Array.isArray(config.literature_profile?.focal_document_ids) ? config.literature_profile.focal_document_ids : [];
  if (focalDocumentIds.length === 0) {
    findings.push(finding("error", "source.focal.missing", projectDir, "Group-meeting projects require at least one literature_profile.focal_document_ids entry."));
    return;
  }
  for (const documentId of focalDocumentIds) {
    const document = byId.get(documentId);
    if (!document) {
      findings.push(finding("error", "source.focal.unknown", projectDir, `Focal document id ${documentId} is not present in input.documents.`));
      continue;
    }
    if (document.role !== "focal_paper") findings.push(finding("error", "source.focal.role", projectDir, `Document ${documentId} is focal but has role=${document.role ?? "missing"}; expected focal_paper.`));
    const documentPath = typeof document.path === "string" ? path.resolve(projectDir, document.path) : null;
    if (!documentPath || !(await exists(documentPath))) {
      findings.push(finding("error", "source.focal.file", documentPath ?? projectDir, `Focal document ${documentId} points to a missing source.`));
      continue;
    }
    const info = await stat(documentPath);
    if (info.isDirectory() && (await sourceFiles(documentPath)).length === 0) findings.push(finding("error", "source.focal.empty", documentPath, `Focal document directory ${documentId} contains no supported source file.`));
  }
}

async function validateMilestoneSources(projectDir, config, findings) {
  const documents = Array.isArray(config.input?.documents) ? config.input.documents : [];
  const byId = new Map(documents.map((document) => [document?.id, document]));
  const milestone = config.milestone_profile ?? {};
  const mode = milestone.mode;
  const planIds = Array.isArray(milestone.plan_document_ids) ? milestone.plan_document_ids : [];
  const progressIds = Array.isArray(milestone.progress_document_ids) ? milestone.progress_document_ids : [];
  const planRoles = new Set(["research_proposal", "approved_plan", "study_protocol", "main_thesis"]);
  const progressRoles = new Set(["midterm_report", "progress_evidence", "main_thesis"]);

  if (mode === "proposal" && planIds.length === 0) findings.push(finding("error", "source.milestone.plan.missing", projectDir, "Proposal mode requires at least one plan document."));
  if (mode === "midterm" && progressIds.length === 0) findings.push(finding("error", "source.milestone.progress.missing", projectDir, "Midterm mode requires at least one progress document."));
  if (mode === "midterm" && planIds.length === 0) findings.push(finding("warning", "source.milestone.baseline.missing", projectDir, "No approved-plan baseline is available. Record this limitation and do not fabricate plan-versus-actual claims.", { strictExempt: true }));

  const checkIds = async (ids, label, allowedRoles) => {
    for (const documentId of ids) {
      const document = byId.get(documentId);
      if (!document) {
        findings.push(finding("error", `source.milestone.${label}.unknown`, projectDir, `${label} document id ${documentId} is not present in input.documents.`));
        continue;
      }
      if (!allowedRoles.has(document.role)) findings.push(finding("error", `source.milestone.${label}.role`, projectDir, `Document ${documentId} has role=${document.role ?? "missing"}; expected one of ${[...allowedRoles].join(", ")}.`));
      const documentPath = typeof document.path === "string" ? path.resolve(projectDir, document.path) : null;
      if (!documentPath || !(await exists(documentPath))) {
        findings.push(finding("error", `source.milestone.${label}.file`, documentPath ?? projectDir, `${label} document ${documentId} points to a missing source.`));
        continue;
      }
      const info = await stat(documentPath);
      if (info.isDirectory() && (await sourceFiles(documentPath)).length === 0) findings.push(finding("error", `source.milestone.${label}.empty`, documentPath, `${label} document directory ${documentId} contains no supported source file.`));
    }
  };

  await checkIds(planIds, "plan", planRoles);
  await checkIds(progressIds, "progress", progressRoles);
}

function manifestEntries(manifest) {
  if (Array.isArray(manifest)) return manifest;
  for (const key of ["figures", "items", "assets"]) if (Array.isArray(manifest?.[key])) return manifest[key];
  return [];
}

function paperIndexEntries(index) {
  if (Array.isArray(index)) return index;
  for (const key of ["papers", "items", "literature"]) if (Array.isArray(index?.[key])) return index[key];
  return [];
}

async function validatePaperIndex(paperIndexPath, findings, mode, requireSchema) {
  if (!(await exists(paperIndexPath))) {
    findings.push(finding("error", "paper-index.missing", paperIndexPath, "paper-index.json is required for group-meeting literature projects."));
    return null;
  }
  try {
    const index = await validateJsonAgainstBundledSchema(paperIndexPath, "paper-index.schema.json", findings, requireSchema);
    if (!index) return null;
    const papers = paperIndexEntries(index);
    if (papers.length === 0) {
      findings.push(finding("error", "paper-index.empty", paperIndexPath, "paper-index.json must contain at least one paper."));
      return index;
    }
    if (index.mode !== mode) findings.push(finding("error", "paper-index.mode", paperIndexPath, `paper-index mode=${index.mode ?? "missing"} does not match project literature_profile.mode=${mode ?? "missing"}.`));
    const focalIds = Array.isArray(index.focal_paper_ids) ? index.focal_paper_ids : [];
    if (mode === "single_paper" && focalIds.length !== 1) findings.push(finding("error", "paper-index.focal-count", paperIndexPath, `single_paper mode requires exactly one focal paper; found ${focalIds.length}.`));
    if (mode === "multi_paper" && focalIds.length < 2) findings.push(finding("error", "paper-index.focal-count", paperIndexPath, `multi_paper mode requires at least two focal papers; found ${focalIds.length}.`));
    const ids = new Set();
    papers.forEach((paper, indexNumber) => {
      const pointer = `papers[${indexNumber}]`;
      const id = paper?.id ?? paper?.paper_id;
      if (typeof id !== "string" || !id.trim()) findings.push(finding("error", "paper-index.id", paperIndexPath, `${pointer} needs a stable id or paper_id.`));
      else if (ids.has(id)) findings.push(finding("error", "paper-index.id.duplicate", paperIndexPath, `Duplicate paper id: ${id}.`));
      else ids.add(id);
      const title = paper?.title ?? paper?.bibliography?.title;
      if (typeof title !== "string" || !title.trim()) findings.push(finding("error", "paper-index.title", paperIndexPath, `${pointer} needs a non-empty title.`));
    });
    for (const focalId of focalIds) if (!ids.has(focalId)) findings.push(finding("error", "paper-index.focal-unknown", paperIndexPath, `focal_paper_ids refers to unknown paper id ${focalId}.`));
    return index;
  } catch (error) {
    findings.push(finding("error", "paper-index.invalid", paperIndexPath, error.message));
    return null;
  }
}

async function validateMilestoneAnalysis(analysisPath, config, findings, requireSchema) {
  if (!(await exists(analysisPath))) {
    findings.push(finding("error", "milestone-analysis.missing", analysisPath, "milestone-analysis.json is required for proposal/midterm projects."));
    return null;
  }
  const analysis = await validateJsonAgainstBundledSchema(analysisPath, "milestone-analysis.schema.json", findings, requireSchema);
  if (!analysis) return null;
  const configMode = config.milestone_profile?.mode;
  if (analysis.mode !== configMode) findings.push(finding("error", "milestone-analysis.mode", analysisPath, `milestone-analysis mode=${analysis.mode ?? "missing"} does not match project milestone_profile.mode=${configMode ?? "missing"}.`));
  if (config.project?.id && analysis.project_id !== config.project.id) findings.push(finding("error", "milestone-analysis.project-id", analysisPath, `milestone-analysis project_id=${analysis.project_id ?? "missing"} does not match project-config project.id=${config.project.id}.`));

  const sameIds = (left, right) => JSON.stringify([...(left ?? [])].sort()) === JSON.stringify([...(right ?? [])].sort());
  if (!sameIds(analysis.plan_document_ids, config.milestone_profile?.plan_document_ids)) findings.push(finding("error", "milestone-analysis.plan-documents", analysisPath, "milestone-analysis plan_document_ids do not match project-config."));
  if (!sameIds(analysis.progress_document_ids, config.milestone_profile?.progress_document_ids)) findings.push(finding("error", "milestone-analysis.progress-documents", analysisPath, "milestone-analysis progress_document_ids do not match project-config."));
  if (configMode === "midterm" && analysis.as_of_date !== config.milestone_profile?.as_of_date) findings.push(finding("error", "milestone-analysis.as-of-date", analysisPath, "milestone-analysis as_of_date does not match project-config."));

  for (const [label, records] of [["objective", analysis.objectives ?? []], ["work-package", analysis.work_packages ?? []], ["risk", analysis.risks ?? []]]) {
    const ids = new Set();
    for (const [index, record] of records.entries()) {
      if (!isStableId(record?.id)) continue;
      if (ids.has(record.id)) findings.push(finding("error", `milestone-analysis.${label}.duplicate`, analysisPath, `Duplicate ${label} id at index ${index}: ${record.id}.`));
      else ids.add(record.id);
    }
  }
  return analysis;
}

async function validateGroupPaperManifests(projectDir, paperIndexPath, paperIndex, findings, requireSchema) {
  const paperAssetManifests = [];
  for (const [index, paper] of paperIndexEntries(paperIndex).entries()) {
    const assetRelative = paper?.asset_manifest_path;
    if (assetRelative != null) {
      if (typeof assetRelative !== "string" || !assetRelative.trim()) {
        findings.push(finding("error", "paper-index.asset-manifest", paperIndexPath, `papers[${index}].asset_manifest_path must be a non-empty path or null.`));
        continue;
      }
      const candidates = path.isAbsolute(assetRelative)
        ? [assetRelative]
        : [path.resolve(projectDir, assetRelative), path.resolve(path.dirname(paperIndexPath), assetRelative)];
      const availability = await Promise.all(candidates.map(exists));
      const resolved = candidates[availability.findIndex(Boolean)];
      if (!resolved) {
        findings.push(finding("error", "paper-index.asset-manifest.missing", candidates[0], `papers[${index}].asset_manifest_path points to a missing file.`));
        continue;
      }
      const manifest = await validateJsonAgainstBundledSchema(resolved, "paper-assets.schema.json", findings, requireSchema);
      if (manifest) {
        for (const [assetIndex, asset] of (manifest.assets ?? []).entries()) {
          const relativeFile = asset?.crop?.file ?? asset?.materialization?.path;
          if (asset?.crop?.status !== "materialized" || typeof relativeFile !== "string" || !relativeFile.trim()) continue;
          const fileCandidates = path.isAbsolute(relativeFile)
            ? [relativeFile]
            : [path.resolve(path.dirname(resolved), relativeFile), path.resolve(projectDir, relativeFile)];
          const fileAvailability = await Promise.all(fileCandidates.map(exists));
          if (!fileAvailability.some(Boolean)) findings.push(finding("error", "paper-assets.file.missing", fileCandidates[0], `assets[${assetIndex}] is materialized but its crop file is missing.`));
        }
        paperAssetManifests.push({ paper_id: paper?.paper_id ?? paper?.id, path: resolved, manifest });
      }
      continue;
    }

    const relative = paper?.figure_manifest_path;
    if (relative == null) continue;
    if (typeof relative !== "string" || !relative.trim()) {
      findings.push(finding("error", "paper-index.figure-manifest", paperIndexPath, `papers[${index}].figure_manifest_path must be a non-empty path or null.`));
      continue;
    }
    const candidates = path.isAbsolute(relative)
      ? [relative]
      : [path.resolve(projectDir, relative), path.resolve(path.dirname(paperIndexPath), relative)];
    const availability = await Promise.all(candidates.map(exists));
    const resolved = candidates[availability.findIndex(Boolean)];
    if (!resolved) {
      findings.push(finding("error", "paper-index.figure-manifest.missing", candidates[0], `papers[${index}].figure_manifest_path points to a missing file.`));
      continue;
    }
    const manifest = await validateJsonAgainstBundledSchema(resolved, "figures-manifest.schema.json", findings, requireSchema);
    if (manifest) await validateManifestFiles(projectDir, resolved, manifest, findings);
  }
  return paperAssetManifests;
}

async function validateManifestFiles(projectDir, manifestPath, manifest, findings) {
  const ids = new Set();
  const readyIds = new Set();
  const entries = manifestEntries(manifest);
  const referencedFiles = [];
  const resolveRecord = async (record, pointer) => {
    const relative = record?.path;
    if (typeof relative !== "string" || !relative.trim()) return;
    const candidates = path.isAbsolute(relative)
      ? [relative]
      : [path.resolve(projectDir, relative), path.resolve(path.dirname(manifestPath), relative)];
    const availability = await Promise.all(candidates.map(exists));
    const resolved = candidates[availability.findIndex(Boolean)];
    if (!resolved) {
      findings.push(finding("error", "manifest.file.missing", candidates[0], `${pointer} points to a missing file.`));
      return;
    }
    referencedFiles.push(resolved);
    if (typeof record.sha256 === "string" && /^[A-Fa-f0-9]{64}$/.test(record.sha256)) {
      const actual = createHash("sha256").update(await readFile(resolved)).digest("hex");
      if (actual.toLowerCase() !== record.sha256.toLowerCase()) findings.push(finding("error", "manifest.file.hash", resolved, `${pointer} sha256 does not match the file on disk.`));
    }
  };
  for (const [index, item] of entries.entries()) {
    if (!item || typeof item !== "object") continue;
    const id = item.id ?? item.figure_id ?? item.figure_number;
    if (id) {
      if (ids.has(id)) findings.push(finding("error", "manifest.id.duplicate", manifestPath, `Duplicate figure id at item ${index}: ${id}`));
      ids.add(id);
    }
    const original = item.file?.original ?? (typeof item.file === "object" ? item.file : null);
    if (original?.path) await resolveRecord(original, `figures[${index}].file.original`);
    else {
      const legacy = item.file_path ?? item.path ?? item.original_path ?? (typeof item.file === "string" ? item.file : null);
      if (legacy) await resolveRecord({ path: legacy, sha256: item.sha256 }, `figures[${index}]`);
    }
    for (const [readyIndex, ready] of (item.file?.ready_variants ?? []).entries()) {
      if (ready?.id) {
        if (readyIds.has(ready.id)) findings.push(finding("error", "manifest.ready-id.duplicate", manifestPath, `Duplicate ready variant id: ${ready.id}.`));
        readyIds.add(ready.id);
      }
      await resolveRecord(ready, `figures[${index}].file.ready_variants[${readyIndex}]`);
    }
  }
  const summary = manifest?.extraction_summary;
  if (summary) {
    if (summary.manifest_record_count !== entries.length) findings.push(finding("error", "manifest.count.records", manifestPath, `extraction_summary.manifest_record_count=${summary.manifest_record_count}, but figures has ${entries.length} records.`));
    const originalsOnDisk = entries.filter((item) => item?.file?.original?.path || item?.file_path || item?.path || item?.original_path || typeof item?.file === "string").length;
    if (summary.file_count !== originalsOnDisk) findings.push(finding("error", "manifest.count.files", manifestPath, `extraction_summary.file_count=${summary.file_count}, but ${originalsOnDisk} original file records are listed.`));
    if (summary.status === "matched" && (summary.detected_caption_count !== summary.manifest_record_count || summary.manifest_record_count !== summary.file_count)) {
      findings.push(finding("error", "manifest.count.matched", manifestPath, "Extraction status is matched, but caption, record, and file counts differ."));
    }
    if (summary.status === "explained_difference" && (!Array.isArray(summary.differences) || summary.differences.length === 0)) findings.push(finding("error", "manifest.count.explanation", manifestPath, "explained_difference requires at least one recorded difference."));
  }
  for (const [index, item] of entries.entries()) {
    for (const [relationIndex, relation] of (item?.relationships ?? []).entries()) {
      if (relation?.figure_id && !ids.has(relation.figure_id)) findings.push(finding("error", "manifest.relationship.unknown", manifestPath, `figures[${index}].relationships[${relationIndex}] refers to unknown figure id ${relation.figure_id}.`));
    }
  }
}

function isStableId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function addEvidenceRef(refs, value) {
  if (typeof value === "string" && value.trim()) refs.add(value);
}

function collectSlideEvidenceRefs(slide) {
  const refs = new Set();
  for (const ref of slide?.evidence_refs ?? []) addEvidenceRef(refs, ref);
  for (const bullet of slide?.content?.bullets ?? []) for (const ref of bullet?.evidence_refs ?? []) addEvidenceRef(refs, ref);
  for (const metric of slide?.content?.metrics ?? []) addEvidenceRef(refs, metric?.evidence_ref);
  addEvidenceRef(refs, slide?.content?.quote?.source_ref);
  for (const visual of slide?.visuals ?? []) for (const ref of visual?.source_refs ?? []) addEvidenceRef(refs, ref);
  for (const ref of slide?.formula?.source_refs ?? []) addEvidenceRef(refs, ref);
  for (const ref of slide?.diagram?.source_refs ?? []) addEvidenceRef(refs, ref);
  for (const node of slide?.diagram?.nodes ?? []) for (const ref of node?.source_refs ?? []) addEvidenceRef(refs, ref);
  for (const source of slide?.speaker_notes?.sources ?? []) addEvidenceRef(refs, source?.source_id);
  return refs;
}

function collectDeckEvidenceRefs(deck) {
  const refs = new Set();
  for (const slide of deck?.slides ?? []) for (const ref of collectSlideEvidenceRefs(slide)) refs.add(ref);
  if (Array.isArray(deck?.claim_evidence_map)) {
    for (const claim of deck.claim_evidence_map) for (const ref of claim?.evidence_refs ?? claim?.refs ?? []) addEvidenceRef(refs, ref);
  } else if (deck?.claim_evidence_map && typeof deck.claim_evidence_map === "object") {
    for (const claimRefs of Object.values(deck.claim_evidence_map)) for (const ref of claimRefs ?? []) addEvidenceRef(refs, ref);
  }
  return refs;
}

function evidenceHasLocator(record) {
  if (typeof record?.locator === "string" && record.locator.trim()) return true;
  if (typeof record?.source_url === "string" && record.source_url.trim()) return true;
  return record?.type === "derived_calculation"
    && Array.isArray(record.inputs)
    && typeof record.expression === "string"
    && record.expression.trim().length > 0
    && Object.hasOwn(record, "result");
}

function mapStableRecords(records, label, filePath, findings) {
  const output = new Map();
  for (const [index, record] of records.entries()) {
    const id = record?.id ?? record?.evidence_id ?? record?.document_id;
    if (!isStableId(id)) {
      findings.push(finding("error", `${label}.id`, filePath, `${label}[${index}] needs a stable id.`));
      continue;
    }
    if (output.has(id)) findings.push(finding("error", `${label}.id.duplicate`, filePath, `Duplicate ${label} id: ${id}.`));
    else output.set(id, record);
  }
  return output;
}

function validateMilestoneAnalysisEvidence(analysis, evidenceIndex, paths, findings) {
  if (!analysis || !evidenceIndex) return;
  const evidenceById = mapStableRecords(Array.isArray(evidenceIndex.evidence) ? evidenceIndex.evidence : [], "evidence", paths.evidenceIndex, findings);
  const checkRefs = (refs, pointer) => {
    for (const ref of refs ?? []) if (!evidenceById.has(ref)) findings.push(finding("error", "milestone-analysis.evidence.unknown", paths.milestoneAnalysis, `${pointer} refers to unknown evidence id ${ref}.`));
  };
  for (const [index, objective] of (analysis.objectives ?? []).entries()) checkRefs(objective?.evidence_refs, `objectives[${index}].evidence_refs`);
  for (const [index, workPackage] of (analysis.work_packages ?? []).entries()) {
    checkRefs(workPackage?.baseline_evidence_refs, `work_packages[${index}].baseline_evidence_refs`);
    checkRefs(workPackage?.progress_evidence_refs, `work_packages[${index}].progress_evidence_refs`);
    if (analysis.mode === "midterm" && workPackage?.status === "completed" && (workPackage?.progress_evidence_refs?.length ?? 0) === 0) {
      findings.push(finding("error", "milestone-analysis.completed.evidence", paths.milestoneAnalysis, `Completed work package ${workPackage?.id ?? index + 1} has no progress evidence.`));
    } else if (analysis.mode === "midterm" && !["planned", "not_started"].includes(workPackage?.status) && (workPackage?.progress_evidence_refs?.length ?? 0) === 0) {
      findings.push(finding("warning", "milestone-analysis.status.evidence", paths.milestoneAnalysis, `Work package ${workPackage?.id ?? index + 1} has status=${workPackage?.status ?? "missing"} without progress evidence.`));
    }
  }
  for (const [index, risk] of (analysis.risks ?? []).entries()) checkRefs(risk?.evidence_refs, `risks[${index}].evidence_refs`);
}

function validateEvidenceIndexRelationships(evidenceIndex, paths, findings) {
  if (!evidenceIndex) return;
  const evidenceById = mapStableRecords(Array.isArray(evidenceIndex.evidence) ? evidenceIndex.evidence : [], "evidence", paths.evidenceIndex, findings);
  for (const evidence of evidenceById.values()) {
    for (const relatedId of evidence?.related_evidence_ids ?? []) if (!evidenceById.has(relatedId)) findings.push(finding("error", "evidence.related.unknown", paths.evidenceIndex, `Evidence ${evidence.id} refers to unknown related_evidence_id=${relatedId}.`));
    if (evidence?.evidence_role === "deviation") {
      const relatedRoles = new Set((evidence.related_evidence_ids ?? []).map((id) => evidenceById.get(id)?.evidence_role).filter(Boolean));
      if (!relatedRoles.has("plan_commitment") || !["progress_update", "completed_result", "preliminary_result"].some((role) => relatedRoles.has(role))) {
        findings.push(finding("error", "evidence.deviation.closure", paths.evidenceIndex, `Deviation evidence ${evidence.id} must relate to a plan_commitment and current progress evidence.`));
      }
    }
  }
}

function validateMilestoneDeckEvidence(config, evidenceIndex, deck, paths, findings) {
  if (config.presentation?.type !== PROPOSAL_MIDTERM_PROFILE || !evidenceIndex || !deck) return;
  const evidenceById = mapStableRecords(Array.isArray(evidenceIndex.evidence) ? evidenceIndex.evidence : [], "evidence", paths.evidenceIndex, findings);
  const planRoles = new Set(["plan_commitment"]);
  const progressRoles = new Set(["progress_update", "completed_result", "preliminary_result"]);
  for (const slide of deck.slides ?? []) {
    const roles = new Set((slide?.narrative_roles ?? []));
    const variant = slide?.layout?.variant;
    const evidence = [...collectSlideEvidenceRefs(slide)].map((ref) => evidenceById.get(ref)).filter(Boolean);
    const evidenceRoles = new Set(evidence.map((record) => record?.evidence_role).filter(Boolean));
    if (variant === "plan-vs-actual" || roles.has("deviation")) {
      if (![...planRoles].some((role) => evidenceRoles.has(role)) || ![...progressRoles].some((role) => evidenceRoles.has(role))) {
        findings.push(finding("error", "evidence.milestone.plan-actual", paths.deckSpec, `Slide ${slide?.id ?? slide?.order ?? "unknown"} must cite both plan_commitment and progress evidence.`));
      }
    }
    if (config.milestone_profile?.mode === "midterm" && (roles.has("progress_status") || roles.has("interim_result"))) {
      if (![...progressRoles].some((role) => evidenceRoles.has(role))) findings.push(finding("error", "evidence.milestone.progress", paths.deckSpec, `Midterm slide ${slide?.id ?? slide?.order ?? "unknown"} reports progress without progress_update/completed_result/preliminary_result evidence.`));
    }
  }
}

function validateEvidenceClosure(config, sourceManifest, evidenceIndex, deck, paths, findings) {
  if (!evidenceIndex || !deck) return;
  const evidenceRecords = Array.isArray(evidenceIndex.evidence) ? evidenceIndex.evidence : [];
  const evidenceById = mapStableRecords(evidenceRecords, "evidence", paths.evidenceIndex, findings);
  const manifestRecords = [
    ...(Array.isArray(sourceManifest?.documents) ? sourceManifest.documents : []),
    ...(Array.isArray(sourceManifest?.derived_sources) ? sourceManifest.derived_sources : []),
  ];
  const documentById = mapStableRecords(manifestRecords, "source-manifest.document", paths.sourceManifest, findings);
  const expectedProjectId = config.project?.id;
  for (const [label, value, filePath] of [
    ["evidence-index", evidenceIndex.project_id, paths.evidenceIndex],
    ["source-manifest", sourceManifest?.project_id, paths.sourceManifest],
    ["deck-spec", deck.project_id, paths.deckSpec],
  ]) {
    if (expectedProjectId && value && value !== expectedProjectId) findings.push(finding("error", "evidence.project-id", filePath, `${label} project_id=${value} does not match project-config project.id=${expectedProjectId}.`));
  }

  for (const evidence of evidenceRecords) {
    if (!evidenceHasLocator(evidence)) findings.push(finding("error", "evidence.locator.missing", paths.evidenceIndex, `Evidence ${evidence?.id ?? "unknown"} needs a source locator, source_url, or reproducible derived calculation.`));
    if (evidence?.document_id && !documentById.has(evidence.document_id)) findings.push(finding("error", "evidence.document.unknown", paths.evidenceIndex, `Evidence ${evidence.id} refers to document_id=${evidence.document_id}, which is absent from source-manifest.`));
  }

  const deckSources = Array.isArray(deck.sources) ? deck.sources : [];
  const deckSourceById = new Map(deckSources.filter((source) => source?.id).map((source) => [source.id, source]));
  for (const source of deckSources) {
    const evidence = evidenceById.get(source?.id);
    if (!evidence) {
      findings.push(finding("error", "evidence.source.unknown", paths.deckSpec, `Deck source ${source?.id ?? "unknown"} is absent from evidence-index.`));
      continue;
    }
    const sourceDocumentId = source.document_id;
    if (sourceDocumentId && !documentById.has(sourceDocumentId)) findings.push(finding("error", "evidence.source-document.unknown", paths.deckSpec, `Deck source ${source.id} refers to document_id=${sourceDocumentId}, which is absent from source-manifest.`));
    if (evidence.document_id && sourceDocumentId && evidence.document_id !== sourceDocumentId) findings.push(finding("error", "evidence.document.mismatch", paths.deckSpec, `Deck source ${source.id} uses document_id=${sourceDocumentId}, but evidence-index records ${evidence.document_id}.`));
    if (!evidenceHasLocator(evidence)) findings.push(finding("error", "evidence.source.locator", paths.deckSpec, `Deck source ${source.id} does not resolve to a reviewable locator in evidence-index.`));
  }

  for (const ref of collectDeckEvidenceRefs(deck)) {
    if (!evidenceById.has(ref)) findings.push(finding("error", "evidence.reference.unknown", paths.deckSpec, `Deck evidence reference ${ref} is absent from evidence-index.`));
  }

  if (config.presentation?.type === GROUP_MEETING_PROFILE && config.literature_profile?.mode === "multi_paper") {
    const focalDocumentIds = new Set(config.literature_profile.focal_document_ids ?? []);
    const crossPaperLayouts = new Set(["cross-paper-matrix", "consensus-divergence"]);
    for (const slide of deck.slides ?? []) {
      const variant = slide?.layout?.variant;
      if (!crossPaperLayouts.has(variant)) continue;
      const covered = new Set();
      for (const ref of collectSlideEvidenceRefs(slide)) {
        const evidence = evidenceById.get(ref);
        const documentId = evidence?.document_id ?? deckSourceById.get(ref)?.document_id;
        if (focalDocumentIds.has(documentId)) covered.add(documentId);
      }
      if (covered.size < 2) {
        findings.push(finding("error", "evidence.cross-paper.coverage", paths.deckSpec, `Cross-paper slide ${slide.id ?? slide.order ?? "unknown"} (${variant}) covers ${covered.size} focal paper(s); cite evidence from at least two focal papers.`));
      }
    }
  }
  validateMilestoneDeckEvidence(config, evidenceIndex, deck, paths, findings);
}

async function inferStage(paths) {
  if (await exists(paths.finalPptx)) return "final";
  if (await exists(paths.deckSpec)) return "deck";
  if (await exists(paths.outline)) return "outline";
  if ((await exists(paths.figuresManifest)) || (await exists(paths.evidenceIndex)) || (paths.paperIndex && await exists(paths.paperIndex)) || (paths.milestoneAnalysis && await exists(paths.milestoneAnalysis))) return "assets";
  if ((await sourceFiles(paths.source)).length) return "source";
  return "config";
}

function stageIncludes(target, stage) {
  return STAGES.indexOf(target) >= STAGES.indexOf(stage);
}

function resolveProjectPaths(projectDir, config, profileId) {
  const documents = Array.isArray(config.input?.documents) ? config.input.documents : [];
  const preferredRoles = profileId === GROUP_MEETING_PROFILE
    ? ["focal_paper", "primary_paper", "main_paper", "source_paper"]
    : profileId === PROPOSAL_MIDTERM_PROFILE
      ? ["research_proposal", "approved_plan", "midterm_report", "progress_evidence", "main_thesis"]
      : ["main_thesis"];
  const mainDocument = documents.find((item) => preferredRoles.includes(item?.role)) ?? documents[0];
  const configuredSource = typeof mainDocument?.path === "string" && mainDocument.path.trim()
    ? path.resolve(projectDir, mainDocument.path)
    : configuredPath(projectDir, config, ["paths.source", "paths.source_dir", "source.path", "source.file", "source_pdf"], "source");
  const filenameStem = config.output?.filename_stem;
  return {
    source: configuredSource,
    sourceManifest: configuredPath(projectDir, config, ["paths.source_manifest", "source_manifest"], "source-manifest.json"),
    thesisAnalysis: configuredPath(projectDir, config, ["paths.thesis_analysis", "thesis_analysis"], "thesis-analysis.json"),
    milestoneAnalysis: configuredPath(projectDir, config, ["paths.milestone_analysis", "milestone_analysis"], "milestone-analysis.json"),
    figuresManifest: configuredPath(projectDir, config, ["paths.figures_manifest", "assets.figures_manifest", "figures_manifest"], "assets/figures/figures.manifest.json"),
    evidenceIndex: configuredPath(projectDir, config, ["paths.evidence_index", "evidence_index"], "evidence-index.json"),
    paperIndex: configuredPath(projectDir, config, ["paths.paper_index", "assets.paper_index", "paper_index"], "paper-index.json"),
    outline: configuredPath(projectDir, config, ["paths.outline", "paths.outline_md", "outline"], "PPT内容与设计大纲.md"),
    deckSpec: configuredPath(projectDir, config, ["paths.deck_spec", "deck_spec"], "deck-spec.json"),
    finalPptx: configuredPath(projectDir, config, ["paths.final_pptx", "paths.output_pptx", "output.pptx", "final_pptx"], filenameStem ? `${filenameStem}.pptx` : "final.pptx"),
    qaDir: configuredPath(projectDir, config, ["paths.qa_dir", "qa_dir"], "qa"),
  };
}

export async function validateProject(projectPath, options = {}) {
  const projectDir = path.resolve(projectPath);
  const findings = [];
  if (!(await isDirectory(projectDir))) {
    return { ok: false, project: projectDir, stage: options.stage ?? "auto", paths: {}, issues: [finding("error", "project.missing", projectDir, "Project directory does not exist.")] };
  }
  const configPath = await findConfig(projectDir);
  let config = {};
  if (!(await exists(configPath))) findings.push(finding("error", "config.missing", configPath, "Create project-config.json before validating the project."));
  else {
    const parsed = await validateJsonAgainstBundledSchema(configPath, "project-config.schema.json", findings, options.requireSchemas);
    if (parsed) config = parsed;
  }
  const profileRegistry = await loadProfileRegistry(findings);
  const profileId = projectProfile(config, profileRegistry);
  if (profileRegistry && !profileRegistry.profiles[profileId]) findings.push(finding("error", "profile.unregistered", PROFILE_REGISTRY_PATH, `Presentation profile ${profileId} is not registered.`));
  const literatureMode = config.literature_profile?.mode;
  if (profileId === GROUP_MEETING_PROFILE && !["single_paper", "multi_paper"].includes(literatureMode)) findings.push(finding("error", "profile.literature-mode", configPath, "Group-meeting projects require literature_profile.mode=single_paper or multi_paper."));
  const milestoneMode = config.milestone_profile?.mode;
  if (profileId === PROPOSAL_MIDTERM_PROFILE && !["proposal", "midterm"].includes(milestoneMode)) findings.push(finding("error", "profile.milestone-mode", configPath, "Proposal/midterm projects require milestone_profile.mode=proposal or midterm."));
  const paths = resolveProjectPaths(projectDir, config, profileId);
  const targetStage = options.stage === "auto" || !options.stage ? await inferStage(paths) : options.stage;
  let sourceManifest = null;
  let evidenceIndex = null;
  let milestoneAnalysis = null;
  let paperIndex = null;
  let paperAssetManifests = [];

  if (stageIncludes(targetStage, "source")) {
    if (profileId === GROUP_MEETING_PROFILE) await validateGroupSources(projectDir, config, findings);
    else if (profileId === PROPOSAL_MIDTERM_PROFILE) await validateMilestoneSources(projectDir, config, findings);
    else {
      const sources = await sourceFiles(paths.source);
      if (!sources.length) findings.push(finding("error", "source.missing", paths.source, "No supported PDF, DOCX, PPTX, TeX, Markdown, or text source document was found."));
    }
  }

  if (stageIncludes(targetStage, "assets")) {
    const recommendedJson = profileId === FINAL_PROFILE
      ? [["sourceManifest", "source-manifest.json"], ["thesisAnalysis", "thesis-analysis.json"]]
      : [["sourceManifest", "source-manifest.json"]];
    for (const [key, label] of recommendedJson) {
      if (!(await exists(paths[key]))) findings.push(finding("warning", `${key}.missing`, paths[key], `${label} is recommended before asset planning.`));
      else {
        try {
          const parsed = await readJsonFile(paths[key]);
          if (key === "sourceManifest") sourceManifest = parsed;
        } catch (error) {
          findings.push(finding("error", `${key}.invalid`, paths[key], error.message));
        }
      }
    }
    if (profileId === GROUP_MEETING_PROFILE) {
      paperIndex = await validatePaperIndex(paths.paperIndex, findings, literatureMode, options.requireSchemas);
      if (paperIndex) paperAssetManifests = await validateGroupPaperManifests(projectDir, paths.paperIndex, paperIndex, findings, options.requireSchemas);
    } else if (profileId === FINAL_PROFILE) {
      if (!(await exists(paths.figuresManifest))) findings.push(finding("error", "figures.manifest.missing", paths.figuresManifest, "Figure manifest is required at the assets stage."));
      else {
        const manifest = await validateJsonAgainstBundledSchema(paths.figuresManifest, "figures-manifest.schema.json", findings, options.requireSchemas);
        if (manifest) await validateManifestFiles(projectDir, paths.figuresManifest, manifest, findings);
      }
    } else if (profileId === PROPOSAL_MIDTERM_PROFILE) {
      milestoneAnalysis = await validateMilestoneAnalysis(paths.milestoneAnalysis, config, findings, options.requireSchemas);
      if (await exists(paths.figuresManifest)) {
        const manifest = await validateJsonAgainstBundledSchema(paths.figuresManifest, "figures-manifest.schema.json", findings, options.requireSchemas);
        if (manifest) await validateManifestFiles(projectDir, paths.figuresManifest, manifest, findings);
      }
    }
    if (!(await exists(paths.evidenceIndex))) findings.push(finding("error", "evidence.index.missing", paths.evidenceIndex, "Evidence index is required at the assets stage."));
    else {
      evidenceIndex = await validateJsonAgainstBundledSchema(paths.evidenceIndex, "evidence-index.schema.json", findings, options.requireSchemas);
    }
    validateEvidenceIndexRelationships(evidenceIndex, paths, findings);
    if (profileId === PROPOSAL_MIDTERM_PROFILE) validateMilestoneAnalysisEvidence(milestoneAnalysis, evidenceIndex, paths, findings);
  }

  if (stageIncludes(targetStage, "outline")) {
    if (!(await exists(paths.outline))) findings.push(finding("error", "outline.missing", paths.outline, "PPT内容与设计大纲.md is required at the outline stage."));
    else {
      const outline = await readFile(paths.outline, "utf8");
      if (!/^#\s+/m.test(outline) || outline.trim().length < 100) findings.push(finding("warning", "outline.thin", paths.outline, "Outline has no heading or is unusually short."));
    }
  }

  if (stageIncludes(targetStage, "deck")) {
    if (!(await exists(paths.deckSpec))) findings.push(finding("error", "deck.spec.missing", paths.deckSpec, "deck-spec.json is required at the deck stage."));
    else {
      try {
        const validation = await validateDeckSpecFile(paths.deckSpec, { strict: options.strict, requireSchema: options.requireSchemas });
        for (const item of validation.issues) findings.push(finding(item.severity, `deck.${item.code}`, paths.deckSpec, `${item.path}: ${item.message}`, { strictExempt: item.strict_exempt === true }));
        const scientific = await validateScientificDesignFile(paths.deckSpec, { strict: options.strict });
        for (const item of scientific.issues) {
          const code = item.code.startsWith("scientific.") ? `deck.${item.code}` : `deck.scientific.${item.code}`;
          findings.push(finding(item.severity, code, paths.deckSpec, `${item.path}: ${item.message}`));
        }
        const deck = validation.deck;
        const resolvedDeckProfile = deckProfile(deck, profileRegistry);
        if (resolvedDeckProfile !== profileId) findings.push(finding("error", "deck.profile", paths.deckSpec, `deck profile=${resolvedDeckProfile} does not match project profile=${profileId}.`));
        if (profileId === GROUP_MEETING_PROFILE) {
          const deckMode = deck.literature?.mode;
          if (deckMode !== literatureMode) findings.push(finding("error", "deck.literature-mode", paths.deckSpec, `deck literature.mode=${deckMode ?? "missing"} does not match project literature_profile.mode=${literatureMode ?? "missing"}.`));
        }
        if (profileId === PROPOSAL_MIDTERM_PROFILE) {
          const deckMode = deck.milestone?.mode;
          if (deckMode !== milestoneMode) findings.push(finding("error", "deck.milestone-mode", paths.deckSpec, `deck milestone.mode=${deckMode ?? "missing"} does not match project milestone_profile.mode=${milestoneMode ?? "missing"}.`));
          if (milestoneMode === "midterm" && deck.milestone?.as_of_date !== config.milestone_profile?.as_of_date) findings.push(finding("error", "deck.milestone-as-of-date", paths.deckSpec, "Deck milestone.as_of_date does not match project-config."));
        }
        if (config.project?.id && deck.project_id !== config.project.id) findings.push(finding("error", "deck.project-id", paths.deckSpec, `deck project_id=${deck.project_id} does not match project-config project.id=${config.project.id}.`));
        if (config.presentation?.duration_minutes != null && deck.timing?.duration_minutes !== config.presentation.duration_minutes) findings.push(finding("error", "deck.duration", paths.deckSpec, "Deck duration_minutes does not match project-config."));
        if (config.presentation?.aspect_ratio && deck.slide_size?.ratio !== config.presentation.aspect_ratio) findings.push(finding("error", "deck.aspect-ratio", paths.deckSpec, "Deck slide_size.ratio does not match project-config presentation.aspect_ratio."));
        const policy = config.presentation?.page_policy;
        const countedSlides = policy?.include_appendix_in_count === true ? (deck.slides ?? []) : (deck.slides ?? []).filter((slide) => slide?.kind !== "appendix");
        if (policy?.mode === "fixed" && Number.isInteger(policy.target_slide_count) && countedSlides.length !== policy.target_slide_count) findings.push(finding("error", "deck.page-policy", paths.deckSpec, `Project requires ${policy.target_slide_count} counted slides; deck has ${countedSlides.length}.`));
        validateEvidenceClosure(config, sourceManifest, evidenceIndex, deck, paths, findings);
        const scientificContent = validateScientificContent({ config, paperIndex, evidenceIndex, deck, assetManifests: paperAssetManifests }, { strict: options.strict });
        for (const item of scientificContent.issues) {
          findings.push(finding(item.severity, item.code, paths.deckSpec, `${item.path}: ${item.message}`, { strictExempt: item.strict_exempt === true }));
        }
      } catch (error) {
        findings.push(finding("error", "deck.spec.invalid", paths.deckSpec, error.message));
      }
    }
  }

  if (stageIncludes(targetStage, "final")) {
    if (!(await exists(paths.finalPptx))) findings.push(finding("error", "final.missing", paths.finalPptx, "Final PPTX is missing."));
    else {
      const info = await stat(paths.finalPptx);
      const header = (await readFile(paths.finalPptx)).subarray(0, 2).toString("binary");
      if (info.size < 10_000 || header !== "PK") findings.push(finding("error", "final.invalid", paths.finalPptx, "File does not look like a valid non-empty PPTX archive."));
    }
    if (!(await isDirectory(paths.qaDir))) findings.push(finding("error", "qa.missing", paths.qaDir, "Final stage requires a QA directory with render/validation records."));
    else if ((await readdir(paths.qaDir)).length === 0) findings.push(finding("error", "qa.empty", paths.qaDir, "QA directory is empty."));
  }

  if (options.strict) for (const item of findings) if (item.severity === "warning" && item.strict_exempt !== true) item.severity = "error";
  const errors = findings.filter((item) => item.severity === "error");
  return { ok: errors.length === 0, project: projectDir, config: configPath, profile: profileId, stage: targetStage, paths, issues: findings };
}

function printHuman(result) {
  console.log(`${result.ok ? "PASS" : "FAIL"}: ${result.project} [profile=${result.profile ?? "unknown"}; stage=${result.stage}]`);
  for (const item of result.issues) console.log(`- ${item.severity.toUpperCase()} ${item.code}: ${item.message} (${item.file})`);
  const errors = result.issues.filter((item) => item.severity === "error").length;
  const warnings = result.issues.filter((item) => item.severity === "warning").length;
  console.log(`${errors} error(s), ${warnings} warning(s)`);
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
  if (!args.projectDir) {
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  try {
    const result = await validateProject(args.projectDir, args);
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else printHuman(result);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    if (args.json) console.log(JSON.stringify({ ok: false, error: error.message }, null, 2));
    else console.error(`ERROR: ${error.message}`);
    process.exitCode = 2;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) await main();
