# Acceptance report (S1–S27)

Plan chapter 6 maps the leader-facing questions to scenarios; V6 added S18–S23 and V7.2 adds
S24–S27 for the v0.3 design-alignment work. This page records the automated evidence behind
each one on the development machine, and names the checks that need a machine this host does
not have (a WPS 2019+ box, a Linux runner with LibreOffice, or the local reference deck).
"Verified" means the listed command or test was executed and passed; the evidence file or ADR is
named in the row. S26/S27 land with B4/B5 (compliance audit and the reference-quality
scenario).

| # | scenario | evidence | status |
|---|---|---|---|
| S1 | install as a plugin, no environment tinkering | scratch profile `~/.dsh/profiles/ppt-eval`: `dsh plugin --profile ppt-eval add -w link:<checkout>` (dependency + bundle entry), `--dump-config` shows the `# == dsh-ppt-flashmade` layer, boot on port 3098 logs no plugin error, `GET /dsh-ppt/preview/*` answers with `x-dsh-ppt-preview: 1`, `remove -w` leaves no residue (ADR-050); `dsh-ppt doctor` eight rows green (M1, ADR-020/024) | verified; **browser card user-confirmed 2026-09-22** (M9 prep); real `web`-profile re-check rides the M9 install |
| S2 | technology stack is the project's choice | `docs/architecture.md` (dual runtime, boundaries, invariants) + ADRs 001–051 | verified (documentation) |
| S3 | a deck that can be edited, not a picture | `pnpm eval:run` (v0.2 regression): topic-only PASS attempt 1, 548 s / 131 tool calls, 5 slides, single master, audit ok, native table page; earlier M6 run 811 s in `docs/m6-model-eval.md`; v0.2 results in `docs/v02-model-eval.md` | verified |
| S4 | 24 themes are swappable | `pnpm themes:verify` (24 token snapshots), `theme list --json` returns 24 ids, `pnpm matrix:verify` covers six menu families end-to-end | verified |
| S5 | reuse the company deck's colours | real `brand extract --bind` run + a reference extraction compared against the bound palette (M7 spot check); M6 first caught the model rewriting the palette; the SKILL rule was added and the confirmation run bound the reference palette field for field (ADR-047) | verified |
| S6 | charts must be editable | M6 doc-to-deck: 4 native chart parts; PowerPoint COM reads series values `31,42`, `6.1,8.6`, `65,68`, `46,27,18,9`; golden `ppt/charts/chart101.xml` root `c:chartSpace` | verified |
| S7 | animation and transitions | ADR-042 COM probe: emphasis type 61 and path type 149 with `behaviours >= 1`; golden v5 carries `p:transition` and `p:timing` | verified |
| S8 | narration | M5: real edge-tts MP3s 93600 B / 82224 B plus SRTs; golden v7 embeds media with auto-advance timings recomputed from the bytes (`fixtures:verify` prints the S23 line); without the Q5 fix the merged package lost the exporter's `advTm` and its `useTimings` flag (ADR-055 → ADR-060) | verified |
| S9 | the CLI has what it should | M8 item 3: every leaf command accepts `--json`, enforced by `src/cli.test.ts`; `dsh-ppt audit` carries `schemaVersion: 1` | verified |
| S10 | no keys, no model, no network | credentials cleared and `HTTP_PROXY=http://127.0.0.1:9` set: `dsh-ppt render tmp/s10` exits 0 with 5 slides / 196839 B; COM opens it; `docs/architecture.md` network boundary | verified |
| S11 | no generated images | real Pexels search recorded `assets/image_sources.json` with licence/author/attribution (ADR-048); the command surface has no `image-gen` (CLI coverage test) | verified |
| S12 | Chinese typography | the M6 CJK decks render and open in COM; the only audit advisories are warning-level `ea-font-slot` findings (no registered downgrade) | verified; human glyph review is an M8/M9 nicety |
| S13 | opens without a repair prompt | `scripts/win-com-smoke.ps1` on the golden (5 slides), the S10 render (5) and the M6 eval decks (6 / 4 / 5): all `ok`, `unchanged` | verified |
| S14 | one design master | P1 single-master invariant in `audit`/`opc` and in every matrix snapshot; python-pptx reports one master across all 10 matrix artifacts (`docs/compat/matrix.md`) | verified |
| S15 | other Office versions | `pnpm compat:matrix`: 10/10 artifacts pass `compat lint` at `safe`/`standard`/`max`; golden compat-level snapshots equal in `fixtures:verify` | verified |
| S16 | WPS and older Office | python-pptx reopen 10/10 (`docs/compat/matrix.md`); LibreOffice headless conversion runs in `pnpm compat:matrix` — the ubuntu CI leg installs `libreoffice-impress` and compares the rendered PDF page count (run 35761959099, green) | python-pptx verified; LibreOffice verified in CI (PDF page count per artifact) |
| S17 | signed off on a real WPS machine | user confirmed on 2026-09-22 that the ten-point checklist passed (`docs/compat/wps-report.md`, ADR-051); concrete WPS build and per-item notes to be captured next run | **user-confirmed; v1 may claim T1** (ADR-051); a future failure reverts to T2 |
| S18 | 页码按契约出现 | `chrome.test.ts` unit assertions: a non-skipped page carries exactly one `slidenum` field and a skipped page zero; `audit` rule `chrome-coverage` on every rendered deck; fixture `fixtures/hello` validates with page numbers on pages 2–4 only | verified (automated) |
| S19 | 页码是原生域 | rendered XML carries `<a:fld type="slidenum">` with text `‹#›` and a deterministic UUID-v5 id (`chrome.test.ts`, ADR-058); deleting a page and watching PowerPoint/WPS renumber is a human check on a machine with the suite | XML verified; **deletion renumber pending user check** |
| S20 | chrome 几何/文案一致 | `chrome.test.ts`: identical `a:off`/`a:ext` per chrome kind across pages, footer text identical, idempotent re-apply and two-run byte equality; `audit` rules `chrome-geometry`/`chrome-footer-text`/`chrome-section`/`chrome-baked-strip` | verified |
| S21 | role→layout 匹配 | `validate` rejects a foreign theme pin, an unregistered face and a menu slot the role may not use (ADR-059); `pnpm eval:run` v0.2 rubric `role-layout` green in 3/3 scenarios (`docs/v02-model-eval.md`); `schema/storyboard.test.ts` covers the three rejection paths | verified |
| S22 | 内容预算守门 | `validate` measures words/items/charts/tables/images and reports `budget-exceeded` with page/role/measured/limit; `schema/budget.test.ts` covers the counters and the violation shape; v0.2 rubric `budget` green in 3/3 scenarios | verified |
| S23 | 旁白自动翻页 | `fixtures:verify` (fixtureVersion 8) prints `narration auto-advance ok (2 narrated slide(s), useTimings=1)`; `post.test.ts`/`audio.test.ts` cover the byte-driven recompute, the preserve-on-unreadable fallback and the `useTimings` restore (ADR-060); playing a narrated deck and watching it advance is a human check | automated verified; **playback pending user check** |
| S24 | 档案提取忠于参考 | `pnpm design:verify` re-extracts the deck named by `DSH_PPT_REFERENCE_DECK` and compares it field by field with `fixtures/reference/profile.json` (5 roles / 5 type rows on this machine); the schema is strict; palette, fonts and the type scale match plan Appendix A (geometry anchors differ, ADR-061) | verified on this machine; CI skips without the deck |
| S25 | 档案可套用 | `theme apply-profile` writes a ThemeFile whose palette/fonts match; `init --profile` leaves chrome/storyboard correct and copies the profile into the deck. Measured on `tmp/profile-deck`: validate OK 4 gates; rendered XML carries `#577FD2/#0D0D0D/#595959/#FFFFFF` and, after the font pass, `latin=MiSans ea=MiSans` on every run; `out/manifest.json` records `design.typefaces:["MiSans"]`; audit 11 sources, 0 error, 0 warning (ADR-066) | verified |
| S26 | 符合性审计复现参考 | `dsh-ppt audit <dir> --profile fixtures/reference/profile.json --file <参考 deck>` 重放提取器测量并比对：`ok=true`、0 error、1 warning（第 8 页一个正文框只有 33% 像素达到 4.5:1，且该页无覆盖层 → warning）；`pnpm design:verify` 现在同时跑 S24 字段比对与 S26 profile 审计；负例覆盖错字号/错色/错强调色/错锚点/错列/缺水印/多页码/缺 meta footer/缺 PNG 回退/暗图对比（ADR-062） | verified on this machine; CI skips without the deck |
| S27 | 与参考观感对齐 | `reference-quality` 场景 12 页一次通过：14/14 rubric 检查绿（含 `design-profile`），统一审计 0 error、profile 审计 0 error / 4 warning，1698s / 221 tool calls / 0 failed；交付 `tmp/quality-demo/out/reference-quality.pptx` + preview HTML + `audit.json`；基线记录在 `docs/quality.md`（ADR-069） | 自动化已验证；**3 样本并排评分 pending user check** |
| S29 | 图像生成=可选，不是必选 | 未开启：`images generate` 直接拒绝并打印 `svg → user → office → flat → photo`（本机实测 exit 1 / `ContractViolation`）；`DSH_PPT_ENABLE_IMAGE_GEN=1` 但无 key：`UsageError` 点名 `OPENAI_API_KEY`/`GEMINI_API_KEY`（本机实测）；单测覆盖 engine argv/凭据白名单、`image_sources.json` 的 `provider: ai-image-*` + prompt 摘要 + 尺寸 + 人工复核说明、同名替换/异名追加、缺图=`OutputMissing`、坏 manifest=`ContractViolation`；默认 `render` 不引用该模块（ADR-064） | automated verified; **live generation skipped（本机无 provider key）** |
| S28 | 素材不靠 AI 也能达标 | `assets discover --source office` on this machine records 1689 assets (1651 clip-art + 38 theme) from 7 probed roots into `<DSH_HOME>/ppt-fusion/assets/office-assets.json`; `assets copy` moves an office PNG and a user SVG+PNG into a deck (office copy sha256 equals the source, reruns report `unchanged`); a manifest without a licence / an escaping path / a bad format each fail `ContractViolation`; `flat` and `svg` backgrounds both render on `tmp/bg-flat` / `tmp/bg-svg`, the SVG deck carries `.svg`+`.png` parts with `a:blip→PNG` and `asvg:svgBlip→SVG`, `minContrast` 5.61:1, and two renders are byte-identical (ADR-067). Unit tests: `assets.test.ts` (15), `background.test.ts` (9) | automated verified; **background look pending user check** |
| S30 | 双 DSH 版本可安装 | `dsh-compat` CI job 矩阵（0.1.2-rc.1 / 0.1.7-rc.2）：`scripts/dsh-compat.mjs` 在 0.1.7 上跑官方 peer 门禁、在 0.1.2 上显式 skipped；`scripts/dsh-compat-profile.mjs` 在两条线上都把打包后的插件装进 scratch profile 并 compose（本机实测两版 ok，ADR-079） | 无（CI 复核） | V8 Part 0 |
| S31 | 0.1.7 探针记录 | `docs/dsh017-probe.md`：两版运行时矩阵、peer 门禁语义（只查 `@deepseek-ai/dsh*`、预发布参与匹配、`compatibility.json` 精确豁免与 BOM 坑）、本插件 5 个 peer 的声明与验证证据、V9 三杠杆（Kit/附件/子代理）可用性 | 无 | V8 Part 0 |
| S32 | 0.1.7 实机运行 | 本机基线已切到 `~/dsh-017-runtime`（0.1.7-rc.2）：`--profile web --dump-config` 退出 0 且 `dsh-ppt-flashmade` 层在列；`%TEMP%\dsh-web.log` 无 `Failed to load / failed to import / did not activate`；`tests/dsh-peers.test.ts` 3 绿 | 浏览器 red banner 复核（用户） | V8 Part 0 |
| S35 | 渲染快照可用 | `dsh-ppt renderpages` 在本机对 reference-quality deck 出全页 PNG：LibreOffice Kit 0.1.1（native，1280×721，12 页）与 PowerPoint COM 16.0（1280×720，12 页）各一份 + `pages.json`；二次运行两引擎均 `cached`（0 重渲）；`--force` 重渲；`--engine`/`--scale`/`--max-pages`/`--max-pixels` 与 `--required` 语义有单测（ADR-081） | 抽 2 页看图（用户） | V10 Part A |
| S36 | 渲染门禁有效 | `dsh-ppt audit --rendered` 在 reference-quality deck 上跑通并给出 `ok=true`（仅 2 条 `render-parity` warning：两引擎墨迹占比漂移 6.2% / 0.5%）；规则：page-count / content-loss / off-page（几何越界 + 外带 warning）/ overlap（忽略模板的整幅隐形文本框）/ contrast（窗口内最深墨色，<18pt 4.5:1、≥18pt 3:1）/ chrome（页脚带暗色小标记 0.15–12%）/ tofu（仅 PowerPoint）/ overflow（warning）/ parity（warning）；`--require-rendered` 升级缺快照；`render-audit.test.ts` 4 例。校准事实：LibreOffice 把 `wrap="none"` 文本框按自身锚点绘制（比声明框高 30–100px），PowerPoint 严格按框（ADR-082） | 无 | V10 Part A |
| S37 | 模型看图自评闭环 | `dsh_ppt_review` 工具（插件内 scoped `attachments` 注入）：inspect 模式把渲染页图作为图片附件交给模型 + rubric + `review.json` 路径；record 模式校验 findings 并写 `.dsh-ppt/review/review.json`；无附件服务 / 路由无法解析 / 模型不声明 image 输入时一律报 `image-input-unavailable` 并如实记录"视觉自评未运行"。`tests/plugin/review-tool.test.ts` 5 例钉住：附件页数与图片块、页选择与上限、两条拒绝路径、finding 校验与写入、渲染失败不上陈旧索引；SKILL 增相位 5.5（`DSH_PPT_REVIEW=pixel|model|subagent`，≤2 轮，approve 归用户），prompt-audit 25 files / 112,405 / 120,000 · 0 error。**本机实时看图需 image-capable 模型路由，未在本会话验证** | 用图片模型跑一轮并看修复前后（用户） | V10 Part B |

