# M0 report — environment and upstream feasibility

Date: 2026-09-22. Machine: Windows, `%DSH_HOME%` = `C:\Users\dell\.dsh`, DSH runtime
`@deepseek-ai/dsh@0.1.2-rc.1` at `C:\Users\dell\dsh-rc1-runtime`.

This file is the **evidence log**. The gate decision it feeds — the per-experiment
conclusions and chosen fallbacks required by plan v2 §5 — is `docs/m0-decision.md`.
Deviations from the plan are `decisions.md` ADR-001 … ADR-018; contracts are frozen in
`contracts.md`.

Task mapping: this log was first written against plan v1's nine-item checklist. Plan v2
regroups the same work into experiments A–F (A = the v1 items 1/8, B = 2/3, C = 6,
D = 7, E = 5, F = 8) and adds the decision matrix; nothing from v1 was dropped, and the
v2 additions (the P1 single-master assertion, the tiered determinism measurement, the
`pptwise doctor` run) are recorded below and summarized in `m0-decision.md`.

Goal: prove that both upstreams run on this machine and freeze their CLI contracts
before any fusion code exists.

## Verdict

| M0 task | Result | Evidence |
|---|---|---|
| 1. scratch profile + pptwise install | **green, narrower than planned** | `rc1-test` profile now has `@liustack/pptwise@0.35.0` in `dependencies` and in `dsh.profile.bundles`; `dsh --profile rc1-test --dump-config` emits `# == @liustack/pptwise` / `- id: pptwise`; `tests/m0/pptwise-plugin-smoke.mjs` registers skill + tool + `webServer` injection in-process. The browser card check is deferred (ADR-002) |
| 2. ppt-master venv + full subcommand list | **green** | `uv venv --python 3.13` + `uv pip install ppt-master==0.1.128` (Tsinghua mirror) at `%DSH_HOME%\ppt-fusion\venvs\ppt-master-0.1.128`; `ppt-master --help` lists 70 subcommands, captured in `docs/help/` |
| 3. 3-page ppt-master deck openable in PowerPoint | **green** | `fixtures/master-hello_ppt169_20260922/` with three hand-authored SVGs; export → `fixtures/golden/deep.pptx`; COM smoke: opened, 5 slides, 960×540 |
| 4. pptwise hello deck: validate/render/audit/preview | **green** | `fixtures/hello/deck.ir.json`: `validate` OK (5 slides, theme brief); `render` → `fixtures/golden/base.pptx` (30762 B); `audit --json` 0 findings, exit 0; `preview --html` wrote 5 SVGs + `preview.html` + `manifest.json` |
| 5. theme bridge feasibility | **green** | `pptwise theme new --from brief -o brief.theme.json --id brief` wrote a ThemeFile v2 with `style.{id,colors,fonts,shape,defaultBackgrounds}`; the token groups and their keys are in `contracts.md` §3 |
| 6. native chart capability | **green, stronger than planned** | `ppt/charts/chart401.xml` (root `c:chartSpace`, `c:numCache`, series name) + `ppt/embeddings/Microsoft_Excel_Sheet401.xlsx` + the slide's `relationships/chart` entry; the same deck also carries a native table (`<a:tbl>` in a `p:graphicFrame` on slide 5) |
| 7. merge risk minimal set | **green, narrowed** | `scripts/m0/merge-slide.mjs` replaced slide 3 of the pptwise deck with the shape-only deep page and repointed its layout relationship → `fixtures/golden/merged-proto.pptx`, opened by PowerPoint with 5 slides (ADR-010) |
| 8. spawn discipline / pipe EPERM | **measured, premise refuted** | `tests/m0/spawn-probe.mjs`: piped `spawnSync`, `execSync`, async piped `spawn`, `inherit`, `ignore`, and a 5 KB engine capture all succeeded; no EPERM (ADR-004) |
| 9. upstream pins | **green** | `python-assets/manifest.json`: wheel/tarball SHA-256 + sizes, npm SRI + shasum, branch heads, packaging facts |

