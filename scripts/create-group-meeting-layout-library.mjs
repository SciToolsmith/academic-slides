#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createLayoutLibrary } from "./create-layout-library.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(SCRIPT_DIR, "..");
const ASSET_DIR = path.join(SKILL_DIR, "assets", "group-meeting-literature-universal");
const SPEC_PATH = path.join(ASSET_DIR, "sample-deck-spec.json");

const SOURCE_IDS = ["layout-registry", "design-tokens", "template-heritage"];
const SECTION_FOR_ORDER = (order) => order <= 6 ? "identity" : order <= 16 ? "method-evidence" : order <= 24 ? "judgment-synthesis" : "discussion-closing";

const LAYOUTS = [
  { id: "group-cover", family: "title", kind: "title", title: "组会文献汇报·学术通用｜布局库", takeaway: "封面只交代共同问题、汇报身份与阅读范围。", render: { kicker: "GROUP MEETING · LITERATURE REVIEW", subtitle: "单篇精读与多篇综合的通用视觉语言", presenter: "示范姓名", research_group: "示范课题组", date: "20XX 年 X 月" } },
  { id: "paper-agenda", family: "agenda", kind: "agenda", title: "文献地图", takeaway: "论文数量和顺序由共同问题决定，不由模板固定。", render: { papers: [
    { number: "01", title: "论文 A｜机制证据", detail: "回答“是否存在”" },
    { number: "02", title: "论文 B｜方法证据", detail: "回答“如何测量”" },
    { number: "03", title: "论文 C｜外部验证", detail: "回答“能否迁移”" },
    { number: "Q", title: "共同问题｜哪些证据会改变我们的判断？", detail: "跨论文综合" },
  ] } },
  { id: "paper-divider", family: "section", kind: "section", title: "PAPER 01｜论文精读", takeaway: "章节页用于切换问题或论文，不承担正文。", render: { part: "PAPER 01", subtitle: "From question to evidence", bridge: "先弄清论文试图解决什么，再判断证据是否足够。" } },
  { id: "paper-profile", family: "free_canvas", title: "论文档案：先核对身份，再讨论结论", takeaway: "书目信息、研究问题与一句话贡献在同一页完成定位。", visuals: 1, render: { paper: { title: "论文题目：用一句话说明研究对象与核心关系", authors: "第一作者；共同作者；通讯作者", venue: "期刊 / 会议 / 学位来源", year: "20XX", publication_type: "研究论文", doi: "DOI / PMID / arXiv（如有）", keywords: ["关键词一", "关键词二", "关键词三"], research_question: "在明确对象与条件下，作者究竟想回答什么？", one_line_contribution: "用新的证据链解释关键现象，并给出可验证预测。" } } },
  { id: "selection-rationale", family: "evidence_chain", title: "为什么选这些论文", takeaway: "选文必须服务共同问题，而不是按下载顺序罗列。", render: { criteria: [
    { title: "问题相关", body: "直接回应本组当前关心的科学问题。" },
    { title: "证据互补", body: "补充机制、方法或外部验证。" },
    { title: "存在张力", body: "结论有冲突，或边界不同。" },
  ] } },
  { id: "known-gap-question", family: "evidence_chain", title: "从已知到缺口，再到研究问题", takeaway: "研究问题必须由证据缺口自然推出。", render: { known: "既有研究已确认现象存在，但主要依赖单一场景与替代指标。", gap: "缺少直接机制证据，也不清楚结论能否跨样本迁移。", question: "哪条机制链真正驱动该现象，且在什么边界内成立？", boundary: "已知、缺口和问题应来自论文文本与证据，而不是套用固定三段式。" } },
  { id: "concept-framework", family: "system_architecture", title: "概念框架：变量如何共同形成可检验解释", takeaway: "只有真实存在输入—机制—输出—边界关系时才绘制框架。", diagram: [
    ["context", "研究情境", "input"], ["mechanism", "核心机制", "process"], ["outcome", "可观测结果", "output"], ["boundary", "适用边界", "context"], ["evidence", "关键证据", "evidence"],
  ], render: {} },
  { id: "study-design", family: "method_design", title: "研究设计：从样本到结论的证据链", takeaway: "把设计顺序、关键控制和最终输出一起展示。", diagram: [
    ["sample", "样本与分组", "input"], ["measure", "测量与干预", "process"], ["analysis", "分析与对照", "process"], ["validation", "稳健性检查", "evidence"], ["result", "主要结论", "output"],
  ], render: {} },
  { id: "method-sequence", family: "process_flow", title: "方法时间线：每一步解决一个不确定性", takeaway: "方法页强调为什么这样做，不罗列软件按钮。", diagram: [
    ["m1", "构建数据集", "input"], ["m2", "识别关键模式", "process"], ["m3", "机制验证", "evidence"], ["m4", "外部复核", "output"],
  ], render: { events: [
    { title: "样本准备", caption: "定义对象与排除标准" }, { title: "模式识别", caption: "发现候选关系" }, { title: "机制检验", caption: "排除替代解释" }, { title: "外部验证", caption: "检查可迁移性" },
  ] } },
  { id: "method-comparison", family: "case_matrix", title: "方法比较：不同路径回答不同问题", takeaway: "选择方法要与研究问题和证据强度匹配。", render: { table: { headers: ["方法", "回答的问题", "优势", "主要风险"], rows: [
    ["观察研究", "是否相关", "真实场景", "混杂偏倚"], ["干预实验", "是否因果", "控制明确", "外部效度"], ["模型分析", "机制是否自洽", "可检验预测", "假设依赖"],
  ] } } },
  { id: "sample-data-profile", family: "method_design", title: "样本与数据：先交代可比性，再解释结果", takeaway: "样本结构与质量控制决定结论可以外推多远。", metrics: [["样本规模", "N=XX", null], ["数据模态", "3", "类"], ["关键分组", "2", "组"], ["时间点", "4", "个"]], render: { data_layers: [
    { title: "研究对象", body: "来源、纳入标准与关键分层。" }, { title: "测量与数据", body: "指标、数据模态与时间尺度。" }, { title: "质量控制", body: "缺失处理、批次效应与偏倚控制。" },
  ] } },
  { id: "single-result-evidence", family: "hero_figure", title: "单一关键结果：主图占据视觉中心", takeaway: "主结果在核心条件下显著改变，并由独立分析支持。", visuals: 1, bullets: ["先读坐标和对照", "再说差异方向与量级", "说明结果意义"], metrics: [["效应变化", "+32", "%"]], render: { conclusion_text: "作者据此提出核心机制，但仍需结合样本边界判断。" } },
  { id: "result-compare", family: "comparison", title: "结果对照：同一尺度下比较才有意义", takeaway: "差异来自关键条件变化，而非坐标或样本口径不同。", visuals: 2, render: { left_label: "基线 / 对照", right_label: "干预 / 目标条件", left_text: "共同尺度下的基线观察", right_text: "共同尺度下的差异观察" } },
  { id: "multi-result-evidence", family: "comparison", title: "多证据并列：每张图承担不同证据角色", takeaway: "现象、机制和外部验证共同决定结论可信度。", visuals: 3, render: { items: [
    { title: "现象证据", body: "先确认主要变化。" }, { title: "机制证据", body: "解释变化如何发生。" }, { title: "验证证据", body: "检查是否可复现。" },
  ] } },
  { id: "table-chart-result", family: "chart_insight", title: "图表结果：趋势之后必须给出解释", takeaway: "效应随条件增强，但在高水平区域出现平台。", metrics: [["相对基线", "+23.8", "%"]], render: { chart: { type: "bar", categories: ["基线", "低", "中", "高"], series: [{ name: "相对响应", values: [42, 48, 51, 52] }] } } },
  { id: "mechanism-explanation", family: "hero_figure", title: "机制解释：图中关系必须能被口头逐步追踪", takeaway: "关键中介连接输入与输出，并受边界条件调节。", visuals: 1, bullets: ["输入首先改变关键中介", "中介再驱动可观测输出", "边界条件决定效应是否成立"], metrics: [["关键路径", "1", "条"]] },
  { id: "claim-evidence-boundary", family: "evidence_chain", title: "把作者主张、证据与边界分开", takeaway: "作者声称不等于汇报者认同。", text_emphasis: [{ text: "因果强度", role: "key" }], render: { claim: "作者认为关键中介是现象变化的主要驱动因素。", evidence: [{ title: "直接证据", body: "干预中介后主要结果同步变化。" }, { title: "一致性证据", body: "独立方法得到相同方向结果。" }], boundary: "现有证据尚不能排除长期适应与样本选择的影响。", verdict: "可接受机制方向，但因果强度和适用范围仍需验证。" } },
  { id: "paper-conclusion", family: "summary", title: "单篇论文结论：发现、依据与未证明内容", takeaway: "一页完成“发现—证据—边界”的论文收束。", render: { finding: "关键中介在目标条件下改变主要结果。", support: "干预、对照和独立样本提供方向一致的证据。", not_proven: "尚未证明该机制在所有场景或长期尺度都成立。", one_line: "核心结论可作为工作假设，而不是无条件事实。" } },
  { id: "critical-appraisal", family: "contribution_limits", title: "批判性阅读：同时回答可信与不可信之处", takeaway: "综合判断哪些结论可采纳，哪些仍需本组验证。", render: { strengths: ["研究问题与设计匹配", "关键对照充分", "结论边界较清楚"], risks: ["样本外推受限", "替代解释未完全排除", "部分复现信息缺失"], verdict: "证据足以支持方向性判断，但不足以支持广泛因果外推。" } },
  { id: "reproducibility-check", family: "validation_matrix", title: "可复现性：从数据可得走到外部验证", takeaway: "可复现性不是一个标签，而是四层逐步核查。", render: { checks: [
    { title: "数据可得", body: "原始数据、纳排规则与预处理。", status: "部分" }, { title: "方法可复现", body: "参数、代码、软件版本与随机性。", status: "可核" }, { title: "结果可重算", body: "主要图表与统计口径能够追踪。", status: "待做" }, { title: "外部可验证", body: "独立样本或替代方法支持。", status: "不足" },
  ] } },
  { id: "cross-paper-matrix", family: "case_matrix", title: "跨论文矩阵：统一比较轴后再综合", takeaway: "样本、方法和结论口径不同，不能只比较标题结论。", render: { table: { headers: ["论文", "对象 / 样本", "方法", "核心结论", "主要边界"], rows: [
    ["论文 A", "对象 1", "干预实验", "支持机制", "单一场景"], ["论文 B", "对象 2", "观察数据", "方向一致", "混杂风险"], ["论文 C", "外部样本", "复现研究", "部分支持", "效应较弱"],
  ] } } },
  { id: "consensus-divergence", family: "evidence_chain", title: "一致、冲突与原因要同时出现", takeaway: "冲突往往来自样本、测量或边界，而非简单的“谁对谁错”。", render: { consensus: ["关键现象方向一致", "核心中介被多方法观察到"], divergence: ["效应量差异明显", "外部样本仅部分复现"], explanations: ["样本构成不同", "测量时间窗不同", "控制变量不一致"] } },
  { id: "evidence-quality-map", family: "chart_insight", title: "证据地图：强度与适用性是两个维度", takeaway: "优先讨论证据强但迁移边界不清的关键论文。", render: { points: [
    { label: "论文 A", x: 0.78, y: 0.55, size: 36 }, { label: "论文 B", x: 0.52, y: 0.78, size: 30 }, { label: "论文 C", x: 0.36, y: 0.44, size: 28 },
  ], criteria: [{ title: "横轴", body: "设计、对照、统计与复现决定证据强度。" }, { title: "纵轴", body: "样本与情境决定外部适用性。" }, { title: "用途", body: "把高价值不确定性变成讨论重点。" }] } },
  { id: "research-evolution", family: "process_flow", title: "研究演进：问题如何被一轮轮收窄", takeaway: "时间线展示证据演进，不机械罗列发表年份。", render: { events: [
    { title: "现象发现", caption: "确认问题存在" }, { title: "候选机制", caption: "提出可检验解释" }, { title: "因果干预", caption: "排除替代解释" }, { title: "外部复核", caption: "明确适用边界" },
  ] } },
  { id: "transfer-to-our-work", family: "process_flow", title: "从论文结论迁移到本组动作", takeaway: "迁移前先核对对象、尺度、工况与评价指标。", render: { paper_finding: "论文给出可检验机制与测量路径。", transfer_logic: "对象相似，但尺度和边界不同。", next_action: "先完成最小验证，再决定是否扩展。", caveat: "可借鉴的是证据逻辑，不是把论文结论原封不动搬到本组。" } },
  { id: "discussion-questions", family: "free_canvas", kind: "questions", title: "讨论问题：形成新的判断", takeaway: "讨论题应能改变判断、实验或阅读计划。", render: { questions: ["哪个替代解释最值得优先排除？", "若迁移到本组对象，首个验证实验应是什么？", "哪项证据最可能改变我们的判断？", "不同论文冲突的最小解释是什么？"] } },
  { id: "decision-request", family: "free_canvas", title: "需要组会形成什么决定", takeaway: "本次组会希望确定下一步验证优先级。", render: { decision: "我们是否应把这条机制列为下一阶段的优先验证假设？", options: [{ title: "立即验证", body: "科学价值高，已有最小实验条件" }, { title: "先补证据", body: "先核对关键参数与外部数据" }, { title: "暂不推进", body: "与本组主线或资源不匹配" }], criterion: "按科学价值、可验证性和资源成本共同决策。" } },
  { id: "next-reading-actions", family: "summary", title: "下一步阅读与验证安排", takeaway: "把组会结论转成责任明确、输出清楚的后续动作。", render: { actions: [
    { title: "补读关键方法", body: "参数、假设与可复用步骤", owner: "成员 A｜下次组会前" }, { title: "核对冲突证据", body: "统一比较矩阵与差异解释", owner: "成员 B｜本周" }, { title: "形成验证方案", body: "最小实验、判据与资源清单", owner: "成员 C｜两周内" },
  ] } },
  { id: "selected-sources", family: "summary", title: "本次汇报精选来源", takeaway: "只列真正进入论证链的论文、数据和方法来源。", render: { group_labels: ["焦点论文", "方法与背景来源"], references: [
    "[1] 焦点论文 A：完整作者. 完整题名. 期刊/会议, 年份. DOI.", "[2] 焦点论文 B：完整作者. 完整题名. 期刊/会议, 年份. DOI.", "[3] 焦点论文 C：完整作者. 完整题名. 期刊/会议, 年份. DOI.", "[4] 关键方法来源：作者. 题名. 来源, 年份.", "[5] 数据或标准来源：机构. 名称. 版本/年份.", "[6] 补充材料或代码仓库：名称与稳定链接.",
  ] } },
  { id: "group-closing", family: "closing", kind: "closing", title: "讨论与下一步", takeaway: "把阅读结论转成可检验假设和明确行动。", render: { synthesis: "这组论文支持一条可检验的机制方向，但外部适用性仍是当前最大不确定性。", prompts: ["接受哪项结论？", "还缺哪项证据？", "下一步由谁完成？"], presenter: "示范课题组 · 文献汇报" } },
];

