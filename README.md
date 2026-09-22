# dsh-ppt-fusion

DeepSeek Harness（DSH）插件：把 **pptwise** 的 DSH 原生前端（IR v5、24 套主题、审计、预览）与 **ppt-master** 的深度引擎（SVG→DrawingML、原生图表/表格/公式、动画/旁白）融合成一条 `dsh-ppt` 命令链。

- 上游：`@liustack/pptwise@0.35.0`（npm，MIT）· `ppt-master==0.1.128`（PyPI，MIT）
- 本包：`@dsh-ppt/dsh-ppt-fusion`，MIT，Node >= 22.19，bin `dsh-ppt`
- 权威计划：仓库外的 `C:\Users\dell\Desktop\PPT-FUSION-PLAN.md`（v4）；本仓库 `docs/decisions.md` 是裁决记录（ADR），冲突时 **ADR 比计划新**。

> 状态：**M0–M3 已验收，M4 第 1 部分（OPC 层 + 合并桥 + render 链）已落地。** M4 第 2 部分接近完成（动画施加点 ✅ ADR-032、T1 canonicalize + 黄金 v1 ✅ ADR-033、compat pass ✅ ADR-034、统一审计门 ✅ ADR-035；剩余合并纪律测试、三档兼容黄金、黄金重录）、M5–M9 待做；DSH 插件壳（`dsh/index.js`/`cordis.patch.yml`/`dsh` 字段）按计划在 **M7** 落地，当前包以 CLI + 库形态开发。

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
- **确定性三级**：T1 语义确定性 = 硬门（`tests/support/canonicalize.ts` 递归进 `ppt/embeddings/*`，`pnpm fixtures:verify` 在 CI 执行）；T2 本包字节稳定 = 目标（merge 步骤已达成）；T3 全链字节一致 = 非 v1 门（master 输出时间戳不稳定）。
- **兼容性被声明、不靠假设**：`src/compat/registry.json` 登记每个版本敏感标记的最低 Office/WPS 支持与降级规则；`render --compat safe|standard|max` 覆盖 manifest 的 `compat` 字段，默认 `standard`（Office 2016+/WPS 2019+）；报告写 `out/compat-report.json`，哈希进 `out/manifest.json`（ADR-034）。
- **失败分类**：每个错误是 `src/engine/errors.ts` 的封闭枚举，CLI 打印 `dsh-ppt: <code> <message>`。
- **交付门**：`dsh-ppt audit` 聚合八源（validate、pptwise、引擎门、OPC+P1、delivery、compat、可选 ΔE）；缺产物是 error 并把跳过的源记入 `skipped`（ADR-035）。
- **非目标不可达**：`image-gen`、`video-*`、`gemini-watermark-remove` 不在 contracts 白名单（ADR-013）。

## 已实现的命令

`version · doctor [--json --repair --no-self-test] · init · plan [--from --confirm] · validate [--json] · theme ensure|list|new|fork|try · tokens export [--master] · deep render [--page] · render [-o] [--compat <level>] · compat lint <file> · audit [--strict --pixels]`

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
```

- 引擎 venv：`%DSH_HOME%/ppt-fusion/venvs/ppt-master-0.1.128`，由 `doctor --repair` 从 `python-assets/requirements.lock`（uv pip compile --generate-hashes，含 cairosvg）重建。
- 机器纪律（本仓库开发机）：`dsh plugin add` 带 `-w`；PS 5.1 下生成文件用 Node 写（无 BOM）；`[Content_Types].xml` 路径必须 `-LiteralPath`；子进程管道可用但大产物走文件契约。

## 目录

```
src/           CLI、frontend、engine、bridge、schema、compat registry
scripts/       opc-invariants、win-com-smoke、probe/测量工具
fixtures/      hello deck（golden 输入）、master deep 项目、golden（base/deep/merged + golden-manifest.json）、M0 夹具 m0-fixtures.json
python-assets/ requirements.in/.lock、上游 SHA manifest、vendor 文档位
docs/          architecture / cli / contracts / decisions(ADR) / m0-* / compat/
tests/         vitest 单元与契约回放；themes:record/verify、fixtures:record/verify（T1 黄金门）
```

## 文档索引

- 架构与边界：[`docs/architecture.md`](docs/architecture.md)
- 全部命令与退出码：[`docs/cli.md`](docs/cli.md)
- 引擎/主题/IR/工作区契约：[`docs/contracts.md`](docs/contracts.md)
- ADR 裁决记录：[`docs/decisions.md`](docs/decisions.md)（ADR-001…030）
- M0 决策门与兼容探针：[`docs/m0-decision.md`](docs/m0-decision.md)、[`docs/compat/probe.md`](docs/compat/probe.md)
- 权威计划（仓库外）：`C:\Users\dell\Desktop\PPT-FUSION-PLAN.md`（v4）

## License

MIT。上游版权与依赖许可清单在 `NOTICE`（M9 补齐）。引擎 venv 含 `PyMuPDF`（AGPL-3.0）：它只在用户机器上由 `doctor` 安装，不随本包分发；发布前按 `docs/licensing.md`（M9 落地）核对 full/minimal。
