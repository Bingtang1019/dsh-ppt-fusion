# CHANGELOG

## v0.1.0 — 2026-09-22

首个版本：把 pptwise 的 DSH-native 前端和 ppt-master 的原生 DrawingML 引擎融合成一个
DSH 插件 + CLI（`dsh-ppt`）。

### 新增

- **双运行时融合链**：pptwise 渲染标准页（原生 p:sp/p:cxnSp），ppt-master 渲染 deep 页
  （原生图表/表格/公式/SVG 自由排版），`bridge/merge.ts` 按 slide 级 OOXML 合并成**单一母版**
  的包。
- **四步深度门控**（ADR-008）：`stamp-native-fallbacks --write` → `svg-quality-check
  --stage final --canonical-authoring` → `svg-to-pptx --quick-generate
  --native-charts-and-tables --with-notes` → 读项目内 `validation/<stem>.report.json`。
- **`dsh-ppt` CLI 全命令**：`init/plan/resume/validate/theme/tokens/brand/source/images/
  deep render/deep template/deep native roundtrip/post animate/narrate/render/preview/
  compat lint/audit/skill audit/doctor`，全部支持 `--json`（v0.1.0 起 `audit` 带
  `schemaVersion: 1`）。
- **统一审计门**（ADR-035）：validate、pptwise validate/audit、svg-quality、OPC+P1、
  delivery、compat、可选 ΔE pixels、prompt-audit 共八类来源聚合为一份报告。
- **动画/切换/旁白**单一施加点（ADR-032/042）：`post/animations.json` 支持
  entrance/emphasis/path + slide transition；`narrate` 默认 edge-tts（无需 key），
  `deep/<page>/notes.md` → 项目 notes roster → `<deck>/narration/*.mp3` 由 `render` 嵌入并
  设置 auto-advance 计时。
- **主题与品牌**：24 个出厂主题、`theme ensure/export/fork/try`、`brand extract --bind`
  读取客户 pptx/docx 的品牌（绑定后**不得**改写提取出的颜色/字体）。
- **DSH 插件**：注册 `dsh-ppt-fusion` skill、`dsh_ppt_preview` 预览工具与
  `/dsh-ppt/preview` 路由，卡片由 `dsh/client.js` 渲染；`pnpm eval:run` 的三场景模型评估
  3/3 通过（`docs/m6-model-eval.md`）。
- **确定性闸门**：`pnpm fixtures:verify`（canonical T1 + 三档 compat 快照 + ΔE pixel）、
  `pnpm themes:verify`（24 主题 tokens）、`pnpm matrix:record/verify`（6 代表主题）、
  `pnpm compat:matrix`（python-pptx 重开 + compat lint 三档；CI 加 LibreOffice 转换）。

### 兼容性声明

- **T1 与 T2**：v0.1.0 可宣称 T1（canonical 语义等价 + WPS 2019+ 实机清单由用户确认，
  见 `docs/compat/wps-report.md` 与 ADR-051）；T3（整链字节相同）从不是 v1 门槛
  （上游导出器会打时间戳，ADR-014/017）。
- 已验证：本机 PowerPoint 365 COM 打开黄金/e2e/模型产物无修复、单母版；python-pptx
  重开 10/10；`--compat safe|standard|max` 三档均无 error。

### 已知限制

- **图片搜索**：openverse/wikimedia 在本网络不可达；`pexels`/`pixabay` 可用但需要用户
  自己的 key（`PEXELS_API_KEY`/`PIXABAY_API_KEY`，无 key 时跳过）。不支持 AI 生成图。
- **LibreOffice 转换**只在 CI 执行（本机无 `soffice`），`compat:matrix` 会显式标 skipped。
- **`serve`、`deep check|chart`** 等命令未在本版实现（见 `docs/cli.md` 的 Planned）。
- 原生对象（图表/表格/公式）与 `--native-charts-and-tables` 一起导出时会以 PowerPoint
  对象替换 SVG 回退的样式细节，需要精确回退画面时用默认 shape-based 导出。