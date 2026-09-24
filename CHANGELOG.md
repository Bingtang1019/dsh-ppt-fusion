# CHANGELOG

## v0.3.3 — 2026-09-24

### 变更

- **内容页卡片归一（S27 P4/P6/P11，ADR-075）**：`content` 页的卡片面板按参考版式重排为等宽列
  （`min(卡片数, columnsMax)` 列、间距取档案 `cardGapIn`），每张卡内最大的文字成为 20pt 强调色卡标题、
  其余文字用角色正文字号/颜色；图标移到卡片顶部。原先"左大卡 + 右侧两张小卡、14pt/12pt 无强调色"的
  预设版式不再出现；`design.pass` 新增 `cards` 计数。

## v0.3.2 — 2026-09-24

### 修复

- **目录页标题被卡片盖住（S27 P2，ADR-073）**：`toc` 页的标题此前被移动到档案 `roles.toc.titlePos`——该几何
  取自参考页 `01.` 编号框 (5.19, 1.79in)，使 40pt 标题正好落在卡片行上并被面板盖住（PowerPoint 渲染里标题
  墨迹为 0）。现在 `toc` 页保留作者锚点，字号/颜色/正文仍用 `typeScale.toc`；重渲后标题回到卡片上方
  （标题带墨迹 3755px）。`design-pass.test.ts` 增加该用例。

## v0.3.1 — 2026-09-24

### 修复

- **svg 背景在 PowerPoint/WPS 里不可见（ADR-071）**：背景层原先把生成的背景图插在“所有作者内容之前”，而
  pptwise 每个标准页的首个形状是一块不透明全幅底板（主题背景色），背景图正好被它盖住；PowerPoint COM 栅格化
  证明 `svg` 导出与 `flat` 导出字节相同（全白），shape 级导出才看得到图。现插入点改为“首块全幅不透明底板之后、
  其余内容之前”，没有该底板时保留原行为；chrome 的页码形状仍在形状树末尾，位于背景之上。`background.test.ts`
  增加该用例（469 tests / 58 files 全绿）。

## v0.3.0 — 2026-09-24

设计系统对齐：参考 deck → 数值化 design profile → theme/chrome/storyboard 套用 → 符合性审计。

### 新增

- **`design profile extract`（B1，ADR-061）**：`dsh-ppt design profile extract <ref.pptx> -o design-profile.json
  [--roles <spec>] [--copy-media]` 由 engine venv 的 python-pptx 提取色板、字体、字号阶梯、role 几何、chrome 与
  背景策略为**纯数值**档案（无文本、无媒体、无输入路径），严格 schema 校验；`--copy-media` 默认关，开启时只写
  `<output dir>/.dsh-ppt/design-media`。
- **参考档案夹具 + S24 门禁**：`fixtures/reference/profile.json`（已人工对照计划附录 A 复核）；
  `pnpm design:verify` 用 `DSH_PPT_REFERENCE_DECK` 指向的本地参考 deck 重提取并逐字段比对，未设置该变量时
  skip（CI 友好）。
- **deck 纪律防护**：`.gitignore`（`fixtures/reference/*` 仅放行 `profile.json`）、`scripts/check-pack.mjs`
  （tarball 禁 deck/media/profile）与 `tests/repo-discipline.test.ts`（CI 断言 tracked 文件与 `files` 白名单），
  保证任何真实 deck 及其媒体不以任何形式进入 git 或 npm。
- **`theme apply-profile`（B2，ADR-066）**：`dsh-ppt theme apply-profile <profile> [--from <preset>] [-o <file>]`
  生成 deck 本地 `theme.json`（保持预设 id 与菜单，pptwise 会优先解析它），映射色板/字体/背景；WCAG 硬门
  （`body|muted|title` 对 `bg`/`surface` ≥4.5，`onAccent` 对 `accent`、`accent` 对 `bg` ≥3.0），不通过显式报错
  并给出实测比值；`emphasisInk` 不映射（否则白底白字会被 pptwise 拒绝），跨菜单 id 直接拒绝（ADR-052）。
- **`init --profile`（B2）**：物化预设后就地改写 `theme.json`、按新调色板重导 `tokens.json`/`master-design.json`，
  档案无页码时写 `chrome = { pageNumber: { show: false } }`，storyboard 按改写后的菜单生成；档案副本写入
  `design-profile.json` 并在 manifest 记 `designProfile`。
- **字体套用 pass（B2，ADR-066）**：pptwise 0.35.0 用硬编码 safe-font 白名单解析字体栈，主题里写 MiSans 也只会
  回退；因此 manifest 声明 `designProfile` 时，`render` 在 merge 后按档案重写每段 run 的 `a:latin`/`a:ea`/`a:cs`
  （≥28pt→heading、≥32pt 纯数字→number、其余→body，EA 槽同选），幂等且 `post animate` 会重放，
  结果记入 `out/manifest.json` 的 `design`。
- **storyboard `toc` role（B2）**：storyboard 可为 content 页声明 `role: "toc"`（目录页用 content 菜单槽位；
  chrome 角色保持不变）。
