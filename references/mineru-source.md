# MinerU 来源适配器

MinerU 是可选的远程文档解析器，不是默认来源通道。它适合长篇、版式复杂、含大量公式与表格的论文；本地 PDF 提取始终保留为无上传回退。只有确定性 normalizer 可以打开供应商原始输出；agent/LLM 只接触紧凑索引和受预算约束的 hydrate 结果。

## 目录

- [启用边界](#启用边界)
- [选择解析路径](#选择解析路径)
- [密钥与上传安全](#密钥与上传安全)
- [准备与归一化](#准备与归一化)
- [文件访问白名单](#文件访问白名单)
- [缓存契约](#缓存契约)
- [原始输出保留策略](#原始输出保留策略)
- [索引与按需取证](#索引与按需取证)
- [上下文硬预算](#上下文硬预算)
- [质量边界与回退](#质量边界与回退)

## 启用边界

默认只在本地处理源文件。仅当用户对当前任务明确同意把指定源文件上传给 MinerU 时，才允许远程解析；用户提供了 API token、网页截图或服务链接，不等于同意上传。授权必须能回答“上传哪个文件、发送到哪个服务、用于什么任务”，且不自动延续到其他文件或后续任务。

远程模式同时要求：

1. 用户已经明确授权本次上传；
2. 调用包含 `--confirm-upload`；
3. 进程环境中存在指定 token 变量；
4. 文件、页数和格式符合 MinerU 当前官方限制。

缺少任一条件时使用本地解析，不为获得授权反复追问。`--normalize-only` 只读取用户已有的 MinerU 解压目录，不上传文件，因此不要求 `--confirm-upload` 或 token。

## 选择解析路径

按以下顺序决策：

```text
已有可验证的同源缓存
→ 直接复用并按需 hydrate

没有缓存 + 已明确授权远程上传
→ 长论文、复杂公式/表格/多栏版式：MinerU 精准解析 VLM
→ 解析完成后立刻归一化和建立紧凑索引

没有授权、缺少 token、服务失败或结果不完整
→ 本地 PDF 文本/图片/页面裁切流程
```

不要为了 A/B 测试而把整篇论文重复上传或用多个模型完整解析。只有关键页质量无法判断时，才对少量风险页做有界比较。服务能力和限制可能变化；实现与维护时以 [MinerU 官方 API 文档](https://mineru.net/apiManage/docs) 为准。

## 密钥与上传安全

- 默认只从 `MINERU_API_TOKEN` 读取密钥；`--token-env NAME` 可以改用另一个环境变量名。
- CLI 不接受 token 值。不得把 token 写入命令参数、项目 JSON、Markdown、日志、缓存键、PPT 备注、MJS、DOCX 或交付包。
- 不打印 `Authorization`、Bearer 值、签名上传 URL 或完整 API 响应。`extraction-record.json` 也不得保存这些值；错误信息只保留状态、阶段和经过脱敏的错误码。
- 不把 `.env`、MinerU 原始包或远程响应提交到 Git。若 token 曾出现在聊天、截图、终端回显或仓库中，立即要求撤销并轮换；不要在答复里重复该值。
- 远程授权只覆盖指定源文件。品牌素材、其他附件和整个项目目录不得顺带上传。

## 准备与归一化

远程解析入口：

```bash
node scripts/prepare-source-mineru.mjs \
  --source <论文.pdf> \
  --output-dir <内部来源目录> \
  --confirm-upload
```

离线归一化入口：

```bash
node scripts/prepare-source-mineru.mjs \
  --normalize-only <MinerU解压目录> \
  --source <同一论文.pdf> \
  --output-dir <内部来源目录> \
  --model-version vlm
```

远程模式默认不请求 DOCX、HTML 或 LaTeX 导出。

## 文件访问白名单

把文件分成四层，不得因为它们都在本地磁盘上就混用：

| 层级 | 文件 | 允许的读取者与用途 |
|---|---|---|
| required machine input | 源 PDF；一个有效的 v1 `*_content_list.json` | normalizer 用于来源哈希、稳定块结构和候选索引；v1 是唯一必需的 MinerU 结构输入 |
| optional machine input | 可解析的 `*_content_list_v2.json`、`layout.json`/`*_middle.json`、位于 raw 根内且被 v1/v2 引用的图像 | normalizer 用于标题、LaTeX、页尺寸、bbox 和本地资产路径增强；缺失或损坏时可降级 |
| raw-never-read by agent | `full.md`、所有原始 `content_list*.json`、`model*.json`、`layout.json`/`*_middle.json`、HTML、TeX、DOCX、原始 ZIP、整个供应商解压目录 | 只允许确定性 normalizer 或受控调试工具读取；agent/LLM 永不直接打开、搜索或粘贴 |
| canonical seven | 下表七个归一化文件 | 稳定的供应商隔离接口；agent 首次只读 `document-index.json`，之后只消费 retrieve CLI 的 stdout |

禁止 agent/LLM 对 raw 目录或六个详细归一化文件执行 `cat`、`sed`、`head`、`tail`、`rg`、`grep`、`jq`、通用 `readFile` 或等价的直接读取。对 `blocks.ndjson` 的部分行读取也不允许；必须由检索器施加页、类型、候选、块数和字符预算。

唯一的内容访问例外是已经由 retriever 返回的入选候选图像：agent 可以用返回的单个 `asset_path` 做视觉核验、选图或投影可读性判断，但不得浏览整个 raw 图片目录，也不得绕过 retriever 自行枚举资产。公式和表格的文本仍以 hydrate 结果为入口，关键内容再回看源 PDF 对应页面。

解析器把供应商输出归一化为以下规范七件套：

| 文件 | 用途 |
|---|---|
| `document-index.json` | 标题层级、页范围、紧凑统计和可检索导航 |
| `blocks.ndjson` | 按页、阅读顺序保存的正文与结构块；仅由 retriever 读取 |
| `page-map.json` | PDF 物理页、论文页码和归一化页索引映射；仅供工具定位 |
| `figure-candidates.json` | 图、图注、页码、bbox、来源路径与候选 ID；仅由 retriever 读取 |
| `table-candidates.json` | 表格标题、结构内容、截图、页码与候选 ID；仅由 retriever 读取 |
| `formula-candidates.json` | 公式编号、LaTeX、公式图、页码与候选 ID；仅由 retriever 读取 |
| `extraction-record.json` | 来源哈希、解析参数、模型/归一化版本、缓存、保留策略和完整性记录；仅供验证工具读取 |

这七个文件都是机器接口，不是七份提示词附件。`document-index.json` 是唯一允许首次直接进入 agent 上下文的文件；`blocks.ndjson`、page map、候选清单和 extraction record 由确定性工具读取，agent 只获取有界结果。以 MinerU v1 `content_list` 作为稳定结构入口；v2 只用于同页和 bbox 可验证的增强。供应商原始文件含义以 [MinerU 官方输出格式说明](https://opendatalab.github.io/MinerU/reference/output_files/) 为准，但不要让供应商格式直接成为 `deck-spec.json` 或项目 MJS 的依赖。

## 缓存契约

缓存键由以下字段的规范 JSON 计算 SHA-256：

```text
source_sha256
model_version
language
is_ocr
enable_formula
enable_table
page_ranges
extra_formats
retain_full_raw
normalizer_version
```

默认 `extra_formats=[]`。只有来源哈希、参数、模型和归一化版本完全一致，且 `extraction-record.json` 标记完成、归一化文件可读时才命中缓存。失败或部分结果不得伪装成命中。缓存失效时只重做来源阶段，不重做已经不受影响的叙事、页面或资产。

受管缓存只可包含下一节规定的最小 raw 白名单，或一次显式 full-raw 调试快照；两者都不得复制到客户包或进入模型上下文。

## 原始输出保留策略

API 模式默认采用 minimal raw retention。结果解压后，机器先验证必需/可选输入、生成保留计划并裁剪受管 raw，再从该最小快照归一化。白名单只包含：

- 有效的 v1 `*_content_list.json`；
- 可成功解析的 v2 content list；
- 可成功解析的 `layout.json` 或 `*_middle.json`；
- 被 v1/v2 引用、解析后仍位于 raw 根目录内的图像。

默认删除受管缓存中的源文件副本、`full.md`、model JSON、HTML、TeX、DOCX、未引用图片和其他未列入白名单的文件。结果 ZIP 下载并解压后立即删除。这里的“删除”只作用于 Skill 管理的缓存，不删除用户的原论文。

只有为了解析器诊断、且已记录有界原因时，才显式加入 `--retain-full-raw`。它保留供应商完整输出，但不会授权 agent/LLM 读取 raw，也不会改变上下文白名单。调试完成后不要把完整 raw 移入项目或提交 Git。

`--normalize-only` 默认不修改用户提供的解压目录，而是把同一最小白名单复制到 `.academic-slides-mineru-cache/<cache-key>/raw`，再从受管快照归一化。显式 `--retain-full-raw` 时直接使用用户目录做只读归一化，不复制或清理该目录。

`extraction-record.json` 的 `retention` 使用固定机器字段：

- `policy`: `minimal_required` 或 `full_raw_opt_in`；
- `scope`: API 最小缓存为 `managed_cache_pruned`，API 完整调试为 `managed_cache_full_raw_opt_in`，离线最小快照为 `managed_cache_snapshot`，离线完整调试为 `external_full_raw_opt_in`；
- `full_raw_opt_in`、始终为 false 的 `source_input_modified`、始终为 true 的 `standardized_outputs_only_for_model`；
- `counts`: 处理前、保留、移除的文件数和字节数，以及缺失的引用图像数；
- `categories`: v1、v2、layout/middle、引用图像与其他文件计数。

不得在 record 中保存绝对路径、token 或签名 URL。缓存侧的 `raw-retention.json` 只供缓存完整性校验，也不进入 agent 上下文。缓存命中仍要求规范七件套全部非空。

## 索引与按需取证

首次来源分析只允许读取一次紧凑的 `document-index.json`，据此选择章节、风险页和候选资产；不得先读 `full.md` 或 candidate JSON“了解一下”。`retrieve-source-evidence.mjs` 不带 selector 时只返回该索引。需要支持具体主张、页面或局部修复时，之后只能调用：

```bash
node scripts/retrieve-source-evidence.mjs \
  --source-dir <归一化来源目录> \
  --pages 12,18-20 \
  --types title,text,figure,table,formula \
  --max-blocks 80 \
  --max-chars 20000 \
  --pretty
```

也可使用 `--query <关键词>`、`--candidate <候选ID>` 和小范围 `--context-pages N`。检索结果写到标准输出，调用方只把当前决策需要的块放入活跃上下文，并把最终入选项转成 `evidence-index.json`、`figures.manifest.json` 或 profile 分析文件。需要科学核验时，以检索结果中的页码和 bbox 定位源 PDF，只视觉复核被引用的局部页，不重新全文读取。

将流程理解为四步：

```text
cache：保存可复用的供应商结果
→ normalize：转成稳定、本地、可检索的结构
→ index：用紧凑地图选择页、块和候选资产
→ hydrate：只加载当前主张或页面需要的证据
```

## 上下文硬预算

- 每个源文件的全文读取预算最多一次；MinerU 路径不读取 raw 全文，首次进入上下文的来源文件只能是紧凑 `document-index.json`。机器提取不等于允许模型通读 raw。
- 禁止把完整或节选的 `full.md`、原始 `content_list*.json`、`model*.json`、`layout*.json`、HTML、TeX、DOCX 或整个解压目录放入提示词、agent 消息或 `deck-spec.json`。
- 禁止 agent 直接读取整个或部分 `blocks.ndjson`、page map、候选清单与 extraction record。首次只读 document index；之后按页、类型、候选 ID 或关键词调用 retrieve CLI hydrate。
- 多 agent 协作时由一个 evidence owner 写来源清单与证据索引；其他 agent 只返回候选 ID、页码和简短发现，不各自重读全文或改写同一文件。
- 局部页面修复只 hydrate 该页所引用的证据块、候选资产及必要的相邻上下文；不重新读取整篇论文。
- 诊断默认报告计数、文件名、页码和每类少量代表样例，不回显大段供应商输出。

## 质量边界与回退

MinerU 的图、表和公式都是候选证据，不是最终科学真值。至少核对进入 PPT 的关键数字、单位、公式编号、上下标、图注归属、多面板组合和表格列关系。关键页以源 PDF 为最终裁决；投影清晰度不足时，从源 PDF 高分辨率重裁，而不是放大解析器的小图。

这条边界同时节省上下文并提高可维护性：实测长论文的 `full.md` 可超过 10 万字符，直接读取会把大量正文、参考文献和重复图注带入上下文；规范索引已经保留 PDF 页码与 bbox，可定向取证；供应商 raw 与 deck spec 隔离后可以升级 normalizer 而不重写演示；最终回看源 PDF 则避免把 OCR、公式合并或多面板误配当作科学事实。

出现以下任一情况时切换到本地处理或只对受影响页补救：授权缺失、密钥缺失、上传失败、异步任务失败、输出页数不完整、页码映射冲突、关键公式/表格损坏、缓存完整性校验失败。记录回退原因和受影响页，不让远程服务故障阻断其余生产阶段。
