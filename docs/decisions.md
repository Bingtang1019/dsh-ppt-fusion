# Decisions

ADR log for dsh-ppt-fusion. Every entry records date, decision, evidence, and the
alternatives that were rejected. An entry is added whenever an implementation choice or
an observed upstream fact departs from `PPT-FUSION-PLAN.md`; the plan is then synced to
the newest ADRs at the next plan revision (v4 did that for ADR-001…029). **The ADR is
the authoritative record; where a stale line of the plan disagrees with a newer ADR,
the ADR wins.**

## ADR index

| # | Subject |
|---|---|
| 001 | `dsh plugin add` needs `-w` on workspace profiles |
| 002 | M0.1 verifies without restarting the live web profile |
| 003 | Resolve uv by absolute path, never PATH |
| 004 | Child-process pipes work; EPERM premise refuted |
| 005 | Pin upstream artifacts by actual-file SHA-256 + size |
| 006 | Engine venv is uv-managed, no pip |
| 007 | Deep pages: seven measured authoring rules |
| 008 | Deep export = four-step gated pipeline |
| 009 | Machine output read from files, not stdout |
| 010 | M0.7 prototype scope (superseded by 018) |
| 011 | Fusion fixtures author their own native chart/table pages |
| 012 | Theme bridge reads `style.*` of ThemeFile v2 |
| 013 | Whitelist excludes image-gen / video-* non-goals |
| 014 | Determinism: pptwise byte-stable, master timestamp-only unstable |
| 015 | Deep project directory keeps its generated name |
| 016 | PS 5.1, BOM-free writers, `[Content_Types].xml` `-LiteralPath` |
| 017 | canonicalize recurses into embedded OOXML parts |
| 018 | M0.D closed with full closure import; multi-master dormant |
| 019 | runner.ts + logging.ts added; DSH fields wait for M7 |
| 020 | M1 verification record |
| 021 | Theme fonts are arrays; backgrounds carry gradient slots |
| 022 | 24-theme re-capture is a script gate |
| 023 | M2 verification record |
| 024 | Plan v3 alignment retro-fitted into closed milestones |
| 025 | B7 activated: no Python-side PNG rasteriser |
| 026 | `deep render` batch-only; reports inside project; `--out` deck-relative |
| 027 | M3 verification record |
| 028 | Merge bridge: content-aware reuse + three real-merge bugs |
| 029 | M4 progress: merge core and render chain landed, rest listed |
| 030 | V4 sync: plan, architecture, README, docs index |
| 031 | ADR-029 remaining list made explicit: M4.9 / M4.10 / M4.11 are separate items |
| 032 | Animation owner: one post-merge pass in `bridge/post.ts` |
| 033 | T1 canonicaliser, the golden v1 fixture, and `fixtures:verify` |
| 034 | The compat pass v1: registered downgrades, the sharp PNG stamp, and refusals |
| 035 | The unified audit gate: eight sources, an honest skip list, a warning-only ΔE |
| 036 | Merge compatibility discipline: creationId renumbering, MCE migration, zip shape |
| 037 | Compat goldens for all three levels, and the fixtureVersion 2 re-record |
| 038 | M5 opens: native round trip, template routing, brand extraction |
| 039 | Source pipeline: five routes, fail-closed URL policy, 5 MiB output cap |
| 040 | Image search records provenance and refuses unattributed images |
| 041 | T2 fix: pin every zip entry date, folders included |
| 042 | Motion breadth (emphasis/paths) and narration: COM-verified wrapper, two TTS blockers |
| 043 | Narration lands: notes roster, embedded audio, and the merge bugs it found |

---

## ADR-001 — Install profile plugins with an explicit workspace-root flag

- **Date:** 2026-09-22
- **Decision:** Every `dsh plugin --profile <p> add` invocation passes `-w` (pnpm's
  workspace-root flag). Both `web` and `rc1-test` profiles carry a
  `pnpm-workspace.yaml` with `packages: ['.']`, so pnpm 8 treats the profile directory
  as a workspace root and refuses a plain `add`.
- **Evidence:** `dsh plugin --profile rc1-test add @liustack/pptwise@0.35.0` exited 1
  with `ERR_PNPM_ADDING_TO_ROOT`; the identical command with `-w` installed the
  package and reconciled `dsh.profile.bundles`.
- **Alternatives rejected:** setting `ignore-workspace-root-check=true` in the profile
  `.npmrc` (mutates a file DSH owns and shares with the `web` profile); editing
  `pnpm-workspace.yaml` (same ownership problem).

## ADR-002 — M0.1 plugin verification runs without restarting the live web profile

- **Date:** 2026-09-22
- **Decision:** Install pptwise into the `rc1-test` scratch profile and verify it at
  two levels that need no service restart: the composed profile tree
  (`dsh --profile rc1-test --dump-config`, which shows the `@liustack/pptwise` layer)
  and an in-process `apply()` smoke test against a stub Cordis context
  (`tests/m0/pptwise-plugin-smoke.mjs`). The browser plugin-card check is deferred to a
  window in which the user restarts the `web` profile.
- **Evidence:** this session runs inside the live service
  (`DSH_WEB_URL=http://127.0.0.1:3080`, session `session-18e61857-…`), and the launcher
  `Dsh-Web-UI.bat` boots that service; restarting it would terminate the session
  performing the verification. The smoke test captured registrations: skill `pptwise`
  (9622-byte body with the CLI preamble), tool `pptwise_preview`, and a
  `['webServer']` injection.
- **Alternatives rejected:** restarting `web` mid-session; starting a second server
  against the same `~/.dsh` (the machine's documented storage-sharing failure mode).

## ADR-003 — Resolve `uv` by absolute path, never through PATH

- **Date:** 2026-09-22
- **Decision:** The engine resolves uv at
  `%LOCALAPPDATA%\Packages\PythonSoftwareFoundation.Python.3.13_qbz5n2kfra8p0\LocalCache\local-packages\Python313\Scripts\uv.exe`,
  with `python -m uv` as an equivalent fallback. `doctor` reports the resolved path.
- **Evidence:** `uv --version` fails on PATH, but `python -m uv --version` prints
  `uv 0.12.17` and the shim exists in the Store Python's `local-packages` script
  directory. `ppt-mcp` hit the same shim-directory problem earlier and is invoked from
  the global patch layer by absolute path.
- **Alternatives rejected:** `pip install uv` (already satisfied in the user site, and
  re-installing would not put the shim on PATH); vendoring uv inside the plugin.

## ADR-004 — Child-process pipes work here; the §2.6 EPERM premise does not hold

- **Date:** 2026-09-22
- **Decision:** Keep the file-contract style between Node and the Python engine for
  replayability, cacheability, and large payloads, but do not treat piped stdio as
  unavailable or forbidden. `engine/master.ts` may use `spawnSync`/`spawn` with pipes
  for small results and must still write bulk artifacts to files.
- **Evidence:** `tests/m0/spawn-probe.mjs` exercised `spawnSync` with `encoding`,
  `execSync`, async `spawn` collecting `stdout`/`stderr` through pipes, `stdio:
  'inherit'`, `stdio: 'ignore'`, and a 5 KB `ppt-master --help` capture: every mode
  succeeded with exit code 0 and intact output; no EPERM appeared.
- **Alternatives rejected:** building the bridge around a constraint that could not be
  reproduced (would add a `cmd /c` redirect layer and make error classification
  strictly worse).

## ADR-005 — Pin upstream artifacts by size and SHA-256 over the artifact, not by branch head

- **Date:** 2026-09-22
- **Decision:** `python-assets/manifest.json` stores the SHA-256 and byte size of the
  files actually used (wheel, source tarballs) as the binding pin, and records the
  branch head SHA alongside as informational. The ppt-master wheel is **15,400,327
  bytes**, not the 22,142,023 bytes stated in the plan.
- **Evidence:** `Get-FileHash` over `%TEMP%\ppt-fusion-research\ppt_master.whl`;
  `git ls-remote` gave `ppt-master@fb478a93…` and `pptwise@fa2444bc…` as moving heads.
- **Alternatives rejected:** trusting the plan's byte count (the plan itself says an
  observed difference wins); `git clone` for reproducible SHA pinning (both clones
  failed with `fatal: early EOF` against this network, so tarballs are the available
  artifact).

## ADR-006 — The engine venv is uv-managed and has no `pip`

- **Date:** 2026-09-22
- **Decision:** All Python package operations on the engine venv go through uv
  (`uv venv`, `uv pip install`, `uv pip freeze`). Never call `python -m pip` inside it.
- **Evidence:** `uv venv` does not install pip, and
  `<venv>\Scripts\python.exe -m pip --version` fails with `No module named pip`.
- **Alternatives rejected:** adding `--seed`/`pip` (slower, and the lock file is the
  source of truth anyway).

## ADR-007 — Deep pages obey a stricter authoring contract than the plan describes

- **Date:** 2026-09-22
- **Decision:** The fusion deep-page authoring flow, the SKILL, and `validate` enforce:
  1. the project root carries `spec_lock.md` with `## typography` rows whose values are
     bare positive px numbers; every `*_family` row is free text;
  2. every page SVG declares `data-pptx-page-role` (`cover|toc|section|content|ending`);
  3. any element carrying `data-pptx-role` also carries a stable `id`;
  4. every root-level `<g>` declares `data-pptx-bounds="x y w h"`, zones stay disjoint
     beyond 1 px, and contained text must not overflow the declared zone by more than
     5 %;
  5. a font size absent from the typography anchors may appear at most twice per page;
  6. native-object markers need `data-pptx-fallback-sha256`, produced by
     `stamp-native-fallbacks --write` after every fallback edit.
- **Evidence:** `svg-quality-check` error text during M0 iterations: "Master export
  requires spec_lock.md typography title and body rows"; "spec_lock typography sizes
  must be positive finite unitless px values"; "page SVG is missing root
  data-pptx-page-role"; "`<rect>` with data-pptx-role requires a stable id"; "visible
  root-level `<g>` module(s) without explicit data-pptx-bounds"; "spec_lock
  typography-size recurrence"; "requires data-pptx-fallback-sha256".
- **Alternatives rejected:** editing the checker's expectations by disabling rules
  (the constraints are what make deep pages render predictably in PowerPoint).

## ADR-008 — Deep export is a four-step gated pipeline, not one command

- **Date:** 2026-09-22
- **Decision:** `renderDeep` runs: `stamp-native-fallbacks --write` (only when markers
  exist) → `svg-quality-check <project> --quick-generate --canonical-authoring --stage
  final --json` → `svg-to-pptx <project> --quick-generate --native-charts-and-tables
  --with-notes` → read `validation/<stem>.report.json`. The quality step is not
  optional: `svg-to-pptx --quick-generate` refuses to run without a passing recorded
  final report and fails with "found not-provided".
- **Evidence:** the first export attempt failed with exactly that message and named the
  command to run; after the report existed, the export completed with
  `[POSTFLIGHT] status=passed-with-warnings quality_gate=passed slides=5`.
- **Alternatives rejected:** running the checker with default flags (its plain run
  passes while the final-stage gate still fails, so the recorded artifact must come
  from the `--stage final` invocation).

## ADR-009 — Machine-readable engine output is read from files, not stdout

- **Date:** 2026-09-22
- **Decision:** the Python bridge treats `validation/svg_quality_report.json` and
  `validation/<stem>.report.json` as the machine interfaces, and parses stdout only for
  human receipts (`[POSTFLIGHT] …`, `[PPTX] …`).
- **Evidence:** `svg-quality-check … --json` writes `[SCAN]`/`[REPORT]` progress lines
  to stdout around the JSON body, so the captured stdout is not valid JSON, while
  `validation/svg_quality_report.json` parsed cleanly.
- **Alternatives rejected:** regex-extracting the JSON region from stdout.

