# dsh-ppt-fusion 用户指南

面向"要做一份能改的 PPT"的使用者。流程权威在 `skills/dsh-ppt-fusion/SKILL.md`（模型读的），
机器契约在 `docs/contracts.md`；本页是怎样安装、跑通、排错。

## 1. 安装

前置：Node ≥ 22.19、DSH 0.1.2-rc.1 或更新、能联网装 Python 依赖。

```sh
# 在 dsh-ppt-fusion 仓库里先构建
pnpm install && pnpm build

# 装进一个 DSH profile（-w 必填：profile 根是 pnpm workspace）
dsh plugin --profile <profile> add -w ./

# 首次运行：建引擎 venv（uv + Python 3.13 + 锁定依赖，约 1–5 分钟）
node <仓库>/dist/cli.js doctor --repair
```

验证：

```sh
dsh --profile <profile> --dump-config | grep -A1 'dsh-ppt-fusion'
```

应看到 `# == dsh-ppt-flashmade` 层；重启后浏览器无红条、技能列表里有
`dsh-ppt-fusion`、调用一次 `dsh_ppt_preview` 会出预览卡片。

卸载：

```sh
dsh plugin --profile <profile> remove -w dsh-ppt-flashmade
```

依赖、bundle 条目、skill/tool/路由随之消失，不会在用户机器上留残留。

## 2. 五分钟跑通 hello

```sh
dsh-ppt init hello --theme brief     # 建工作区 + 骨架 IR/清单 + 主题
dsh-ppt plan hello                   # 生成待确认草稿
# 模型补页面与 theme 后：
dsh-ppt plan hello --confirm
dsh-ppt render hello                 # 标准页 + deep 页 + 合并 + 兼容 + 发布
dsh-ppt audit hello                  # 统一审计门
```

产物：

- `hello/out/<名字>.pptx`：最终交付包（单母版、原生图表/表格）；
- `hello/out/manifest.json`：文件名/大小/sha256/页数/合并与后处理回执；
- `hello/out/compat-report.json`：兼容档结论；
- `hello/.dsh-ppt/logs/`：每次引擎/前端调用的日志（排错先看这里）。

## 3. deep 页（原生对象）

按页级路由决策表选：封面/要点/卡片/时间线/引用 → `pptwise`；图表、表格、公式、多图拼贴、
复杂矢量 → `ppt-master`（deep）。

deep 页必须满足七条作者契约（ADR-007）：`spec_lock.md` 数字锚点、根
`data-pptx-page-role`、元素 `data-pptx-role`、根 `<g data-pptx-bounds>` 分区不重叠且文本
溢出 ≤5%、页内字号分档、`stamp-native-fallbacks` 哈希、可见回退完整投影到原生对象
marker。颜色只能来自 `tokens.json`。

渲染 deep 页固定四步（`dsh-ppt deep render <dir>` 内部完成）：stamp → svg-quality-check
`--stage final --canonical-authoring` → `svg-to-pptx --quick-generate
--native-charts-and-tables --with-notes` → 读项目内 `validation/<stem>.report.json`。**不要
看 stdout 判断成败**（ADR-009）。

预览：

```sh
dsh-ppt preview hello --html        # 标准页走 pptwise，deep 页用作者 SVG 覆盖占位
# 或对模型说：用 dsh_ppt_preview 预览 hello
```

## 4. 旁白与动画

旁白文本写在每页 `deep/<page>/notes.md`；`narrate` 会按导出 stem 组成 notes roster：

```sh
dsh-ppt narrate hello -o narration      # 默认 edge-tts，无需 key
dsh-ppt render hello                    # 自动嵌入 <deck>/narration/*.mp3 并设 auto-advance
```

动效配置在 `hello/post/animations.json`：支持 `transition` 与 `entrance`/`emphasis`/`path`
（顺序 entrance → emphasis → path）；选择器匹配不到是硬失败，不是 no-op。只改动效：

```sh
dsh-ppt post animate hello              # 重新施加动效 + 重跑兼容 + 刷新 manifest
```

## 5. 故障排查

错误一律是 `dsh-ppt: <code> <message>`：先看 code，再看 `<deck>/.dsh-ppt/logs/` 最后一份
日志。

| 现象 | 处理 |
|---|---|
| `theme ... is stale` / `tokens.json` 过期 | `dsh-ppt theme ensure <dir>` |
| `doctor` 里 png-renderer 红 | **设计使然**（本机无 cairo，B7 用 sharp 兜底）；其余项绿就不要 `--repair` |
| 引擎/前端整体缺失（`VenvMissing` 等） | `dsh-ppt doctor --repair`；不要手工改 venv |
| 旁白嵌入报缺 ffprobe/ffmpeg | 安装 ffmpeg（或按 `docs/` 记录的 shim 方式提供 ffprobe） |
| `images search` 说 provider 被跳过 | openverse/wikimedia 在受限网络不可达；设 `PEXELS_API_KEY` 或 `PIXABAY_API_KEY` 走 keyed provider |
| `audit --strict` 红但 `audit` 绿 | 都是 warning 级（当前主要是 `ea-font-slot` CJK 字槽建议）；按需决定是否收窄 |
| `resume` 报缺产物 | checkpoint 声称的文件不在了：先补齐工作或修正 checkpoint |
| PowerPoint 弹修复 | 用 `dsh-ppt audit <dir>` 看 OPC/P1 结论，并把包与日志一起留档 |

## 6. 命令速查

```
version · doctor [--repair] · init · plan [--confirm] · resume [--write]
validate · audit [--strict] [--pixels] [--file] · preview [--html]
theme ensure|list|new|fork|try · tokens export · brand extract [--bind]
source · images search · deep render · deep template create|apply|register
deep native roundtrip · post animate · narrate [--sync] · render [--compat]
compat lint · skill audit
```

全部命令支持 `--json`；`audit` 的报告带 `schemaVersion: 1`。