function falseFormula() {
  return { include: false, reason: "本页不需要公式；只有承担核心定义、方法、约束或结果解释时才加入。", equation_ref: null, latex: null, role: "none", variables_to_explain: [], plain_meaning: null, source_refs: [], asset_ref: null, fallback_asset_ref: null };
}

function makeDiagram(nodes) {
  if (!nodes?.length) return { include: false, reason: "本页不需要额外关系图。", source_refs: [], type: "none", direction: "none", nodes: [], edges: [], output: null, asset_ref: null };
  const normalized = nodes.map(([id, label, role], index) => ({ id, label, role, detail: index === 0 ? "从问题与证据出发" : null, source_refs: ["template-heritage"] }));
  return {
    include: true, reason: "内容包含三步以上的顺序或依赖关系，关系图比列表更清楚。", source_refs: ["template-heritage"], type: "process", direction: "left_to_right", nodes: normalized,
    edges: normalized.slice(0, -1).map((node, index) => ({ from: node.id, to: normalized[index + 1].id, relation: "sequence", label: null })), output: "形成可追踪的证据关系", asset_ref: null,
  };
}

function makeVisuals(count, layoutId) {
  return Array.from({ length: count || 0 }, (_, index) => ({
    id: `${layoutId}-visual-${index + 1}`, type: "figure", role: count > 1 ? "comparison" : "primary_evidence", include: true,
    rationale: "版式画廊用占位资产验证图片面积、比例与解释层级；正式项目必须替换为真实论文证据。",
    asset_ref: `sample:${layoutId}-evidence-${index + 1}`, source_refs: ["template-heritage"], caption: `证据图 ${index + 1}`, alt_text: "论文证据图示意槽位", placement: "主证据区", crop: "contain", highlight: null, transformations: [],
  }));
}