Acceptance from the plan (tasks 1/3/4/6/7 green, `contracts.md` carries the `--help`
snapshots, `manifest.json` carries SHAs) is met, with task 1's browser half deferred and
documented.

## What was verified beyond the plan's checklist

- **Determinism.** pptwise renders the same IR to identical bytes; ppt-master differs
  only in `docProps/core.xml` and embedded-workbook timestamps (ADR-014). M4's
  byte-identical requirement is therefore reachable by normalizing timestamps.
- **The deep authoring gate is much stricter than "write an SVG".** Seven rules —
  page role, ids on role-carrying elements, non-overlapping `data-pptx-bounds` modules
  with ≤5 % text overflow, a `spec_lock.md` with numeric typography anchors, per-page
  font-size banding, `stamp-native-fallbacks` hashes, and full projection of the visible
  fallback into native-object payloads — are now measured and written down (ADR-007,
  ADR-008). Building M3/M6 without these would have cost a debugging cycle per page.
- **The upstream chart/table prototypes are not export-ready** under that gate
  (ADR-011), so the fusion ships its own marker pages.
- **`--quick-generate` is gated on a recorded final quality report.** The export refuses
  to run without `validation/svg_quality_report.json` from a `--stage final` run; the
  pipeline order is stamp → quality final → export (ADR-008).
- **ppt-master's native chart path writes an editable workbook**, which is what makes
  "change the numbers in PowerPoint" real rather than nominal.

## Artifacts produced

```
docs/contracts.md                 frozen CLI + authoring + pipeline contracts (v1)
docs/m0-decision.md               M0 gate: experiments A-F, Plan B status, P1, cost
docs/decisions.md                 ADR-001 … ADR-018
docs/m0-report.md                 this file
docs/help/                        5 captured --help snapshots (UTF-8, byte-exact)
python-assets/manifest.json       upstream pins, hashes, packaging facts
fixtures/hello/deck.ir.json       pptwise hello deck (5 pages, theme brief)
fixtures/hello/.pptwise-preview/  5 SVG pages + preview.html + manifest.json
fixtures/master-hello_ppt169_20260922/   deep project: 5 SVGs, spec_lock.md, validation/
fixtures/golden/                  base/deep/merged-proto/merged-chart pptx + chart401.xml
                                  + pptwise-doctor.json + manifest.json (fixtureVersion 1)
scripts/m0/capture.mjs            subprocess → UTF-8 file capture (avoids console re-encoding)
scripts/m0/schema-summary.mjs     JSON Schema envelope summarizer
scripts/m0/schema-path.mjs        JSON Schema node printer
scripts/m0/merge-slide.mjs        merge-bridge prototype: closure import + layout remap
scripts/m0/canonical-equal.mjs    T1 semantic comparison for two packages
scripts/m0/extract-part.mjs       pull one part out of a package (debug helper)
scripts/opc-invariants.mjs        OPC census, rels/content-type integrity, P1 assertion
scripts/win-com-smoke.ps1         PowerPoint COM open/read/round-trip gate (M4 CI reuse)
tests/m0/pptwise-plugin-smoke.mjs in-process DSH plugin registration check
tests/m0/spawn-probe.mjs          child-process stdio capability probe
```

Scratch (not deliverables): `fixtures/_m0-scratch/` holds the intermediate exports,
quality reports and error captures used while measuring.

## Environment changes made on this machine

1. `~/.dsh/profiles/rc1-test/package.json` — added `@liustack/pptwise: 0.35.0` and the
   matching `dsh.profile.bundles` entry (via `dsh plugin --profile rc1-test add -w`).
