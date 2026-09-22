---
name: dsh-ppt-fusion
description: 用 DSH-native 前端（pptwise）+ 原生 DrawingML 深度引擎（ppt-master）做融合 PPTX：相位 0 路由、主题、大纲、页级作者、四步深度门、渲染后处理与评审。
---

# dsh-ppt-fusion 工作流（七相位 + checkpoint）

本 SKILL 是"怎么做"的权威流程；机器契约在 `docs/contracts.md`，裁决记录在 `docs/decisions.md`（ADR 比本文新）。
模型无关：不写死模型名；DeepSeek 默认可跑，能力验证在 M6。

## 0. 相位路由（先选定，再动手）

| 模式 | 何时选 | 入口 |
|---|---|---|
| **Generate**（默认） | 从主题/文档/大纲做一套新 deck | `init` → `plan` → … → `render` → `audit` |
| **Create Template** | 客户给了 pptx，要做可复用模板 | `deep template create` → `deep template apply` |
| **Edit Native PPTX** | 已有 deck 要改内容/动效 | `deep native roundtrip` → 编辑 SVG → `deep render`/`render` |
| **Quick**（短相位） | 只要几页速稿、明确接受降级 | `init` → `plan --confirm` → `render`（跳过 deep 页） |

## 1. 相位 1 · 意图与叙事
- 问清：受众、场合、页数上限、是否要原生图表/表格/公式、是否要旁白/动画、品牌来源。
- 叙事词汇用 pptwise narrative presets；一页一个主张，标题写结论不写名词。
- **BLOCKING**：受众或用途不明 → 先问，不要猜。

## 2. 相位 2 · 主题
- `dsh-ppt theme list` 看 24 个预设；2–4 个候选用 `theme try <ids>` 出选型接触片。
- 客户品牌：`dsh-ppt brand extract <file> --bind <deck>`（提取 ThemeFile v2 → 写 `{file:...}` → 自动 `theme ensure`）。
- **品牌忠实**：`--bind` 写出的 `brand.theme.json` 就是客户色/字体，**不得**为了好看改写其中的颜色或字体；确需调整先问用户，得到确认才改。
- 绑定后 **必须** `theme ensure`（deep 页的 spec_lock 依赖 tokens）；`validate` 会检查 tokens 是否过期。

## 3. 相位 3 · 大纲与规格
- `dsh-ppt init <dir> --theme <preset>`；`dsh-ppt plan <dir>` 起草，模型补齐后 `plan --confirm`。
- `deck.fusion.json` 逐页声明：`route: pptwise | ppt-master`；deep 页必须写 `deep: { dir, kind, format }` 且 IR 对应页 `placeholder: true`。
- 页级路由决策表：

| 页内容 | 路由 | 理由 |
|---|---|---|
| 封面/结束页/要点/卡片/时间线/引用 | `pptwise` | 文本与几何，IR 组件已覆盖 |
| 图表（bar/line/pie/area/scatter…） | `ppt-master` | 需要原生可编辑图表对象 |
| 表格 | `ppt-master` | 需要原生表格 |
| 公式 | `ppt-master` | `a14:m` + MCE 线性文本回退 |
| 多图/图标拼贴、复杂矢量图 | `ppt-master` | SVG 作者自由度；注意 PNG 回退（B7） |
| 纯文本页想加动画 | `pptwise` | post 按 `blk<slide>-<block>` 名字目标 |

## 4. 相位 4 · 作者
- 标准页：写 pptwise IR（组件词汇见 `tokens export --master` 的角色表）。
- deep 页：按 **七条作者契约**（ADR-007）：`spec_lock.md` 数字排版锚点、根 `data-pptx-page-role`、元素 `data-pptx-role` id、根 `<g data-pptx-bounds>` 分区不重叠且文本溢出 ≤5%、页内字号分档、`stamp-native-fallbacks` 哈希、可见回退完整投影到原生对象 marker。
- deep 页只能引用 `tokens.json` 的颜色；`audit --pixels` 会抽样比对 ΔE。
- 旁白文本：每页写 `deep/<page>/notes.md`；音频放 `<deck>/narration/*.mp3`（按 SVG stem 匹配）。

