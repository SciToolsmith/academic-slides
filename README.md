<div align="center">

<h1>Paper Club PPT</h1>

<p><strong>把研究论文变成讲得清、看得懂、可追溯的组会汇报 PPT。</strong></p>

<p>面向 Codex 的开源 Skill · 单篇精读 · 多篇对比</p>

<p>
  <a href="https://github.com/SciToolsmith/paper-club-ppt/actions/workflows/ci.yml"><img src="https://github.com/SciToolsmith/paper-club-ppt/actions/workflows/ci.yml/badge.svg" alt="Validation"/></a>
  <a href="https://github.com/SciToolsmith/paper-club-ppt/releases/latest"><img src="https://img.shields.io/github/v/release/SciToolsmith/paper-club-ppt?style=flat-square" alt="Latest release"/></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/SciToolsmith/paper-club-ppt?style=flat-square" alt="MIT License"/></a>
</p>

</div>

## 简介

Paper Club PPT 用于制作以研究论文为核心的组会汇报。它围绕研究问题、方法、证据、核心发现和批判性思考组织内容，而不是简单复述论文目录或把 PDF 直接转换成幻灯片。

## 核心能力

- 支持单篇论文精读与多篇论文对比；
- 提取、裁切并标注论文中的关键图表；
- 建立主张、证据和来源之间的对应关系；
- 区分作者结论、图表事实和汇报者判断；
- 生成可编辑 PPTX、同步发言稿和可重建源码。

## 安装

在 Codex 中使用 `$skill-installer`：

```text
使用 $skill-installer，从 https://github.com/SciToolsmith/paper-club-ppt 安装 paper-club-ppt。
```

## 使用

单篇论文：

```text
使用 $paper-club-ppt，根据我上传的论文制作组会汇报 PPT。
重点讲清研究问题、研究方法、核心图、主要发现、局限和启发。
```

多篇论文：

```text
使用 $paper-club-ppt，对我上传的论文制作对比型组会汇报 PPT。
围绕共同问题比较方法、证据、结论和适用边界。
```

## 默认与定制

未指定时直接使用自动页数和学术蓝。单篇精读保留章节导航，多篇问题比较可围绕共同问题展开；可使用结论标题、其他语言结束语和明确请求的答疑备用页。

```text
围绕这三篇为什么得到不同结论组织汇报，先讲比较轴。
使用结论型标题，最后留两页方法细节供答疑，只交付PPT。
```

## 交付内容

| 请求 | 交付 |
| --- | --- |
| 默认制作 PPT | 可编辑 PPTX，含逐页讲稿备注和来源 |
| 同时要 Word 讲稿 | PPTX + 同源 DOCX |
| 要可重建源码包 | PPTX + DOCX + MJS + 所需 assets |

源图与复杂公式可能以图片呈现；文字、表格、支持的图表和简单图形保持原生可编辑。TeX 公式源可修改后重建，不等于原生 PowerPoint 数学对象。

重建包会记录实现、模板和运行环境；发现版本变化会提示恢复匹配版本或明确迁移，不静默换用新版 renderer。

## 质量与评测边界

自动裁图是待核验候选，保留完整图注和图片哈希。移动文件到 `ready/` 不代表已处理；清晰原图经过目标尺寸核验可保持原样。

脚本测试验证结构、溯源和已知回归，不能替代来源核对与渲染检查。真实行为/作品评测方法见 [评测说明](references/evaluation.md)。维护检查：

```sh
node scripts/validate-skill-assets.mjs . --profile release --strict
```

## 许可

本项目采用 [MIT License](LICENSE)。第三方组件说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
