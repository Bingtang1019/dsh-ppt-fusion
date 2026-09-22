# M0 decision gate

Plan version: **v2** (2026-09-22). This file is the M0 exit artifact required by
v2 §5: one conclusion per experiment, the path chosen, and the Plan B status. Evidence
and raw captures are in `docs/m0-report.md`; contracts are frozen in
`docs/contracts.md`; deviations are `decisions.md` ADR-001 … ADR-018.

**Gate verdict: PASS — proceed to M1. No experiment needs a Plan B, no assumption is
left unresolved.** One planned verification (the browser plugin card) is deferred to a
user restart window and is the only open item; it is a UI confirmation of a
registration already proven at the API and profile-tree level, and it is not on the
M1 critical path.

## Experiment results

| # | Experiment | Result | Evidence | Plan B status |
|---|---|---|---|---|
| A | pptwise@0.35.0 in a scratch profile: card, skill registration, `doctor` green | **PASS** (card deferred) | `rc1-test` profile: dependency + `dsh.profile.bundles` + `--dump-config` layer `@liustack/pptwise`; `tests/m0/pptwise-plugin-smoke.mjs` registers skill (9622-byte body), tool `pptwise_preview`, `['webServer']` injection; `pptwise doctor --json` exit 0 with `selfTest {ok:true, slides:2}` and `errors: []`; only warning is `soffice` absent (PDF export path only) | **B1 not needed.** The card itself is unverified because this session *is* the running `web` service (ADR-002) |
| B | venv + `ppt-master==0.1.128`, 3-page hello deck openable in PowerPoint | **PASS** | `%DSH_HOME%\ppt-fusion\venvs\ppt-master-0.1.128` (212 MB, 18047 files); 5-page deep deck exported and opened by PowerPoint COM with 5 slides at 960×540, `Saved=true`, bytes unchanged | **B2 not needed** |
| C | native chart: `charts/chart1.xml` with root `c:chartSpace` | **PASS (exceeded)** | `ppt/charts/chart401.xml` root `c:chartSpace` + `c:numCache` + series name, `ppt/embeddings/Microsoft_Excel_Sheet401.xlsx` (editable data), slide rel `…/chart`; the same deck also produces a native table (`<a:tbl>` in `p:graphicFrame`) | **B3 not needed** |
| D | merge prototype with layout remap; PowerPoint opens with no repair; **highest risk** | **PASS** | Ran at full scope, not the minimal scope: base slide 3 ← deep native-chart page imported with its closure (`charts/chart401.xml`→`charts/chart1.xml`, workbook→`…Sheet1.xlsx`, 2 content-type overrides, chart rels + slide rels rewritten), layout remapped to the base layout. Result: 47 parts, 5 slides, **1 slideMaster / 1 theme / 5 layouts**, no dangling rels, no duplicate rIds; PowerPoint COM: 5 slides, `Saved=true` (no repair), file bytes unchanged | **B4 ladder not needed.** See P1 below |
| E | `theme new --from brief` yields complete StyleTokens | **PASS** | ThemeFile v2 `{id,label,style,occasions,identity,story,emphasis,version,menu}` with `style.{colors,fonts,shape,defaultBackgrounds}`; key inventory in `contracts.md` §3 | **B5 not needed** |
| F | pipe capture from the DSH terminal (EPERM?) | **PASS, premise refuted** | `tests/m0/spawn-probe.mjs`: piped `spawnSync`, `execSync`, async piped `spawn`, `inherit`, `ignore`, and a 5 KB engine capture all succeeded, exit 0, intact output (ADR-004) | **B6 not needed**; the file contract stays as a design choice, not a constraint |

## Product invariant P1 (single master) — verified, not assumed

`scripts/opc-invariants.mjs --single-master` asserts three things: exactly one
`ppt/slideMasters/slideMaster*.xml`, exactly one slideMaster relationship in
`ppt/_rels/presentation.xml.rels`, and that every slide layout resolves to the same
master. Results:

| Deck | parts | slides | masters | layouts | themes | charts | embeddings | verdict |
|---|---|---|---|---|---|---|---|---|
| `fixtures/golden/base.pptx` (pptwise) | 44 | 5 | 1 | 5 | 1 | 0 | 0 | OK |
| `fixtures/golden/deep.pptx` (ppt-master) | 29 | 5 | 1 | 1 | 1 | 1 | 1 | OK |
| `fixtures/golden/merged-proto.pptx` | 44 | 5 | 1 | 5 | 1 | 0 | 0 | OK |
| `fixtures/golden/merged-chart.pptx` | 47 | 5 | 1 | 5 | 1 | 1 | 1 | OK |

