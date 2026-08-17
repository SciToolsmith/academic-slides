#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createLayoutLibrary } from "./create-layout-library.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(SCRIPT_DIR, "..");
const ASSET_DIR = path.join(SKILL_DIR, "assets", "proposal-midterm-universal");
const REGISTRY_PATH = path.join(ASSET_DIR, "layout-registry.json");
const SPEC_PATH = path.join(ASSET_DIR, "sample-deck-spec.json");

const SOURCE_IDS = ["layout-registry", "design-tokens", "template-heritage"];
const COVER_IDS = new Set(["cover-short-title", "cover-long-title"]);
const PROPOSAL_IDS = new Set(["innovation-claims", "expected-outcomes", "baseline-gantt", "proposal-decision-check"]);
const MIDTERM_IDS = new Set(["progress-snapshot", "plan-vs-actual", "leading-result-single", "leading-results-multipanel", "deviation-cause-action", "remaining-work-updated-plan"]);

const SCHEMA_FAMILY_BY_ID = {
  "cover-short-title": "title",
  "cover-long-title": "title",
  "agenda-adaptive": "agenda",
  "section-divider": "section",
  "evaluation-focus": "free_canvas",
  "closing-feedback": "closing",
  "context-stakes": "evidence_chain",
  "literature-landscape": "case_matrix",
  "evidence-gap": "evidence_chain",
  "question-hypothesis": "evidence_chain",
  "objectives-workpackages": "method_design",
  "conceptual-framework": "system_architecture",
  "scope-boundaries": "case_matrix",
  "contribution-value": "contribution_limits",
  "technical-route": "process_flow",
  "method-architecture": "system_architecture",
  "study-design": "method_design",
  "data-sample-variables": "method_design",
  "model-formula": "figure_formula",
  "validation-plan-status": "validation_matrix",
  "feasibility-resources": "evidence_chain",
  "risk-ethics-contingency": "case_matrix",
  "innovation-claims": "contribution_limits",
  "expected-outcomes": "contribution_limits",
  "baseline-gantt": "process_flow",
  "proposal-decision-check": "contribution_limits",
  "progress-snapshot": "validation_matrix",
  "plan-vs-actual": "comparison",
  "leading-result-single": "hero_figure",
  "leading-results-multipanel": "comparison",
  "deviation-cause-action": "evidence_chain",
  "remaining-work-updated-plan": "process_flow",
};

