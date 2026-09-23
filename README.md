# dsh-ppt-fusion

DeepSeek Harness（DSH）插件：把 **pptwise** 的 DSH 原生前端（IR v5、24 套主题、审计、预览）与 **ppt-master** 的深度引擎（SVG→DrawingML、原生图表/表格/公式、动画/旁白）融合成一条 `dsh-ppt` 命令链。

- 上游：`@liustack/pptwise@0.35.0`（npm，MIT）· `ppt-master==0.1.128`（PyPI，MIT）
- 本包：`dsh-ppt-flashmade`，MIT，Node >= 22.19，bin `dsh-ppt`
- 下载：npm [`dsh-ppt-flashmade@0.1.1`](https://www.npmjs.com/package/dsh-ppt-flashmade) · GitHub Release [v0.1.1](https://github.com/Bingtang1019/dsh-ppt-fusion/releases/tag/v0.1.1)（附件 `dsh-ppt-flashmade-0.1.1.tgz` 与 npm 包字节一致，sha1 `2844d8d9…`）
- **交付物**：`out/<name>.pptx` —— 原生可编辑 PPTX（原生形状/图表/表格）。`preview --html` 与卡片里的
  HTML **只是评审查看器**，不代表交付物形态。

> 状态：**CI 双平台全绿（ADR-055）；v0.1.1 已按 §8 双渠道发布（npm + GitHub Release，ADR-056），并修掉了预览卡片的渲染路径（ADR-057，0.1.1）。

---

## 架构（S2：Node 驱动 Python，无 FFI、无共享内存）

```
DSH 会话（模型）
  │  遵循 skills/dsh-ppt-fusion/SKILL.md（M6 落地）
  ▼
dsh-ppt CLI                        Node >= 22.19
  │  src/cli.ts → src/commands/*
  ├── src/frontend.ts ─────────────► node node_modules/@liustack/pptwise/dist/cli.js
  │      IR v5 进，pptx 出                npm 依赖 0.35.0（JS API 已封，只走 CLI）
  │
  └── src/engine/master.ts ────────► <venv>/Scripts/ppt-master.exe
         SVG 进，pptx 出                  PyPI 依赖 0.1.128（uv venv，无 pip）
             ▲
             └── src/engine/venv.ts      建/查/修 venv；uv 解析不走 PATH
```

`render` 主链（已落地）：`pptwise render --draft`（deep 页=占位）→ `deep render`（ppt-master 四步门控流水线）→ **slide 级合并**（layout 重映射到 base 母版 + 闭包导入）→ OPC/delivery 门 → 原子发布 `out/<name>.pptx` + `out/manifest.json`。

```
deck/
├── deck.fusion.json    页级路由表 + post 配置（schema v1）
├── deck.ir.json        标准页 IR v5；deep 页 placeholder:true
├── theme.json/tokens.json/master-design.json   主题桥产物
├── deep/pNN-*/         每 deep 页一目录：page.svg（七条作者契约见 contracts.md）
├── out/                产物 + manifest（sha256、slide 数、导出回执、merge 报告）
└── .dsh-ppt/           缓存、临时 master 项目、诊断日志、render 中间产物
```

## 层与职责

| 模块 | 职责 | 不得 |
|---|---|---|
| `dsh/index.js`（M7） | DSH 插件注册、skill 注册、preview 工具/路由 | 含生成逻辑 |
| `src/cli.ts` + `src/commands/` | argv、退出码、接线 | 渲染 |
| `src/frontend.ts` | 定位并驱动 pptwise CLI、解析 JSON、其失败分类 | import pptwise 内部 |
| `src/bridge/theme.ts` | ThemeFile v2（`style.*`）→ tokens → master 调色板 | 改上游主题 |
| `src/bridge/merge.ts` | slide 级合并：内容感知复用、layout remap、单一母版、creationId 去重 | 解析 shape 语义 |
| `src/bridge/post.ts`（M4 第 2 部分 ✅） | 合并后统一施加动画/切换/旁白 | 在合并前运行 |
| `src/bridge/compat.ts`（M4 第 2 部分 ✅） | 兼容 pass：scan/transform/stamp/lint，对照 `src/compat/registry.json` | 注册表之外的隐式改写 |
| `src/commands/audit.ts`（M4 第 2 部分 ✅） | 八源统一审计门：validate / pptwise / 引擎门 / OPC+P1 / compat / ΔE | 吞失败门、缺产物静默跳过 |
| `src/engine/contracts.ts` | 引擎命令白名单 + 参数枚举 + 输出文件契约 | 放行未登记命令 |
| `src/engine/venv.ts` | venv 生命周期、uv 解析、锁文件安装/修复 | 启动路径联网 |
| `src/engine/master.ts` | 唯一 Python spawn 点；超时、错误分类、路径白名单 | 接受白名单外命令 |
| `src/engine/runner.ts` | 子进程原语 + 默认拒绝的 env 白名单 | 默认继承凭据 |
| `src/logging.ts` | `<deck>/.dsh-ppt/logs/<ts>-<cmd>.log` | 删改 deck 数据 |
| `src/audit.ts` | 多来源审计聚合（随 M4/M5 扩展） | 吞失败门 |

## 不变式

- **P1 单一母版**：merged deck 恰好 1 个 `slideMaster`，所有 layout 指向它；`scripts/opc-invariants.mjs --single-master` 硬门（M0/M4 均已验证）。
- **deep 页绝对定位**：deep 页走 `--pptx-structure flat`，layout remap 不动内容。
- **确定性三级**：T1 语义确定性 = 硬门（`tests/support/canonicalize.ts` 递归进 `ppt/embeddings/*`，`pnpm fixtures:verify` 在 CI 执行）；T2 本包字节稳定 = 目标（merge 步骤已达成，且每个 zip entry 含目录项都钉死在固定时间戳，ADR-041）；T3 全链字节一致 = 非 v1 门（master 输出时间戳不稳定）。
- **兼容性被声明、不靠假设**：`src/compat/registry.json` 登记每个版本敏感标记的最低 Office/WPS 支持与降级规则；`render --compat safe|standard|max` 覆盖 manifest 的 `compat` 字段，默认 `standard`（Office 2016+/WPS 2019+）；报告写 `out/compat-report.json`，哈希进 `out/manifest.json`（ADR-034）。
- **失败分类**：每个错误是 `src/engine/errors.ts` 的封闭枚举，CLI 打印 `dsh-ppt: <code> <message>`。
- **交付门**：`dsh-ppt audit` 聚合八源（validate、pptwise、引擎门、OPC+P1、delivery、compat、可选 ΔE）；缺产物是 error 并把跳过的源记入 `skipped`（ADR-035）。
- **素材署名**：`images search` 的每个下载项都进 `assets/image_sources.json`，缺许可或缺署名文本即失败；`--strict-no-attribution` 直接拒绝需署名的许可（ADR-040）。
- **动效单一 owner**：`post/animations.json` 的 entrance/emphasis/path 由 `bridge/post.ts` 写；emphasis/路径必须按 PowerPoint 自己的包装结构书写，否则 COM 读回 behaviours=0（ADR-042）。
- **非目标不可达**：`image-gen`、`video-*`、`gemini-watermark-remove` 不在 contracts 白名单（ADR-013）。

## 已实现的命令

`version · doctor [--repair --no-self-test] · init · plan [--from --confirm] · resume [--write] · validate · audit [--strict --pixels --file] · preview [--html] · theme ensure|list|new|fork|try · tokens export [--master] · brand extract [--bind] · source <input...> · images search · deep render [--page] · deep template create|apply|register · deep native roundtrip · post animate · narrate [--sync --list-voices] · render [-o] [--compat <level>] · compat lint <file> · skill audit`（全部命令支持 `--json`）

- `doctor` 八项：Node / uv / Python / engine venv / ppt-master / **png-renderer**（本机红=设计使然，B7 用 Node `sharp` 兜底）/ pptwise / PowerPoint COM / self-test。
- `render` 的动画/切换由 `bridge/post.ts` 在合并后单一施加（ADR-032）；选择器匹配不到时是硬失败 `ContractViolation`，不静默忽略。
- 完整命令面与 Planned 表见 [`docs/cli.md`](docs/cli.md)。

## 开发

```sh
pnpm install                    # pnpm 8.15.9 + npmmirror（本机纪律）
pnpm typecheck && pnpm lint && pnpm test
pnpm build                      # tsup → dist/cli.js
node dist/cli.js doctor         # 八项体检 + self-test
pnpm themes:verify              # 24 主题快照（脚本门，CI 独立步骤）
pnpm opc:check                  # P1/OPC 不变式
pnpm fixtures:verify            # T1 黄金门 + 三档 compat 快照 + ΔE pixel（需要 ffprobe 在 PATH）
pnpm matrix:verify              # 6 代表主题的 validate/render/audit 快照（ADR-052）
pnpm compat:matrix              # python-pptx 重开 + compat 三档（有 soffice 时含 LibreOffice 转换）
pnpm capacity:run               # 60 页标准 deck 的容量探针（ADR-052）
pnpm eval:run                   # M6 三场景模型评估（需要 DSH_HARNESS_ROOT 或 PATH 里的 dsh）
pnpm prepack                    # build + files/tarball 清单校验
```

- 引擎 venv：`%DSH_HOME%/ppt-fusion/venvs/ppt-master-0.1.128`，由 `doctor --repair` 从 `python-assets/requirements.lock`（uv pip compile --generate-hashes，含 cairosvg）重建。
- 机器纪律（本仓库开发机）：`dsh plugin add` 带 `-w`；PS 5.1 下生成文件用 Node 写（无 BOM）；`[Content_Types].xml` 路径必须 `-LiteralPath`；子进程管道可用但大产物走文件契约。

## 目录

```
src/           CLI、frontend、engine、bridge、schema、compat registry
dsh/           DSH 插件入口 + dsh_ppt_preview 工具 + 预览卡片（ADR-049/050）
skills/        dsh-ppt-fusion 的中英 SKILL 与预算 manifest
scripts/       opc-invariants、win-com-smoke、probe/测量工具、compat-matrix、engine-provision
fixtures/      hello deck（golden 输入：含 deep/*/notes.md 与 narration/*.mp3）、master deep 项目、golden（base/deep/merged + golden-manifest.json + compat-levels.json）、M0 夹具 m0-fixtures.json
python-assets/ requirements.in/.lock、上游 SHA manifest、vendor 文档位
docs/          architecture / cli / contracts / decisions(ADR) / guide.zh / install / licensing / acceptance-report / capacity / m6-model-eval / upstream-drill / m0-* / compat/
tests/         vitest 单元与契约回放；themes:record/verify、fixtures:record/verify（T1 黄金门）
```

## 文档索引

- 架构与边界：[`docs/architecture.md`](docs/architecture.md)
- 全部命令与退出码：[`docs/cli.md`](docs/cli.md)
- 引擎/主题/IR/工作区契约：[`docs/contracts.md`](docs/contracts.md)
- 中文用户指南：[`docs/guide.zh.md`](docs/guide.zh.md)
- 安装与卸载：[`docs/install.md`](docs/install.md)；许可清单：[`docs/licensing.md`](docs/licensing.md)
- 发布清单：[`docs/release.md`](docs/release.md)
- M6 模型评估结论：[`docs/m6-model-eval.md`](docs/m6-model-eval.md)；验收报告 S1–S17：[`docs/acceptance-report.md`](docs/acceptance-report.md)
- 兼容矩阵与 WPS 记录：[`docs/compat/matrix.md`](docs/compat/matrix.md)、[`docs/compat/wps-report.md`](docs/compat/wps-report.md)
- ADR 裁决记录：[`docs/decisions.md`](docs/decisions.md)（ADR-001…053）
- M0 决策门与兼容探针：[`docs/m0-decision.md`](docs/m0-decision.md)、[`docs/compat/probe.md`](docs/compat/probe.md)
- 权威计划：仓库外的 `PPT-FUSION-PLAN.md`（v5，本机保留）

## License

MIT。上游版权与依赖许可清单在 `NOTICE` 与 [`docs/licensing.md`](docs/licensing.md)。引擎 venv 含 `PyMuPDF`（AGPL-3.0）：它只在用户机器上由 `doctor` 安装，不随本包分发；分发 venv 的一方需自行满足 AGPL。