## ADR-010 — M0.7 prototype scope: shape-only slide, layout rel repointed

- **Date:** 2026-09-22
- **Decision:** the M0 merge prototype replaces one slide part of the pptwise deck with
  a shape-only ppt-master slide and repoints that slide's `slideLayout` relationship at
  the receiving deck's own layout. Importing the deep page's layout/master/theme
  closure, charts, and media is M4 work and is rejected loudly (not silently) by the
  prototype.
- **Evidence:** `scripts/m0/merge-slide.mjs` produced a 30,213-byte package that
  PowerPoint opened with 5 slides; the deep page used was `03-bars.svg`, whose slide
  XML references no relationship ids.
- **Alternatives rejected:** importing the full closure inside M0 (a merge-bridge-sized
  change, and the plan schedules it as M4's core).

## ADR-011 — Fusion fixtures author their own native chart/table pages

- **Date:** 2026-09-22
- **Decision:** the hello fixture's deep chart and table pages are authored in this
  repository; the shipped prototypes under
  `templates/charts/` and `templates/tables/` are references, not fixtures.
- **Evidence:** `templates/charts/column_chart.svg` fails on overlapping
  `data-pptx-bounds` zones and undeclared font sizes; `templates/tables/record_table.svg`
  fails the SVG-first projection gate with `columns[].align "l"` unprojected and banded
  row fills that the payload never states. Both failures are reported by the upstream
  checker itself, so the prototypes are not export-ready as-is.
- **Alternatives rejected:** patching the upstream prototypes in place (they are
  upstream artifacts; local edits would be silently overwritten by an upgrade).

## ADR-012 — The theme bridge reads `StyleTokens` from `style.*` of a v2 ThemeFile

- **Date:** 2026-09-22
- **Decision:** `bridge/theme.ts` maps `theme.style.colors`, `theme.style.fonts`,
  `theme.style.shape`, and `theme.style.defaultBackgrounds`, and preserves the v2
  `menu`, `story`, and `emphasis` fields as opaque pass-through data.
- **Evidence:** `pptwise theme new --from brief -o brief.theme.json --id brief` wrote a
  file whose top level is `{id, label, style, occasions, identity, story, emphasis,
  version: 2, menu}` with `style.keys = id, colors, fonts, shape, defaultBackgrounds`;
  the plan's §1.1 describes the token groups as if they were top level.
- **Alternatives rejected:** reading `theme.colors` (absent; the deck-level field
  `theme.id` is a binding, not a palette).

## ADR-013 — The engine command whitelist must exclude the non-goal commands

- **Date:** 2026-09-22
- **Decision:** `contracts.ts` registers only the subcommands the fusion exposes;
  `image-gen`, `powerpoint-video`, `video-motion-plan`, `video-sound-mix`,
  `video-subtitles`, and the `gemini-watermark-remove` helper are deliberately absent,
  so `dsh-ppt` cannot reach them.
- **Evidence:** `ppt-master --help` lists 74 subcommands including `image-gen` and the
  four `video-*` commands, while the plan lists image generation and video export as
  v1 non-goals.
- **Alternatives rejected:** exposing them and documenting them as unsupported (the
  plan's §3.7 requires that the CLI accept no image-generation command at all).

## ADR-014 — Determinism: pptwise is byte-stable, ppt-master is timestamp-only unstable

- **Date:** 2026-09-22
- **Decision:** M4's byte-identical requirement is met by normalizing three things in
  the merged package: ZIP entry timestamps, `docProps/core.xml`
  `dcterms:created`/`dcterms:modified`, and the timestamps inside every imported
  `ppt/embeddings/*.xlsx`. Golden fixtures compare post-normalization bytes.
- **Evidence:** rendering `fixtures/hello/deck.ir.json` twice produced identical SHA-256
  (`5dbf19c9…`). Exporting the same `svg_output/` twice through
  `svg-to-pptx --quick-generate --native-charts-and-tables` produced different bytes
  (`39ab274a…` vs `e72e3ae7…`) with exactly three parts differing: `docProps/core.xml`
  (timestamps only), `ppt/embeddings/Microsoft_Excel_Sheet401.xlsx` (its own timestamp
  metadata), and `[Content_Types].xml`, which is in fact identical — that third hit was
  a PowerShell wildcard artifact (`[Content_Types].xml` is a glob pattern), and a
  `-LiteralPath` comparison returned equal.
- **Alternatives rejected:** declaring ppt-master output non-reproducible and dropping
  the golden byte assertion (the unstable fields are metadata, not content, so
  normalization is lossless).

## ADR-015 — The M0 deep project directory keeps its generated name

- **Date:** 2026-09-22
- **Decision:** the checked-in deep project stays at
  `fixtures/master-hello_ppt169_20260922/`. `project init` names directories
  `<name>_<format>_<YYYYMMDD>` and `svg-to-pptx` reads the canvas from the roster, so a
  renamed directory would no longer match the name `project init` produces.
- **Evidence:** `project init master-hello --format ppt169 --dir fixtures` created
  `fixtures\master-hello_ppt169_20260922`; `svg-quality-check` and `svg-to-pptx` both
  accepted that directory unchanged.
- **Alternatives rejected:** renaming to `fixtures/deep-hello/` for tidiness (would
  desynchronize the fixture from the generator, and M3 will create project directories
  programmatically under `.dsh-ppt/` anyway).

## ADR-016 — The harness shell is Windows PowerShell 5.1; generated files are written without a BOM

- **Date:** 2026-09-22
- **Decision:** scripts in this repository stay PowerShell 5.1 compatible, and any
  generated text artifact is written by Node (`writeFileSync(..., 'utf8')`) or by .NET
  `UTF8Encoding($false)`. `Set-Content -Encoding utf8` is never used for machine-parsed
  files.
- **Evidence:** `$PSVersionTable` reports `5.1.22000.2538` / `Desktop`; `pwsh` is not on
  PATH; `-Encoding utf8NoBOM` fails to bind; `Set-Content -Encoding utf8` produced a
  BOM that broke `JSON.parse` on `fixtures/golden/manifest.json`. Separately,
  `[Content_Types].xml` is a wildcard pattern to PowerShell path cmdlets, so a
  `Test-Path`/`Select-String` on it silently reports absence unless `-LiteralPath` is
  used — which already produced one false "missing part" result during M0.
- **Alternatives rejected:** requiring `pwsh` (not installed, and the harness chooses the
  shell); tolerating BOMs (they break every JSON consumer in the toolchain).

## ADR-017 — `canonicalize` must recurse into embedded OOXML parts

- **Date:** 2026-09-22
- **Decision:** the T1 semantic comparison normalizes each XML part *and* recurses into
  OOXML members of `ppt/embeddings/*` (workbooks and any embedded Office file), because
  those carry their own `docProps/core.xml` timestamps.
- **Evidence:** two `svg-to-pptx` runs over the same `svg_output/` compared
  semantically different on exactly one part, `ppt/embeddings/Microsoft_Excel_Sheet401.xlsx`;
  extracting that workbook from both runs and comparing it with the same normalizer gave
  SEMANTICALLY EQUAL (10 parts). Every other part, including `docProps/core.xml` after
  top-level normalization, already matched.
- **Alternatives rejected:** treating embedded binaries as opaque SHA-256 (would leave
  T1 permanently red for any deck with a native chart — a false negative, not a real
  difference); excluding embedded parts from the comparison (would silently ignore a
  part that carries the deck's editable data).

## ADR-018 — M0.D closed with the full closure import; the multi-master fallback stays dormant

- **Date:** 2026-09-22
- **Decision:** the merge bridge's main strategy is layout remap (v2 §3.5) and it has
  been proven end to end with the hardest page available (native chart plus its
  workbook). `--allow-multi-master` is implemented in M4 only as an escape hatch and is
  not part of any default path; the P1 assertion is a hard gate in
  `scripts/opc-invariants.mjs`.
- **Evidence:** `fixtures/golden/merged-chart.pptx` — base slide 3 replaced by the deep
  native-chart page, closure imported (`chart401.xml`→`chart1.xml`,
  `Microsoft_Excel_Sheet401.xlsx`→`…Sheet1.xlsx`, two `[Content_Types].xml` overrides,
  chart and slide rels rewritten), deep layout/master/theme dropped and the slide's
  layout relationship repointed at the base layout. Result: 47 parts, 5 slides, one
  master, one theme, no dangling relationships, no duplicate rIds; PowerPoint COM opened
  it with 5 slides, `Saved=true`, bytes unchanged. Two independent merges of the same
  inputs are semantically equal (47 parts, 0 differences).
- **Alternatives rejected:** shipping the minimal shape-only prototype from the first
  M0 pass (ADR-010) as the gate evidence — it never exercised the closure import, which
  is where the plan localizes the project's highest risk. ADR-010's narrower prototype
  remains in the fixtures as `merged-proto.pptx` for contrast, and ADR-010 is superseded
  by this entry for the M0 gate decision.

## ADR-019 — Two modules beyond the plan's file list; the DSH plugin fields arrive in M7

- **Date:** 2026-09-22
- **Decision:** `src/engine/runner.ts` and `src/logging.ts` exist in addition to the file
  list in plan §2.4, and `package.json` in M1 deliberately omits `main`, `exports` and
  the `dsh` block (including `cordis.patch.yml`) until M7 adds the plugin shell.
- **Evidence:** the runner holds the child-process primitive and the default-deny
  environment whitelist that both `master.ts` and `frontend.ts` need; duplicating it in
  each would put the credential policy in two places. The logger implements v2 §3.12's
  `<deck>/.dsh-ppt/logs/<ts>-<cmd>.log` contract, which is written by both the engine and
  the front end. §3.10 describes the *finished* package, and M7 is the milestone that
  creates `dsh/index.js`; declaring `main`/`exports`/`dsh` in M1 would advertise an entry
  point that does not exist yet.
- **Alternatives rejected:** inlining the runner in `master.ts` (the front end would need
  its own copy of the credential policy); adding a stub `dsh/index.js` now (a placeholder
  that reports "not implemented" is worse than an absent entry point).

## ADR-020 — M1 verification record

- **Date:** 2026-09-22
- **Decision:** M1 is accepted on the following measurements; the next milestone may
  build on them.
- **Evidence:**
  - `pnpm typecheck`, `pnpm lint` and `pnpm test` are clean; 47 unit tests across
    `frontend.test.ts`, `engine/contracts.test.ts`, `engine/venv.test.ts` and
    `engine/master.test.ts`, all driven through injected process and filesystem ports
    (no network, no venv, no PowerPoint).
  - `pnpm build` emits `dist/cli.js` (30 KB, shebang present).
  - `node dist/cli.js doctor` on this machine: Node v24.18.1, uv found via
    `local-packages`, Python 3.13.12, engine venv carrying `ppt_master 0.1.128`, the
    `ppt-master` dispatcher reporting **74** subcommands (the plan's "~70" was an
    estimate; `docs/help/ppt-master-help.txt` has 74 command lines), pptwise 0.35.0,
    PowerPoint COM 16.0, and a one-page self-test render — exit 0.
  - The self-test deck (`%DSH_HOME%/ppt-fusion/doctor/self-test.pptx`, 18117 bytes) opens
    in PowerPoint with exactly 1 slide, `Saved=true`, bytes unchanged.
  - **Amended by ADR-024/ADR-025:** v3 added an eighth check (`png-renderer`) and that row
    is red on this machine because no Python-side rasteriser works here. "Doctor green"
    for M1 therefore means every check green except the row v3 introduced after the fact,
    whose remedy is B7 in M4.
  - The venv was renamed aside and `doctor --repair` rebuilt it from
    `python-assets/requirements.lock`: 212 MB / 18048 files, dispatcher healthy, doctor
    green again. The 500-file difference against the M0 capture is `__pycache__` written
    by the M0 engine runs.
  - `python-assets/requirements.lock` is `uv pip compile --generate-hashes` output over
    `ppt-master==0.1.128`: 2378 lines with transitive pins and hashes.
- **Alternatives rejected:** accepting M1 on the unit tests alone (the point of the phase
  is that the wrapper really drives this machine's upstreams, which only a live doctor
  run shows).

## ADR-021 — Upstream theme contract corrections found by the snapshot gate

- **Date:** 2026-09-22
- **Decision:** `ThemeFonts` models `heading`, `body` and `mono` as **arrays** of family
  names, and a `defaultBackgrounds` entry is `{kind, value?}` for colours plus
  `{kind: "gradient", from, to, direction}` for gradients, with every background field
  contributing palette literals.
- **Evidence:** recording the 24 preset snapshots failed twice on real upstream data.
  First, `style.fonts.mono` is an array of two families and appears in exactly 3 presets
  (journal, memo, terminal); the plan's `fonts{heading[],body[],mono?}` wording suggested
  a bare string. Second, `ledger` and `terminal` carry
  `{kind: "gradient", from: "#151B23", to: "#0C1016", direction: "tb"}` for all four
  background slots, so a `value`-only model rejected them. Across the catalog: 88 colour
  slots and 8 gradient slots.
- **Alternatives rejected:** special-casing the two gradient themes in the audit (the
  palette walker now reads every field of a background, so a future `kind` needs no code
  change); accepting `mono` as `string | string[]` (no preset ships a bare string, and a
  union would let a real upstream contract change pass unnoticed).

## ADR-022 — The 24-theme re-capture is a script gate, not a vitest case

- **Date:** 2026-09-22
- **Decision:** `pnpm test` keeps the structural snapshot checks (catalog size, fixture
  presence, palette self-consistency) plus a one-theme re-capture; the full 24-theme
  re-capture runs as `pnpm themes:verify` and as its own CI step.
- **Evidence:** driving the upstream CLI 24 times through `spawnSync` blocks the vitest
  worker for ~77 s, which trips vitest's own RPC timeout (`Timeout calling
  "onTaskUpdate"`) and fails the run even though every assertion passed.
- **Alternatives rejected:** raising the vitest timeouts (the timeout is in the worker
  RPC, not in the test); making the runner asynchronous just for tests (the whole engine
  layer is deliberately synchronous, and an async variant would exist only to satisfy the
  test harness).

## ADR-023 — M2 verification record

- **Date:** 2026-09-22
- **Decision:** M2 is accepted on the following measurements.
- **Evidence:**
  - `pnpm typecheck`, `pnpm lint`, `pnpm test` clean: **108 tests** in 12 files, of which
    the snapshot file re-captures `brief` and `terminal` from the real upstream.
  - `pnpm themes:verify`: **24/24 theme snapshots match the installed pptwise 0.35.0**
    (the gate first failed on 2 themes, exactly as designed, when `allowedPalette` gained
    gradient stops and the fixtures were re-recorded).
  - `pnpm themes:record` regenerates every fixture, so the snapshot set is reproducible
    rather than hand-maintained.
  - `dsh-ppt init tmp/m2-demo --theme brief` then `validate` → `OK 3 gates: manifest,
    ir, theme`; `theme ensure` on the same deck reports `0 changes` on both the first and
    second run.
  - Five deliberately broken decks are rejected with per-field messages:
    an unknown manifest field, an unregistered `deep.kind`, a page-coverage gap, a deep
    page without `page.svg`, and a stale `tokens.json`. M2 required three of these.
  - `plan --from sources/brief.md` produced a 4-page draft listing 3 fields needing
    confirmation, and `--confirm` copied it into place; `theme list` prints the 24 presets.
  - A real defect was found and fixed while exercising `tokens export`: the preset branch
    spawned the CLI with a temporary directory that had not been created yet, which
    Node reports as `ENOENT` on the *executable*. `spawnFailed` messages now name the
    working directory, and `src/commands/tokens.test.ts` pins the regression.
- **Alternatives rejected:** accepting M2 on unit tests alone (the snapshot gate is the
  row of the acceptance table that actually exercises upstream data, and it caught three
  contract mistakes that mocks never would have).

## ADR-024 — Plan v3 alignment: what was retro-fitted into the finished milestones

- **Date:** 2026-09-22
- **Decision:** v3's compatibility domain is adopted as written, and the parts that
  belong to milestones already closed were retro-fitted rather than deferred:
  - **M0.G** ran as a real experiment with its artifact `docs/compat/probe.md`; the
    decision gate in `docs/m0-decision.md` now lists seven experiments and G's row ends
    in `B7 activated`.
  - **M1** gains `cairosvg` in `python-assets/requirements.lock` (now 2398 lines) and an
    eighth `doctor` check, `png-renderer`, which runs the engine's own probe
    (`python-assets/probe-png-renderer.py`) and fails when no renderer imports *or* when
    one imports but cannot write a PNG.
  - **M4/M8** keep their v3 scope: `bridge/compat.ts` with the scan/transform/stamp/lint
    pass, `--compat safe|standard|max` on `render`, `compat lint`, the LibreOffice
    headless CI leg, and S15–S17.
  - `src/compat/registry.json` exists now, with the entries M0.G could measure, so the
    later milestones extend a real registry instead of inventing one.
- **Evidence:** plan v3 §1.5, §3.4, §3.14, M0.G, S15–S17, R14/R15. The probe's raw
  measurements are in `docs/compat/probe.md`.
- **Alternatives rejected:** deferring G to M4 (its whole purpose is to price the
  rasteriser before the merge bridge is built, and the price turned out to be B7);
  leaving the registry to M4 (then M4 would design it without measurements and S15's
  lint would have nothing to check against).

## ADR-025 — B7 activated: no Python-side PNG rasteriser on this machine

- **Date:** 2026-09-22
- **Decision:** the compatibility pass rasterises SVG with the Node-side `sharp` (B7)
  instead of the engine's `use_compat_mode` PNG path, and `doctor`'s `png-renderer` row
  is red on this machine by design until that lands in M4.
- **Evidence:** `cairosvg 2.9.1` installs from the lock and then fails to import —
  `OSError: no library called "cairo-2" was found`; upstream swallows exactly that error
  and prints "No PNG rendering library installed, cannot use compatibility mode …
  Will use pure SVG mode (may not display in Office LTSC 2021 and similar versions)".
  The upstream fallback fares no better: with `svglib` + `reportlab` the detector says
  `svglib` but conversion fails with `cannot import desired renderPM backend rlPyCairo`;
  adding `rlPyCairo` + `pycairo` makes the detector report **no** renderer, because
  `reportlab`/`cairocffi` resolve libcairo through `ctypes` while pycairo statically
  links its own copy (pycairo itself works and reports cairo 1.18.4). `sharp` is proven
  available on this machine (`pptwise doctor`: `sharp=true`).
- **Also measured, and it bounds the cost:** our native-shape export does not use compat
  mode at all — upstream ignores it in native mode — and a marker census over
  `fixtures/golden/deep.pptx` finds only `p14:dur` on all five slides, with no `asvg`,
  `a14:m` or `mc:AlternateContent`. So B7's customer is M5's SVG-image content
  (formulas, imported icons, template materialisation), not the v1 chart/table path.
- **Alternatives rejected:** installing a GTK/cairo runtime on the user's machine as a
  prerequisite (a heavyweight, machine-specific dependency for a fallback path, and it
  would not help CI); pinning an older `reportlab` with the bundled `_renderPM` extension
  (tested: 4.2.5 still routes through `rlPyCairo`); dropping the requirement and letting
  upstream degrade silently (that is precisely the failure mode v3 §3.4 exists to
  prevent, and `doctor` would be lying).

## ADR-026 — `deep render` is a real command, batch-only, and the engine writes reports inside the project

- **Date:** 2026-09-22
- **Decision:** M3 exposes `dsh-ppt deep render <dir> [--page <n>] [-o <out>]` as the
  deep half of M4's `render` chain, and it implements **batch only**: a single page is a
  batch of one, so there is one code path, one project layout and one quality gate rather
  than two divergent flows. Two engine facts changed the wrappers:
  - the quality report and the export report live **inside the project**
    (`<project>/validation/…`), so the command contracts carry the project prefix; the
    previous workspace-root paths failed the moment the pipeline ran for real;
  - `--out` resolves against the **deck**, not the caller's working directory, because
    the engine is only allowed to write inside the workspace. A relative `-o tmp/x.pptx`
    run from the repository root is therefore a deck-relative path, and a path outside
    the deck is refused instead of silently nested.
- **Evidence:** the batch decision is the measured fixed cost: one page took 12.6 s and
  14.8 s across two runs, while two pages took 14.5 s and 13.6 s — project init, the
  final quality gate and the export setup dominate, and the marginal page costs about
  1–2 s. The report-path correction came from
  `svg-quality-check exited 0 but did not write validation/svg_quality_report.json`
  (the file was at `<project>/validation/…`); the `--out` bug produced
  `tmp/m3-deep/tmp/m3-deep/out/deep-single.pptx` before it was fixed.
- **Also decided here:** the deck commands now run every child through the logging
  runner (`<deck>/.dsh-ppt/logs/<ts>-<command>.log`, plan §3.12), and the `spec_lock.md`
  the gate demands is derived from the deck — canvas from the page format, typography
  anchors from the font sizes the SVG actually uses, colours from `tokens.json`, and the
  primary language from the pages' script (the engine rejects a placeholder).
- **Alternatives rejected:** a `--single` flag with its own project layout (two paths to
  keep in step for no measured benefit); resolving `--out` against the process working
  directory (the engine would then be asked to write outside the workspace, which the
  path whitelist refuses by design).

## ADR-027 — M3 verification record

- **Date:** 2026-09-22
- **Decision:** M3 is accepted on the following measurements.
- **Evidence:**
  - **Single-page deep render:** `dsh-ppt deep render tmp/m3-deep --page 2` produced
    `out/deep-single.pptx` (1 slide, `Postflight status=passed-with-warnings
    quality_gate=passed`), opened by PowerPoint COM with `Saved=true` and unchanged
    bytes, carrying 1 native chart and 1 slideMaster (P1).
  - **Batch deep render:** `dsh-ppt deep render tmp/m3-deep` produced
    `out/deep-batch.pptx` (2 slides, 1 chart + 1 table), same COM and P1 results, and
    the independent reader (`scripts/probe-pptx-reopen.py`) reads 2 slides, 8 shapes,
    1 table, 1 chart.
  - **Pipeline order is enforced and pinned:** the recorded transcripts show
    `project init` → `stamp-native-fallbacks --write` → `svg-quality-check --stage final
    --canonical-authoring` → `svg-to-pptx --quick-generate --native-charts-and-tables
    --with-notes`, and `src/engine/deep-render.test.ts` asserts the same order.
  - **Contract replay:** `fixtures/engine/*.log` holds those four real transcripts;
    `tests/engine-fixtures.test.ts` replays them through the production parsers
    (`parseCreatedProjectDir`, `parsePostflight`) and through the report-path contract.
  - **Error classes:** sixteen cases across `deep-render.test.ts` and `master.test.ts`
    cover the five the milestone names (missing venv, non-zero exit, timeout, missing
    output, contract violation) plus path escape, missing SVG, absent receipt and
    unusable venv.
  - **Full suite:** 144 tests in 16 files green; `typecheck`, `lint`, `build` and
    `themes:verify` (24/24) clean.
  - **DSH terminal:** every command above ran from this session's shell, which is the
    M0.F conclusion applied in practice (pipes work, so the pipeline is an ordinary
    synchronous chain with file artefacts).

## ADR-028 — Merge bridge: content-aware reuse, and three bugs only a real merge found

- **Date:** 2026-09-22
- **Decision:** `bridge/merge.ts` implements plan §3.5 as: replace the base slide in
  place, import the deep page's non-layout closure (charts, workbooks, media, notes),
  remap its layout relationship onto the base layout, and keep exactly one master. A
  part is reused **only when its bytes are identical**; a name match with different
  content is renamed and imported. `--allow-multi-master` remains the escape hatch and
  registers imported masters in `presentation.xml.rels` and `p:sldMasterIdLst`.
- **Evidence:** three defects surfaced from running the merge on real fixtures rather than
  on hand-built ones:
  1. the closure walk treated the deep slide itself as "already in base" because both decks
     name slides `slide1.xml`, so a page's chart and workbook were never imported and the
     slide pointed at parts that did not exist;
  2. imported parts' relationships were rewritten only under `--allow-multi-master`, so a
     plain merge left the chart pointing at its old workbook name;
  3. reuse keyed on the *name* first, which silently replaced a deep page's chart with the
     base deck's when the two shared a name — data loss that stayed invisible because
     ppt-master names its parts `chart101.xml` while pptwise has no charts at all.
  The audit also had to learn that `_rels/.rels` belongs to the package root, not to a
  `_rels` directory.
- **Verification:** the merged deck passes `scripts/opc-invariants.mjs` (47 parts, 5
  slides, one master, no dangling relationships), the independent reader (5 slides, 1
  chart, 1 table) and PowerPoint COM (`Saved=true`, bytes unchanged). `src/bridge/
  {opc,merge}.test.ts` pin the four OPC cases the milestone names (missing part, `..`
  normalization, External targets, duplicate rId) plus the merge rules, and the merge
  output itself is byte-stable for identical inputs, which is tier T2.
- **Alternatives rejected:** trusting the name match (bug 3); rewriting only the slide's
  relationships and hoping imported parts needed none (bug 1/2); always renumbering
  imported parts (throws away upstream naming for no benefit, and `freePartName` now keeps
  a free name as-is).

## ADR-029 — M4 progress: the merge core and render chain are done, the rest is listed

- **Date:** 2026-09-22
- **Decision:** M4 is being landed in two parts. **Landed here:** `bridge/opc.ts`,
  `bridge/merge.ts`, the `render` chain (`renderDeck`: pptwise `--draft` → deep render →
  merge → structural gates → delivery check → atomic publish with `out/manifest.json`),
  failure injection behaviour, and the bridge test suites. **Still open in M4:**
  1. the animation/transition application-point spike (v3 M4.3, ≤2 pd, "must not slip to
     M5") — `render` currently refuses a manifest whose `post.animations` is set rather
     than publishing a deck that ignores the request;
  2. `bridge/compat.ts` v1 (scan/transform/stamp/lint) with `--compat safe|standard|max`
     and the compat-report hash in `out/manifest.json` (v3 M4.9–11);
  3. golden v1 (`fixtures/hello/` five pages including one with animation, plus
     `golden-manifest.json`) and the semantic-determinism canonicaliser of §7.2;
  4. merge discipline tests for `mc:AlternateContent` migration and `p14:creationId`
     de-duplication (v3 M4.10) — both need the animation pass to exist first.
- **Evidence for what landed:** `dsh-ppt render tmp/m3-deep` published a 3-slide deck
  (1 standard page + 2 deep pages: native chart and native table) whose audit is clean,
  which PowerPoint opens with `Saved=true` and one master, and which the independent
  reader reads as 3 slides / 1 chart / 1 table. Breaking a deep page makes the same
  command exit 1 with **no** `out/` file and three staged diagnostics under
  `.dsh-ppt/render/`. Two renders of the same deck differ bytewise (the engines stamp
  their own times), which is why T3 is not a gate; the merge step alone is stable.
- **Alternatives rejected:** publishing without the compat pass while accepting `--compat`
  flags (the flag would lie); leaving `post.animations` silently unapplied (a deck that
  promises animation and delivers none is worse than a refusal).

## ADR-030 — V4 sync: plan, architecture, README, docs index

- **Date:** 2026-09-22
- **Decision:** The external plan `C:\Users\dell\Desktop\PPT-FUSION-PLAN.md` is advanced
  to **v4** and made consistent with ADR-001…029: EPERM premise refuted (ADR-004), uv-only
  venv (ADR-003/006), ThemeFile v2 `style.*` and gradient/font-array shapes (ADR-012/021),
  wheel pin 15,400,327 bytes / 74 subcommands (ADR-005/020), seven deep authoring rules and
  the four-step gated export (ADR-007/008), full-closure M0.D and P1 verification
  (ADR-010/018), B7 with Node `sharp` (ADR-025), and the M4 part-1/part-2 split with the
  remaining-items list (ADR-028/029). `docs/architecture.md` is updated to reference plan v4,
  mark the landed merge layer, and name the post/compat layers as M4 part 2. A repository
  `README.md` now carries the architecture diagram, layer ownership, invariants, command
  surface and doc index. This file gains the ADR index above.
- **Evidence:** repo state at commit `616345e` (M4 part 1); plan v4 verification shows all
  ADR-driven corrections present; README matches the committed `src/` tree and `docs/cli.md`.
- **Alternatives rejected:** rewriting history in earlier ADRs (entries stay as written;
  the index and v4 plan carry the consolidated view); deleting `docs/m0-*`/`docs/compat/*`
  into one file (the probes and decision matrices remain the raw evidence the summaries
  point to).

## ADR-031 — ADR-029 remaining list made explicit: M4.9 / M4.10 / M4.11 are separate items

- **Date:** 2026-09-22
- **Decision:** ADR-029's phrase "v3 M4.9–11" is unpacked into three separately
  verifiable remaining items in M4 part 2, and the plan v4 §4.5 / §5 M4 task list mirror
  them exactly:
  1. **M4.9** — `bridge/compat.ts` v1 (scan/transform/stamp/lint) + `--compat
     safe|standard|max` on `render` + `compat lint`; stamp implements the Node `sharp`
     path only (B7), no cairosvg code.
  2. **M4.10** — merge discipline tests: `mc:AlternateContent` pair migration and
     `p14:creationId` de-duplication (needs the animation pass to exist first).
  3. **M4.11** — compat goldens for all three levels: `safe`/`standard`/`max` each
     render hello, with compat-report snapshots; asserts SVG-backed images carry PNG
     fallbacks and `--compat safe` output contains no morph or above-level chart types.
  These three stay separate acceptance rows in M4; item 11 is not folded into item 9.
- **Evidence:** plan v4 §5 M4 tasks 9/10/11 (all `- [ ]`, the only remaining compat
  work) and §4.5 M4 row ②③④⑤.
- **Alternatives rejected:** treating the three-tier golden as an implementation detail
  of the compat pass (then a pass that lints but never renders would look complete);
  rewriting ADR-029 in place (the entry stands as the part-1 landing record, this entry
  refines its open list).

## ADR-032 — Animation application point: one post-merge pass, and it works

- **Date:** 2026-09-22
- **Decision:** a deck's motion has a **single owner**: `bridge/post.ts`, applied after the
  merge and before the structural gates. `render` reads `post/animations.json` (the path in
  the manifest), strips whatever `p:transition`/`p:timing` the engines wrote, and writes the
  configured transitions and entrances itself. Targets resolve by **shape name** — deep
  pages carry their SVG group id (`milestone-chart`), standard pages carry pptwise's
  `blk<slide>-<block>` markers when the IR sets `meta.animation.elements = "auto"` — with
  explicit `spids` as the escape hatch. `post animate` as a standalone command stays in M5
  (§3.9), and narration-after-animation stays forbidden (M5 wires the check).
- **Evidence:** the XML is ported from pptwise's own byte-verified writer (`transitionXml`,
  the `set`+`animEffect` pair, the `tmRoot → mainSeq → click par → effect par` nesting,
  and its `dedupeShapeIds` guard for the duplicate `p:cNvPr id` values it hit in the wild).
  PowerPoint itself confirms the result: opening the rendered deck reports
  `MainSequence.Count = 1` with `EffectType = 10` (`msoAnimEffectFade`) on the fade slide and
  `EffectType = 12` (`msoAnimEffectWipe`) on the wipe slide, `EntryEffect = 3849`
  (`ppEffectFade`) / `2819` (`ppEffectWipeRight`) for the transitions, and `Saved = msoTrue`
  (no repair). The pass is **byte-idempotent** — re-applying over its own output produces an
  identical package — and the package audit stays clean. v4 §3.6's fallback (letting pptwise
  own the standard pages' motion per page) is therefore **not needed**.
- **Scope note for M6:** a standard page can only be targeted by name when its IR declares
  `meta.animation.elements = "auto"`; otherwise the author must either rely on the default
  deck-level transition or address shapes by explicit `spids`. The SKILL must state this,
  because a name selector that matches nothing is a hard failure (`ContractViolation`), not a
  silent no-op.
- **Alternatives rejected:** two owners (engines writing what they like, post filling gaps) —
  a mixed deck would need both timelines reconcilable and neither side knows about the other;
  making `post animate` the only entry point and leaving `render` unanimated — the plan's
  data flow (§2.3 step d) applies motion inside the render chain; silently ignoring a
  selector that matches nothing — that is how a deck ships with the motion its author
  declared missing.
## ADR-033 — Golden v1: the T1 canonicaliser and the `fixtures:verify` gate

- **Date:** 2026-09-22
- **Decision:** M4 part 2 item ⑤ lands as three pieces: `tests/support/canonicalize.ts`
  (the T1 comparison §7.2 asks for), the five-page `fixtures/hello` golden input, and the
  `pnpm fixtures:record` / `pnpm fixtures:verify` pair over
  `fixtures/golden/golden-manifest.json`. `fixtures:verify` renders the fixture in a
  scratch workspace and enforces canonical equality for `base`, `deep` and `merged`;
  byte equality is reported for orientation and required only of `base`, which M0 measured
  to be byte-stable (ADR-014). The current record is `fixtureVersion: 1`.
- **Canonical form.** Per part: XML under `*.xml`/`*.rels` is normalised by deleting
  `dcterms:created`/`modified`, `cp:revision`, `cp:lastModifiedBy`, `TotalTime`,
  `Application` and `AppVersion`, and by collapsing inter-tag whitespace; nested OOXML
  (`.xlsx/.docx/.pptx/.xlsm/.docm`, default depth 1) is canonicalised recursively as
  ADR-017 requires; every other part is reduced to its SHA-256; the part list is a
  name-keyed map, so zip entry order carries no meaning and the comparison reports the
  differing part names. This is the **T1 hard gate**, and `fixtures:verify` runs it in CI
  next to `themes:verify`.
- **Deviation from §7.2's sketch.** The plan also sketches attribute ordering,
  namespace-prefix normalisation, a rebuilt semantic tree, and special `p:sldId`
  order-semantics handling. None of those are implemented, because none is needed by the
  measured differences (ADR-014/017): text-level normalisation already makes two
  independent deep renders equal (39 parts) while their bytes differ, and `p:sldIdLst`
  order is compared exactly where it is meaningful — inside `ppt/presentation.xml` — while
  part enumeration order is already insignificant in the name-keyed map. Attribute order
  and prefix spelling are equal only because both engines emit them deterministically;
  that is sufficient for T1 as defined (our own renders of one input), but the plan's
  stronger wording is recorded as **not** implemented. A blanket attribute sort would also
  risk hiding a real edit such as a changed attribute value, so it is not wanted as-is.
- **Fixture shape.** `fixtures/hello` holds authored inputs only: `deck.ir.json` (5 pages —
  cover, points, deep chart, deep table, ending, with `meta.animation.elements = "auto"`),
  `deck.fusion.json`, `deep/p03-native-chart/page.svg`,
  `deep/p04-native-table/page.svg`, and `post/animations.json` (slide 3 fade entrance,
  slide 4 wipe entrance). `theme.json`, `tokens.json` and `master-design.json` are derived,
  so `prepareWorkspace` copies the fixture to `tmp/golden-work/hello` and runs
  `theme ensure` there: the gate exercises the theme bridge and the fixture commits no
  generated file (the three names are gitignored).
- **Record runbook.** §7.3's shape: `fixtureVersion`,
  `upstream.{pptwise,ppt-master}` taken from `PINNED`, `baseRef`/`deepRef`/`mergedRef`
  each carrying `file`, `sha256`, `canonical`, `bytes`, plus `generatedBy`, `command`
  and `createdAt`. `fixtures:record` copies the three artifacts staged by one `render`
  (`<deck>/.dsh-ppt/render/{base,deep,merged}.pptx`) into `fixtures/golden/` and rewrites
  the manifest; binaries are never hand-edited, and a semantic change re-records with a
  raised `fixtureVersion` in the same commit.
- **Evidence.** `pnpm fixtures:record` wrote fixtureVersion 1 (base 29206 B
  `423624c1…`, deep 21153 B, merged 36251 B `f5455d54…`); `pnpm fixtures:verify` reported
  canonical equal for all three, base bytes identical, deep/merged bytes differing only as
  expected. It was re-verified after normalising the tracked fixture text to LF (the
  `.gitattributes` rule): the deep/merged byte counts move by 1–4 bytes while canonical
  equality still holds — the T1/T3 distinction the plan draws, measured. The canonicaliser itself was first proven on two real `svg-to-pptx` runs of the
  same project: `semantically equal (39 parts)` while the byte hashes differed — exactly
  what ADR-014/017 predicted. M4's acceptance evidence was re-read from the recorded
  merged deck: 47 parts, 5 slides, 1 master, 1 chart + 1 embedding, PowerPoint COM opens it
  with `saved:true unchanged:true`, and the animation probe reads the slide-3 fade and
  slide-4 wipe that `post/animations.json` asked for.
- **Naming.** M0's fixture manifest moved from `fixtures/golden/manifest.json` to
  `fixtures/golden/m0-fixtures.json` so that §7.3's name belongs to the golden manifest;
  the M0 evidence itself is unchanged and ADR-016's sentence carries the pointer.
- **Alternatives rejected:** byte comparison as T1 (the engines stamp their own times, so
  the gate would be permanently red for no meaning — ADR-014); implementing the whole §7.2
  sketch up front (no measured difference demands it, and blanket normalisation can hide
  real edits); committing `theme.json`/`tokens.json` beside the fixture (they would freeze
  theme drift and let the gate pass without exercising `theme ensure`); recording only
  after the compat pass lands (that would leave M4's end-to-end determinism gate unproven
  while the riskiest remaining work proceeds — the golden is re-recorded then, §7.3).
- **Remaining in M4 part 2:** ② `bridge/compat.ts` v1 + `--compat safe|standard|max` +
  `compat lint` (B7: Node `sharp` only); ③ merge compatibility discipline tests
  (`mc:AlternateContent` pair migration, `p14:creationId` de-duplication, plain zip / no
  duplicate entries); ④ compat goldens for the three levels; ⑥ the §3.8 unified
  `dsh-ppt audit` gate; and ⑤b — re-record the golden once the compat output settles.

## ADR-034 — The compat pass: what v1 implements, what it refuses, and where it sits

- **Date:** 2026-09-22
- **Decision:** `bridge/compat.ts` implements plan 3.14 four steps (scan, transform, stamp,
  lint) for the markers `src/compat/registry.json` lists, and `render` runs it after the post
  pass and before the structural gates. `render --compat safe|standard|max` overrides the
  manifest `compat` field, which overrides `standard`; `compat lint <file>` re-runs the
  read-only half on any artifact; `out/compat-report.json` carries the occurrences, applied
  changes and findings, and its sha256, the level, the level source, the registry version and
  the counts enter `out/manifest.json`.
- **Implemented transforms (only the registered ones).** (a) An over-level or
  un-fallbacked morph/advanced transition becomes its registered `fade`: the
  `mc:AlternateContent` block is unwrapped to its `mc:Fallback` when one exists, otherwise the
  `p159:morph` attribute or the bare `p14:` child element is replaced with `p:fade`.
  (b) An `asvg:svgBlip` without a raster sibling is stamped: `sharp` rasterises the
  referenced SVG, the PNG part, its content type and its relationship are added, and the
  `a:blip` `r:embed` is pointed at the PNG, so Office 2013+ shows the raster while 2016+ still
  sees the SVG extension (B7; the Python-side renderers stay unusable per ADR-025).
- **Refused, not guessed.** A downgrade the registry names but this build cannot build is an
  error, never a silent no-op: `bar-chart` for the 2016/2019 chart tiers (the registry note
  says it is a pre-export payload edit, not an XML rewrite) and `drop-narration` for a
  non-mp3 media container (deleting narration is content loss). A missing fallback for
  `formula-a14m` (`linear-text`) or `animation-bounce-extension` (fade over a timing tree this
  pass did not build) is likewise an error. None of those paths is reachable from the current
  fixture set, so their acceptance rows land with the content that produces them (M5/M8);
  refusing keeps the no-implicit-edits rule true until then.
- **Lint rules.** `mc:AlternateContent` must carry at least one `mc:Choice` and exactly one
  non-empty `mc:Fallback`; each `Requires` prefix must be declared in its part and registered;
  any other version-sensitive prefix (`p14`, `p15`, `p159`, `a14`, `a15`, `asvg`, `adec`) must
  also be declared where it is used; a package without `ppt/presentation.xml` is rejected; and
  every registry feature must have a scanner, so a registry edit cannot silently stop being
  enforced. Duplicate `p14:creationId` values are an error (the merge-side rule is item 3),
  while a CJK run without an `a:ea` slot is a warning that `--strict` promotes.
- **Evidence.** `fixtures/golden/hello-merged.pptx` scans as five `p14:dur` occurrences with
  zero findings at `safe`, `standard` and `max`, and the pass applies nothing, so the golden T1
  comparison is unchanged (`pnpm fixtures:verify`: canonical equal for base/deep/merged).
  `render --compat safe` on the scratch golden deck published a deck whose `out/manifest.json`
  records `level: "safe", levelSource: "flag"`, with `out/compat-report.json` written and
  hashed. The synthetic transform and stamp paths are covered by 23 unit tests, including a
  real `sharp` rasterisation (PNG signature verified), the injected-rasteriser seam, the
  unwrapped-morph downgrade and a missing-SVG refusal.
- **Alternatives rejected:** implementing every registry downgrade up front (the two content
  rewrites need M5/M8 material and would be untestable here); letting an unimplemented
  downgrade pass as a warning (the deck would ship with markers its target Office cannot
  render); running the pass before post (its stripper rewrites transitions, so the pass would
  judge the wrong package); writing the pre-compat package to the staged `merged.pptx` (the
  staged artifact must be the published bytes); leaving `sharp` a transitive dependency (a user
  install could lose the binary the stamp needs).

## ADR-035 — The unified audit gate: eight sources, an honest skip list, and a warning-only ΔE

- **Date:** 2026-09-22
- **Decision:** `dsh-ppt audit <dir> [--json] [--strict] [--pixels] [--file <pptx>]
  [--compat <level>]` implements plan §3.8 as one command: the `validate` pass, pptwise IR
  validation, pptwise geometry audit, the deep SVGs quality gate, the package OPC/P1 audit, the
  engine delivery gate, the compat lint and the optional pixel comparison. `--strict` makes
  warnings fail as well as errors; `--json` prints the whole report.
- **Artifact rules.** `--file`, else `out/manifest.json` `file`, else the single pptx under
  `out/`. A missing artifact is an `artifact-missing` error, and the three sources that need
  it are named in `skipped`. A delivery gate that passes without a package would be worthless,
  so this is deliberately not a skip.
- **Source mapping.** pptwise findings map `severity: error` to errors and everything else to
  warnings, with `page ?? slide` and `code` preserved as the rule id. The SVG quality report
  maps `blocking` to errors and `introduced`/`inherited`/`source-import` to warnings. Engine
  calls that throw become errors with their stable failure code in the message.
- **`--pixels` is the source-colour ΔE check, warning only.** `sharp` rasterises each deep SVG
  (longest side 256 px), colours below 1 % of the opaque pixels are dropped, and every survivor
  is compared with the palette in CIELAB (CIE76). Above ΔE 10 the page gets a
  `palette-delta-e` warning. It is opt-in because anti-aliasing and gradients invent colours,
  and warning-only because it samples the authored SVG, not the rendered slide. Measured
  anchors: ΔE black/white ≈ 100, `#FF0000`/`#EE0000` = 6.4.
- **Why source colours and not the merged package.** Rasterising the merged DrawingML package
  needs a renderer this machine does not have (no LibreOffice, no PDF path; Office COM export
  is Windows-only and slow). M8 owns the renderer-based ΔE matrix over the merged package; this
  row covers the authored deep pages today and is recorded as the narrower check.
- **`prompt-audit` stays skipped.** The engine command registry does not carry `prompt-audit`
  and the SKILL it would budget does not exist before M6; an unregistered engine command is not
  callable (§3.9), so the gate names the skip instead of inventing a budget.
- **Evidence.** On the rendered golden deck the non-strict gate is green: 11 sources, 0 errors,
  5 warnings (all `svg-quality-introduced` advisories from the two fixture SVGs),
  `artifact=out/hello.pptx`, `compat=standard`. `--strict` is red on exactly those advisories,
  which the upstream gate itself calls non-blocking; the fixture keeps the explicit authoring
  form plan §3.4 allows. Where M8 puts the strict CI line (compact the fixture with the upstream
  legacy migration script, or scope strictness) is left to that milestone with this evidence.
- **Alternatives rejected:** parsing the engine quality verdict from stdout instead of the
  recorded report (ADR-009); treating a missing artifact as a skip (the gate would pass on an
  unrendered deck); promoting the advisory quality categories to errors (the engine maps them
  as non-blocking, and the plan maps the gate, not its advisories, to errors); rasterising the
  merged package for ΔE (no renderer here; COM would make the gate Windows-only and slow).

## ADR-036 — Merge compatibility discipline: creationId renumbering, MCE migration, zip shape

- **Date:** 2026-09-22
- **Decision:** `mergeDeep` renumbers duplicate `p14:creationId` values in every merged
  slide (`renumberDuplicateCreationIds`, exported) and reports the count as
  `MergeReport.renumberedCreationIds`; `auditPackage` additionally rejects a package that
  declares no content types at all. The MCE and zip rules need no new code: they are
  properties of the merge and are pinned by tests.
- **Renumbering rule.** The first occurrence of an id keeps it; later duplicates move above
  the slide current highest id, in document order. It runs on every merged slide, replaced or
  kept, so the result is deterministic and idempotent. Measured on a synthetic pair where the
  deep slide carried [5, 5] and a kept base slide [3, 3, 9]: the merged slides read [5, 6] and
  [3, 10, 9], with `renumberedCreationIds = 2`.
- **Why per slide.** `p14:creationId` identifies animation nodes inside one slide, and
  upstream `template_validation.py` rejects duplicates there (plan §1.5). Real decks reuse
  ids across slides, so a package-wide rule would rewrite valid files.
- **MCE migration.** A slide-level replacement copies the deep page XML verbatim, so an
  `mc:AlternateContent` pair cannot be split. The test pins the stronger claim: the block, its
  `Requires` prefix and its fallback survive the merge, and the image relationship the block
  wraps is imported and rewritten with it. The published package is re-checked by the compat
  lint (ADR-034), which fails on any block without a fallback.
- **Zip discipline.** The writer keys parts by name in a Map, so duplicate entries and
  encrypted streams are impossible by construction; `tests/merge-discipline.test.ts` proves it
  on the recorded `fixtures/golden/hello-merged.pptx`: unique entry names, file entries exactly
  equal to `OpcPackage.names()`, no encrypted entry, one `[Content_Types].xml`. Directory
  entries are legal — JSZip creates them for shared folders and OPC readers ignore them — so
  the check asserts they are folder paths rather than rejecting them.
- **Evidence.** Five new tests (two in `merge.test.ts`, three in
  `tests/merge-discipline.test.ts`); the recorded golden deck passes the package audit with
  the single-master invariant, and its five slides repeat no id.
- **Alternatives rejected:** renumbering package-wide (breaks legitimate cross-slide reuse);
  renumbering into a dense sequence from 1 (collides with ids in other slides and with the
  next engine export); refusing the merge on duplicates (plan §1.5 says the bridge inherits
  upstream rule by fixing the ids); forbidding directory entries (contrary to what JSZip and
  PowerPoint write).

## ADR-037 — Compat goldens for all three levels, and the fixtureVersion 2 re-record

- **Date:** 2026-09-22
- **Decision:** `fixtures/golden/compat-levels.json` records one stable snapshot per level
  (`counts`, `occurrences`, `applied`, `findings`; no timestamp) at the same fixtureVersion as
  `golden-manifest.json`. `pnpm fixtures:record` writes it from the freshly rendered merged
  package; `pnpm fixtures:verify` recomputes the pass over that package at each level, compares
  the snapshot, and asserts the level promises: no `p159:morph` at `safe`/`standard`, no 2016+
  chart element at `safe`, no 2019+ chart element below `max`, and no lint finding at any level
  (MCE pairs complete, every `asvg:svgBlip` carrying its raster sibling).
- **Why the pass and not three more renders.** The level is applied after the merge, so running
  it over the recorded merged package covers M4.11 without three extra deep renders (minutes of
  CI per verify). The render plumbing itself is unit-tested (`resolveCompatLevel`) and was
  exercised end-to-end at `safe` in ADR-034 evidence, where `out/manifest.json` recorded
  `level: "safe", levelSource: "flag"`.
- **The re-record (item ⑤b) is fixtureVersion 1 → 2.** The p03 deep page now declares
  `lang="en"` because the quality gate asks the first page for a deck language; the advisory
  count drops from five to four. The exported packages are canonically unchanged: the recorded
  deep digest `ef8d92de…` and merged digest `4a09d5c9…` are identical to fixtureVersion 1, and
  only the engine timestamp bytes moved. `fixtures:verify` reports canonical equality for all
  three artifacts plus all three compat snapshots equal, and PowerPoint COM opens the new
  merged golden with five slides. A version bump with no semantic change is exactly the T1/T2
  behaviour plan §7.2 asks for.
- **The remaining four warnings, and the strict line.** They are the upstream `introduced`
  style advisories on the two deep pages ("noncanonical compact authoring"). The upstream gate
  itself calls them advisory and explicitly allows the explicit form, so `--strict` is red by
  design for this fixture; the non-strict gate is green with 11 sources. M8 decides between
  compacting the fixture with upstream legacy migration script (which hoists inheritable
  attributes and would change how `deriveSpecLock` reads typography) and scoping the strict CI
  surface. The audit names the warnings instead of hiding them (ADR-035).
- **Evidence.** `pnpm fixtures:record` wrote fixtureVersion 2: base 29206 B (byte-identical to
  v1), deep 21153 B, merged 36251 B, plus the three level snapshots. `pnpm fixtures:verify`
  green; `tests/compat-levels.test.ts` (3 tests) pins the recorded snapshots and the level
  assertions; `tests/merge-discipline.test.ts` pins the package shape; COM smoke `[OK] … 5
  slides`; the suite is 225 tests.
- **Alternatives rejected:** three full renders in the verify script (redundant cost for a
  post-merge pass); snapshotting the reports without the level assertions (a snapshot of a
  pass that silently stopped enforcing a level would still compare equal); dropping the
  advisories from the audit (they are real upstream signals, and `skipped`/warnings are how
  this repo keeps gaps visible); compacting the fixture now (an upstream legacy migration whose
  hoisting changes our spec-lock derivation — an M8 decision with this evidence).

## ADR-038 — M5 opens with the native round trip, template routing and brand extraction

- **Date:** 2026-09-22
- **Decision:** three new engine contracts and three commands land first, because they are
  the offline-provable half of M5 and the rest of the milestone builds on them:
  `deep native roundtrip` (`pptx-to-svg --roundtrip --inheritance-mode both`),
  `deep template create|apply|register` (`pptx-template-import` →
  `mirror-template-materialize` → `apply-template` / `register-template`), and
  `brand extract` (pptwise `brand extract`, plus `--bind` = write the theme into the deck,
  repoint `deck.fusion.json`, run `theme ensure`).
- **Round trip.** The engine help states that `--roundtrip` requires `--inheritance-mode
  both`; the argv builder refuses the mismatch before spawning, and publishes
  `authoring-svg-flat/` as the editable source. Measured on `fixtures/golden/hello-merged.pptx`:
  five slide SVGs plus `analysis/native_structure.json` and `sources/source.pptx`. The
  workspace is what `apply-template` accepts directly as an exact root.
- **Template routing is two different workspaces, and the distinction is the engine rule.**
  `mirror-template-materialize` publishes only from a `pptx-template-import` reference
  workspace (`svg/` + `inheritance.json`), while an SVG round-trip workspace is consumed as
  an exact root by `apply-template`. The first attempt wired materialisation to the round-trip
  output and the engine rejected it (`Cannot read inheritance graph: …/svg/inheritance.json`);
  the fix was `pptx-template-import` as its own contract, with the round-trip workspace kept
  for editing and direct application. Measured: create from `hello-base.pptx` wrote five
  template SVGs, five text-slot files, `source_themes.json`, `native_payloads.json.gz` and a
  Design Spec TODO; `deep template apply --dry-run` then planned 14 files into a deep project
  and the real run installed them and wrote `template_install.json`.
- **Known engine limitation, recorded rather than worked around.** Materialising a template
  from an *animated* import fails inside the engine with `animation-not-reconstructed: 2`
  (the merged golden deck carries two post-pass timelines the importer cannot map back to SVG
  groups). Non-animated sources work. The fusion does not paper over it with
  `--skip-validation`; the SKILL (M6) must tell the model to build templates from the
  pre-animation deck and to keep animated decks on the round-trip/edit path.
- **Brand extraction linkage.** Measured end to end on this machine (no network needed):
  `brand extract out/base.pptx --dir <deck> --bind .` wrote `brand.theme.json` (theme id
  `brand`, extracted by pptwise from the recorded golden base deck), repointed the manifest to
  `{file: "brand.theme.json"}` and derived `tokens.json` with `themeId: brand` and
  `source.kind: file`.
- **Path rule.** Every new command resolves its arguments against the deck workspace, not the
  process directory, and refuses escapes (`PathOutsideWorkspace`); this caught two
  implementation bugs during the first real runs (`fs.exists` on a workspace-relative path, and
  a doubled path when `--bind` pointed at the workspace root).
- **Evidence.** Thirteen new tests: four engine-contract cases (round-trip pairing, import
  flags, apply roots, register flags), three round-trip, four template, three brand; plus the
  real runs above. `tests/support/fake-venv.ts` installs the venv files the engine manager
  checks, so command tests reach the spawn without a real engine.
- **Alternatives rejected:** wiring mirror materialisation to the round-trip output (the engine
  rejects it); exposing `--skip-validation` to push the animated template through (hides a real
  engine refusal the SKILL must know about); letting `--bind` resolve against the process
  directory (inconsistent with every other deck command and untestable); treating
  `register-template` as backlog (a template that is never registered cannot be reused, and the
  contract is already recorded).

## ADR-039 — The source pipeline: five routes, a fail-closed URL policy, and a size cap

- **Date:** 2026-09-22
- **Decision:** `dsh-ppt source <input...> -o <dir>` converts the five plan routes
  (pdf/docx/xlsx/pptx/web, plus Markdown and plain text) through the engine unified
  `source-to-md` dispatcher, one call per input so each output name and receipt is
  deterministic. `src/policy/url-policy.ts` gates every URL before a process starts.
- **URL policy.** http(s) only, no credentials, port 80/443, at most 2048 characters, local
  names refused before DNS, and **every** resolved address must be public: loopback, private,
  link-local, CGNAT, multicast, reserved and unspecified IPv4 ranges, unique-local and
  link-local IPv6, and IPv4-mapped forms of any blocked address. DNS failure fails closed, and
  the fusion never passes `--allow-private-hosts`. The resolver is injectable, so the rules are
  unit-tested without network.
- **Size and MIME.** The written Markdown must be non-empty and at most 5 MiB; a larger
  document is a `ContractViolation`. Byte-size and MIME limits on the *fetched* response stay
  the engine responsibility, because the fusion never sees that response: `web-to-md` writes
  Markdown and keeps remote images as links by default. Inventing a second fetcher to measure
  MIME would duplicate the engine and add its own SSRF surface.
- **Evidence.** Generated inputs (openpyxl workbook, PyMuPDF page, a hand-built DOCX, the
  recorded `hello-base.pptx`, a text file) converted for real: `pdf 54 B`, `excel 360 B`,
  `doc 78 B`, `pptx 488 B` (5 slides), `text 69 B`, plus one
  `<stem>.conversion_profile.json` per route, all recorded in `sources/source-manifest.json`.
  The web route is network-blocked on this machine: `example.com` passed the policy (public
  DNS answer) and then failed inside the engine with curl error 28 — the honest offline
  outcome. `localhost`, `10.0.0.5`, `::1` and mixed public/private DNS answers are refused by
  the guard before the engine is reached, and the web golden stays blocked until network access
  exists (a proxy would have to be configured outside the repository).
- **Alternatives rejected:** letting the engine own URL policy (the fusion cannot then name the
  refusal, and `--allow-private-hosts` would be one typo away); rejecting hostnames that
  resolve to any private address only when the *first* answer is private (a split-horizon answer
  would slip through); a bespoke downloader for MIME/size (duplicate fetch path, new SSRF
  surface); treating a DNS failure as "allow" (fail-open).

## ADR-040 — Image search records provenance, and refuses an unattributed image

- **Date:** 2026-09-22
- **Decision:** `dsh-ppt images search` wraps `image-search` with the fusion defaults
  (`assets/` plus `assets/image_sources.json`), requires a filename (deriving one from the
  query or the URL extension, because the engine demands one in single-query mode), validates
  every manifest item before reporting success, and routes `--from-url` through the same
  public-http policy as `source` (ADR-039).
- **Attribution rule.** Each item must carry `filename`, `provider` and `license_name`, and
  `attribution_text` whenever `attribution_required` is true; otherwise the command fails with
  a `ContractViolation` naming the item and the missing fields. The engine manifest keeps its
  own schema (`items[]` with author, licence, licence URL, source page, download URL, search
  query, slide, purpose, measured dimensions); the fusion does not rewrite it, so upstream
  provenance stays intact.
- **Evidence.** The command path is measured end to end: a real `images search mountain
  --provider openverse` reaches the provider and fails with the engine timeout against
  `api.openverse.org` (this machine has no outbound network), while `--from-url
  http://127.0.0.1/x.jpg` is refused by the policy before any process starts
  (`UsageError source URL host 127.0.0.1 is not a public address`). Six unit tests cover the
  happy path, the passthrough flags, the missing-licence and missing-attribution refusals, the
  strict-mode re-check, the URL policy and a missing/unreadable manifest; a recorded golden
  download stays blocked until network access exists.
- **Alternatives rejected:** letting the engine own the attribution rule (it writes
  `attribution_required` but does not fail a run whose text is missing); rewriting the engine
  manifest into a fusion schema (loses upstream fields and breaks the engine append-only
  contract); requiring the caller to always name `--filename` (the engine error is cryptic and
  the query already implies a name); skipping the URL policy for `--from-url` (the same SSRF
  surface as `source`).

## ADR-041 — T2 was only true inside a two-second window: JSZip folder entries carried the clock

- **Date:** 2026-09-22
- **Decision:** `OpcPackage.write` pins the date of **every** zip entry to the fixed
  `1980-01-01T00:00:00Z` it already used for part entries, instead of only passing that date to
  `zip.file()`. Regression tests assert that all entries carry the fixed date and that two writes
  separated by a 2.1-second sleep are byte-identical.
- **What was wrong.** JSZip creates a folder entry for every path segment (`ppt/`,
  `ppt/slides/`, …) and dates it with the wall clock. `write()` created a fresh JSZip per call
  and only the part entries received the fixed date, so a package written twice inside the same
  DOS-time bucket was identical and a write across a bucket boundary was not. DOS time has a
  two-second resolution, which is why `mergeDeep > is byte-stable` and `applyPost > is idempotent`
  passed most runs and failed roughly one in four.
- **How it surfaced.** The M5 unit-test runs showed the two byte-stability tests failing
  intermittently; a 200-write stress loop on one package reproduced it deterministically
  (hashes changed at writes 22/79/178 and stayed changed until the next boundary). The fix makes
  that loop produce exactly one hash across 60 writes separated by a 2.5-second pause.
- **Scope of the old claim.** The T2 claim covered our own writer with fixed input, so the bug
  was real but narrow: T1 (canonical) never saw it because canonicalisation ignores zip metadata,
  and T3 was never claimed. The recorded `fixtures/golden/hello-merged.pptx` was written by the
  buggy writer, so its folder entries carry a record-time date; canonical equality is unaffected
  and the M5.6 re-record picks up the fixed writer. No golden bump is needed for the fix alone.
- **Alternatives rejected:** post-processing the zip to rewrite folder timestamps (a second pass
  over the archive for a one-line fix); dropping folder entries entirely with
  `createFolders: false` (legal OPC, but Office writes them and the recorded artifacts already
  have them, so keeping the shape is the smaller change); accepting the flake (a determinism gate
  that fails one run in four trains people to ignore it).

## ADR-042 — Motion breadth and narration: what PowerPoint actually accepted, and the two TTS blockers

- **Date:** 2026-09-22
- **Decision:** the post layer gains emphasis (`spin`, `grow-shrink`) and motion paths
  (`right`, `down`) ported from ppt-master's MIT preset catalog, plus the standalone
  `dsh-ppt post animate`; `dsh-ppt narrate` wraps `notes-to-audio` (+ `narration-sync
  animations`) with an edge voice default and an offline voice list. The fixture motion now
  uses emphasis and a path, so the golden moved to `fixtureVersion: 4`.
- **The wrapper is the difference between showing and playing.** Inserting the catalog rows
  verbatim made PowerPoint report each effect with the right duration but **zero behaviours**
  (`MainSequence.Item(2).Behaviors.Count = 0`), i.e. nothing would animate. Comparing with
  XML PowerPoint itself wrote showed the missing structure: a hold group, then the preset
  `p:cTn` with `nodeType="clickEffect"` and a `p:iterate` element, then the behaviour. With
  that wrapper the recorded golden reads back through COM as slide 3: fade entrance
  (`type=10`, 2 behaviours, 0.4 s), spin (`type=61`, 1 behaviour, 1.0 s), path right
  (`type=149`, 1 behaviour, 0.8 s); slide 4: wipe entrance (`type=12`, 2 behaviours) and
  grow/shrink (`type=59`, 1 behaviour, 0.9 s). The entrance-only output is byte-identical to
  the pre-M5 writer, which the unchanged entrance tests assert.
- **`post animate` is the same pass, standalone.** It applies the deck config to the published
  package, re-runs the compat pass at the deck level (a new path becomes a compatibility fact),
  writes the package atomically and refreshes `out/compat-report.json` plus the compat/post
  blocks of `out/manifest.json`. Measured: three unit tests cover replace-in-place, `--out`
  and the three refusal paths.
- **Narration has two blockers on this machine, both recorded rather than worked around.**
  (1) `notes-to-audio` requires a per-slide notes roster (`<project>/notes/<exported-stem>.md`);
  our deep projects have an empty `notes/` because the fixture SVGs carry no notes, and
  authoring that text is the M6 workflow's job — so `narrate` refuses before spawning with that
  instruction. (2) TTS needs the provider network; the machine is offline (the same block as
  ADR-039/040). The engine also requires `--voice` for `edge`, so `narrate` defaults it from the
  deck script (`zh-CN-XiaoxiaoNeural` for CJK, `en-US-JennyNeural` otherwise) using
  `detectPrimaryLanguage`.
- **Voices.** `docs/compat/voices.md` records the engine's curated offline list
  (`notes-to-audio --list-common-voices`, captured on this machine: 14 zh/en voices).
  `narrate --list-voices` prints it.
- **Golden v4 (the M5.6 re-record, animation half).** fixtureVersion 3 → 4 adds the emphasis
  and path blocks to the fixture motion: merged 36551 bytes, canonical `c893198f…`, base
  byte-identical. `pnpm fixtures:verify` reports canonical equality and the three compat
  snapshots equal, and the recorded golden carries the vendor wrapper above. The narration half
  of M5.6 stays blocked on the two blockers named here; on a networked machine with an authored
  notes roster, `dsh-ppt narrate` then `pnpm fixtures:record` completes it without code changes.
- **Alternatives rejected:** shipping the catalog rows without the wrapper (COM proves nothing
  would play); changing the entrance writer to the wrapper shape as well (risks the verified
  pptwise output and is unnecessary); generating placeholder notes text in `narrate` (narration
  text is model work, and a stub would make the golden a lie); requiring an explicit `--voice`
  (the engine already has a curated default per language, and the deck knows its script).

## ADR-043 — Narration lands: notes roster, embedded audio, and the merge bugs it found

- **Date:** 2026-09-22
- **Decision:** narration is a first-class M5 output: a deep page may carry `notes.md` beside
  its SVG, `<deck>/narration/*.mp3` are embedded by the deep export
  (`--recorded-narration narration --use-narration-timings`), and the golden moved to
  `fixtureVersion: 5` with speaker notes, two narration audio parts and auto-advance timings.
- **Network.** The user accelerator (SteamTools, PAC at `127.0.0.1:26561`) intercepts TLS with
  its own root. The runner now inherits the standard proxy and CA bundle variables
  (`http_proxy`/`https_proxy`/`all_proxy`/`no_proxy`, `requests_ca_bundle`, `curl_ca_bundle`,
  `ssl_cert_file`, `node_extra_ca_certs`) when the user sets them; the fusion never sets them.
  On this machine a bundle of certifi plus the accelerator roots lives at
  `~/.dsh/ppt-fusion/certs/ca-bundle.pem` (logged in `~/.dsh/CHANGELOG-dsh.md`).
- **ffprobe is required, exactly as the engine requires it.** `--use-narration-timings` reads
  each audio duration with `ffprobe -show_entries format=duration -of json`, with no fallback;
  the golden gate therefore installs ffmpeg on both CI legs (apt on Linux, choco on Windows).
  This machine has no ffmpeg, so a machine-local shim
  (`~/.dsh/ppt-fusion/bin/ffprobe.exe` → an imageio-ffmpeg static build) provides it; that is a
  local workaround, not part of the repository.
- **What the narration golden found.** Four real gaps, all fixed and covered by tests:
  (1) the deep project already needed a notes roster and the exporter reads it by SVG *stem*, so
  `deep-render` writes `notes/<roster-stem>.md`; (2) the merge closure never registered the
  replaced slide in its mapping, so a notes slide back-reference imported a second copy of the
  slide (the package then held 7 slides against a 5-entry `p:sldIdLst`); (3) imported media
  relied on a hardcoded content-type list, so `narration2.mp3` had no content type — imported
  parts now inherit the source package declaration; (4) notes masters carry their own theme,
  which the closure used to drop, leaving a dangling relationship — themes referenced from a
  notes master are imported now.
- **Measured.** Real edge-tts audio through the proxy: 93600 B and 82224 B MP3s with SRTs; the
  recorded merged deck is 196845 B with 61 parts, 5 slides, 1 master, 7 notes slides, 3 notes
  masters, 3 themes, the native chart and both audio parts. `fixtures:verify` reports canonical
  equality for all three artifacts plus equal compat snapshots; PowerPoint COM opens the golden
  with 5 slides and no repair; `opc-invariants` passes with `masters=1`.
- **Also verified with the accelerator on.** `source https://www.bing.com/` produced a real
  2569-byte Markdown; `images search --from-url <pexels CDN jpeg>` downloaded a 5306x3770 image
  and recorded `image_sources.json` with `provider: manual`, `license: unverified — direct URL`
  and no attribution requirement. **Still blocked:** the no-key providers openverse and
  wikimedia return 502 through this accelerator (it tunnels bing/pixabay/pexels hosts but not
  those), and pexels/pixabay search needs an API key. Adding those domains to the accelerator
  or supplying a free Pexels key completes the last acceptance row without code changes.
- **Alternatives rejected:** keeping narration out of the golden until a networked CI existed
  (the machine can do it now, and the golden is the evidence); setting proxy/CA variables inside
  the repository (deployment facts belong to the user environment); hardcoding audio content
  types in the merge (the source package already declares them); dropping the notes master theme
  (leaves a dangling relationship PowerPoint would repair); scaffolding the engine animation
  config to satisfy `narrate --sync` (the fusion owns motion in `post/animations.json`, ADR-032).

## ADR-044 — The SKILL budget gate: prompt-audit thresholds, vendored links, and tiktoken

- **Date:** 2026-09-22
- **Decision:** `dsh-ppt skill audit [--json] [--strict]` wraps the engine's `prompt-audit` over
  `skills/dsh-ppt-fusion/prompt_audit_manifest.json` (corpus `skills/dsh-ppt-fusion/**/*.md`
  plus `python-assets/vendor/ppt-master/docs/*.md`). The gate's thresholds are the engine's own:
  the manifest's ceiling is a fixed upper bound on o200k_base token counts, over-budget or any
  deterministic error fails, and `--strict` makes warnings fail too; the fusion adds no second
  policy layer. `dsh-ppt audit` now runs the same source (`prompt-audit`) instead of recording it
  as skipped, and names it in `skipped` with the reason when the engine venv is absent.
- **Measured.** 24 files, 109510 tokens against the 120000-token ceiling, 0 errors, 0 warnings.
  Per-file budgets sit above the measured block and load sets cover the SKILL's 8-12 document
  reference packs; the one cross-file exact duplicate (the language-neutral CLI roster shared by
  `SKILL.md` and `SKILL.en.md`) is declared in `duplicates.accepted`.
- **Vendored references.** The upstream wheel ships only `skills/ppt-master/scripts/docs`; the
  referenced `references/`/`workflows/` trees are not in it and raw.githubusercontent.com is
  unreachable through this machine's accelerator. The 22 vendored docs keep their content, but
  relative links whose targets are outside the vendored subset were rewritten to absolute
  `https://github.com/elvisw/ppt-master/blob/main/...` URLs; `python-assets/vendor/NOTICE`
  records the edit and `manifest.json` the new hashes (upstream repository per the wheel's
  `Project-URL`).
- **Engine dependency.** The engine refuses `prompt-audit` without `tiktoken`, so
  `python-assets/requirements.in`/`.lock` pin `tiktoken==0.14.0` plus its `regex` dependency;
  the lock diff is additive (89 to 91 packages, no version churn) and `dsh-ppt doctor --repair`
  installs it with the rest of the lock.
- **Alternatives rejected:** a second budget policy in the fusion (the manifest already owns
  the ceilings); making the deck audit fail when the venv is absent (a pure-pptwise deck must
  audit on a consumer machine); keeping dangling vendored links (the audit's local-reference
  check would stay red); leaving tiktoken out of the lock (the gate would be un-runnable after a
  repair).

## ADR-045 — Checkpoint and resume: model-authored state, read-only reporting, opt-in brief

- **Date:** 2026-09-22
- **Decision:** The SKILL writes `.dsh-ppt/checkpoint.json`
  (`{version, phase, deck?, updatedAt?, artifacts[], gates{}, notes}`) at the end of every phase,
  and `dsh-ppt resume <dir> [--json] [--write]` reads it. Resume never infers progress from the
  filesystem or the model's memory: it validates the checkpoint, checks each claimed artifact,
  reads `out/manifest.json` for the published `{file, sha256, bytes, slides}`, and prints the next
  phase's entry commands. `--write` persists the same brief to `.dsh-ppt/resume.md`.
- **Leniency.** The checkpoint schema ignores unknown keys (a model-authored file must not become
  unusable over a stray field) but reports known-field violations with their path, like
  `deck.fusion.json`. `phase` accepts `0`–`7` as a string or a number.
- **Exit contract.** Missing artifacts make the report `ok: false` and exit 1; an unreadable
  `out/manifest.json` is a `problem` inside an otherwise valid report; an absent or invalid
  checkpoint is `OutputMissing`/`ContractViolation`.
- **Alternatives rejected:** deriving the phase from file timestamps (checkpoint plus manifest
  are the authority); letting resume write the checkpoint itself (the model owns the phase
  narrative, and a tool that rewrites it could silently erase work); failing the report on a
  malformed published manifest (the render command owns that file).

## ADR-046 — The M6 model eval: shipped headless profile, isolated workspaces, rubric from the package

- **Date:** 2026-09-22
- **Decision:** `pnpm eval:run [--scenario <name>] [--attempts <n>] [--json]` runs every
  `fixtures/scenarios/*.yaml` through DeepSeek Harness's shipped `headless` profile, at most
  `maxAttempts` fresh sessions per scenario, and judges each finished workspace with
  `tests/eval/rubric.ts`: the unified audit gate, slide count, per-slide text shapes, a single
  slide master, native chart/table parts, image attribution, the checkpoint file, and a bound
  theme file. The nine check meanings live in `fixtures/scenarios/rubric.json`.
- **Isolation.** An attempt owns `tmp/eval/<scenario>/attempt-<n>/`: `work` is the agent cwd,
  `home` is a fresh `DSH_HOME` (no machine-local patch layer or MCP servers), and `bin` holds
  `dsh-ppt` shims that run this checkout's built `dist/cli.js`. The SKILL is mounted with
  `skill-filesystem.customSkillDirs` through a generated `--patch` overlay, so the eval never
  installs anything into the user's `~/.dsh/skills`.
- **Model and permissions.** `DSH_HARNESS_ROOT` selects the harness source checkout (booted
  through `tsx/esm`); without it an installed `dsh` is used. The profile's default model
  (`deepseek-v4-flash`) runs with `DSH_PERMISSION_MODE=danger-full-access`, so an autonomous
  session never blocks on an approval prompt; the key comes from `DEEPSEEK_API_KEY` or the
  user's `~/.dsh/.credentials.yaml`.
- **Metrics.** Wall time is measured by the harness. Turns, tool calls, failed calls, gate
  failures, skill loads and checkpoint commands are recovered from the session log
  (`$DSH_HOME/sessions/**/session.jsonl.zstd`; the CLI appends one zstd frame per event, so the
  reader splits on the frame magic). The model's own summary is never the evidence.
- **Pass line.** A scenario passes when every check passes. The 3/3 decision and any downgrade
  level are recorded in `docs/m6-model-eval.md`; the harness exits non-zero unless all
  scenarios pass.
- **Alternatives rejected:** booting the user's `web` profile (machine-local patches and MCP
  servers change the agent under test); installing the SKILL into `~/.dsh/skills` (an
  unnecessary machine change); letting the model judge itself (a rubric read from the package
  is repeatable and independent).

## ADR-047 — M6 verdict: GO, with a brand-fidelity finding and one confirmation run pending

- **Date:** 2026-09-22
- **Decision:** The M6 model evaluation passes its plan 6.6 line: 3/3 scenarios produced
  packages that pass the unified audit gate (topic-only 5 slides, doc-to-deck 6 slides with
  four native charts, branded-template 4 slides), and the doc-to-deck package passed the
  manual spot check (PowerPoint COM reads four editable charts with the brief's series values;
  one slide master; the pixel audit finds no unknown colour; COM opens it unchanged). M7 may
  start while the one confirmation run is scheduled.
- **Measured.** topic-only 811 s / 133 tools / checkpoint phase 7; doc-to-deck 1104 s / 147
  tools (two subagent calls) / three recovered gate failures / checkpoint phase 7;
  branded-template 339 s / 88 tools / four slides / one recovered gate failure. Every session
  stayed inside one turn. The only audit findings anywhere are warning-level `ea-font-slot`
  compat advisories (CJK runs without an `a:ea` slot), outside this command surface.
- **Brand-fidelity finding.** The branded-template session ran `brand extract --bind`
  correctly, then edited the bound `brand.theme.json` into a different palette (#1E2A4A /
  #F5C518 versus the extracted #4472C4 / #ED7D31). The manual spot check caught what the
  file-existence check could not. The SKILL now forbids restyling a bound brand without
  asking, and the next model round gains a rubric check comparing the bound palette with a
  reference extraction of the staged input.
- **Quota abort.** The DeepSeek balance ran out mid-session (21:17): the branded-template
  session ended before writing the checkpoint, and attempts 2 and 3 aborted in 15-17 s with
  `QUOTA: Insufficient Balance`. The harness records a boot with no tool calls as an
  infrastructure abort and does not retry it; the confirmation run is pending an account
  top-up (`pnpm eval:run --scenario branded-template`).
- **Alternatives rejected:** a capability NO-GO from the branded-template result (its package
  passes every error-level check, and the palette change was a deliberate edit rather than an
  inability to run the workflow); triggering L2-L4 (the observed gaps are instruction and
  environment, not context or phase-count ceilings); declaring M6 complete without the
  confirmation run (the brand-fidelity rule has not been exercised by a model yet).

## ADR-048 — Keyed image providers receive their keys; openverse/wikimedia stay unreachable here

- **Date:** 2026-09-22
- **Decision:** `dsh-ppt images search` passes `PEXELS_API_KEY`, `PIXABAY_API_KEY` and
  `IMAGE_SEARCH_CONCURRENCY` through to the engine child. The runner is default-deny, so a key
  reaches the child only because the command names it; with no key the engine still skips the
  keyed provider.
- **Evidence.** `PEXELS_API_KEY=test-key dsh-ppt images search ... --provider pexels` reaches
  `https://api.pexels.com/v1/search` and fails with the provider's `401 Unauthorized` instead
  of the engine's missing-key skip. Direct probes on this machine: `api.pexels.com` 401 and
  `pixabay.com/api` 400 (both answering), while `api.openverse.org` and `commons.wikimedia.org`
  time out directly and return 000/502 through the local accelerator.
- **Accelerator state.** The Steam++ 2.6.9 proxy (127.0.0.1:26561) answers 000 for every host
  including bing; restarting it needs elevation and the running executable is not at the path
  in the uninstall registry, so no rule edit was applied. Its rule store is a MessagePack file
  that cannot be authored blind.
- **Consequences.** The last M5 image-search acceptance row is one key away: set
  `PEXELS_API_KEY` (free at pexels.com/api) and run `dsh-ppt images search`; the recorded
  `assets/image_sources.json` then carries `provider: pexels` attributions.
- **Confirmed 2026-09-22 21:52.** With a user-supplied Pexels key the real search ran end to end:
  `dsh-ppt images search "bird migration flock flying" --provider pexels` downloaded
  `assets/birds.jpg` (1687676 B, 6000x4000 JPEG) and wrote `assets/image_sources.json` with
  `provider: pexels`, `license_name: Pexels License`, `author: Satyabrata Maiti`,
  `license_tier: no-attribution` and a complete attribution text. The M5 image-search row is
  closed on the keyed path; no accelerator change was needed.
- **Alternatives rejected:** editing the accelerator rules (unsafe, and the service does not
  route those hosts); hardcoding a key into the repository or the eval harness (credentials
  never enter the repo); treating the no-key providers as the only path (they are unreachable
  on this network).

## ADR-049 — `dsh-ppt preview`: pptwise pages plus the authored deep SVGs

- **Date:** 2026-09-22
- **Decision:** `dsh-ppt preview <dir> [-o <dir>] [--html]` runs pptwise `preview --html` over
  the deck's IR into `.dsh-ppt/preview`, then replaces each deep page's placeholder SVG with
  the authored `deep/<dir>/page.svg`, clears the manifest `placeholder` flag, sets
  `deep: true`, and patches the self-contained viewer when its inline markup still matches.
  The result reports overlaid pages, remaining placeholders and whether the viewer was
  patched.
- **Evidence.** On `fixtures/hello`: 5 pages written, 2 deep pages overlaid, the page-3 output
  byte-identical to `deep/p03-native-chart/page.svg`, the manifest no longer marks pages 3/4 as
  placeholders, and the viewer HTML contains the authored SVG markup. Unit tests cover the
  overlay, a deep page with no authored SVG (reported as a placeholder) and a missing
  manifest.
- **Alternatives rejected:** a second renderer for deep pages (the authored SVG is exactly
  what the exporter ships); leaving placeholders in the viewer (the card and the viewer would
  disagree); regenerating `preview.html` from scratch (pptwise owns that format; a failed
  patch is reported, never faked).

## ADR-050 — The DSH plugin bundle: skill + preview tool + card, verified in a scratch profile

- **Date:** 2026-09-22
- **Decision:** The package is a DSH bundle: `dsh/index.js` (the package root export) registers
  the `dsh-ppt-fusion` skill with a runtime preamble and the `dsh_ppt_preview` tool;
  `dsh/client.js` is the lazy-CJS preview card; `cordis.patch.yml` is the bundle layer;
  `dsh.bundle.patch`, `dsh.client.immediately`, `main` and `exports` are declared in
  package.json. `pnpm prepack` builds and runs `scripts/check-pack.mjs`, which refuses a
  tarball that misses any runtime file.
- **Skill mounting.** The registered content is the SKILL body (frontmatter stripped) plus a
  preamble mapping `dsh-ppt <args>` to `node <package>/dist/cli.js <args>` and pointing the
  vendored reference paths at the package root; `resourceBase` is the package root so the
  playbook's relative paths resolve inside an installed plugin.
- **Verification (M7.5, ops discipline).** Scratch profile `~/.dsh/profiles/ppt-eval` (base +
  web-app bundles): `dsh plugin --profile ppt-eval add -w link:<checkout>` updated
  `dependencies` and `dsh.profile.bundles`; `--dump-config` showed the
  `# == @dsh-ppt/dsh-ppt-fusion` layer; booting on port 3098 logged no plugin skip line and
  answered `GET /dsh-ppt/preview/does-not-exist` with 404, `x-dsh-ppt-preview: 1` and
  `preview_unknown`; `remove -w @dsh-ppt/dsh-ppt-fusion` removed both the dependency and the
  bundle entry, left no `node_modules/@dsh-ppt`, and the linked checkout was intact. Backups
  and the changelog entry live in `~/.dsh/CHANGELOG-dsh.md`; the browser card is the one check
  a browser-less host cannot do.
- **Alternatives rejected:** shipping the skill as a filesystem-only directory (a DSH_HOME
  install is a machine change and stays invisible to `dump-config`); copying pptwise's plugin
  verbatim (its CLI has no `assemble` step and no fusion render; identity and route would
  collide); a from-scratch card protocol (the lazy-CJS card and its failure vocabulary are
  battle-tested).
