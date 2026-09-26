---
name: dsh-ppt-fusion
description: 用 DSH-native 前端（pptwise）+ 原生 DrawingML 深度引擎（ppt-master）做融合 PPTX：相位 0 路由、主题、分镜、页级作者、四步深度门、渲染后处理与评审。
---

# dsh-ppt-fusion 工作流（七相位 + checkpoint）

本 SKILL 是"怎么做"的权威流程；机器契约在 `docs/contracts.md`，裁决记录在 `docs/decisions.md`（ADR 比本文新）。模型无关，不写死模型名。

## 0. 相位路由

| 模式 | 何时选 | 入口 |
|---|---|---|
| **Generate**（默认） | 从主题/文档做新 deck | `init` → `plan` → … → `render` → `audit` |
| **Create Template** | 客户 pptx 做可复用模板 | `deep template create` → `deep template apply` |
| **Edit Native PPTX** | 已有 deck 要改内容/动效 | `deep native roundtrip` → 编辑 SVG → `deep render`/`render` |
| **Quick**（短相位） | 几页速稿、接受降级 | `init` → `plan --confirm` → `render`（跳过 deep 页） |

## 1. 相位 1 · 意图与叙事
- 问清：受众、场合、页数、原生图表/表格/公式、旁白/动画、品牌来源。
- 叙事用 pptwise presets；一页一个主张，标题写结论。
- **BLOCKING**：受众或用途不明 → 先问，不要猜。

## 2. 相位 2 · 主题
- `dsh-ppt theme list` 看 24 个预设；2–4 个候选用 `theme try <ids>` 出选型接触片。
- 客户品牌：`dsh-ppt brand extract <file> --bind <deck>`（ThemeFile v2 → `{file:...}` → 自动 `theme ensure`）。
- **品牌忠实**：`--bind` 写出的 `brand.theme.json` 就是客户色/字体，不得为了好看改写；确需调整先问用户。
- 绑定后 **必须** `theme ensure`（deep 页 spec_lock 依赖 tokens）。

## 3. 相位 3 · 大纲 → 分镜 → 规划确认（BLOCKING）
- `dsh-ppt init <dir> --theme <preset>`；`dsh-ppt plan <dir>` 起草 `deck.fusion.draft.json`（含 manifest + storyboard 骨架）。
- **分镜** `deck.storyboard.json`：**每页必须声明 `role`**（含 storyboard 专有的 `toc`）/`layout`（`<主题>:<版式脸>`，取自绑定主题菜单）/`route`/`chrome.pageNumber`/`budget`/`source`；字号阶梯、色板角色和 role 几何（标题锚点/列宽/卡间距）按 `references/design-language.md`。`init`、`plan` 已按菜单填首个合法版式，只改有理由的页；`content` 页按 IR `kind` 细分 `data`/`quote`。
- **chrome 一次声明**：`chrome` 写页码（默认封面/结束页跳过）、footer、section；正文不要手画页脚/页码。冲突以 manifest 为准，`validate` 会拦。
- `deck.fusion.json` 逐页声明 `route: pptwise | ppt-master`；deep 页必须写 `deep: { dir, kind, format }` 且 IR 对应页 `placeholder: true`。
- 页级路由决策表：

| 页内容 | 路由 |
|---|---|
| 封面/结束页/要点/卡片/时间线/引用 | `pptwise` |
| 图表 / 表格 / 公式 | `ppt-master`（原生对象；公式带 MCE 线性回退） |
| 多图/图标拼贴、复杂矢量图 | `ppt-master`（注意 PNG 回退，B7） |
| 纯文本页想加动画 | `pptwise`（post 按 `blk<slide>-<block>` 命名） |

- **BLOCKING**：`plan --confirm` 前把 storyboard 逐页交用户确认（role/版式/预算/来源），得到确认才落草稿；confirm 同时落 manifest 与 storyboard。

## 4. 相位 4 · 按 role 作者
- 按 storyboard 的 role 写页：`cover`/`ending`/`section` 标题句 + 1–2 条支撑；`content` 一页一主张、标题写结论；`data` 走 deep 且一页一个主图形/表格；`quote` 引用 + 出处。
- 标准页：写 pptwise IR（组件词汇见 `tokens export --master` 的角色表）；排版按 `references/design-language.md` 的字号阶梯与 role 几何，内容页用 2–3 列卡片、一列一个要点。
- deep 页：按七条契约（ADR-007）与 `svg-contract`；颜色只用 `tokens.json`，`audit --pixels` 抽查 ΔE。
- 内容必须在 `budget` 内：`validate` 实测文本/条目/图表/表格/图片数，超限即 error；先删内容或换版式，不要抬预算。
- 旁白：每页写 `deep/<page>/notes.md`；音频放 `<deck>/narration/*.mp3`（按 SVG stem 匹配）。

## 5. 相位 5 · Gates（BLOCKING，任一红即停）
1. `dsh-ppt validate <dir>`：manifest/IR/**storyboard（存在、覆盖、role↔版式、预算）**/deep 文件/theme 同步。
2. `dsh-ppt deep render <dir>` 内部固定四步：`stamp-native-fallbacks --write` → `svg-quality-check --stage final --canonical-authoring` → `svg-to-pptx --quick-generate --native-charts-and-tables --with-notes` → 读 `validation/<stem>.report.json`（读报告，不读 stdout，ADR-009）。
3. `dsh-ppt audit <dir>`：八源统一门（`--pixels` 可选）。
4. **禁止**为过门降低质量：不许手改二进制、跳过 `--stage final` 或把 deep 页降级成标准页。