- **素材三通道 `assets discover|list|copy`（B2.5，ADR-067）**：`--source office` 探测本机 Office/WPS 资源目录并登记
  `<DSH_HOME>/ppt-fusion/assets/office-assets.json`（本机实测 1689 项；找不到即显式失败并给回退指引）；
  `--source user` 读 `DSH_PPT_ASSET_DIRS`/`<deck>/assets` 的 `asset-manifest.json`（许可必填，缺许可即
  `ContractViolation`）；copy 落 deck `assets/`，越界/同名异字节拒绝，同字节幂等。
- **`svg`/`flat` 背景层（B2.5，ADR-067）**：render 在 motion 后、chrome 前施加档案背景模式；flat 写 `p:bg`，
  svg 按 role 生成确定性程序化 SVG + 覆盖层（alpha=overlayOpacity），对比硬门 ≥4.5:1，compat stamp 自动补
  PNG sibling（实测 slide `a:blip→PNG`、`asvg:svgBlip→SVG`）。
- **设计语言参考与 Phase 3/4 规则（B3，ADR-068）**：新增
  `skills/dsh-ppt-fusion/references/design-language.md`（字号阶梯/色板角色/role 几何/背景素材优先级/chrome），
  单列 `generate.design` 装载集（2000 tokens）；两版 SKILL 在不抬预算的前提下补"每页必须声明 role"与
  "按档案字号/几何作者、内容页 2–3 列卡片"（2492/2245 tokens）。
- **`audit --profile` 符合性审计（B4，ADR-062）**：重放提取器测量后比对 `design-*` 规则（role 标题/正文字号
  ±1pt、颜色 ΔE≤3、accent 色、标题锚点/卡间距 ±0.05in、列数、章节水印、chrome 布尔）；背景规则判
  flat/svg/photo/mixed、SVG 必须有 PNG 回退、正文按 ≥70% 像素覆盖 4.5:1（有覆盖层 error、无覆盖层 warning）；
  支持 `--roles` 与工作区外 `--file` 的 package-only 审计。顺带修正 chrome/background 写 `srgbClr val="#…"`
  的非法 OOXML，golden 重录为 **fixtureVersion 8**。
- **档案设计施加 pass（B5，ADR-069）**：标准页在字体 pass 前套用档案语言（代表标题字号/颜色/锚点、正文众数、
  accent 重着色、toc/content 卡片列按卡间距重排、section 水印号、封面/结束 meta footer）；`chapter` IR 页归一
  到 section，render/audit 优先 storyboard 角色。
- **`reference-quality` 场景与质量基线（B5）**：12 页同学科 deck 场景走完整 SKILL + 双引擎，14/14 rubric 检查
  首轮通过（1698s），交付 `tmp/quality-demo`（pptx + audit JSON + preview HTML）；三样本 1–5 基线见
  `docs/quality.md`。
- **可选图像生成 `images generate`（B5.5，ADR-064）**：`DSH_PPT_ENABLE_IMAGE_GEN=1` 才可用，provider 为
  `gemini|openai-compatible`（映射 engine `gemini|openai`）；未开启/无 key 拒绝并打印
  `svg → user → office → flat → photo`；成功后写 `image_sources.json`（`provider: ai-image-*`、prompt 摘要、
  尺寸、"AI-generated content (review required)"），无记录不返回；默认 render 永不调用。

### 已知限制

- `photo`/`office`/`user` 背景模式还没有显式资产引用：render 目前以 flat 回退并在
  `out/manifest.json#design.background.notes` 记录，`audit --profile` 按档案模式会报 error（B4 规则本身正确）。
- deep 页 MiSans 的 ea font slot 与"非 PPT-safe 字体"由 `svg-quality` 记为 warning；WPS 渲染一致性待人工复核。
- 人工复核未尽项：S27 三样本并排评分、S28 背景观感、S19 删页重排、S23 旁白播放。

## v0.2.0 — 2026-09-23

规划与一致性层：先分镜（storyboard）→ 每页 role/版式/预算 → 生成前机械自检（ADR-059）。

### 新增

- **`deck.storyboard.json` 契约**：每页声明 `role`（`content` 页按 IR `kind` 细分为 `data`/`quote`）、
  `layout`、`route`、页码参与、`budget` 与 `source`；`init` 写骨架、`plan` 起草草稿（draft 携带
  manifest + storyboard）、`plan --confirm` 同时落两份文件。
- **role→layout 允许矩阵**：`layout` 用 `"<主题>:<版式脸>"` 指向绑定主题菜单；`validate` 拒绝跨主题
  引用（ADR-052 不允许跨菜单重绑）、菜单里不存在的脸、以及脸所在槽位与 role 不匹配（`data`→数据类、
  `quote`→引用类）。
- **内容预算**：各 role 首版默认 `maxWords/maxItems/maxCharts/maxTables/maxImages`，页面可逐字段覆盖；
  pptwise 页按 IR 文本/组件实测、deep 页按 SVG 文本与 `data-pptx-replace-with` marker 实测，超限报
  `budget-exceeded`（page/role/实测/上限）。