const SAMPLES = {
  "cover-short-title": {
    title: "可解释机器学习风险预测研究",
    takeaway: "短题目封面只交代课题、答辩阶段和正式身份信息。",
    render: { mode: "proposal", mode_label: "开题答辩", subtitle: "Research Proposal", presenter: "示范姓名", advisor: "示范导师", institution: "示范学术机构", date: "20XX 年 X 月" },
  },
  "cover-long-title": {
    title: "面向复杂场景的多源异构数据融合、机制解释与可验证决策方法研究",
    takeaway: "长题目封面扩大标题区，不通过缩小字号强行塞入。",
    render: { mode: "midterm", mode_label: "中期答辩", subtitle: "Midterm Progress Review", presenter: "示范姓名", advisor: "示范导师", institution: "示范学术机构", date: "20XX 年 X 月" },
  },
  "agenda-adaptive": {
    title: "汇报结构由证据链决定",
    takeaway: "目录可以3至7部分自适应，不固定开题或中期的章节数。",
    render: { sections: [
      { number: "01", title: "问题与缺口", detail: "为什么值得研究" },
      { number: "02", title: "目标与设计", detail: "准备如何回答" },
      { number: "03", title: "方法与验证", detail: "证据如何建立" },
      { number: "04", title: "可行性与风险", detail: "能否按计划交付" },
      { number: "05", title: "计划与评审请求", detail: "需要形成什么判断" },
    ] },
  },
  "section-divider": {
    title: "方法与验证",
    takeaway: "章节页用一个桥接问题建立节奏，不承担正文证据。",
    render: { section_number: "03", section_title: "方法与验证", bridge: "怎样的证据组合，才足以回答核心研究问题？" },
  },
  "evaluation-focus": {
    title: "本次评审需要形成三个判断",
    takeaway: "开题关心价值与可行性，中期关心实际证据与剩余交付。",
    render: { mode: "proposal", question: "本研究是否已形成值得开展、可被验证且能按期交付的闭环？", criteria: [
      { title: "问题是否成立", body: "缺口和边界是否有证据支持" },
      { title: "方案是否闭环", body: "方法、数据与验证能否对应问题" },
      { title: "计划是否可交付", body: "资源、风险和里程碑是否可控" },
    ], request: "请评委重点判断核心假设、验证强度和时间边界。" },
  },
  "closing-feedback": {
    title: "敬请各位老师批评指正",
    takeaway: "结束页简洁收束，实质结论和评审请求应在前一页完成。",
    render: { prompts: ["研究问题与边界", "方法与验证闭环", "进度、风险与下一步"], presenter: "示范姓名 · 学术答辩" },
  },
  "context-stakes": {
    title: "现实信号和技术限制共同定义了研究问题",
    takeaway: "背景页必须从可核对证据推到核心问题。",
    render: { evidence_items: [
      { title: "现实信号", value: "XX%", body: "来源明确的趋势或影响" },
      { title: "技术约束", value: "3 项", body: "当前方法的关键失效点" },
      { title: "研究切口", value: "1 个", body: "本项目能直接验证的问题" },
    ], conclusion: "真正的研究必要性来自证据之间的张力，不是泛化意义。" },
  },
  "literature-landscape": {
    title: "三条研究路线在证据直接性上仍有断层",
    takeaway: "文献综述应按共同维度比较，而不是默认分成国内与国外。",
    render: { streams: [
      { title: "理论解释", consensus: "确认关键关系", limit: "缺少直接操作化" },
      { title: "数据驱动", consensus: "可以提升预测", limit: "外部适用性不清" },
      { title: "机制验证", consensus: "提供因果线索", limit: "样本与情境有限" },
    ], synthesis: "当前缺口是一条可跨样本验证的解释链。" },
  },
  "evidence-gap": {
    title: "已知结论无法直接回答目标场景中的机制问题",
    takeaway: "缺口必须由已知证据、边界和未解问题逐步推出。",
    render: { known: "现有研究在单一数据源上已证明现象存在。", boundary: "测量时间窗、样本结构和对照方式不一致。", gap: "仍不清楚哪条机制驱动差异，也缺少外部验证。", question: "哪个可检验机制能同时解释差异和适用边界？" },
  },
  "question-hypothesis": {
    title: "核心假设将研究问题转化为可否证的预测",
    takeaway: "问题、假设、预测和判据应能在一页上互相对应。",
    render: { question: "在目标条件下，关键因素 X 是否通过机制 M 改变结果 Y？", hypothesis: "若 X 通过 M 作用，则控制 M 后 X 对 Y 的效应应显著减弱。", predictions: ["关键中介随 X 变化", "干预中介后 Y 同步变化", "独立样本中方向一致"], criterion: "预测中任一关键环节失败时，必须修正或否定假设。" },
  },
  "objectives-workpackages": {
    title: "三个工作包逐步回答总目标，但数量不由模板固定",
    takeaway: "每个工作包必须有独立问题、方法和交付证据。",
    render: { objective: "建立可解释、可验证并能跨场景检验的方法体系。", work_packages: [
      { title: "WP1｜数据与表征", question: "现象是否稳定存在？", output: "标准化数据与基线" },
      { title: "WP2｜机制与方法", question: "哪条机制能解释差异？", output: "可检验模型与假设" },
      { title: "WP3｜验证与边界", question: "结论在何种条件下成立？", output: "外部验证与边界" },
    ], output: "形成从数据基线、机制方法到外部验证的完整证据链。" },
  },
  "conceptual-framework": {
    title: "输入通过核心机制影响结果，并受边界条件调节",
    takeaway: "概念框架只显示可被证据追踪的真实关系。",
    diagram: [["input", "研究输入", "input"], ["mechanism", "核心机制", "process"], ["outcome", "可观测结果", "output"], ["boundary", "边界条件", "context"]],
    render: { relations: [{ from: "研究输入", to: "核心机制", label: "触发" }, { from: "核心机制", to: "可观测结果", label: "影响" }, { from: "边界条件", to: "机制→结果", label: "调节" }] },
  },
  "scope-boundaries": {
    title: "结论的有效范围由对象、情境和时间窗共同限定",
    takeaway: "明确边界是提升可信度，不是削弱研究价值。",
    render: { included: ["目标人群或对象", "明确场景与工况", "可观测时间窗"], excluded: ["不具备必要数据的对象", "与主要问题无关的特殊情境"], implication: "研究结论先针对定义范围成立，外推需要独立验证。" },
  },
  "contribution-value": {
    title: "研究价值来自可验证的新解释，而不是泛化的学术意义",
    takeaway: "贡献与价值必须连接缺口、新做法、验证和边界。",
    render: { contributions: [
      { title: "理论价值", body: "把现象性相关转成可检验机制命题", boundary: "待外部样本验证" },
      { title: "方法价值", body: "建立方法—证据—边界的闭环", boundary: "依赖数据质量" },
      { title: "实践价值", body: "给出可复核的决策指标与适用条件", boundary: "不直接替代现场判断" },
    ] },
  },
  "technical-route": {
    title: "技术路线从问题出发，通过验证和边界检查形成结论",
    takeaway: "步骤数量由真实依赖决定，不固定为五步。",
    diagram: [["q", "研究问题", "input"], ["data", "数据与样本", "process"], ["method", "核心方法", "process"], ["validation", "验证与稳健性", "evidence"], ["boundary", "结论与边界", "output"]],
    render: { stage_labels: ["问题定义", "证据准备", "方法实施", "交叉验证", "边界判断"] },
  },
  "method-architecture": {
    title: "三层方法架构把数据、分析和验证连成可追踪闭环",
    takeaway: "架构页强调模块之间的输入输出和验证接口。",
    diagram: [["data", "数据层", "input"], ["analysis", "分析层", "process"], ["validation", "验证层", "evidence"], ["decision", "结论与边界", "output"]],
    render: { layers: [
      { title: "数据层", modules: ["数据源 A", "数据源 B", "质量控制"] },
      { title: "分析层", modules: ["表征构建", "核心模型", "机制解释"] },
      { title: "验证层", modules: ["对照检验", "稳健性", "外部复核"] },
    ] },
  },
  "study-design": {
    title: "对照、处理和判据共同决定研究设计是否能回答问题",
    takeaway: "设计页不罗列工具，只保留影响证据强度的关键选择。",
    render: { design: [
      { title: "对象与分组", body: "纳入条件、分层和对照" },
      { title: "处理与测量", body: "干预、时间窗和观察指标" },
      { title: "分析与验证", body: "主要模型、负对照和稳健性" },
      { title: "结论判据", body: "支持、修正或否定假设的条件" },
    ] },
  },
  "data-sample-variables": {
    title: "样本结构和质量控制决定结论能够外推多远",
    takeaway: "先交代对象、规模、变量和质量，再进入模型结果。",
    metrics: [["样本量", "N=XXX", null], ["关键分组", "3", "组"], ["数据模态", "4", "类"], ["观察窗口", "12", "月"]],
    render: { layers: [
      { title: "来源与纳入", body: "来源、抽样、纳入排除与代表性" },
      { title: "变量与测量", body: "输入、结果、共变量、单位和时间尺度" },
      { title: "质量与偏差", body: "缺失、批次、测量误差和偏差控制" },
    ] },
  },
  "model-formula": {
    title: "核心模型用一个参数表达目标关系，其余细节留在论文中",
    takeaway: "公式页只解释答辩需要理解的变量、方向、单位和边界。",
    formula: { include: true, reason: "该页专门验证核心方法公式的空间与解释层级；公式由本地 LaTeX 同源生成 TEX、路径化 SVG 与高分辨率透明 PNG，本库采用 PNG 以兼顾 PowerPoint/WPS 兼容性。", equation_ref: "gallery:equation-1", latex: "y = \\beta_0 + \\beta_1 x + \\varepsilon", render_method: "latex_png", role: "method_core", variables_to_explain: [{ symbol: "β₁", meaning: "在控制其他条件后 x 对 y 的边际影响", unit: null }], plain_meaning: "β₁ 的方向和不确定性用于检验核心假设。", source_refs: ["template-heritage"], asset_ref: "formulas/gallery-core-model.png", fallback_asset_ref: null },
    render: { assumption: "样例公式仅用于布局画廊，不构成实际研究结论。", evidence_link: "正式答辩中应将公式与研究问题、变量和验证直接连接。" },
  },
  "validation-plan-status": {
    title: "验证矩阵同时交代方法、判据和实际状态",
    takeaway: "开题显示拟验证路径，中期必须追加实际证据和未通过项。",
    render: { mode: "midterm", validations: [
      { target: "基线效应", method: "主分析", criterion: "效应与方向达到预定判据", status: "complete", evidence: "图 3 / 表 2" },
      { target: "稳健性", method: "替代参数与负对照", criterion: "核心结论不反转", status: "inProgress", evidence: "已完成2/3" },
      { target: "外部适用性", method: "独立样本复核", criterion: "方向一致且边界可解释", status: "atRisk", evidence: "样本到位延迟" },
    ] },
  },
  "feasibility-resources": {
    title: "数据、方法和先行证据共同支撑方案可行",
    takeaway: "可行性需要可核对证据，不能只写‘条件成熟’。",
    render: { dimensions: [
      { title: "数据可得", evidence: "已完成授权或获取流程", boundary: "后续样本增量依赖外部协作" },
      { title: "方法可执行", evidence: "核心方法已完成最小原型", boundary: "大规模验证仍需优化" },
      { title: "前期证据", evidence: "先导结果支持研究方向", boundary: "当前不足以支持最终结论" },
    ] },
  },
  "risk-ethics-contingency": {
    title: "关键风险必须有触发指标、缓解动作和备选路径",
    takeaway: "风险页不追求穷尽所有问题，只处理会改变研究结论或交付的事项。",
    render: { risks: [
      { risk: "样本到位不足", trigger: "关键分层低于最小数量", response: "扩展协作来源；若仍不足，将结论限定为探索性", owner: "数据负责人" },
      { risk: "核心方法不稳定", trigger: "负对照下结果反转", response: "定位假设与数据质量，必要时切换替代模型并降低结论强度", owner: "方法负责人" },
      { risk: "伦理或数据合规", trigger: "授权范围与分析用途不一致", response: "暂停相关分析并补充审查，必要时使用合规替代数据", owner: "项目负责人" },
    ] },
  },
  "innovation-claims": {
    title: "创新点必须能回到缺口、新做法和验证路径",
    takeaway: "不使用没有检索与证据支持的‘首次’或‘填补空白’。",
    render: { innovations: [
      { gap: "现有研究只给出相关", novelty: "提出可操作的机制假设", validation: "通过干预和负对照验证" },
      { gap: "结论限于单一数据源", novelty: "建立跨场景边界检验", validation: "在独立样本中复核" },
      { gap: "方法结果缺少解释", novelty: "将解释纳入方法约束", validation: "比较预测与机制一致性" },
    ] },
  },
  "expected-outcomes": {
    title: "预期成果用可验收交付物表达，不把计划写成既成事实",
    takeaway: "每个交付物都需对应研究目标和验收判据。",
    render: { outcomes: [
      { title: "数据与规范", deliverable: "可复核数据字典与质控报告", acceptance: "关键字段、来源和处理可追溯" },
      { title: "方法与证据", deliverable: "核心模型、对照与外部验证", acceptance: "结论方向、不确定性和边界明确" },
      { title: "学术与实践", deliverable: "论文、软件或方法指南", acceptance: "与实际证据强度匹配" },
    ] },
  },
  "baseline-gantt": {
    title: "基线计划用里程碑和交付物组织，而不是日常任务清单",
    takeaway: "甘特图必须显示阶段、依赖、里程碑和可评审交付物。",
    render: { periods: ["Q1", "Q2", "Q3", "Q4", "Q5", "Q6"], tasks: [
      { title: "WP1｜数据与基线", start: 0, end: 2, status: "planned", deliverable: "M1｜基线冻结" },
      { title: "WP2｜方法与机制", start: 1, end: 4, status: "planned", deliverable: "M2｜核心方法锁定" },
      { title: "WP3｜验证与边界", start: 3, end: 5, status: "planned", deliverable: "M3｜外部验证" },
      { title: "整合与交付", start: 4, end: 6, status: "planned", deliverable: "M4｜论文与交付物" },
    ] },
  },
  "proposal-decision-check": {
    title: "开题评审最终需要判断价值、闭环、可行性与风险",
    takeaway: "一页收回开场问题，并明确请评委对哪些权衡给出意见。",
    render: { checks: [
      { title: "价值", verdict: "问题重要且缺口可验证", evidence: "背景与文献证据" },
      { title: "方法", verdict: "任务、数据、方法和验证闭环", evidence: "技术路线与设计" },
      { title: "可行性", verdict: "前期基础与资源能支撑计划", evidence: "先行证据与资源清单" },
      { title: "风险", verdict: "关键风险有触发条件和备选路径", evidence: "风险与应对表" },
    ], request: "请评委重点对核心假设、验证强度和计划边界提出意见。" },
  },
  "progress-snapshot": {
    title: "三个里程碑已有两个形成可验证交付，外部验证存在风险",
    takeaway: "中期概览用实际证据和状态说明进展，不使用无基线百分比。",
    render: { as_of_date: "20XX-XX-XX", work_packages: [
      { title: "M1｜数据基线", status: "complete", body: "已形成数据字典与质控报告" },
      { title: "M2｜核心方法", status: "complete", body: "已交付模型、对照和初步结果" },
      { title: "M3｜外部验证", status: "atRisk", body: "样本延迟，已启动备选来源" },
      { title: "M4｜整合交付", status: "notStarted", body: "依赖 M3 完成" },
    ], focus: "当前最大不确定性是外部样本时间。" },
  },
  "plan-vs-actual": {
    title: "核心方法按计划完成，外部验证延迟一个周期",
    takeaway: "计划与实际的差异要同时解释原因、影响和处理。",
    render: { rows: [
      { title: "数据基线", plan: "Q1 完成", actual: "Q1 完成", delta: "0｜无影响" },
      { title: "核心方法", plan: "Q2 锁定", actual: "Q2 锁定", delta: "0｜无影响" },
      { title: "外部验证", plan: "Q3 完成", actual: "预计 Q4", delta: "+1 周期｜挤压综合时间" },
      { title: "论文整合", plan: "Q4 启动", actual: "已提前启动", delta: "-1 周期｜部分对冲延迟" },
    ] },
  },
  "leading-result-single": {
    title: "核心干预在主要对照下改变了目标结果",
    takeaway: "一张主图承担证据，旁边只保留读图方法、主结论和边界。",
    text_emphasis: [{ text: "+24", role: "result" }],
    visuals: 1,
    metrics: [["相对基线", "+24", "%"]],
    bullets: ["同一坐标与对照下比较", "报告方向、效应和不确定性", "限定当前结果的适用范围"],
    render: { conclusion: "阶段证据支持核心方向，但外部适用性仍待复核。" },
  },
  "leading-results-multipanel": {
    title: "现象、机制与稳健性证据共同支持阶段结论",
    takeaway: "每个面板承担不同证据角色，但必须共同回答一个问题。",
    visuals: 3,
    render: { panels: [
      { title: "现象证据", body: "主要变化在对照下稳定出现" },
      { title: "机制证据", body: "关键中介随干预同步变化" },
      { title: "稳健性证据", body: "替代参数下结论方向不反转" },
    ], boundary: "当前外部样本尚未完成，暂不做广泛外推。" },
  },
  "deviation-cause-action": {
    title: "外部样本延迟源于数据授权，已通过备选来源和并行分析纠偏",
    takeaway: "中期偏差页必须说明基线、实际、根因、影响、动作和复查点。",
    render: { items: [
      { deviation: "外部样本验证较基线计划延迟一个周期", cause: "数据授权边界变更，不是分析方法失败", action: "启用备选数据源，并提前完成不依赖外部样本的论文部分" },
      { deviation: "外部适用性结论暂时不能按原强度表述", cause: "关键分层尚未达到预定样本量", action: "两周后按有效样本数重新判断结论强度和时间表" },
    ], review_point: "20XX-XX-XX｜检查有效样本数与关键分层" },
  },
  "remaining-work-updated-plan": {
    title: "剩余工作围绕外部验证、边界收敛和论文整合展开",
    takeaway: "更新计划必须显示新时间、依赖、风险、交付物和待决问题。",
    render: { periods: ["T0", "+1", "+2", "+3", "+4"], tasks: [
      { title: "备选样本接入", start: 0, end: 2, status: "inProgress", deliverable: "可用数据与质控报告" },
      { title: "外部验证", start: 1, end: 3, status: "atRisk", deliverable: "效应、不确定性与边界" },
      { title: "结果整合与补充", start: 1, end: 4, status: "inProgress", deliverable: "完整证据链" },
      { title: "论文和答辩交付", start: 3, end: 5, status: "notStarted", deliverable: "论文初稿与答辩材料" },
    ], decision: "请评委判断：若外部样本仍延迟，是否接受限定性结论并优先保证论文交付？" },
  },
};

