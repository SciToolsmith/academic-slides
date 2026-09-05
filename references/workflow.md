# Paper Club PPT 工作流

按科学证据组织工作，按用户要求选择制作范围。源材料、证据索引与 deck spec 保留在内部项目；用户拿到的格式由 `output.delivery_mode` 决定。

## 1. 确定设置和环境

加载 Codex bundled workspace dependencies。读取用户要求并写入 `project-config.json`：未指定页数/主题采用 `auto + blue`；新任务显式写入交付模式。需要了解阅读目的或听众基础时只问一次有价值的问题，同时继续材料解析。未知身份不虚构。

运行 `scripts/preflight.mjs` 检查实际要用的依赖；Word 只在相应交付模式中检查和构建。普通单篇采用 `lean_single_paper`，复杂或多篇采用 `balanced_95`。已解析且哈希未变的文件可复用。

## 2. 建立证据底座

一次解析焦点论文的出版信息、问题、数据/样本、方法、对照、指标、核心发现、限制与证据生成逻辑。用稳定 `paper_id` 建立 `paper-index.json`，用页码、图表/公式号和原文定位建立 `evidence-index.json`。

PDF 来源运行 `scripts/extract-paper-assets.mjs` 建立 caption/page/bbox 索引。Markdown/文本摘录使用原文标题、行号与已有数据，不调用 PDF 提取器；摘录不足以支撑正式结论时明确所缺原始证据。阈值内可以一次物化，其他情况先选候选；普通单篇从约 3–6 个父图开始，证据不足时扩展。候选选择同时考虑比较、稳健性、限制和可能反驳主结论的证据。

非 PDF 文本的 `asset_manifest_path` 设为 `null`，用 `evidence-index` 保存原文位置，用 deck 的 `assets` 和处理记录追溯派生视觉；不要创建带虚构页码/裁框的 PDF 清单。摘录未给作者时 `bibliography.authors=[]` 并说明缺失，元数据保持待核验，不填占位作者或声称已验证。

脚本只提议裁框。核对入选资产与源页面、完整图注，确认图体/面板、坐标轴、图例完整且无相邻正文；记录核验所针对的文件哈希。对未入选图无需做同等深度核验。不能用“文件存在”或 `ready/` 路径代替核验。

## 3. 形成叙事和规格

每页按“听众的问题 → 一句话判断 → 支撑证据 → 表达形式 → 布局 → 上屏文字 → 讲稿与来源”决策。生成 `deck-spec.json`，再派生 `PPT内容与设计大纲.md`；不要分别维护两份事实源。

写规格前读取对应 schema 和所选布局的示例字段，不凭名称猜字段或 renderer。正文的 `takeaway` 仍需保存一句话判断，结论标题可复用同一判断；视觉上无需再重复显示。用 `build-outline.mjs <deck-spec.json> --strict` 生成大纲，先修复缺字段、引用与语义错误。大纲通过不等于资产和渲染已验收。

顺序精读用 `paper_walkthrough`；共同问题比较用 `question_comparison`。在后者先交代问题与比较口径，再组织多篇证据。每篇仍须覆盖问题、方法、核心证据和边界。章节导航与结论标题可分开。用户要求附录时按所选配置安排，不把默认无附录当禁令。

新项目采用 `group_meeting_v2`：核心发现绑定真实源证据，作者声音与 `presenter_synthesis` / `presenter_critique` 分离，至少有一项可见的证据绑定判断。未知本组方向时给通用的证据触发问题，不代造本组计划。

用户要求 `outline_first` 才在大纲后暂停。其他情况继续构建。

## 4. 准备资产并构建

只加工选入规格的资产。原图保留，派生资产记录输入/输出 ID、哈希、操作及理由。清晰原图经目标尺寸复核可直接使用。只有可靠数据才能重建图表。公式使用 `render-formula.mjs`；无法可靠转写时使用源裁图。

正常入口：

    node scripts/build-project.mjs \
      --project-dir <project-dir> \
      --spec <deck-spec.json> \
      --output-dir <internal-build-dir> \
      --stem <短题名_组会汇报> \
      --render

构建模式由配置或显式 `--delivery-mode` 选择。PPT 备注始终带 Sources。`presenter_pack` 增加同源 Word；`rebuildable_pack` 再交付内嵌规格的 MJS 与实际依赖资产。内部构建可保留重建入口，但不把所有内部文件强制交给用户。

## 5. 质量检查与交付

先运行 schema、跨文件引用、科学内容/设计结构检查，然后看全稿联系表与高风险全尺寸页面。独立核对核心主张、数字、比较口径和来源；结构标签齐全不能证明科学正确。按照 `references/qa.md` 修复重要缺陷，局部改动只复查受影响页。

读取 `references/delivery.md` 并在干净暂存目录重建所选格式。硬失败解决后交付；剩余重要限制需清楚说明。小留白、字距和无需加工的清晰原图不触发无意义循环。

## 修改和维护

用户调整某页时，先定位相关 slide/claim/asset，保留未变来源和决策。同步修改备注及需要的 Word，不重做整个论文解析。全局主题、字体或渲染逻辑变更才重查整稿。

维护发布运行 `node scripts/validate-skill-assets.mjs . --profile release --strict`。它含规定测试、确定性合同检查和打包检查；只有失败或新增改动时重复相关检查。真实模型行为和作品质量按 `references/evaluation.md` 单独评测，不用合同通过率替代。
