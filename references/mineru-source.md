# MinerU 来源适配器

MinerU 是可选的远程文档解析器，不是默认来源通道。它适合长篇、版式复杂、含大量公式与表格的论文；本地 PDF 提取始终保留为无上传回退。这里约束上传授权、密钥、缓存、归一化和按需检索，避免把解析服务的完整输出变成新的上下文负担。

## 目录

- [启用边界](#启用边界)
- [选择解析路径](#选择解析路径)
- [密钥与上传安全](#密钥与上传安全)
- [准备与归一化](#准备与归一化)
- [缓存契约](#缓存契约)
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

远程模式默认不请求 DOCX、HTML 或 LaTeX 导出。解析器把供应商输出归一化为稳定的内部接口：

| 文件 | 用途 |
|---|---|
| `document-index.json` | 标题层级、页范围、紧凑统计和可检索导航 |
| `blocks.ndjson` | 按页、阅读顺序保存的正文与结构块；只按需读取 |
| `page-map.json` | PDF 物理页、论文页码和归一化页索引映射 |
| `figure-candidates.json` | 图、图注、页码、bbox、来源路径与候选 ID |
| `table-candidates.json` | 表格标题、结构内容、截图、页码与候选 ID |
| `formula-candidates.json` | 公式编号、LaTeX、公式图、页码与候选 ID |
| `extraction-record.json` | 来源哈希、解析参数、模型/归一化版本、缓存和完整性记录 |

以 MinerU v1 `content_list` 作为稳定结构入口；v2 只用于同页和 bbox 可验证的增强。供应商原始文件含义以 [MinerU 官方输出格式说明](https://opendatalab.github.io/MinerU/reference/output_files/) 为准，但不要让供应商格式直接成为 `deck-spec.json` 或项目 MJS 的依赖。

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
normalizer_version
```

默认 `extra_formats=[]`。只有来源哈希、参数、模型和归一化版本完全一致，且 `extraction-record.json` 标记完成、归一化文件可读时才命中缓存。失败或部分结果不得伪装成命中。缓存失效时只重做来源阶段，不重做已经不受影响的叙事、页面或资产。

原始 ZIP、`full.md`、`content_list*.json`、`model`/`layout` JSON、HTML、TeX 和供应商图片属于内部缓存；不得复制到客户包。保留它们是为了重归一化与诊断，不是为了进入模型上下文。

## 索引与按需取证

首次来源分析只读取一次紧凑的 `document-index.json`，据此选择章节、风险页和候选资产。`retrieve-source-evidence.mjs` 不带 selector 时只返回该索引。需要支持具体主张、页面或局部修复时，再调用：

```bash
node scripts/retrieve-source-evidence.mjs \
  --source-dir <归一化来源目录> \
  --pages 12,18-20 \
  --types title,text,figure,table,formula \
  --max-blocks 80 \
  --max-chars 20000 \
  --pretty
```

也可使用 `--query <关键词>`、`--candidate <候选ID>` 和小范围 `--context-pages N`。检索结果写到标准输出，调用方只把当前决策需要的块放入活跃上下文，并把最终入选项转成 `evidence-index.json`、`figures.manifest.json` 或 profile 分析文件。

将流程理解为四步：

```text
cache：保存可复用的供应商结果
→ normalize：转成稳定、本地、可检索的结构
→ index：用紧凑地图选择页、块和候选资产
→ hydrate：只加载当前主张或页面需要的证据
```

## 上下文硬预算

- 每个源文件的完整内容读取最多一次；机器提取不等于允许模型反复通读。
- 禁止把完整 `full.md`、`content_list*.json`、`model*.json`、`layout*.json`、HTML、TeX 或整个解压目录放入提示词、agent 消息或 `deck-spec.json`。
- 禁止把完整 `blocks.ndjson` 一次读入上下文。先读索引，再按页、类型、候选 ID 或关键词 hydrate。
- 多 agent 协作时由一个 evidence owner 写来源清单与证据索引；其他 agent 只返回候选 ID、页码和简短发现，不各自重读全文或改写同一文件。
- 局部页面修复只 hydrate 该页所引用的证据块、候选资产及必要的相邻上下文；不重新读取整篇论文。
- 诊断默认报告计数、文件名、页码和每类少量代表样例，不回显大段供应商输出。

## 质量边界与回退

MinerU 的图、表和公式都是候选证据，不是最终科学真值。至少核对进入 PPT 的关键数字、单位、公式编号、上下标、图注归属、多面板组合和表格列关系。关键页以源 PDF 为最终裁决；投影清晰度不足时，从源 PDF 高分辨率重裁，而不是放大解析器的小图。

出现以下任一情况时切换到本地处理或只对受影响页补救：授权缺失、密钥缺失、上传失败、异步任务失败、输出页数不完整、页码映射冲突、关键公式/表格损坏、缓存完整性校验失败。记录回退原因和受影响页，不让远程服务故障阻断其余生产阶段。