function usage() {
  return [
    "Usage: node create-proposal-midterm-layout-library.mjs [options]",
    "",
    "Options:",
    "  --spec-only  Refresh sample-deck-spec.json without building PPTX/preview",
    "  -h, --help   Show this help",
  ].join("\n");
}

function parseArgs(argv) {
  const result = { specOnly: false };
  for (const token of argv) {
    if (token === "--spec-only") result.specOnly = true;
    else if (token === "-h" || token === "--help") result.help = true;
    else throw new Error(`Unknown option: ${token}`);
  }
  return result;
}

function sectionForOrder(order) {
  if (order <= 6) return "orientation";
  if (order <= 14) return "question-logic";
  if (order <= 22) return "method-feasibility";
  if (order <= 26) return "proposal-review";
  return "midterm-review";
}

function slideKind(id) {
  if (COVER_IDS.has(id)) return "title";
  if (id === "agenda-adaptive") return "agenda";
  if (id === "section-divider") return "section";
  if (id === "closing-feedback") return "closing";
  return "content";
}

function falseFormula() {
  return {
    include: false,
    reason: "本页不需要公式；只有公式承担核心定义、方法、约束或结果解释时才加入。",
    equation_ref: null,
    latex: null,
    role: "none",
    variables_to_explain: [],
    plain_meaning: null,
    source_refs: [],
    asset_ref: null,
    fallback_asset_ref: null,
  };
}