2. `%DSH_HOME%\ppt-fusion\venvs\ppt-master-0.1.128\` — new uv venv, 212 MB, 18047 files.
3. Backup of the pre-change configuration at
   `C:\Users\dell\Desktop\dsh-backups\20260922-1307\` (`cordis.patch.yml`,
   `web/package.json`, `rc1-test/package.json`, `Dsh-Web-UI.bat`).

No change was made to the live `web` profile, `~/.dsh/cordis.patch.yml`, or the launcher.
The `~/.dsh/CHANGELOG-dsh.md` entry for change 1 is still owed; the `web` profile was
never touched, so the machine's baseline is unchanged.

## Cost measurements (for M8's performance bar)

| Stage | Wall time |
|---|---|
| pptwise `validate` + `render` + `audit` + `preview` on 5 pages | ~6 s total |
| ppt-master `svg-quality-check --stage final` on 5 pages | ~4 s |
| ppt-master `svg-to-pptx` on 5 pages (native chart + table) | ~9 s |
| Node merge prototype (5-slide package, jszip) | ~1 s |
| PowerPoint COM open + read + close, 3 decks | ~30 s |
| uv venv create + `ppt-master==0.1.128` install | ~2 min |

## v2 additions: P1, tiered determinism, `pptwise doctor`

**P1 single-master assertion** (`scripts/opc-invariants.mjs --single-master`): exactly one
`ppt/slideMasters/slideMaster*.xml`, exactly one slideMaster relationship in
`ppt/_rels/presentation.xml.rels`, and every layout resolving to that one master.

| Deck | parts | slides | masters | layouts | themes | charts | embeddings | verdict |
|---|---|---|---|---|---|---|---|---|
| `base.pptx` | 44 | 5 | 1 | 5 | 1 | 0 | 0 | OK |
| `deep.pptx` | 29 | 5 | 1 | 1 | 1 | 1 | 1 | OK |
| `merged-proto.pptx` | 44 | 5 | 1 | 5 | 1 | 0 | 0 | OK |
| `merged-chart.pptx` | 47 | 5 | 1 | 5 | 1 | 1 | 1 | OK |

**M0.D at full scope.** `merged-chart.pptx` replaces base slide 3 with the deep
native-chart page and imports its non-layout closure: `ppt/charts/chart401.xml` →
`ppt/charts/chart1.xml`, `ppt/embeddings/Microsoft_Excel_Sheet401.xlsx` →
`…Sheet1.xlsx`, two `[Content_Types].xml` overrides, chart rels rewritten to
`../embeddings/Microsoft_Excel_Sheet1.xlsx`, slide rels = remapped layout (rId1) + chart
(rId2). The deep deck's own layout, master and theme are absent from the result.

**Tiered determinism.**

| Measurement | Result |
|---|---|
| pptwise render, same IR twice | byte-identical (`5dbf19c9…`) |
| our merge, same inputs twice | **semantically equal** (47 parts, 0 differences) but not byte-identical — zip entry timestamps only |
| ppt-master export, same `svg_output/` twice | top-level diff on one part: the embedded workbook; extracting it from both runs and normalizing gave SEMANTICALLY EQUAL (10 parts) → `canonicalize` must recurse into embedded OOXML (ADR-017) |
| PowerPoint round trip | `Saved=true` and identical bytes on all four decks (no repair) |

**`pptwise doctor --json`** (scratch profile, exit 0): `runtime.nodeMeetMinimum` true,
`dsh.profiles[rc1-test] = {installed: true, version: 0.35.0, stale: false}`,
`selfTest {ok: true, slides: 2, elapsedMs: 1830}`, `errors: []`, one warning
(`soffice` not on PATH — PDF export path only).

## Carry-forward risks

- **R2 (OOXML merge) is the live risk.** The prototype moved one shape-only slide and
  repointed its layout. M4 still has to import the layout/master/theme closure, charts,
  embeddings and media with collision-safe renaming — and M0 confirmed the deep deck
  ships a second master and theme that must be registered in
  `ppt/presentation.xml.rels`.
- The 960 vs 959.75 pt slide width difference between the two producers is real and must
  not be "fixed" by rewriting base geometry during merge.
- `doctor` must treat the missing uv shim on PATH, the absent pip in the venv, and the
  stale `D:\新建文件夹 (2)\python.exe` registry entry as reportable conditions rather
  than failures.
