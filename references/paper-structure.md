# 叙事、导航与附录配置

导航帮助听众定位，不能取代页面要表达的判断。选择叙事模式后再检查相应结构；科学证据要求不随模式降低。

## 顺序精读

`structure.narrative_mode=paper_walkthrough` 保持已有兼容默认。单篇默认不放目录；多篇按 `literature.focal_paper_ids` 排列论文目录与编号分隔。

每篇按 `X.1 文献基本信息`、`X.2 研究背景与意义`、`X.3 研究设计与方法`、`X.4 主要结果与结论` 展开；`X.5 批判性思考与启示` 按需独立成页。章节编号表示语义，不是页码。跨页重复章节编号，`render_data.continuation` 可表示当前/总页数。

`structure.title_policy=section` 为旧规格默认，完整章节名写在 `content.title`。当使用 `title_policy=claim` 时，把章节导航写入 `content.section_label`，主标题 `content.title` 写本页判断；`render_data.paper_no` 保留论文号。导航可随汇报语言翻译。

## 围绕问题比较

`structure.narrative_mode=question_comparison` 适合共同问题、方法取舍或结论冲突。先展示共同问题与可比维度，再按比较轴安排证据；无需逐篇重复目录、divider 和固定四章。章节/标题保持真实阅读顺序，不把多篇证据强塞成轮流讲完。

- 每页用 `paper_ids` 标出参与论文，保留稳定 `claim_ids` 和来源；来源条目的 `paper_id` 指向所属论文。
- 每篇焦点论文都要有研究问题、方法/证据生成方式、核心发现的实际源证据和可信度边界。覆盖可跨页完成，不能用一串角色标签代替上屏解释。
- 同口径才横向比较；数据集、终点、尺度或样本不同须标明。
- 作者结论与汇报者综合分别绑定证据，不能把综合判断归给某篇论文。

## 主稿结尾与备用页

`structure.closing_mode=thanks` 保留简洁结束壳，文案按用户语言和风格，不强制特定中文字符串。`closing_mode=discussion` 允许总结/讨论承担收束：在 closing 的 `render_data.synthesis`、`prompts` 或 `content.body/bullets` 放入有意义的内容；最多 3 个讨论点，更多内容另起正文页。讨论页与正文一样需要讲稿和证据来源。

每类内容选择一个规范字段：总结用 `synthesis` 或 `body`，讨论点用 `prompts` 或 `bullets`。两处都填写时文本须等价，避免不同判断相互覆盖；空字段可回退到另一处非空内容。

`structure.appendix_policy=none` 为默认。用户请求答疑备用页时使用 `after_closing_unlisted`，将备用页标为 `kind=appendix`（或附录章节），放在主稿 closing 之后，不加入主稿目录。固定页数默认不计备用页；如用户要总页数，把 project 的 `page_policy.include_appendix_in_count` 与 deck 的 `timing.include_appendix_in_count` 同时设为 `true`，两处口径须一致。

封面与结尾依照已知信息和用户提供的壳层；未知汇报人或会议日期可省略，不填论文作者或虚构信息。
