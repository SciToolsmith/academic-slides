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

## 交付内容

```text
短题名_组会汇报/
├── 短题名_组会汇报.pptx
├── 短题名_组会汇报_发言稿.docx
├── 短题名_组会汇报.mjs
└── assets/
```

PPT、发言稿和来源信息保持同步，所有页面均可继续编辑。

## 许可

本项目采用 [MIT License](LICENSE)。第三方组件说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
