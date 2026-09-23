# 设计语言参考（Phase 3/4）

数据口径：`design profile`（见 `docs/contracts.md` 第 19–21 节）与参考 deck 的实测值；裁决见 `docs/decisions.md` ADR-061/066/067。下表是默认常量，档案里声明了的字段（`typeScale`/`roles`/`palette`/`chrome`/`background`）以档案为准。

## 1. 字号阶梯

| 元素 | 字号 | 颜色角色 | 字体角色 |
|---|---|---|---|
| 封面标题 | 44 pt bold | title | heading |
| 封面元信息 | 16 pt | body | body |
| 目录编号 02./03. | 40 pt | title | number |
| 目录条目 | 20 pt | muted | body |
| 章节水印号 | 85 pt | watermark | number |
| 章节标题 | 34 pt | title | heading |
| 内容页标题 | 36 pt | title | heading |
| 卡片小标题 | 20 pt | accent | heading |
| 卡片正文 | 14 pt | body | body |
| 强调数字 | 32 pt | onAccent | number |
| 结束页主标题 | 54 pt | title | heading |
| 结束页副题 | 32 pt | accent | heading |
| 页脚元信息 | 16 pt | body | body |

- 一页最多 4 个字号档；正文 ≥14 pt；层级优先靠字重/颜色，不靠继续缩小字号。
- 字体只来自档案 `fonts`：`render` 的 font pass 把 ≥28 pt 的 run 写 heading、数字 ≥32 pt 写 number、其余写 body；不要在页里混入第二个字体家族。
- 内容页标题 36 pt 与卡片小标题 20 pt 的对比是参考 deck 的主要层级信号，不要压平。

## 2. 色板角色

| 角色 | 参考值 | 用途 |
|---|---|---|
| `bg` | #FFFFFF | 页面底色、flat 背景 |
| `title` | #0D0D0D | 主标题 |
| `accent` | #577FD2 | 章节号、卡片小标题、强调块 |
| `body` | #262626 | 正文 |
| `muted` | #595959 | 次要信息、目录条目 |
| `watermark` | #F2F7FA | 水印、大面积浅色底 |
| `onAccent` | #FFFFFF | 压在 accent 块上的文字 |

- 一页文字色 ≤3 种（title/body/accent）；muted 只用于说明性文字。
- 文字直接压在照片或生成背景上时，必须先过覆盖层并保证正文对比 ≥4.5:1；这是 render 的硬门，`audit --profile` 会复核。
- 图表、表格用 `tokens.json` 的 `chartPalette`，标准页也不要手写十六进制色。

## 3. role 几何

| role | 标题锚点 (in) | 列数 | 卡间距 (in) | 备注 |
|---|---|---|---|---|
| cover | (0.69, 3.08) | 1 | — | 标题在左半区，右侧留白或图 |
| toc | (5.19, 1.79) | 3 | 1.04 | 编号块 + 灰色条目 |
| section | (0.64, 3.43) | 1 | — | 85 pt 水印号 + 标题 |
| content | (0.59, 0.58) | 2–3 | 0.43 | 2–3 列卡片 |
| ending | (0.69, 3.79) | 1 | — | 致谢/结束语，留白 |

- 内容页 2–3 列卡片：一列一个要点，卡片含小标题 + 正文；列宽 =（可用宽 − 卡间距 × (列数 − 1)）/ 列数；`columnsMax` 声明上限。
- `storyboard` 的每一页必须声明 `role`；`toc` 是 storyboard 专有 role（IR 上仍是 content），`data`/`quote` 是 content 的 IR 细分，几何沿用 content。
- 几何容差 ±0.05 in；改版式要说明理由，并同步 storyboard 与 IR，不要只改渲染结果。

## 4. 背景与素材

优先级从高到低：`svg` → `user` → `office`（本机有资源时）→ `flat` → `photo`（图库）→ 可选 `image-gen`（默认关闭）。任何一级不可用都显式降级，不得阻塞 render，也不得伪造来源。

| 模式 | 来源与命令 | 覆盖层 | 许可要求 |
|---|---|---|---|
| `svg` | 程序化生成（render 自动） | overlayOpacity | 无第三方素材 |
| `user` | `assets list|copy --source user`，目录带 `asset-manifest.json` | ≥10% | 每项 licence 必填；缺失 = ContractViolation |
| `office` | `assets discover|list|copy --source office`，读本机 discover 记录 | ≥10% | 机器内建资源；不打包、不提交仓库 |
| `flat` | 档案 `palette.bg`，render 写 `p:bg` | 不需要 | 无 |
| `photo` | `images search`（openverse/wikimedia 免 key；pexels/pixabay 需 key） | 10–20% | 许可/署名写入 `assets/image_sources.json`；缺失 = 失败 |
| `image-gen` | 可选扩展，`DSH_PPT_ENABLE_IMAGE_GEN=1`（B5.5） | 10–20% | 生成式内容需人工复核并写来源；默认路径不得依赖 |

- 背景模式由 storyboard/profile 声明；render 统一加覆盖层并把正文对比 ≥4.5:1 作为硬门。
- `svg` 背景必须带 PNG 回退（compat stamp 自动补 `.png` sibling），否则旧版 Office 打不开。
- `office` 发现不到时显式失败并给回退指引；`user` 记录逐项有 licence，copy 落 deck 的 `assets/`。
- 素材只进 deck，不进 git、不进发布包（deck discipline）。

## 5. chrome

- chrome 只在 `deck.fusion.json` 的 `chrome` 块声明一次：`pageNumber` / `footer` / `section`；正文页不要手画页码、页脚、章节标记。
- 参考口径：无逐页页码（`pageNumber.show: false`）；章节页有水印号（`sectionMarker: true`）；封面/结束页有 16 pt 元信息 footer（`metaFooter: true`）。
- section 标记与 footer 由 chrome 层生成 `chrome-` 前缀形状并有固定几何；不要自己造，也不要逐页覆盖。
- storyboard 与 manifest 冲突时以 manifest 为准；改 chrome 后重跑 `validate` 与 `audit`。

## 6. Phase 3/4 检查单

1. 每页 `role` 已声明（含 `toc`），`layout` 是绑定主题菜单里该 role 可用的脸。
2. 字号落在阶梯上；颜色取自色板角色；一页文字色 ≤3 种。
3. 内容页 2–3 列卡片；标题锚点、列宽、卡间距按上表或档案，容差 ±0.05 in。
4. 背景模式已声明；图片/生成背景带覆盖层且对比 ≥4.5:1；SVG 背景有 PNG 回退。
5. 素材许可/署名齐全（user 的 licence、photo 的 image_sources.json）；AI 生成图默认关闭、不得依赖。
6. chrome 只在 manifest 声明一次；页脚/页码/章节标记都不手画。