function makeDiagram(nodes) {
  if (!nodes?.length) return {
    include: false,
    reason: "本页不需要额外关系图。",
    source_refs: [],
    type: "none",
    direction: "none",
    nodes: [],
    edges: [],
    output: null,
    asset_ref: null,
  };
  const normalized = nodes.map(([id, label, role], index) => ({
    id,
    label,
    role,
    detail: index === 0 ? "从研究问题与证据出发" : null,
    source_refs: ["template-heritage"],
  }));
  return {
    include: true,
    reason: "内容存在三步以上的真实顺序、依赖或调节关系。",
    source_refs: ["template-heritage"],
    type: "process",
    direction: "left_to_right",
    nodes: normalized,
    edges: normalized.slice(0, -1).map((node, index) => ({
      from: node.id,
      to: normalized[index + 1].id,
      relation: "sequence",
      label: null,
    })),
    output: "形成可追踪的研究证据关系",
    asset_ref: null,
  };
}

function makeVisuals(count, layoutId) {
  return Array.from({ length: count || 0 }, (_, index) => ({
    id: `${layoutId}-visual-${index + 1}`,
    type: "figure",
    role: count > 1 ? "comparison" : "primary_evidence",
    include: true,
    rationale: "布局画廊使用占位资产验证证据面积和解释层级；正式项目必须替换为真实论文、数据或实验证据。",
    asset_ref: `sample:${layoutId}-evidence-${index + 1}`,
    source_refs: ["template-heritage"],
    caption: `证据图 ${index + 1}`,
    alt_text: "开题或中期答辩证据图示意槽位",
    placement: "主证据区",
    crop: "contain",
    highlight: null,
    transformations: [],
  }));
}