## 5.5 相位 5.5 · 渲染自评（`DSH_PPT_REVIEW`）

相位 6 渲染完成后执行，默认 `pixel`：

- **`pixel`（地板）**：`dsh-ppt renderpages <dir>` → `dsh-ppt audit <dir> --rendered`（发布门用 `--require-rendered`）；按 `render-*` findings 回相位 4 的对应层修，重渲后再审。
- **`model`（先看后改）**：在 pixel 之上调用 `dsh_ppt_review`（把页图作为图片附件给模型），按 rubric 逐页找 off-page / overflow / contrast / 密度 / 叙事问题，再用同工具带 `findings` 写入 `.dsh-ppt/review/review.json`。工具报 `image-input-unavailable` 时如实记录"视觉自评未运行"，**不得假装看过图**。
- **收敛**：最多 2 轮（`review.maxRounds`）；未收敛就把剩余 findings 交用户 BLOCKING，**不要自行 approve**（approve 只归用户）。
- **`subagent`（可选）**：可派独立子代理跑同一 rubric，冲突项标 `critic-disagrees`，默认关闭。
- **交付前的工作树（`dsh_ppt_propose`）**：要改已交付的 deck 时，用该工具把这一版登记成草稿并开会话审查卡（diff trunk ↔ 草稿 + 页缩略图 + approve/discard 命令）；**模型不得 approve**——approve/discard 只由用户执行 `dsh-ppt approve/discard`。
## 6. 相位 6 · 渲染与后处理
- `dsh-ppt render <dir> [-o out.pptx] [--compat safe|standard|max]`：base → deep → merge（单一母版）→ post（动画唯一 owner）→ compat → 结构/交付门 → 原子发布 + `out/manifest.json`/`compat-report.json`。
- 动画：`post/animations.json` 支持 `transition` 与 `entrance`/`emphasis`/`path`（顺序 entrance → emphasis → path）；selector 匹配不到是硬失败。
- 旁白：`dsh-ppt narrate <dir> -o narration`（edge 默认，无需 key；先有 notes roster），再 `render` 自动嵌入音频并设 auto-advance。
- 只改动效可 `dsh-ppt post animate <dir>`；它同样重跑 compat 并刷新 manifest。

## 7. 相位 7 · 评审
- `dsh-ppt audit <dir> --pixels`；必要时 `--strict`（warning 也非零）。
- `dsh-ppt preview <dir> --html`（DSH 工具 `dsh_ppt_preview`）：标准页走 pptwise，deep 页用作者 SVG。
- 逐页读 `out/manifest.json`、`compat-report.json` 与 `.dsh-ppt/review/review.json`（存在时）：单母版、图表可编辑、配色一致、署名齐全。
- 交付口径 = 用户显式 approve；不要在这里重新渲染或自行批准。
- Revision Round：只走对应相位并重跑该相位与其后的门，不要整链重来。

## checkpoint / resume（长链路兜底）
- 每个相位结束写 `.dsh-ppt/checkpoint.json`：`{ version, phase, deck, updatedAt, artifacts, gates, notes }`；**phase 3 额外写 `"storyboard": "deck.storyboard.json"`**。**这是硬要求**。
- **新会话第一步**：`dsh-ppt resume <dir>` 读 checkpoint，打印相位/产物/下一步命令；`--write` 另写 `.dsh-ppt/resume.md`。不要凭记忆重跑。
- 产物缺失时 `resume` 非零退出：先补齐再继续；与 `out/manifest.json` 冲突时以 manifest 的 sha256 为准。

## 配图禁则
- 配图/背景优先级：`svg` → `user` → `office`（本机有资源时，`dsh-ppt assets copy --source office`）→ `flat` → `photo`（仅 `dsh-ppt images search`）；许可以 `asset-manifest.json` / `assets/image_sources.json` 为准，缺失即失败。
- AI 生成图是默认关闭的可选扩展（B5.5）；未开启时降级，不得依赖或伪造来源。

## 参考装载（预算受 prompt-audit 守门）
- 默认装载本相位相关的 8–12 篇 vendor 文档与 `references/design-language.md`；其余按需，不要一次性全读（预算门会红）。
- `dsh-ppt skill audit` 是预算门（语料上限 120000 tokens；本文件 2500）；红了先少读或先精简，不要改预算。
- 上游 references/workflows 未随 wheel 分发：需要时从上游仓库取（见 vendor manifest）。

## 命令面（本 SKILL 只教这些）
`version · doctor · init · plan · resume · validate · theme ensure|list|new|fork|try · tokens export · brand extract · design profile extract · assets discover|list|copy · source · images search|generate · deep render · deep native roundtrip · deep template create|apply|register · post animate · narrate · render · preview · compat lint · audit · skill audit`

## 失败时
- 错误格式 `dsh-ppt: <code> <message>`；先看 code，再读 `.dsh-ppt/logs/` 的最后一份日志。
- `dsh-ppt doctor` 的 png-renderer 红是设计使然（无 cairo，B7 用 sharp 兜底，ADR-020/025）；其余项全绿不要 `--repair`。
- 只有 Node/uv/venv/引擎本体缺失才 `doctor --repair`；不要手工改 venv。
