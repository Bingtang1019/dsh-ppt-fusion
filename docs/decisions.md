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