function makeContent(sample) {
  return {
    title: sample.title,
    subtitle: null,
    body: [],
    bullets: (sample.bullets ?? []).map((text) => ({ text, level: 0, emphasis: "none", evidence_refs: ["template-heritage"] })),
    metrics: (sample.metrics ?? []).map(([label, value, unit]) => ({ label, value, unit, comparison: null, evidence_ref: "template-heritage" })),
    quote: null,
    callout: null,
    visible_source_labels: [],
    footer: null,
  };
}

function sampleMode(layout) {
  if (PROPOSAL_IDS.has(layout.id)) return "proposal";
  if (MIDTERM_IDS.has(layout.id)) return "midterm";
  return SAMPLES[layout.id]?.render?.mode ?? "shared";
}

function makeSlide(layout, index, layouts) {
  const sample = SAMPLES[layout.id];
  if (!sample) throw new Error(`Missing gallery sample for layout: ${layout.id}`);
  const order = index + 1;
  const nextTitle = SAMPLES[layouts[index + 1]?.id]?.title ?? "敬请批评指正";
  const mode = sampleMode(layout);
  const estimated = ["title", "section", "closing"].includes(slideKind(layout.id)) ? 8 : 13;
  return {
    id: `sample-${layout.id}`,
    order,
    kind: slideKind(layout.id),
    section_id: sectionForOrder(order),
    purpose: `示范 ${layout.id} 在${mode === "shared" ? "开题和中期共享" : mode === "proposal" ? "开题" : "中期"}场景中的语义、证据要求与视觉层级。`,
    audience_question: `什么证据关系适合使用 ${layout.id}？`,
    takeaway: sample.takeaway,
    priority: "supporting",
    content: makeContent(sample),
    layout: {
      family: SCHEMA_FAMILY_BY_ID[layout.id],
      variant: layout.id,
      rationale: `只有当内容关系自然匹配 ${layout.id} 的 useWhen 时才使用；否则改用其他候选或 free_canvas。`,
      reading_order: ["标题与主结论", "主证据或关系", "解释、偏差或边界"],
      regions: [],
      density: layout.densityBudget === "low" ? "sparse" : layout.densityBudget === "high" ? "dense" : "balanced",
    },
    claim_ids: [],
    evidence_refs: SOURCE_IDS,
    visuals: makeVisuals(sample.visuals, layout.id),
    text_emphasis: sample.text_emphasis ?? [],
    formula: sample.formula ?? falseFormula(),
    diagram: makeDiagram(sample.diagram),
    speaker_notes: {
      script: `本页示范“${sample.title}”。${sample.takeaway}正式使用时，先判断当前是开题计划性叙事还是中期实绩性叙事，再根据真实证据选择布局；不自然匹配时使用自由画布。`,
      transition: `下一页进入“${nextTitle}”。`,
      estimated_seconds: estimated,
      sources: [
        { source_id: "layout-registry", locator: `layoutId=${layout.id}`, citation: `开题·中期答辩通用版式注册表：${layout.id}`, purpose: "版式语义、模式支持和使用边界" },
        { source_id: "template-heritage", locator: `layoutId=${layout.id}`, citation: "开题·中期通用布局的 clean-generated 抽象视觉 heritage", purpose: "视觉语言与去品牌、去科研素材边界" },
      ],
      delivery_cues: ["先说明当页要解决的评审问题，再说证据、影响与边界。"],
    },
    render_data: { mode, ...(sample.render ?? {}) },
    qa: { status: "not_checked", issues: [] },
  };
}

