# 素材准备与资产目录

在设计大纲前建立可追溯的论文素材库。完整索引用于检索，是否进入 PPT 由主张与证据关系决定。

## 内部工作目录

    project/
    ├── source/
    ├── assets/
    │   ├── figures/
    │   │   └── ready/
    │   ├── papers/
    │   │   └── <paper-id>/
    │   │       ├── original/
    │   │       ├── ready/
    │   │       ├── paper-assets.json
    │   │       └── 论文图表资产说明.md
    │   ├── formulas/
    │   └── data/
    ├── paper-index.json
    ├── evidence-index.json
    ├── project-config.json
    └── deck-spec.json

这是内部工作区，不是客户交付结构。源论文、manifest、项目配置、deck spec、证据索引、联系表、日志和分析文件不得整目录复制给用户。

先建立“已筛选素材目录”再交给 staging 脚本。交付侧按需创建 <code>papers/</code>、<code>formulas/</code> 和 <code>data/</code>；空子目录不创建。单篇任务可按用户要求交付完整忠实图集；多篇任务默认只交付入选和重点分析图片。

不得覆盖 <code>original/</code>。裁白边、增强、标注、拆分、重绘和兼容转换写入 <code>ready/</code> 并记录 provenance。正式构建只引用项目内已核验的本地资产，不依赖远程图片 URL。

## 图表轻索引与条件物化

对每篇焦点论文运行一次：

    node scripts/extract-paper-assets.mjs \
      <paper.pdf> \
      <project/assets/papers/paper-id>

输出：

- <code>paper-assets.json</code>：机器事实源；
- <code>论文图表资产说明.md</code>：供选材的紧凑阅读层；
- 按需生成的 caption-free 图表裁图。

<code>auto</code> 是通用提取器的兼容默认值。普通单篇组会应先显式使用 <code>--materialize none</code> 建立完整 caption/page/bbox 轻索引，再根据主张、方法、比较、稳健性和局限选择一组核心 ID，使用 <code>--materialize selected --select &lt;id,id&gt; --force</code> 定向物化。常从约 3–6 个承担不同证据角色的父图开始，但新增素材只要确实补上独立证据、可读性或用户重点，就可以保留。模型只深读候选，不把“已物化”误当作“必须逐张阅读”。这里的 <code>--force</code> 仅用于有意替换该提取器先前生成的 manifest、说明和同名裁图；它不等于普通构建重试的 <code>build-project.mjs --force</code>。

用户明确要求完整图集时可以使用 <code>--materialize all</code>，不增加人工审批门。

## 提取边界

通用提取器面向有文本层的常规论文 PDF：

- 识别 Figure/Fig./Table/图/表编号图注，以页面几何裁取 PNG；
- 图身默认在图注上方，表体默认在表题下方；
- 一个方向空间不足时只反向降级一次，并记录低置信；
- 表格首轮保留忠实截图，只有入选且数据可复核的表格才结构化重建；
- 扫描件、非常规图注和复杂多栏版面可以标记低置信；
- 只有低置信项成为核心证据时才定向修正一次；
- 不批量索引或渲染全文公式。

## 论文图表处理

1. 记录图号、表号、caption、页码、bbox 和附近正文。
2. 核心图若存在可稳定分离的嵌入位图或矢量原件，优先替换页面裁图。
3. 复合矢量、叠加文字和多层图无法独立提取时使用高分辨率页面裁切。
4. 图片本体不包含外部图注和周围正文；图内坐标轴、图例、箭头、子图编号和必要标签必须保留。
5. 同一图号的多面板图默认保持整体；只有主线需要时才拆分。
6. 使用稳定 ID 和“图号 + 简短图名”命名。
7. 按 <code>schemas/paper-assets.schema.json</code> 建立清单。
8. 对识别图注数、manifest 记录数和实际文件数执行闭合检查。

低清、缺图例、裁切不完整或疑似引用第三方资料的图片必须标记。不要用生成式修复补出论文中不存在的细节。

## 图表说明文档

<code>论文图表资产说明.md</code> 由 <code>paper-assets.json</code> 派生，禁止手工分叉维护。

- 未入选资产只保留 ID、图号、页码、短标题和状态；
- 入选或已物化资产再展开内容、作用、claim、PPT 用途和呈现处理；
- 不为未入选图表填写完整富语义模板。

## 表格与数据图

- 记录表号、标题、单位、脚注、样本口径和论文页码。
- 只有数据可复核时才重建可编辑表格或图表。
- 保留输入数据、转换和计算说明。
- 不因视觉整洁删除误差线、显著性、样本量、单位或基准组。
- 大型表格提炼主结果；完整表保留在内部素材中，用户明确要求时才交付。

## 公式

- 只渲染大纲已选中的核心公式。
- 记录公式号、页面、用途、原始符号和上下文。
- 经过核对的 <code>.tex</code> 是可编辑公式资产的权威源。
- 将论文或模型生成的 LaTeX 视为不可信数据，先执行 <code>scripts/render-formula.mjs --latex &lt;表达式&gt; --validate-only</code>。
- 正式渲染使用 <code>scripts/render-formula.mjs --latex &lt;表达式&gt; --output-dir &lt;assets/formulas&gt; --name &lt;稳定名称&gt;</code>。
- 本机 LaTeX 可用时优先使用；失败一次后回退到内置 MathJax 3.2.2 路径 SVG。
- 目标 PowerPoint 的 SVG 支持未知或验证失败时切换为同源 PNG。
- 含中文、非 ASCII 字面字符、未支持宏或无法可靠转写的复杂公式使用源 PDF 高分辨率忠实裁图。
- 不得使用 raw LaTeX、搜索结果公式图片或在线公式服务作为页面 fallback。
- 逐字核对上下标、希腊字母、括号、编号和量纲。
- 渲染不改变数学含义，不擅自简化或补全推导。
- 本机 LaTeX 和内置 MathJax 各最多尝试一次，再允许一次 SVG→PNG 兼容切换。

## 资产选择与加工

- 大纲阶段先选择稳定资产 ID，再制作 <code>ready/</code> 版本。
- 论文原创图与论文引用图必须区分；后者不能写成作者原创成果。
- 标注只突出已有证据，不添加论文未支持的结论。
- 裁切、旋转、增强、拆分、重绘和格式转换全部进入 provenance。
- 视觉素材必须有 alt text 或可供讲稿使用的内容说明。
- 同一资产跨页复用时保持颜色、标注含义和裁切逻辑一致。
