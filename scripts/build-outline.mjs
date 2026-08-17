#!/usr/bin/env node

import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { validateDeckSpecFile } from "./validate-deck-spec.mjs";

function usage() {
  return [
    "Usage: node build-outline.mjs <deck-spec.json> [output.md] [options]",
    "",
    "Options:",
    "  -o, --output <file>  Output path (default: PPT内容与设计大纲.md beside deck-spec)",
    "  --stdout             Print Markdown instead of writing a file",
    "  --force              Replace an existing output file",
    "  --check              Exit non-zero when the existing output is stale",
    "  --schema <file>      Override deck-spec schema path",
    "  --strict             Require strict deck-spec semantic validation",
    "  -h, --help           Show this help",
  ].join("\n");
}

function parseArgs(argv) {
  const result = { stdout: false, force: false, check: false, strict: false };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--stdout") result.stdout = true;
    else if (arg === "--force") result.force = true;
    else if (arg === "--check") result.check = true;
    else if (arg === "--strict") result.strict = true;
    else if (arg === "--output" || arg === "-o") {
      if (!argv[index + 1]) throw new Error(`${arg} requires a file path.`);
      result.output = argv[++index];
    } else if (arg === "--schema") {
      if (!argv[index + 1]) throw new Error("--schema requires a file path.");
      result.schemaPath = argv[++index];
    } else if (arg === "-h" || arg === "--help") result.help = true;
    else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else positional.push(arg);
  }
  if (positional.length > 2) throw new Error("Too many positional arguments.");
  result.specPath = positional[0];
  result.output ??= positional[1];
  if (result.stdout && result.output) throw new Error("--stdout cannot be combined with an output path.");
  if (result.check && result.stdout) throw new Error("--check cannot be combined with --stdout.");
  return result;
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function text(value, fallback = "—") {
  if (nonEmpty(value)) return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

function escapeTable(value) {
  return text(value).replaceAll("|", "\\|").replaceAll("\n", "<br>");
}

function inlineList(values) {
  if (!Array.isArray(values) || values.length === 0) return "—";
  const rendered = values
    .map((value) => {
      if (nonEmpty(value)) return value.trim();
      if (value && typeof value === "object") {
        if (value.symbol && value.meaning) return `${value.symbol}：${value.meaning}${value.unit ? `（${value.unit}）` : ""}`;
        if (value.citation) return value.locator ? `${value.citation}（${value.locator}）` : value.citation;
        if (value.label && value.value != null) return `${value.label}：${value.value}${value.unit ?? ""}`;
        return value.id ?? value.label ?? value.text ?? value.value ?? JSON.stringify(value);
      }
      return String(value ?? "");
    })
    .filter(Boolean);
  return rendered.length ? rendered.join("、") : "—";
}

function timingSeconds(slide) {
  const notes = slide.speaker_notes ?? {};
  const candidate = notes.estimated_seconds ?? notes.duration_sec ?? notes.duration_seconds ?? slide.duration_sec ?? slide.timing_sec;
  return Number.isFinite(candidate) ? candidate : null;
}

function formatTiming(slide) {
  const seconds = timingSeconds(slide);
  if (seconds == null) return "—";
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`;
}

function contentTitle(slide) {
  return slide.content?.title ?? slide.title ?? slide.takeaway ?? slide.purpose ?? slide.id;
}

function summarizeContent(content) {
  if (content == null) return [];
  if (typeof content === "string") return [content];
  if (Array.isArray(content)) return content.map((item) => (typeof item === "string" ? item : JSON.stringify(item)));
  const lines = [];
  const labels = {
    kicker: "眉题",
    subtitle: "副标题",
    body: "正文",
    bullets: "要点",
    metrics: "关键数字",
    quote: "引文",
    callout: "强调",
    visible_source_labels: "可见来源",
    footer: "页脚",
  };
  for (const [key, value] of Object.entries(content)) {
    if (key === "title" || value == null || value === "") continue;
    const label = labels[key] ?? key;
    if (Array.isArray(value)) {
      if (value.length) lines.push(`${label}：${inlineList(value)}`);
    } else if (typeof value === "object") {
      if (Object.keys(value).length) {
        const rendered = value.text ? `${value.text}${value.analysis ? `；分析：${value.analysis}` : ""}` : JSON.stringify(value);
        lines.push(`${label}：${rendered}`);
      }
    } else lines.push(`${label}：${String(value)}`);
  }
  return lines;
}

function visualSummary(visuals) {
  if (!Array.isArray(visuals) || visuals.length === 0) return "不设置主视觉或待决定";
  return visuals
    .map((visual) => {
      if (typeof visual === "string") return visual;
      const kind = visual.kind ?? visual.type ?? "visual";
      const purposeText = visual.purpose ?? visual.rationale ?? visual.role;
      const purpose = purposeText ? `：${purposeText}` : "";
      const refs = visual.asset_refs ?? (visual.asset_ref ? [visual.asset_ref] : []);
      return `${kind}${purpose}${refs.length ? `（${inlineList(refs)}）` : ""}`;
    })
    .join("；");
}

function formulaSummary(formula) {
  if (!formula || formula.include !== true) return `不插入${nonEmpty(formula?.reason) ? `：${formula.reason}` : ""}`;
  const identity = formula.equation_ref ?? formula.role ?? "核心公式";
  const reason = nonEmpty(formula.reason) ? `；理由：${formula.reason}` : "";
  const meaning = nonEmpty(formula.plain_meaning) ? `；含义：${formula.plain_meaning}` : "";
  return `插入 ${identity}${reason}${meaning}`;
}

function speakerText(notes) {
  if (!notes || typeof notes !== "object") return null;
  return notes.talk_track ?? notes.script ?? notes.narration ?? notes.body ?? notes.text ?? null;
}

function diagramSummary(diagram) {
  if (!diagram || diagram.include !== true) return `不绘制${nonEmpty(diagram?.reason) ? `：${diagram.reason}` : ""}`;
  const nodeCount = Array.isArray(diagram.nodes) ? diagram.nodes.length : 0;
  const edgeCount = Array.isArray(diagram.edges) ? diagram.edges.length : 0;
  const reason = nonEmpty(diagram.reason) ? `；理由：${diagram.reason}` : "";
  const output = nonEmpty(diagram.output) ? `；输出：${diagram.output}` : "";
  return `绘制 ${text(diagram.direction, "未定方向")} 流程/关系图（${nodeCount} 节点、${edgeCount} 连线）${reason}${output}`;
}

function sectionName(deck, slide) {
  const direct = slide.section ?? slide.section_title;
  if (nonEmpty(direct)) return direct;
  const sectionId = slide.section_id;
  if (!sectionId || !Array.isArray(deck.sections)) return "—";
  const section = deck.sections.find((item) => item?.id === sectionId);
  return section?.title ?? section?.name ?? sectionId;
}

function evidenceForSlide(slide) {
  const refs = new Set(Array.isArray(slide.evidence_refs) ? slide.evidence_refs : []);
  for (const entry of slide.claim_evidence_map ?? []) {
    for (const ref of entry?.evidence_refs ?? entry?.refs ?? []) refs.add(ref);
  }
  for (const ref of slide.formula?.source_refs ?? []) refs.add(ref);
  for (const ref of slide.diagram?.source_refs ?? []) refs.add(ref);
  return [...refs].filter(nonEmpty);
}

function presentationProfile(deck) {
  return deck?.profile ?? deck?.presentation_profile ?? deck?.presentation?.type ?? "final_defense";
}

function outlineVocabulary(profile, deck) {
  if (profile === "group_meeting_literature") {
    return {
      defaultTitle: "组会文献汇报",
      strategyHeading: "组会汇报策略",
      durationLabel: "汇报时长",
      takeawayLabel: "核心判断",
      overviewTitle: "标题 / 一句话判断",
    };
  }
  if (profile === "proposal_midterm") {
    const mode = deck?.milestone?.mode;
    return {
      defaultTitle: mode === "midterm" ? "中期汇报" : "开题答辩",
      strategyHeading: mode === "midterm" ? "中期汇报策略" : "开题答辩策略",
      durationLabel: "汇报时长",
      takeawayLabel: mode === "midterm" ? "阶段判断" : "核心主张",
      overviewTitle: "标题 / 一句话判断",
    };
  }
  return {
    defaultTitle: "学术答辩",
    strategyHeading: "答辩策略",
    durationLabel: "总时长",
    takeawayLabel: "核心结论",
    overviewTitle: "标题 / 一句话结论",
  };
}

function paperRefsForSlide(deck, slide) {
  const refs = new Set();
  for (const value of slide?.paper_refs ?? []) if (nonEmpty(value)) refs.add(value.trim());
  for (const value of [slide?.paper_id, slide?.paper_ref, slide?.literature?.paper_id, slide?.content?.paper_id]) if (nonEmpty(value)) refs.add(value.trim());
  const sourcesById = new Map((Array.isArray(deck?.sources) ? deck.sources : []).map((source) => [source?.id, source]));
  for (const evidenceRef of evidenceForSlide(slide)) {
    const paperId = sourcesById.get(evidenceRef)?.paper_id;
    if (nonEmpty(paperId)) refs.add(paperId.trim());
  }
  return [...refs];
}

function paperCount(deck) {
  for (const candidate of [deck?.literature?.focal_paper_ids, deck?.papers, deck?.literature?.papers, deck?.paper_index?.papers]) {
    if (Array.isArray(candidate)) return candidate.length;
  }
  return null;
}

export function buildOutlineMarkdown(deck, sourceName = "deck-spec.json") {
  const slides = [...(Array.isArray(deck.slides) ? deck.slides : [])].sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
  const profile = presentationProfile(deck);
  const vocabulary = outlineVocabulary(profile, deck);
  const lines = [];
  lines.push(`# ${text(deck.title, vocabulary.defaultTitle)}｜PPT 内容与设计大纲`, "");
  lines.push(`> 由 \`${sourceName}\` 生成。页面 ID 是稳定标识，增删页面时不应复用。`, "");
  lines.push(`## ${vocabulary.strategyHeading}`, "");
  lines.push(`- 项目：${text(deck.project_id)}`);
  lines.push(`- 语言：${text(deck.language)}`);
  const slideRatio = typeof deck.slide_size === "object" ? deck.slide_size?.ratio : deck.slide_size;
  lines.push(`- 幻灯片比例：${text(slideRatio)}`);
  const totalMinutes = deck.timing?.duration_minutes ?? deck.timing?.total_minutes ?? deck.timing?.minutes;
  lines.push(`- ${vocabulary.durationLabel}：${totalMinutes != null ? `${totalMinutes} 分钟` : "—"}`);
  lines.push(`- 页面数：${slides.length}`);
  if (profile === "group_meeting_literature") {
    const mode = deck.literature?.mode;
    lines.push(`- 文献模式：${mode === "single_paper" ? "单篇文献" : mode === "multi_paper" ? "多篇文献" : text(mode)}`);
    const count = paperCount(deck);
    if (count != null) lines.push(`- 文献数：${count}`);
  }
  if (profile === "proposal_midterm") {
    const mode = deck.milestone?.mode;
    lines.push(`- 评审阶段：${mode === "proposal" ? "开题" : mode === "midterm" ? "中期" : text(mode)}`);
    if (mode === "midterm") lines.push(`- 进展截止日：${text(deck.milestone?.as_of_date)}`);
    lines.push(`- 计划基线文档：${inlineList(deck.milestone?.plan_document_ids)}`);
    lines.push(`- 进展文档：${inlineList(deck.milestone?.progress_document_ids)}`);
    lines.push(`- 工作包：${(deck.milestone?.work_packages ?? []).map((item) => `${text(item.title)}（${text(item.status)}）`).join("、") || "—"}`);
  }
  if (deck.theme) {
    const themeLabel = typeof deck.theme === "string" ? deck.theme : `${text(deck.theme.id)}${deck.theme.mode ? `（${deck.theme.mode}）` : ""}`;
    lines.push(`- 主题：${themeLabel}`);
  }
  lines.push("", "## 页面总览", "");
  lines.push(`| 页 | ID | 章节 | ${vocabulary.overviewTitle} | 页面任务 | 主视觉 | 时间 |`);
  lines.push("|---:|---|---|---|---|---|---:|");
  slides.forEach((slide, index) => {
    lines.push(`| ${slide.order ?? index + 1} | ${escapeTable(slide.id)} | ${escapeTable(sectionName(deck, slide))} | ${escapeTable(contentTitle(slide))} | ${escapeTable(slide.purpose)} | ${escapeTable(visualSummary(slide.visuals))} | ${escapeTable(formatTiming(slide))} |`);
  });

  for (const [index, slide] of slides.entries()) {
    const page = slide.order ?? index + 1;
    lines.push("", `## ${text(slide.id, `S${String(page).padStart(2, "0")}`)}｜第 ${page} 页｜${text(contentTitle(slide), "未命名页面")}`, "");
    lines.push(`- 页面类型：${text(slide.kind)}`);
    lines.push(`- 所属章节：${text(sectionName(deck, slide))}`);
    const paperRefs = paperRefsForSlide(deck, slide);
    if (profile === "group_meeting_literature" && paperRefs.length) lines.push(`- 对应文献：${inlineList(paperRefs)}`);
    if (profile === "proposal_midterm" && Array.isArray(slide.narrative_roles) && slide.narrative_roles.length) lines.push(`- 叙事任务：${inlineList(slide.narrative_roles)}`);
    lines.push(`- 页面任务：${text(slide.purpose)}`);
    lines.push(`- ${vocabulary.takeawayLabel}：${text(slide.takeaway)}`);
    const question = slide.audience_question ?? slide.question ?? slide.narrative?.question;
    if (nonEmpty(question)) lines.push(`- 回答的问题：${question}`);
    const contentLines = summarizeContent(slide.content);
    lines.push(`- 可见内容：${contentLines.length ? "" : "—"}`);
    for (const item of contentLines) lines.push(`  - ${item}`);
    lines.push(`- 主证据：${inlineList(evidenceForSlide(slide))}`);
    lines.push(`- 主视觉：${visualSummary(slide.visuals)}`);
    if (slide.formula?.include === true) {
      lines.push(`- 公式：${formulaSummary(slide.formula)}`);
      if (Array.isArray(slide.formula.variables_to_explain) && slide.formula.variables_to_explain.length) {
        lines.push(`- 公式变量：${inlineList(slide.formula.variables_to_explain)}`);
      }
    }
    if (slide.diagram?.include === true) lines.push(`- 流程图 / 关系图：${diagramSummary(slide.diagram)}`);
    const layoutId = slide.layout?.variant ?? slide.layout?.layout_id ?? slide.layout?.id ?? slide.layout?.family;
    const layoutReasonText = slide.layout?.rationale ?? slide.layout?.reason;
    const layoutReason = layoutReasonText ? `；${layoutReasonText}` : "";
    lines.push(`- 排版：${text(layoutId)}${layoutReason}`);
    lines.push(`- 建议讲述时间：${formatTiming(slide)}`);
    const talkTrack = speakerText(slide.speaker_notes);
    if (nonEmpty(talkTrack)) lines.push(`- 发言要点：${talkTrack}`);
    const sources = slide.speaker_notes?.sources;
    if (Array.isArray(sources)) lines.push(`- 来源：${inlineList(sources)}`);
    const transition = slide.speaker_notes?.transition ?? slide.speaker_notes?.transition_out ?? slide.transition_out ?? slide.narrative?.transition_out;
    if (nonEmpty(transition)) lines.push(`- 下一页衔接：${transition}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
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
  if (!args.specPath) {
    console.error(usage());
    process.exitCode = 2;
    return;
  }

  try {
    const specPath = path.resolve(args.specPath);
    const validation = await validateDeckSpecFile(specPath, { schemaPath: args.schemaPath, strict: args.strict });
    const validationErrors = validation.issues.filter((item) => item.severity === "error");
    if (validationErrors.length) {
      for (const item of validationErrors) console.error(`ERROR ${item.code} ${item.path}: ${item.message}`);
      throw new Error(`Deck spec has ${validationErrors.length} validation error(s); outline was not generated.`);
    }
    const markdown = buildOutlineMarkdown(validation.deck, path.basename(specPath));
    if (args.stdout) {
      process.stdout.write(markdown);
      return;
    }
    const outputPath = path.resolve(args.output ?? path.join(path.dirname(specPath), "PPT内容与设计大纲.md"));
    if (args.check) {
      if (!(await exists(outputPath))) {
        console.error(`STALE: output does not exist: ${outputPath}`);
        process.exitCode = 1;
        return;
      }
      const current = await readFile(outputPath, "utf8");
      if (current !== markdown) {
        console.error(`STALE: ${outputPath} does not match ${specPath}`);
        process.exitCode = 1;
      } else console.log(`CURRENT: ${outputPath}`);
      return;
    }
    if ((await exists(outputPath)) && !args.force) throw new Error(`Output exists; use --force to replace it: ${outputPath}`);
    await writeFile(outputPath, markdown, "utf8");
    console.log(`WROTE: ${outputPath}`);
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = process.exitCode || 1;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) await main();
