# Paper Club PPT 精简工作流

用固定信息流保证论文组会 PPT 的科学准确性、可编辑性和来源可追溯性，同时避免重复读取、全量视觉深读和多次整稿渲染。

## 总流程

    一次预检
    → 一次解析全部焦点论文
    → 全量图表轻索引
    → 主张、证据与出版信息索引
    → 灵活大纲与逐页规格
    → 只深加工入选资产
    → PPTX / Word / MJS 同源构建
    → 计划中的全稿检查 + 按问题扩展的复查
    → 最小客户包

普通、有文本层的单篇论文默认使用 <code>lean_single_paper</code>。多篇、扫描件、复杂公式或高保真任务使用 <code>balanced_95</code>。两者保留相同的科学、证据、安全、兼容和交付硬门禁。

## 渐进披露与可伸缩默认

开局只读 <code>SKILL.md</code>、<code>references/operating-defaults.md</code>、<code>references/intake.md</code> 和 <code>references/group-meeting-literature.md</code>。进入证据、设计、QA 和交付阶段时再读取对应参考。把确认过的设置、来源哈希、证据定位和页面决策写入清单与 <code>deck-spec.json</code>，不要反复粘贴整篇论文或完整工具输出。

普通任务优先建立一次可复用的论文、证据和素材底座，再据此做叙事规格、构建和复查。完整渲染、定向修复和干净交付重建是默认计划，不是阻止处理真实问题的次数上限。

- <code>lean_single_paper</code>：生产型单篇不少于 12 张可见页；常以 12–14 页和一组聚焦核心视觉开始，根据独立证据任务增减。
- <code>balanced_95</code>：用于多篇、扫描件、多源冲突、复杂公式、密集重绘或用户明确的高保真要求。
- 硬失败为零且重要问题已修复后停止。边缘字距、轻微留白、像素相似度和无害元数据不触发额外整稿循环。

具体的质量门、扩展条件和停止原则见 <code>references/operating-defaults.md</code>；这里不设置 token、分钟、图数或回修次数配额。

## 1. 预检与配置

1. 加载 Codex bundled workspace dependencies。
2. 运行 <code>node scripts/preflight.mjs --skill-dir . --strict</code>。
3. 复用用户已经给出的页数、主题、时长和约束。
4. 只询问缺失的页数策略或主题。
5. 建立源文件清单和 <code>project-config.json</code>。
6. 为源文件计算稳定标识或哈希，输入未变时复用已完成的提取与分析。

焦点论文、单篇/多篇模式、页数策略和主题明确后即可继续。时长只在用户主动提供时作为近似软约束。

## 2. 一次建立论文、证据与素材底座

一次读取全部焦点论文，至少识别：

- 标题、作者、发表来源、年份、DOI/URL 和文章类型；
- 研究问题、知识缺口、假设和方法；
- 数据、样本、对照、指标和证据生成逻辑；
- 核心结果、作者主张、贡献、局限和适用边界；
- 关键数字、单位、图、表、公式和补充材料定位。

为每篇焦点论文执行：

1. 在 <code>assets/papers/&lt;paper-id&gt;/</code> 运行 <code>scripts/extract-paper-assets.mjs</code>。
2. 生成完整 caption/page/bbox 轻索引 <code>paper-assets.json</code>。
3. 派生紧凑的 <code>论文图表资产说明.md</code>。
4. 根据主张、方法、比较、稳健性和局限形成候选视觉。
5. 只物化和深读候选视觉。
6. 更新 <code>paper-index.json</code> 和 <code>evidence-index.json</code>。

普通单篇先用 <code>--materialize none</code> 建立完整轻索引，再从中选取能承担不同证据角色的核心视觉（通常约 3–6 个）并按需物化。不要把自动物化误当成逐张视觉深读；当新增素材填补独立证据缺口、解决可读性问题或满足用户明确要求时，可以继续扩展。只有入选资产才做标注、拆图、局部放大、OCR、表格重建或忠实重绘。

核心主张必须指向 PDF 页码、图表号、公式号、补充材料或可靠出版页面。作者结论使用 <code>source_author_claim</code>；汇报者综合或批判使用 <code>presenter_synthesis</code> 或 <code>presenter_critique</code>，两种声音不得混淆。

## 3. 叙事、大纲与逐页规格