- **SKILL 升级**：Phase 3 改为"大纲 → 分镜 → BLOCKING 规划确认"（chrome 在 Phase 3 一次声明），Phase 4 按
  role 模板作者；checkpoint 增 `storyboard` 引用，`resume` 校验它；`skill audit` 预算不变（0 error，
  109,751/120,000 tokens）。
- **旁白自动翻页**（Q5，ADR-060）：post 从 deck 内嵌音频字节**重算**每页 `advTm`（MPEG 帧时长 + 引擎自身的
  0.4s lead-in / 0.5s padding），不再依赖主机 ffprobe；merge 之后恢复 `p:showPr useTimings="1"`；音频无法
  解析时保留引擎写入的 `advTm`。narrated 黄金重录为 **fixtureVersion 7**，`fixtures:verify` 增加 S23 断言。
- **Q4 模型评估回归**：`pnpm eval:run` 三场景**首轮 3/3 通过**（topic-only 548s / branded-template 734s /
  doc-to-deck 795s），storyboard、role-layout、budget、chrome 四项新 error 检查全绿，checkpoint 均到 phase 7；
  结果见 `docs/v02-model-eval.md`，验收表更新到 S1–S23。

### 变更

- `validate` 新增 `storyboard` 源（存在/覆盖/与 manifest 的 role·route·页码一致、版式合法、预算守门）；
  `render` 默认要求 storyboard，`--no-storyboard` 仅调试用。
- `init` 先物化主题再写 storyboard，因此骨架页直接使用主题菜单的合法版式，"init 即通过 validate" 不回退。
- role 判定统一到 `chromeRoleFor(type, kind)`，chrome 跳过规则、storyboard 要求与 audit 共用同一映射。
- `deep check|chart` 与 `serve` 从 Planned 表**删除**（本版不实现；ADR-065），CLI 只教已实现的命令面。

## v0.1.2 — 2026-09-23

V6 WP1：deck 级 chrome 契约。页码不再"哪个版式自带就有"，而是由 `deck.fusion.json` 声明、由 render
后处理统一施加，并由 audit 硬门检查（ADR-058）。

### 新增

- **`chrome` 契约**（`deck.fusion.json`）：`pageNumber`（开关、`skipRoles`、四个预设位置、主题 tokens
  样式）、可选 `footer` 文本、可选 `logo`、可选 `section`；`pages[]` 可声明 `section`。`dsh-ppt init` /
  `plan` 从本版起默认写入带页码的契约（封面/结束页跳过）。
- **原生页码域**：非跳过页注入 `<a:fld type="slidenum">`（`‹#›`），删页/重排后自动更新；字段 id
  确定性生成（SHA-1 → UUID v5 形状），形状名固定，因此重复施加幂等且字节稳定（T2）。
- **内置页码剥离**：按签名（底部区域 + 横条/右下徽标 + 单个 1–3 位数字 + 右对齐 + 半透明填充）移除
  引擎自带的页码形状，正文数字不受影响。
- **audit 新规则**：`chrome-coverage`、`chrome-skip`、`chrome-geometry`、`chrome-footer-text`、
  `chrome-section`、`chrome-logo-part`、`chrome-baked-strip`（error）与 `chrome-overlap`（warning，
  背景形状不计）。
- **夹具**：`fixtures/hello` 声明 chrome（页脚 + p3 section），黄金重录为 **fixtureVersion 6**；
  `theme-matrix.json` 与 `docs/compat/matrix.md` 同步重录；WPS 清单新增"删页后页码自动重排"一项。

### 变更

- 文案澄清（O1）：README/guide 明确 **HTML 是评审查看器，交付物是原生 PPTX**。

## v0.1.1 — 2026-09-23

修复 `dsh_ppt_preview` 预览卡片的渲染路径（v0.1.0 里卡片无法生成：插件把预览输出目录指到
deck 之外，而融合 CLI 的 `-o` 必须是 deck 相对路径，ADR-026）。

### 修复

- **预览卡片**：改在 deck 内 `.dsh-ppt/preview` 渲染（CLI 的契约），再把
  `manifest.json`/`preview.html`/清单列出的页面 SVG 复制进预览缓存目录；下载按钮、缩略图条与
  iframe 查看器都读同一份产物。
- **目标校验**：预览工具现在明确要求 deck 目录（或 decks root 下的 deck 名）；传入单个
  pptwise IR 文件会给出可操作的错误（融合 CLI 的 `preview` 只接受 deck），工具描述同步更新。

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
- **旁白自动前进**：成品保留旁白音频（`p:pic` + `ppt/media/narration*.mp3`），但音频时长驱动
  的自动前进时间（`advTm`）会被 `bridge/post.ts` 这个单一动画施加点重写掉，所以 v0.1.0 只嵌入
  旁白、不自动翻页；v0.2 计划在 `post.ts` 内改用确定性来源补齐（ADR-055）。
- **`serve`、`deep check|chart`** 等命令未在本版实现（见 `docs/cli.md` 的 Planned）。
- 原生对象（图表/表格/公式）与 `--native-charts-and-tables` 一起导出时会以 PowerPoint
  对象替换 SVG 回退的样式细节，需要精确回退画面时用默认 shape-based 导出。