async function loadRegistry() {
  const registry = JSON.parse(await fs.readFile(REGISTRY_PATH, "utf8"));
  if (registry?.profile !== "proposal_midterm") throw new Error("layout-registry.json must use profile=proposal_midterm.");
  if (!Array.isArray(registry.layouts) || registry.layouts.length !== 32) throw new Error("layout-registry.json must contain exactly 32 layouts.");
  const ids = registry.layouts.map((layout) => layout.id);
  if (new Set(ids).size !== ids.length) throw new Error("layout-registry.json contains duplicate layout IDs.");
  const missing = ids.filter((id) => !SAMPLES[id]);
  const extra = Object.keys(SAMPLES).filter((id) => !ids.includes(id));
  if (missing.length || extra.length) throw new Error(`Gallery samples and registry differ. Missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"}.`);
  return registry;
}

export async function createProposalMidtermSpec() {
  const registry = await loadRegistry();
  const slides = registry.layouts.map((layout, index) => makeSlide(layout, index, registry.layouts));
  const estimated = slides.reduce((sum, slide) => sum + slide.speaker_notes.estimated_seconds, 0);
  return {
    artifact_purpose: "layout_gallery",
    schema_version: "1.1",
    project_id: "proposal-midterm-layout-library",
    profile: "proposal_midterm",
    milestone: {
      mode: "proposal",
      as_of_date: null,
      plan_document_ids: ["gallery-plan"],
      progress_document_ids: [],
      work_packages: [
        {
          id: "gallery-work-package",
          title: "布局画廊计划工作包",
          status: "planned",
          planned_output: "32页一页一布局的可编辑布局画廊",
          planned_due: null,
          actual_output: null,
          evidence_refs: ["layout-registry"],
          deviation_reason: null,
          next_action: null,
        },
      ],
      review_question: "哪种布局能在不改变真实证据结构的前提下最清晰地回答当页问题？",
    },
    title: "开题·中期答辩｜学术通用布局库",
    language: "zh-CN",
    slide_size: { ratio: "16:9", width_inches: 13.333, height_inches: 7.5 },
    timing: {
      duration_minutes: 9,
      usable_fraction: 0.75,
      target_seconds: 405,
      estimated_seconds: estimated,
      approximate: true,
      page_policy: "fixed",
      target_slide_count: slides.length,
      timing_notes: [
        "本文件是一页一布局的视觉画廊，不是正式开题或中期答辩的页序与时长建议。",
        "正式项目的页数、目录、章节和正文构图由论文、研究计划和实际进展决定。",
      ],
    },
    theme: {
      id: "proposal-midterm-academic-blue",
      mode: "preset",
      preset: "blue",
      institution: null,
      verified_logo_asset_id: null,
      colors: {
        primary: "#183A6A",
        primary_dark: "#10294C",
        primary_light: "#E8EDF4",
        accent: "#B77A2E",
        background: "#FFFFFF",
        surface: "#F5F7FA",
        text: "#111827",
        muted_text: "#596273",
        warning: "#B56A2E",
        chart_series: ["#183A6A", "#5877A2", "#39786E", "#B77A2E", "#725A8B", "#A5424A"],
      },
      fonts: { heading: "Microsoft YaHei", body: "Microsoft YaHei", latin: "Arial", math: "Latin Modern Math" },
    },
    sections: [
      { id: "orientation", order: 1, title: "起始与导航", short_title: "起始与导航", role: "opening", purpose: "建立答辩阶段、论证路线和评审焦点。" },
      { id: "question-logic", order: 2, title: "问题与研究逻辑", short_title: "问题与逻辑", role: "problem", purpose: "从背景、文献、缺口推到问题、目标和边界。" },
      { id: "method-feasibility", order: 3, title: "方法、验证与可行性", short_title: "方法与可行性", role: "method", purpose: "说明方法闭环、数据条件、验证、公式、风险和资源。" },
      { id: "proposal-review", order: 4, title: "开题专属评审", short_title: "开题专属", role: "contribution", purpose: "展示创新、预期成果、基线计划和评审请求。" },
      { id: "midterm-review", order: 5, title: "中期专属评审", short_title: "中期专属", role: "progress", purpose: "展示实际进展、阶段证据、偏差、纠偏和更新计划。" },
    ],
    sources: [
      { id: "layout-registry", type: "user_material", title: "开题·中期答辩通用版式注册表", citation: "academic-slides/assets/proposal-midterm-universal/layout-registry.json", document_id: null, paper_id: null, path: "layout-registry.json", url: null, creator: "academic-slides", published_at: null, accessed_at: null, source_nature: "author_original", verification_status: "verified", notes: "定义32种布局的语义、模式支持、证据要求和使用边界。" },
      { id: "design-tokens", type: "user_material", title: "开题·中期答辩设计令牌", citation: "academic-slides/assets/proposal-midterm-universal/design-tokens.json", document_id: null, paper_id: null, path: "design-tokens.json", url: null, creator: "academic-slides", published_at: null, accessed_at: null, source_nature: "author_original", verification_status: "verified", notes: "定义字体、色彩、间距、状态和开题/中期叙事语义。" },
      { id: "template-heritage", type: "user_material", title: "开题·中期通用布局 clean-generated 迁移记录", citation: "academic-slides/assets/proposal-midterm-universal/template-map.json", document_id: null, paper_id: null, path: "template-map.json", url: null, creator: "academic-slides", published_at: null, accessed_at: null, source_nature: "author_original", verification_status: "verified", notes: "只记录抽象视觉 heritage；不复制参考幻灯片对象、学校品牌、科研图片、事实或本机路径。" },
    ],
    slides,
    claim_evidence_map: [],
    qa: { status: "not_checked", issues: [], checks: { schema: "not_checked", evidence: "not_checked", narrative: "not_checked", visual: "not_checked", technical: "not_checked", notes_sources: "not_checked" }, checked_at: null },
  };
}

export async function createProposalMidtermLayoutLibrary({ specOnly = false } = {}) {
  await fs.mkdir(ASSET_DIR, { recursive: true });
  const spec = await createProposalMidtermSpec();
  await fs.writeFile(SPEC_PATH, `${JSON.stringify(spec, null, 2)}\n`, "utf8");
  if (specOnly) return { profile: "proposal_midterm", spec: SPEC_PATH, slideCount: spec.slides.length, built: false };
  return createLayoutLibrary("proposal_midterm");
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
    console.log(JSON.stringify(await createProposalMidtermLayoutLibrary({ specOnly: args.specOnly }), null, 2));
  } catch (error) {
    console.error(`PROPOSAL/MIDTERM LAYOUT LIBRARY BUILD FAILED: ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}

const direct = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (direct) await main();

export { parseArgs };