围绕“为什么值得读、作者如何生成证据、证据说明什么、是否可信、对本组有什么启发”组织，而不是复述论文目录。

每页执行一次决策链：

    听众需要判断的问题
    → 一句话结论
    → 支撑证据
    → 最快且真实的表达形式
    → 布局或自由证据画布
    → 精简上屏文字
    → 发言稿与过渡
    → Sources

生成 <code>deck-spec.json</code> 作为唯一机器事实源，再由它生成 <code>PPT内容与设计大纲.md</code>。

新项目使用 <code>group_meeting_v2</code> 科学内容合同。主稿必须覆盖：

- 为什么值得读或研究问题；
- 学生对方法和证据生成逻辑的理解；
- 至少一个 source-backed core finding；
- 可信度、不确定性、局限或边界；
- 证据绑定且可见的汇报者综合或批判；
- 对本组工作的启发、验证方案或讨论问题。

核心发现必须闭合到真实源证据并由 renderer 实际消费。纯文字强调不能替代论文图、表、结果、公式或源文本。公式中心型论文至少显示一个核心公式；非公式驱动论文允许零公式。

单篇不生成目录，默认也不生成论文分隔页；多篇必须生成论文目录并在每篇焦点论文前设置编号分隔页。默认不生成可见附录。封面必须是第一页，学生结束页必须是最后一页。QA、证据 ID、生成状态和交付说明不进入老师可见页面。

用户选择 <code>outline_first</code> 时在大纲后暂停；否则直接构建。

## 4. 入选资产、公式与构建

只加工已经进入 <code>deck-spec.json</code> 的资产：

- 原始素材保持不变，派生版本写入对应 <code>ready/</code>；
- 数据图表保留可复核的数据与计算；
- 简单关系图使用可编辑 PowerPoint 形状；
- 没有自然匹配布局时使用自由证据画布；
- 论文快照只显示已核验且对叙事有用的字段；
- 出版指标只在确有用途、标明体系和年份且可以复核时显示。

公式统一调用 <code>scripts/render-formula.mjs</code>。本机 LaTeX 可用时优先使用，否则使用内置 MathJax 路径 SVG。只渲染入选公式；复杂公式无法可靠转写时使用忠实高分辨率源裁图，不输出 raw LaTeX。

正常构建入口：

    node scripts/build-project.mjs \
      --project-dir <project-dir> \
      --spec <deck-spec.json> \
      --output-dir <internal-build-dir> \
      --stem <短题名_组会汇报> \
      --render

同一规格一次生成 PPTX、Word 发言稿和项目 MJS。规格、资产和核心渲染代码未变时使用签名缓存；不要把 <code>build-project.mjs --force</code> 当作普通重试。策划、素材整理或文案调整期间可不带 <code>--render</code> 验证结构；规格稳定后进行计划中的完整渲染。只有定向调试才分别调用底层脚本。

项目 MJS 嵌入最终规格，只引用交付 <code>assets/</code> 中的相对路径，默认重建同名 PPTX 与 DOCX。新项目 MJS 必须显式标记 <code>artifact_purpose: production</code>。

## 5. QA、修复与交付

1. 运行 schema、项目、科学内容、科学设计和溢出检查。
2. 在规格稳定后渲染全稿，先看联系表。
3. 全尺寸检查封面、结束页、方法/公式、核心发现、复杂图表、自由画布和自动风险页。
4. 修复学术错误、证据断裂、不可读内容、损坏媒体、遮挡、裁切和异常换行。
5. 局部修改后默认只复查受影响页及其衔接页；必要时扩展检查范围。
6. 主题、字体、全局壳层、导航、渲染器或核心素材发生全局变化时重新进行整稿视觉检查。
7. 硬失败为零且重要问题已修复后停止。

内部 QA 通过后读取 <code>references/delivery.md</code>，调用 <code>scripts/stage-delivery.mjs</code> 在空白暂存目录重建。客户包只保留同名 PPTX、MJS、Word 发言稿和实际使用的 <code>assets/</code>。

维护 Skill 时运行：

    node scripts/validate-skill-assets.mjs . --profile release --strict

发布检查会包含确定性 eval、测试和打包检查。只在需要实际暂存发布包时单独调用 <code>package-skill.mjs</code>。