## What is deliberately not claimed

- **Four human checks ride the user**: S19 (delete a page in PowerPoint/WPS and watch the
  native field renumber), S23 (play a narrated deck and watch it advance), the S21/S22
  visual sample (open the v0.2 eval decks and score 观感/信息密度/叙事) and the S28 background
  look (open `tmp/bg-svg/out/profile-deck.pptx` and judge one page's background). The automated
  halves are green and recorded above; these rows stay open until the user runs them.
- **T1 (canonical equality) is proven for this repository's fixtures**, not for every customer
  deck; the tier definitions live in `docs/architecture.md` and ADR-033/037.
- **LibreOffice conversion** runs on the ubuntu CI leg (installs `libreoffice-impress`, compares the
  PDF page count per artifact; run 35761959099 green) and is reported as `skipped` on this machine,
  which has no `soffice`.
- **WPS** is user-confirmed (2026-09-22) and ADR-051 allows the v1 release notes to claim
  T1; `docs/compat/wps-report.md` still needs the concrete WPS build and per-item notes on
  the next real-machine run, and any future failure reverts the claim to T2.
- **The preview card** was verified server-side (route + logs) and then user-confirmed
  in-browser on 2026-09-22 (M9 prep); the real `web`-profile card/red-banner check rides
  the M9 install.