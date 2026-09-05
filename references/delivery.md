# 按需交付与重建

内部项目保留源论文、索引、规划、QA 与缓存。交付范围由用户请求决定，并显式记录 `output.delivery_mode`；无此字段的旧配置继续按 `rebuildable_pack` 处理。

## 三种交付模式

| mode | 客户包内容 | 使用场景 |
| --- | --- | --- |
| `pptx_with_notes` | 同名 PPTX | 新任务默认，只需要可编辑 PPT 与备注 |
| `presenter_pack` | PPTX + `_发言稿.docx` | 用户要独立 Word 讲稿 |
| `rebuildable_pack` | PPTX + Word + 同名 MJS + `assets/` | 用户要可重建项目或源码 |

PPT 的 Sources 与讲稿备注始终保留。只在需要 Word 的模式同步生成 Word；只在重建包中交付 MJS 和被引用的资产。内部构建入口可以生成 MJS 供安全暂存验证，这不扩大客户交付范围。

默认 basename 为“短题名_组会汇报”，用户明确的安全命名优先。拒绝路径越界与敏感内容，而不把日期或版本号本身当作科学错误。实际内容须满足所选 mode 的白名单。

## 同源与编辑边界

PPT 备注来自 `speaker_notes`，需要 Word 时从同一数据生成，保证页序、讲稿和过渡一致。Sources 留在 PPT 备注中，Word 默认只保留口头讲稿。

文字、表格、支持的图表与简单图形为原生可编辑；论文原图和复杂公式以忠实图片呈现。公式 TeX 是可编辑重建源，不承诺所有符号能直接在 PowerPoint 中修改。

## 重建包

MJS 内嵌最终规格、包内相对资产和构建 manifest。manifest 记录生成实现、schema、模板及 runtime 等可核验信息；有 Git 仓库时记录提交。哈希比较防止升级 skill 后静默换 renderer，不代表不同操作系统能像素级一致。

“按原环境重建”须通过兼容性检查。“迁移到当前版本”必须明确执行，生成新入口并重新检查产物。旧交付缺少版本锁时如实提示，不伪造过去使用的版本。嵌入规格和完整性校验属于封存快照；修改内容应回到内部规格或受支持的迁移入口重新生成，不随意去掉哈希检查。

`assets/` 只保留实际依赖的源图、派生图、公式和数据。用于验证处理溯源的原图/元数据也属于真实构建依赖。不要保留空素材子目录、未使用素材或外部绝对路径。

## 暂存与检查

1. 用 `scripts/build-project.mjs --render` 按配置构建内部产物；显式 `--delivery-mode` 可覆盖配置。
2. 检查 PPT 证据与渲染；需要 Word 时再运行 `render-word-qa.mjs`。
3. 用 `scripts/stage-delivery.mjs --output <客户包目录> --mjs <内部项目.mjs> --delivery-mode <mode>` 从干净目录重建所选格式；需要资产时提供 `--assets`。
4. 验证页面、备注、已请求的 Word、manifest 与输出范围。已知敏感词用 `--forbidden-term` 指定。
5. 新包完整通过后原子替换旧包；失败时保留旧包。

最终展示所选包和必要限制。源 PDF、project/deck spec、paper/evidence/asset 索引、QA、预览、OCR、日志、缓存及 `node_modules` 留在内部工作区，除非用户另有明确要求。