## 5. 相位 5 · Gates（BLOCKING，任一红即停）
1. `dsh-ppt validate <dir>`：manifest/IR/deep 文件/theme 同步。
2. `dsh-ppt deep render <dir>` 内部固定四步：`stamp-native-fallbacks --write` → `svg-quality-check --stage final --canonical-authoring` → `svg-to-pptx --quick-generate --native-charts-and-tables --with-notes` → 读 `validation/<stem>.report.json`（不要读 stdout，ADR-009）。
3. `dsh-ppt audit <dir>`：八源统一门（validate、pptwise validate/audit、svg-quality、OPC+P1、delivery、compat、可选 pixels）。
4. **禁止**为了过门而降低质量：不许手改二进制、不许跳过 `--stage final`、不许把 deep 页降级成标准页。

## 6. 相位 6 · 渲染与后处理
- `dsh-ppt render <dir> [-o out.pptx] [--compat safe|standard|max]`：base → deep → merge（单一母版）→ post（动画唯一 owner）→ compat → 结构/交付门 → 原子发布 + `out/manifest.json` + `out/compat-report.json`。
- 动画：`post/animations.json` 支持 `transition` 与 `entrance`/`emphasis`/`path`（顺序 entrance → emphasis → path）；selector 匹配不到是硬失败，不是 no-op。
- 旁白：`dsh-ppt narrate <dir> -o narration`（edge 默认，无需 key；先有 notes roster），再 `render` 自动嵌入音频并设 auto-advance。
- 只改动效可 `dsh-ppt post animate <dir>`；它同样重跑 compat 并刷新 manifest。

## 7. 相位 7 · 评审
- `dsh-ppt audit <dir> --pixels`；必要时 `--strict`（warning 也非零）。
- 逐页读 `out/manifest.json` 与 `compat-report.json`；对照评审清单：单母版、图表可编辑、配色一致、署名齐全。
- Revision Round：改动只走对应相位，改完重跑该相位与其后的门；不要整链重来。

## checkpoint / resume（长链路兜底）
- 每个相位结束写 `.dsh-ppt/checkpoint.json`：`{ version, phase, deck, updatedAt, artifacts, gates, notes }`；产物路径写相对路径。**这是硬要求**，不要等全部做完才写。
- **新会话第一步**：`dsh-ppt resume <dir>` —— 读 checkpoint，打印当前相位、已完成产物、下一个应执行的命令；`--write` 会把同一份简报写到 `.dsh-ppt/resume.md`。不要凭记忆重跑。
- checkpoint 声明的产物缺失时 `resume` 非零退出：先补齐或修正 checkpoint，再继续。
- checkpoint 与 `out/manifest.json` 冲突时以 manifest 的 sha256 为准。

## 配图禁则
- 只用 `dsh-ppt images search`（openverse/wikimedia 无 key；pexels/pixabay 需 key）；`assets/image_sources.json` 缺许可或缺署名即失败。
- 用户要 AI 生成图：**明确不支持**（`image-gen` 不在白名单），改为图库检索或用户自带图；不得伪造图片。

## 参考装载（预算受 prompt-audit 守门）
- 默认装载 `python-assets/vendor/ppt-master/docs/` 中与本相位相关的 8–12 篇：`svg-pipeline.md`、`svg-contract.md`、`native-data.md`、`pptx-animations.md`、`pptx-transitions.md`、`narration.md`、`image.md`、`template-tools.md`、`project.md`、`conversion.md`、`troubleshooting.md`、`prompt_audit.md`。
- 其余 vendored 文档按需读取；不要一次性全读（预算门会红）。
- `dsh-ppt skill audit` 是预算门：语料上限 120000 tokens（当前总量以命令输出为准）；红了先少读，不要改预算。
- 上游 references/workflows 未随 wheel 分发：需要时从上游仓库取（见 vendor manifest 备注）。

## 命令面（本 SKILL 只教这些）
`version · doctor · init · plan · resume · validate · theme ensure|list|new|fork|try · tokens export · brand extract · source · images search · deep render · deep native roundtrip · deep template create|apply|register · post animate · narrate · render · compat lint · audit · skill audit`

## 失败时
- 每条错误都是 `dsh-ppt: <code> <message>`；先看 code，再读 `<deck>/.dsh-ppt/logs/` 的最后一份日志。
- `dsh-ppt doctor` 的 png-renderer 红是设计使然（本机无 cairo，B7 用 sharp 兜底，ADR-020/025）；其余项全绿就不要跑 `--repair`。
- 只有 Node/uv/venv/引擎本体缺失时才 `dsh-ppt doctor --repair`；不要手工改 venv。
