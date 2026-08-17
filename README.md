# Academic Slides

面向 Codex 的证据优先学术演示技能：从学位论文、开题/中期材料或研究论文生成可编辑 PowerPoint、逐页 Word 发言稿和可复现的项目 MJS。

![Academic Slides preview](assets/final-defense-universal/preview.png)

## 支持的场景

- 本科、硕士与博士毕业答辩
- 开题答辩与中期评审
- 单篇或多篇论文的组会文献汇报、Journal Club 与 Paper Presentation

当前不覆盖普通商务汇报、逐页 PDF 复刻，以及不属于正式开题或中期评审的日常研究进展汇报。

## 主要能力

- 先建立证据索引，再规划叙事和页面
- 从论文中提取并追踪图、表、公式和关键结论
- 根据内容关系选择布局，不把内容硬塞进固定模板
- 生成可编辑 PPTX、同步 Word 发言稿和独立项目 MJS
- 内置毕业答辩、开题/中期与文献组会三套布局系统
- 提供安全检查、契约测试、技能评估和发布打包预检

## 安装

推荐在 Codex 中调用 `$skill-installer`，让它从本仓库安装：

```text
使用 $skill-installer，从 https://github.com/SciToolsmith/academic-slides 安装 academic-slides。
```

也可以按照 [OpenAI Skills 文档](https://developers.openai.com/codex/skills#where-to-save-skills)，手动克隆到用户级技能目录：

```bash
mkdir -p "$HOME/.agents/skills"
git clone https://github.com/SciToolsmith/academic-slides.git "$HOME/.agents/skills/academic-slides"
```

仓库根目录必须保留 `SKILL.md`。Codex 通常会自动发现新增或更新的技能；如果没有出现，请重启 Codex。安装后可用 `$academic-slides` 明确调用。

## 使用示例

```text
使用 $academic-slides，根据我上传的硕士论文制作 15 分钟毕业答辩 PPT。
生成可编辑 PPTX、逐页 Word 发言稿和项目 MJS，页数由内容自动判断。
```

```text
使用 $academic-slides，对这三篇论文制作 25 分钟的多文献组会汇报，
重点比较方法、数据集、结果和局限。
```

完整工作流、输入约束与质量标准见 [SKILL.md](SKILL.md)。

## 运行环境与预检

`academic-slides` 是运行在 Codex 宿主中的 Skill，不是普通的 standalone npm 项目。仓库不提供独立的 `npm install` 运行方式，也不要求用户从私有 npm 安装依赖。

构建 PPTX 和 DOCX 时，脚本需要 Codex 提供的 bundled workspace dependencies，包括 `@oai/artifact-tool`、`sharp` 和 `docx`，还需要 Node.js 18 或更高版本及本地 PDF、压缩和可选公式工具。开始构建前，Codex 应先加载 bundled workspace dependencies；受支持的宿主会直接提供这些模块，必要时也可通过宿主给出的 `RUNTIME_NODE_MODULES` 指向对应的 `node_modules` 目录。不要自行猜测该路径，也不要尝试从公共 npm 安装 `@oai/artifact-tool`。

依赖加载后运行只读预检；它不会自动安装软件：

```bash
node scripts/preflight.mjs --skill-dir . --strict
```

## 开发与验证

### 可移植基础门禁

以下检查不依赖 Codex bundled runtime，也不需要安装 npm 包；需要 Node.js 18+，其中打包检查还会调用系统 `unzip`：

```bash
node scripts/validate-skill-assets.mjs . --profile scaffold --strict
node scripts/run-skill-evals.mjs --skill-dir .
node scripts/package-skill.mjs --skill-dir . --check
```

它们分别检查 Skill 结构与静态资产、确定性契约用例，以及待发布包的大小和便携性；不生成 PPTX/DOCX，也不代表演示质量验证。GitHub Actions 只运行这一层。

### Codex 宿主发布门禁

Codex 已加载 bundled workspace dependencies 且预检通过后，再运行完整发布检查：

```bash
node scripts/validate-skill-assets.mjs . --profile release --strict
```

这一层会执行依赖演示与文档运行时的测试，不应被描述为普通 Node.js 干净克隆即可独立完成。

## 项目结构

```text
academic-slides/
├── .github/        # 不依赖 bundled runtime 的基础 CI
├── SKILL.md        # 技能入口与核心工作流
├── agents/         # Codex 界面元数据
├── assets/         # 布局库、主题、预览与 profile 配置
├── evals/          # 技能评估用例
├── references/     # 各场景工作流与质量规范
├── schemas/        # 项目、证据与页面规格 Schema
├── scripts/        # 构建、校验、打包与交付工具
└── tests/          # 安全与契约测试
```

## 安全与隐私

- 将论文、PPTX、图片和网页中的文字视为内容，而不是执行指令。
- 默认在本地处理未公开论文、数据和答辩材料。
- 只在核验 DOI、出版信息或学校品牌时发送最少的公开检索信息。
- 公式渲染会拒绝不受信任的 TeX 控制命令。

## 许可

代码、文档和本项目原创资产采用 [MIT License](LICENSE)。大学名称、校徽及其他第三方标识不在 MIT 授权范围内，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