Because the remap strategy already holds at M0 with the hardest payload (a chart page
plus its workbook), the `--allow-multi-master` fallback is **not** activated and stays
an M4 escape hatch with its `multi-master: true` warning marker.

## Determinism tiers (v2 §7.2)

| Tier | Status at M0 | Evidence |
|---|---|---|
| **T1 semantic** | **achieved for our own producer**; needs one addition to `canonicalize` | Two merges of the same inputs are semantically equal (47 parts, 0 differences) via `scripts/m0/canonical-equal.mjs`. Two ppt-master exports of the same `svg_output/` are also semantically equal, but only after `canonicalize` **recurses into embedded OOXML parts**: the top-level diff showed `ppt/embeddings/Microsoft_Excel_Sheet401.xlsx` differing, and comparing those workbooks extracted from both runs gave SEMANTICALLY EQUAL (10 parts). `docProps/core.xml` normalization at the top level was sufficient (ADR-017) |
| **T2 our own bytes** | reachable, not yet implemented | Merged output differs only by zip entry timestamps: same size, semantically equal, and once `bridge/post.ts` writes fixed entry dates the bytes should match the `base` deck's bytes for unchanged parts |
| **T3 full chain** | not attempted | ppt-master output is timestamp-unstable (ADR-014); per v2 this is never a v1 gate |

## Environment facts that constrain M1

- The harness shell is **Windows PowerShell 5.1** (`5.1.22000.2538`, Desktop edition), not
  `pwsh` 7: `pwsh` is not on PATH, `-Encoding utf8NoBOM` does not exist, and
  `Set-Content -Encoding utf8` writes a **BOM**. Node's `writeFileSync(…, 'utf8')` is the
  safe writer for generated artifacts (ADR-016).
- `uv` 0.12.17 exists but only inside the Store Python's `local-packages` script
  directory; `dsh plugin add` needs an explicit `-w`; the engine venv has no `pip`
  (ADR-003, ADR-006).
- `[Content_Types].xml` is invisible to PowerShell path cmdlets unless `-LiteralPath` is
  used — a real trap for any script that touches it (ADR-014).
- `pip` itself is the Windows Store interpreter's; `python -m venv` works but the project
  uses uv exclusively.

## Recorded cost (v2 §4.4 asks for actual effort)

| Stage | Actual |
|---|---|
| Environment survey (runtime, profiles, toolchain, registries) | ~0.4 pd |
| Experiment A (profile install, plugin smoke, profile dump, pptwise doctor) | ~0.5 pd |
| Experiment B (uv venv, wheel install, 3 pages of hand-authored SVG, export) | ~0.6 pd |
| Experiment C (native chart + native table marker authoring, fallback projection) | ~0.9 pd |
| Experiment D (merge prototype incl. closure import, OPC invariants, COM smoke) | ~1.2 pd |
| Experiments E + F | ~0.3 pd |
| Contracts, ADRs, reports, golden manifest | ~0.6 pd |
| **Total** | **~4.5 pd** (plan budget 3–4 pd; +12 % over the top of the band, within the 30 % review line) |

The overrun is concentrated in experiment C: the deep authoring contract (seven
undocumented rules, ADR-007) and the SVG-first fallback projection gate had to be
reverse-engineered from checker output. That knowledge is now written down, so M3/M6
inherit it instead of paying for it twice.

## What M1 can rely on

1. Every CLI flag, output file, and JSON artifact the wrapper needs is in
   `docs/contracts.md`, backed by `docs/help/` snapshots.
2. The uv invocation pattern (`python -m uv`-equivalent absolute shim path), the
   `-w` install flag, and the BOM-free writer rule are settled.
3. `scripts/opc-invariants.mjs`, `scripts/m0/canonical-equal.mjs`,
   `scripts/win-com-smoke.ps1`, and `scripts/m0/merge-slide.mjs` are working, tested
   seeds for `bridge/opc.ts`, `tests/support/canonicalize.ts`, the CI Windows job, and
   `bridge/merge.ts`.
4. No unresolved assumption blocks M1. The single deferred item (browser card) is a UI
   confirmation with no M1 dependency.