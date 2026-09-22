# Decisions

ADR log for dsh-ppt-fusion. Every entry records date, decision, evidence, and the
alternatives that were rejected. Add an entry whenever an implementation choice or an
observed upstream fact departs from `PPT-FUSION-PLAN.md`; the plan file itself is not
edited to match reality.

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