function contentFor(entry) {
  return {
    kicker: entry.kind === "section" ? "PAPER / TOPIC TRANSITION" : null,
    title: entry.title,
    subtitle: entry.kind === "title" ? "GROUP MEETING · LITERATURE REVIEW" : null,
    body: [],
    bullets: (entry.bullets ?? []).map((text) => ({ text, level: 0, emphasis: "none", evidence_refs: ["template-heritage"] })),
    metrics: (entry.metrics ?? []).map(([label, value, unit]) => ({ label, value, unit, comparison: null, evidence_ref: "template-heritage" })),
    quote: null,
    callout: null,
    visible_source_labels: [],
    footer: null,
  };
}

function makeSlide(entry, index) {
  const order = index + 1;
  const nextTitle = LAYOUTS[index + 1]?.title ?? "讨论与下一步";
  const estimated = entry.kind === "title" || entry.kind === "section" || entry.kind === "closing" ? 8 : 12;
  return {
    id: `sample-${entry.id}`,
    order,
    kind: entry.kind ?? "content",
    section_id: SECTION_FOR_ORDER(order),
    purpose: `示范 ${entry.id} 的通用语义、布局边界与视觉层级。`,
    audience_question: `什么内容关系适合使用 ${entry.id}？`,
    takeaway: entry.takeaway,
    priority: "supporting",
    content: contentFor(entry),
    layout: {
      family: entry.family,
      variant: entry.id,
      rationale: `仅当内容关系自然匹配 ${entry.id} 的 useWhen 时采用；否则改用其他布局或自由画布。`,
      reading_order: ["标题", "主证据或关系", "解释与边界"],
      regions: [],
      density: ["group-cover", "paper-divider", "group-closing"].includes(entry.id) ? "sparse" : "balanced",
    },
    claim_ids: [],
    evidence_refs: SOURCE_IDS,
    visuals: makeVisuals(entry.visuals, entry.id),
    text_emphasis: entry.text_emphasis ?? [],
    formula: falseFormula(),
    diagram: makeDiagram(entry.diagram),
    speaker_notes: {
      script: `本页示范“${entry.title}”。${entry.takeaway} 正式使用时先判断内容关系，再决定是否采用这个注册布局；不自然匹配时直接使用受设计令牌约束的自由画布。`,
      transition: `下一页进入“${nextTitle}”。`,
      estimated_seconds: estimated,
      sources: [
        { source_id: "layout-registry", locator: `layoutId=${entry.id}`, citation: `组会文献汇报通用版式注册表：${entry.id}`, purpose: "版式语义与使用边界" },
        { source_id: "template-heritage", locator: `layoutId=${entry.id}`, citation: "K105 组会文献汇报参考模板的 clean-generated 迁移记录", purpose: "视觉语言来源与去污染边界" },
      ],
      delivery_cues: ["先说明这一页解决的交流问题，再说明证据与边界。"],
    },
    render_data: entry.render ?? {},
    qa: { status: "not_checked", issues: [] },
  };
}

