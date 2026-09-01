# 最小客户交付标准

内部工作区保留证据、规划、QA 和缓存；客户包只保留使用或重建本次组会 PPT 必需的内容。

## 唯一目录结构

    短题名_组会汇报/
    ├── 短题名_组会汇报.pptx
    ├── 短题名_组会汇报.mjs
    ├── 短题名_组会汇报_发言稿.docx
    └── assets/
        ├── papers/
        ├── formulas/
        └── data/

<code>assets/</code> 必须存在；子目录只在实际包含交付文件时创建。论文素材目录只保留本稿实际使用的忠实提取图和派生版本。入选公式按需保留 <code>.tex</code>、<code>.svg</code> 或 <code>.png</code>；不保留编译日志和临时 PDF。<code>data/</code> 只放可编辑图表真正依赖的数据文件。

## 命名

文件夹、PPTX 和 MJS 使用同一 basename：<code>短题名_组会汇报</code>。

不在名称中加入姓名、日期、版本号、v1、final、“最终版”、“终稿”或“最新版”。题名过长时提取不改变含义的短题名，不为命名另行询问用户。

## 三个文件的契约

- PPTX 保持可编辑，并在每页备注中写入发言稿、过渡和唯一 <code>[Sources]</code> 区块。
- Word 发言稿与 PPT 备注从同一份 <code>speaker_notes</code> 生成。正文按“第 N 页：讲稿”紧凑排版，不输出 Sources。
- MJS 嵌入最终项目规格，只使用 <code>assets/</code> 内的相对路径，不读取未交付的 <code>deck-spec.json</code>，默认重建同名 PPTX 与 DOCX。
- MJS 可以依赖已安装的 <code>paper-club-ppt</code> Skill，但不得写入 Skill 或本机的绝对路径。

## 不交付

不要复制以下内容：

- 原始论文 PDF；
- <code>project-config.json</code>、<code>deck-spec.json</code> 和大纲；
- paper/evidence/asset 索引；
- QA 报告、构建报告、预览图、联系表和逐页渲染图；
- OCR 文本、日志、缓存、<code>node_modules</code> 和测试文件；
- 内部布局库、未使用素材、越界路径或密钥。

多篇任务默认只交付入选和重点分析图片；完整图表提取仅在用户明确要求时交付。

## 构建与交付

客户交付只接受 <code>artifact_purpose: production</code>。正常交付包括一次内部构建和一次空白暂存重建：

1. 使用 <code>scripts/build-project.mjs --render</code> 生成并检查内部 PPTX、Word 与项目 MJS。
2. 使用 <code>scripts/render-word-qa.mjs</code> 检查 Word 可读性、页数和讲稿同步。
3. 使用 <code>scripts/stage-delivery.mjs --output &lt;短题名_组会汇报&gt; --mjs &lt;项目.mjs&gt; [--assets &lt;已筛选素材目录&gt;]</code> 在空白目录重建一次。
4. 暂存脚本校验 canonical MJS、页面顺序、PPT 备注、Word 讲稿和白名单内容。
5. 已知姓名、学号或其他敏感词通过重复的 <code>--forbidden-term</code> 传入。
6. 旧交付目录只在新暂存包完整通过后原子替换；失败时保留旧包。
7. 最终只向用户展示交付目录，不罗列内部中间产物。