function createSpec() {
  const slides = LAYOUTS.map(makeSlide);
  const estimated = slides.reduce((sum, slide) => sum + slide.speaker_notes.estimated_seconds, 0);
  return {
    schema_version: "1.1",
    project_id: "group-meeting-literature-layout-library",
    profile: "group_meeting_literature",
    literature: { mode: "multi_paper", focal_paper_ids: ["paper-a", "paper-b", "paper-c"], synthesis_question: "哪些证据真正改变了我们对共同问题的判断？" },
    title: "组会文献汇报·学术通用｜布局库",
    language: "zh-CN",
    slide_size: { ratio: "16:9", width_inches: 13.333, height_inches: 7.5 },
    timing: { duration_minutes: 8, usable_fraction: 0.75, target_seconds: 360, estimated_seconds: estimated, approximate: true, page_policy: "fixed", target_slide_count: LAYOUTS.length, timing_notes: ["本文件是一页一布局的视觉画廊，不是正式组会页序或时长建议。", "页数、论文数与章节数由真实证据结构决定。"] },
    theme: {
      id: "group-meeting-literature-blue", mode: "preset", preset: "blue", institution: null, verified_logo_asset_id: null,
      colors: { primary: "#32497B", primary_dark: "#24355D", primary_light: "#E8EDF6", accent: "#C7922C", background: "#FFFFFF", surface: "#F4F6F9", text: "#17213A", muted_text: "#5D667A", warning: "#B46A2C", chart_series: ["#32497B", "#6C86B3", "#2F766D", "#C7922C", "#7B5A8E", "#A63C45"] },
      fonts: { heading: "Microsoft YaHei", body: "Microsoft YaHei", latin: "Arial", math: "Latin Modern Math" },
    },
    sections: [
      { id: "identity", order: 1, title: "起始与选文", short_title: "起始与选文", role: "publication", purpose: "说明共同问题、论文范围与论文身份。" },
      { id: "method-evidence", order: 2, title: "方法与证据", short_title: "方法与证据", role: "method", purpose: "呈现研究设计、方法和核心结果。" },
      { id: "judgment-synthesis", order: 3, title: "判断与综合", short_title: "判断与综合", role: "synthesis", purpose: "区分主张、证据、边界并完成跨论文综合。" },
      { id: "discussion-closing", order: 4, title: "讨论与收束", short_title: "讨论与收束", role: "discussion", purpose: "把阅读转化为讨论、决策和下一步。" },
    ],
    sources: [
      { id: "layout-registry", type: "user_material", title: "组会文献汇报通用版式注册表", citation: "academic-slides/assets/group-meeting-literature-universal/layout-registry.json", document_id: null, paper_id: null, path: "layout-registry.json", url: null, creator: "academic-slides", published_at: null, accessed_at: null, source_nature: "author_original", verification_status: "verified", notes: "定义布局语义和使用边界。" },
      { id: "design-tokens", type: "user_material", title: "组会文献汇报设计令牌", citation: "academic-slides/assets/group-meeting-literature-universal/design-tokens.json", document_id: null, paper_id: null, path: "design-tokens.json", url: null, creator: "academic-slides", published_at: null, accessed_at: null, source_nature: "author_original", verification_status: "verified", notes: "定义字体、色彩、间距和投影安全尺度。" },
      { id: "template-heritage", type: "user_material", title: "K105 参考模板迁移映射", citation: "academic-slides/assets/group-meeting-literature-universal/template-map.json", document_id: null, paper_id: null, path: "template-map.json", url: null, creator: "academic-slides", published_at: null, accessed_at: null, source_nature: "author_original", verification_status: "verified", notes: "只记录视觉 heritage；新库为 clean-generated，不复制示例论文事实或对象 ID。" },
    ],
    slides,
    claim_evidence_map: [],
    qa: { status: "not_checked", issues: [], checks: { schema: "not_checked", evidence: "not_checked", narrative: "not_checked", visual: "not_checked", technical: "not_checked", notes_sources: "not_checked" }, checked_at: null },
  };
}

export async function createGroupMeetingLayoutLibrary() {
  await fs.mkdir(ASSET_DIR, { recursive: true });
  await fs.writeFile(SPEC_PATH, `${JSON.stringify(createSpec(), null, 2)}\n`, "utf8");
  return createLayoutLibrary("group_meeting_literature");
}

async function main() {
  try {
    console.log(JSON.stringify(await createGroupMeetingLayoutLibrary(), null, 2));
  } catch (error) {
    console.error(`GROUP MEETING LAYOUT LIBRARY BUILD FAILED: ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}

const direct = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (direct) await main();
