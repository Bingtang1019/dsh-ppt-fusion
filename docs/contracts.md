# Contracts (v1, M0)

Frozen implementation contracts for `dsh-ppt-fusion`, measured on this machine on
2026-09-22. Full `--help` snapshots live in `docs/help/`; this file records what the
fusion code may rely on. ADRs referenced as `ADR-nnn` are in `decisions.md`.

Paths: `MASTER` = `%DSH_HOME%\ppt-fusion\venvs\ppt-master-0.1.128\Scripts\ppt-master.exe`,
`PPTWISE` = `<profile>\node_modules\@liustack\pptwise\dist\cli.js` (invoke as
`node <abs path>`), `PY` = the venv's `Scripts\python.exe`.

---

## 1. ppt-master (deep engine)

### 1.1 Invocation

- Entry point `ppt-master = cli:main`, a dispatcher with 74 subcommands
  (`docs/help/ppt-master-help.txt`).
- The fusion CLI registers only the subcommands it uses (ADR-013). Registration
  records: subcommand, accepted flags with their enumerations, and the output files the
  command is contracted to produce.
- Every invocation sets `PYTHONIOENCODING=utf-8`, runs with `cwd` inside the deck
  workspace, and uses absolute paths for the executable (ADR-003, ADR-004).

### 1.2 Registered subcommands (v1)

| Subcommand | Flags the fusion uses | Output contract |
|---|---|---|
| `project init <name> [--format F] [--dir D]` | `--format {ppt169,ppt43,wechat,xiaohongshu,moments,story,banner,a4}` | creates `<D>\<name>_<format>_<YYYYMMDD>\` with `svg_output/`, `sources/`, `exports/`, `validation/`, … |
| `svg-to-pptx <project> [flags]` | `--quick-generate`, `--native-charts-and-tables`, `--with-notes`, `-f`, `-o`, `-s`, `--pptx-structure {structured,flat,baseline,template,preserve,generated}`, `-t`, `-a`, `--animation-config`, `--animation-duration`, `--no-animations` | writes `-o` target (default `exports/…pptx`); always writes `validation/<stem>.report.json`; prints `[POSTFLIGHT] status=… quality_gate=… slides=N warning_categories=N` plus `[PPTX]`/`[REPORT]` lines |
| `svg-quality-check <project\|dir\|file> [flags]` | `--stage {early,first-page,page,final}`, `--quick-generate`, `--canonical-authoring`, `--json`, `--roundtrip`, `--template-mode`, `--page` (required with `--stage page`) | writes `validation/svg_quality_report.json`; exit 0 = pass. `--json` output on stdout is **not** parseable (progress lines surround it) — read the file (ADR-009) |
| `stamp-native-fallbacks <file\|dir> [--write]` | `--write` to persist | rewrites marker `data-pptx-fallback-sha256` in place; prints a `Native fallback baselines:` receipt with `SVG-first=N` |
| `pptx-delivery-check <file.pptx>` | — | delivery-risk findings; exit 0 = pass |
| `prompt-audit [--json]` | `--json` | prompt-budget findings for the skill documents |
| `pptx-to-svg <pptx> [-o dir] [--inheritance-mode M] [--roundtrip] [--strict] [--keep-hidden]` | `--inheritance-mode {both,layered,flat}`; `--roundtrip` requires `both` | round-trip workspace with `authoring-svg-flat/`, `analysis/native_structure.json` and `sources/source.pptx` (M5 ✓, ADR-038) |
| `pptx-template-import <pptx> [-o dir] [--inheritance-mode M] [--embed-images]` | `--inheritance-mode {both,layered,flat}` | reference workspace (`svg/` + `inheritance.json`) that `mirror-template-materialize` publishes from (M5 ✓) |
| `mirror-template-materialize <import_ws> <template_ws> [--kind deck\|layout]` | `--kind {deck,layout}` | deterministic mirror template: template SVGs, text-slot files, `template_execution_manifest.json`, `source_themes.json`, a Design Spec TODO (M5 ✓) |
| `apply-template <project> --root <ws> [--root …] [--dry-run]` | repeatable `--root`, one per kind | installs a template root into `templates/`; writes `template_install.json` and prints an `[OK] installed N file(s)` receipt (M5 ✓) |
| `register-template [id] [--kind K] [--rebuild-all] [--dry-run]` | `--kind {brand,style,layout,deck}` | refreshes the template index under `templates/<kind>/` (M5 ✓) |
| `image-search <query> [--provider …] [--strict-no-attribution] [--manifest F] [--save-candidates] [--from-url U]` | `--provider {openverse,wikimedia,pexels,pixabay}`, `--orientation`, `--filename`, `--min-width`, `--promise …` | downloads into `-o`, writes the attribution manifest (M5) |
| `source-to-md <input…> [-t type] [-o output] [--json]` (and the five `*-to-md` converters) | `-t {auto,pdf,doc,excel,pptx,web,markdown,text}`, `--images {all,filtered,none}`, `--no-images`, `--json` | Markdown into the chosen output; `web-to-md` accepts http(s) URLs only (M5) |
| `notes-to-audio <project> [--provider P] [--voice V] [--rate R] [--list-common-voices]` | `--provider {edge,elevenlabs,minimax,qwen,cosyvoice}` (default `edge`, no key) | per-slide audio into the project; `--list-common-voices` is offline (M5 ✓) |
| `narration-sync {fingerprint,animations,subtitles} [flags] <project>` | `--pptx` (subtitles), `--audio-dir`, `--animation-config`, `--plan`, `-o`, `--force` | timing plan / merged SRT (M5) |

Registered since M3, under the same rules (enum-validated flags, workspace-contained
paths, contracted outputs): `notes-to-audio` (`--provider {edge,elevenlabs,minimax,qwen,
cosyvoice}`, `--voice/--rate/--volume`), `narration-sync {fingerprint,animations,
subtitles}` (`subtitles` requires `--pptx`), `image-search` (`--provider
{openverse,wikimedia,pexels,pixabay}`, `--orientation`, `--strict-no-attribution`,
`--min-width`), the five converters `pdf-to-md|doc-to-md|excel-to-md|ppt-to-md|web-to-md`
(`--images {all,filtered,none}`, `--max-rows`), `mirror-template-materialize`
(`--kind {deck,layout}`) and `pptx-to-svg` (`--inheritance-mode
{both,layered,flat}`). `REGISTERED_ENGINE_COMMANDS` in `src/engine/contracts.ts` is the
authority; a command absent from it is unreachable.

Explicitly **not** registered: `image-gen`, `powerpoint-video`, `video-motion-plan`,
`video-sound-mix`, `video-subtitles`, `gemini-watermark-remove` (ADR-013).

### 1.3 Deep page authoring contract (measured, ADR-007)

A deep page is one SVG in `<project>/svg_output/` (1280×720 for `ppt169`). Required:

1. Root: `data-pptx-page-role` ∈ `{cover, toc, section, content, ending}`.
2. Background/frame elements: `data-pptx-role` ∈ `{background, chrome, decoration,
   footer, header, logo, page-number, watermark}` **and** a stable `id`.
3. Content modules: root-level `<g id="…" data-pptx-bounds="x y w h">`; zones of
   sibling modules may not overlap by more than 1 px; text inside must not exceed the
   zone by more than 5 % on either axis.
4. Text uses raw Unicode, escapes XML reserved characters, and uses PPT-safe fonts.
   Banned: `mask`, `<style>`, `class`, external CSS, `<foreignObject>`, `textPath`,
   `@font-face`, `<animate*>`, `<set>`, `<script>`, event attributes, `<iframe>`.
5. `<project>/spec_lock.md` exists with the sections required by
   `templates/schemas/spec_lock.schema.json` (`canvas`, `communication`, `mode`,
   `visual_style`, `colors`, `typography`, `icons`, `page_rhythm`, `forbidden`).
   In `## typography`, every row except `font_family`/`*_family` must be a bare
   positive px number; those numbers are the anchors and size bands for the pages. A
   font size that is not an anchor may appear at most twice per page.

### 1.4 Native object markers (measured)

```xml
<g id="milestone-chart" data-pptx-bounds="80 200 1120 400" data-pptx-replace-with="chart">
  <metadata type="application/json">{ …ppt-master chart payload… }</metadata>
  <g id="chart-fallback"> …visible SVG fallback… </g>
</g>
```

- `data-pptx-replace-with` ∈ `{chart, table}`; the group must be a `<g>`.
- `stamp-native-fallbacks --write` must run after every fallback or payload edit; it
  writes `data-pptx-fallback-sha256` and refuses payloads it cannot bind to the visible
  SVG.
- `--native-charts-and-tables` stops unless every visible fallback detail is projected
  by the payload ("SVG-first" authority). Measured requirements: the series color must
  equal the drawn bars (or list `series[].point_colors`), and table payloads must state
  per-column/per-cell `align` and any per-row fill the fallback draws.
- Chart payload keys used: `name, x, y, width, height, type, categories,
  series[{name, values[]}], style{colors[]}` with `type` including `column, bar, line,
  pie, doughnut, of_pie`.
- Table payload: `schema: "ppt-master.semantic-table.v2"`, `strict_grid`,
  `column_widths[]`, `row_heights[]`, `style{font_family, font_size, header_font_size,
  header_fill, header_text, body_fill, body_text, band_row, band_fill, border_color,
  border_width, padding{left,right,top,bottom}, valign}`, `columns[{text,bold,align}]`,
  `rows[[{text,bold,align,color}]]`.
- Verified output: chart → `ppt/charts/chartNNN.xml` (root `c:chartSpace`) plus
  `ppt/embeddings/Microsoft_Excel_SheetNNN.xlsx` and a `…/chart` relationship on the
  slide; table → `<a:tbl>` inside a `p:graphicFrame` on the slide.

### 1.5 Deep export pipeline (measured, ADR-008)

1. `stamp-native-fallbacks <project>/svg_output --write` (when markers exist).
2. `svg-quality-check <project> --quick-generate --canonical-authoring --stage final
   --json` → exit 0 and a fresh `validation/svg_quality_report.json`.
3. `svg-to-pptx <project> --quick-generate --native-charts-and-tables --with-notes -o
   <out>.pptx`.
4. Read `validation/<stem>.report.json`; `quality_gate=passed` or
   `passed-with-warnings` is acceptable, anything else is a failed gate.

`--quick-generate` infers the canvas format and `flat` vs `structured` from the roster;
it does **not** read `spec_lock.md`, but the final quality gate does.

## 2. pptwise (front end)

- Invoke as `node <abs>/dist/cli.js <cmd>`; the package seals its JS API (ADR in
  `manifest.json`), so the CLI + JSON output are the only interfaces.
- Commands and JSON surfaces the fusion relies on:

| Command | Contract |
|---|---|
| `validate <target>` | exit 0 + `OK — N slides, theme "id"`; exit 1 + per-page, per-field messages (measured: bullet length limit, placeholder rules) |
| `render <target> [-o f.pptx] [--draft] [--allow-dropped-content]` | writes the pptx; exit 1 with a readable gate message otherwise |
| `audit <target> [--json] [--pixels]` | `--json` prints `{findings[], pagesAudited, pagesSkipped, checks}`; exit 1 when findings exist; every finding is `{page, slideId, code, message, detail}` |
| `preview <target> [-o dir] [--html]` | writes `NNN-<kind>.svg` per slide, `manifest.json`, and with `--html` a self-contained `preview.html` |
| `serve <target> [--port]` | live-reloading preview |
| `themes --json` | 24 factory presets with `id, label, colors{…}, occasions, identity` |
| `theme new --from <id> -o <file> --id <id>` | writes a complete ThemeFile v2 (see §3) |
| `theme fork <id> --primary … --id …` | rederives a palette, keeps the page menu |
| `theme try <ids> -o <dir>` | contact sheet HTML for 2–4 candidates |
| `brand extract <file.pptx> -o <theme.json> [--from <id>]` | extracts corporate colors/fonts into a full theme |
| `doctor [--json]` | runtime/skills/dsh/engines/self-test report |
| `schema`, `schema --spec` | IR v5 and deck-spec JSON Schemas |

## 3. pptwise ThemeFile v2 (ADR-012)

Top level: `{id, label, style, occasions, identity, story, emphasis, version: 2, menu}`.
`style` = `{id, colors, fonts, shape, defaultBackgrounds}`:

- `colors`: `bg, surface, panel?, primary, accent, text, muted, border, chartPalette[],
  accentPool?, cardStroke?, emphasisInk?, danger?, warning?, success?`
- `fonts`: `heading[]`, `body[]`, `mono?[]` — every role is a **list** of family
  names. `mono` appears in 3 of the 24 presets (journal, memo, terminal) and is an
  array there, never a bare string (ADR-021).
- `shape`: e.g. `{radius: 2, gapScale: 1}`
- `defaultBackgrounds`: `{cover, chapter, content, ending}`, each carrying a `kind`:
  `{kind: "color", value: "#RRGGBB"}` in 88 of the 96 measured slots, or
  `{kind: "gradient", from, to, direction}` in `ledger` and `terminal`. Both stops
  are palette literals, so the palette audit accepts them (ADR-021).

`menu` maps page faces to entries such as
`{cover: {face, decor}, content: {<kind>: {face, decor}}}`.

## 4. pptwise IR v5 envelope (measured)

Root required: `version` (const `"5"`), `filename`, `theme` (`{id}`), `meta`, `assets`,
`slides`. Optional: `narrative`, `brand`, `branding`.
`slides[]` is a union on `type` ∈ `{cover, chapter, content, ending}`:

- all: `id?`, `placeholder?`, `heading?`, `subheading?`, `components[]` (required),
  `background?`, `decor?`, `image_side?`, `footnote?`, `notes?`
- `content` additionally requires `kind` ∈ `{points, list, comparison, process, data,
  photo, statement, quote, fact, evidence, hierarchy}`.

`components[]` is a union of 62 typed units keyed by `type` (for example `bullets`
`{items: string[], style?}`, `paragraph {text}`, `callout {variant, text, icon?}`,
`chart {chart_type, series[], axes?, direction?}`, `data_table {columns[], rows[]}`).

## 5. Spawn and file discipline

- Executables are addressed by absolute path; PATH lookup is never used for the engine
  or the Python interpreter.
- Each spawn carries a timeout by command class, a `cwd` inside the deck workspace, an
  environment whitelist (credentials removed; `PYTHONIOENCODING=utf-8` added), and
  `stdin: 'ignore'`.
- Bulk results travel as files (`exports/`, `validation/`, `preview/`), not as piped
  stdout (ADR-004).
- Engine scratch (temporary master projects, caches, logs) lives under
  `<deck>/.dsh-ppt/`; published artifacts are written atomically to `<deck>/out/`.
- Machine-readable stdout is treated as a receipt only; structured data comes from the
  documented file (ADR-009).

## 6. Deck workspace layout (fusion)

```
<deck>/
  deck.fusion.json     routing manifest (schema v1)
  deck.ir.json         pptwise IR v5 for standard pages; deep pages are placeholder:true
  theme.json           ThemeFile v2 when the manifest binds a file
  tokens.json          bridge export (theme ensure writes it)
  sources/             source markdown
  deep/<page>/          page.svg + engine spec files for deep pages
  out/                 published pptx + manifest.json
  .dsh-ppt/            temp master projects, caches, logs
```

## 7. Fusion CLI contracts (M1)

- **Exit codes.** 0 success; 1 classified failure; 2 usage error (commander).
- **Failure line.** `dsh-ppt: <code> <message>` on stderr, with codes from the closed
  union in `src/engine/errors.ts`: `PptwiseMissing`, `PptwiseFailed`, `VenvMissing`,
  `EngineVersionMismatch`, `UvMissing`, `SpawnFailed`, `EngineTimeout`, `EngineExit`,
  `OutputMissing`, `ContractViolation`, `PathOutsideWorkspace`, `DoctorFailed`,
  `UsageError`.
- **Process discipline.** `src/engine/runner.ts` is the only child-process primitive.
  Every spawn carries a cwd, a timeout class, `stdin: 'ignore'`, and an environment built
  by `buildEnv`, which is default-deny: a fixed system-variable list plus
  `PYTHONIOENCODING=utf-8`, `PYTHONUTF8=1`, `PYTHONDONTWRITEBYTECODE=1`,
  `PYTHONNOUSERSITE=1`. A credential passes only when a caller names it in
  `allowCredentials`.
- **Engine timeouts.** `project init` 120 s; `svg-to-pptx` 900 s; `svg-quality-check`
  600 s; `pptx-delivery-check` 300 s; `stamp-native-fallbacks` 300 s. Front end:
  `validate` 120 s; `render` 600 s; `audit` 300 s; `themes` 60 s; `theme new` 120 s;
  `brand extract` 300 s; `doctor` 600 s.
- **Path containment.** `assertInsideWorkspace` proves every path argument sits under the
  deck workspace; an escape fails with `PathOutsideWorkspace` before any process starts.
- **Command registry.** `REGISTERED_ENGINE_COMMANDS` lists exactly the engine subcommands
  the wrapper may run. The v1 non-goals (`image-gen`, the `video-*` family) are absent
  from it, so they are unreachable rather than merely undocumented.
- **Determinism.** `pnpm engine:lock` regenerates `python-assets/requirements.lock` with
  `uv pip compile --generate-hashes`; engine installs consume that file, never a floating
  range.
- **Diagnostics.** Every engine and front-end run writes
  `<deck>/.dsh-ppt/logs/<timestamp>-<command>.log` containing argv, cwd, status, duration
  and captured output.
- **Doctor checks.** Node, uv, Python, engine venv, ppt-master dispatcher, pptwise front
  end, PowerPoint COM (Windows only), plus a one-page render self-test; `--repair`
  rebuilds the venv from the lock file and never touches deck data.

## 8. Cross-version compatibility (v3)

Measured facts and the B7 decision live in `docs/compat/probe.md`; the machine-readable
registry is `src/compat/registry.json` (`dsh-ppt-fusion.compat-registry.v1`, bundled into
the CLI at build time so it cannot go missing at install).

- **Levels.** `safe` (Office 2013+/WPS 2016+), `standard` (Office 2016+/WPS 2019+,
  default), `max` (Microsoft 365). The level is recorded in the manifest and passed to
  `render --compat`.
- **Registry entries.** `{feature, namespace, marker (XPath), minOffice, wpsSupport,
  mceFallbackRequired, downgradeTo}`; `downgradeTo: null` means the feature is allowed
  everywhere the level permits it.
- **Compat pass** (`bridge/compat.ts`, ADR-034): scan → transform → stamp → lint, run
  by `render` after post and before the structural gates. Implemented transforms are only
  the registered ones: morph/advanced transitions fall back to fade (unwrapping the MCE
  block when it has one), and `asvg:svgBlip` gets its PNG sibling through `sharp`. A
  registered downgrade this build cannot build (`bar-chart`, `drop-narration`,
  `linear-text`) is an error, never a silent edit, and an unknown version-sensitive
  namespace is rejected.
- **Level.** `render --compat safe|standard|max` > the manifest's `compat` field >
  `standard`. `out/manifest.json` records the level, its source, the registry version and
  the report hash; `out/compat-report.json` carries every occurrence, the applied changes
  and the findings. `dsh-ppt compat lint <file> [--strict]` re-runs the read-only half on
  any artifact and fails on errors (and on warnings under `--strict`).
- **PNG rasterisation.** The Python stack cannot produce it on this machine (probe:
  cairosvg imports fail on a missing cairo runtime; svglib/reportlab fail the same way),
  so the `stamp` step uses the Node-side `sharp` (B7). `doctor` reports the Python-side
  renderer state with the exact import error rather than letting upstream's silent
  degradation stand.
- **Verification matrix.** Local: PowerPoint 365 COM smoke, `python-pptx` reopen
  (`scripts/probe-pptx-reopen.py`, which must recurse into group shapes or it reports
  zero text on ppt-master pages), static `compat lint`. CI Linux: LibreOffice Impress
  headless conversion. User machine: the WPS checklist (S17). Until S17 is done, the
  release note claims T2 only, never T1.
- **What our decks carry today.** `p14:dur` on every slide; no `asvg`, `a14:m` or
  `mc:AlternateContent`, because the native-shape export ignores upstream compat mode.
  The PNG-fallback requirement therefore bites M5's SVG-image content, not the v1
  chart/table path.

## 9. Deep pipeline and merge contracts (M3/M4 part 1)

Frozen facts the later milestones build on. Each came from running the real
engines, and each is pinned by a test or a recorded transcript.

**Deep export is a four-step gated pipeline, in this order** (`engine/deep-render.ts`):

1. `project init` into `<deck>/.dsh-ppt/deep/<name>_<format>_<date>/`, then write the
   page roster as `<NNN>-<slug>.svg` (the index prefix fixes deck order) and a
   `spec_lock.md` derived from the deck — canvas from the page format, typography
   anchors from the font sizes the SVGs actually use, colours from `tokens.json`,
   primary language from the pages' script (the engine rejects `und`).
2. `stamp-native-fallbacks --write` (idempotent; reports `unchanged` for pages without
   markers).
3. `svg-quality-check <project> --quick-generate --canonical-authoring --stage final
   --json`; the exporter will not run without the report this step records.
4. `svg-to-pptx <project> --quick-generate --native-charts-and-tables --with-notes`.

Re-rendering the same page set removes the previous project by name prefix, so one
project exists per page set rather than one per run.

**Where the engines write**:

| Artifact | Location |
|---|---|
| Quality report | `<project>/validation/svg_quality_report.json` |
| Export report | `<project>/validation/<output-stem>.report.json` |
| Export receipt | stdout line `[POSTFLIGHT] status=… quality_gate=… slides=N warning_categories=N` |
| All render intermediates | `<deck>/.dsh-ppt/render/{base,deep,merged}.pptx` |
| Per-command logs | `<deck>/.dsh-ppt/logs/<timestamp>-<command>.log` |
| Published deck + record | `<deck>/out/<name>.pptx`, `<deck>/out/manifest.json` |

**Merge rules** (`bridge/merge.ts`):

- A base slide is replaced in place; deck order, slide ids and the single master are
  preserved (P1).
- The deep page's non-layout closure (charts, workbooks, media, notes) is imported; a
  part is reused **only when its bytes are identical**. A shared name with different
  content is renamed and imported — never overwritten (two decks routinely name
  unrelated parts alike).
- The deep page's layout relationship is repointed at the base layout the replaced slide
  used; the deep layout, master and theme are dropped. `--allow-multi-master` is the only
  path that imports them, and it registers the master in both `presentation.xml.rels` and
  `p:sldMasterIdLst`.
- Imported parts' own relationships are rewritten onto the names this package uses.
- Authored part names are kept when they are free.
- `[Content_Types].xml` gains what the imported parts need; `rels` and `xml` defaults are
  left to the source packages.
- `p14:creationId` values are renumbered per slide when the replaced page (or a kept page)
  repeats one: the first occurrence keeps its id and later ones move above the slide's
  highest id, in document order. Upstream `template_validation.py` rejects duplicates, and
  two decks that each number their animation nodes from 1 collide once pages are merged;
  the count enters `out/manifest.json` as `merge.renumberedCreationIds` (ADR-036).
- `mc:AlternateContent` blocks travel as XML, so a slide-level replacement never splits a
  Choice/Fallback pair; the compat lint re-checks every pair on the published package
  (ADR-034), and `tests/merge-discipline.test.ts` pins the pair migration and the zip
  discipline (unique entries, no encryption, one `[Content_Types].xml`) on the recorded
  golden (ADR-036).

**CLI path rules**: deck commands take paths relative to the **deck** (not the process
working directory) because the engine may only write inside the workspace; `deep render
--out` and `render --out` follow that rule, and a path outside the deck is refused.

**Determinism**: the merge writer sorts part names and stamps one fixed entry date, so
identical inputs give identical bytes (T2). The engines themselves stamp their own times,
so a full-chain byte comparison is not a gate (T3); semantic comparison is, and it must
recurse into `ppt/embeddings/*` (ADR-017).

## 10. Post-processing contract (M4 part 2)

- **Owner.** `bridge/post.ts` is the only writer of `p:transition` and `p:timing`. It strips
  any motion an engine produced before writing its own, so re-running is byte-idempotent.
- **Config.** `<deck>/post/animations.json`, referenced by `manifest.post.animations`:
  `{ staggerMs?, slides: [{ index, transition?, durationMs?, entrance? }] }` with
  `transition ∈ {fade, push, wipe, none}` and `entrance = { effect ∈ {fade, wipe, fly},
  durationMs?, target }`, where `target` is `{match: "<name substring>"}` or
  `{spids: [n, …]}`. Unknown fields and unknown effects are rejected with their field path.
- **Target resolution.** `match` is a substring of `p:cNvPr name`: deep pages carry SVG group
  ids, standard pages carry `blk<slide>-<block>` only when the IR sets
  `meta.animation.elements = "auto"`. A selector that matches nothing fails the render;
  it is never a no-op.
- **Shape ids.** `p:spTgt spid` references require unique ids inside the slide, so the pass
  renumbers duplicate `p:cNvPr id` values (first occurrence keeps its id) before writing.
- **Verification.** `scripts/win-com-anim-probe.ps1` reads the deck back through PowerPoint
  COM and reports `MainSequence.Count`, per-effect `EffectType` and `EntryEffect` per slide —
  what the animation pane shows. XML structure alone is not accepted as proof.
- **Recorded data.** `render` writes its post report into `out/manifest.json` (`post`), so a
  published deck records which shapes were animated.

## 11. Determinism gate and the golden fixture (M4 part 2)

- **Owner.** `tests/support/canonicalize.ts` owns the T1 comparison; `pnpm fixtures:verify`
  is the gate and `pnpm fixtures:record` is the only writer of `fixtures/golden/*`.
- **Canonical form.** `*.xml`/`*.rels` have their volatile fields removed
  (`dcterms:created`, `dcterms:modified`, `cp:revision`, `cp:lastModifiedBy`, `TotalTime`,
  `Application`, `AppVersion`) and their inter-tag whitespace collapsed; nested OOXML
  (`.xlsx/.docx/.pptx/.xlsm/.docm`) is canonicalised recursively (default depth 1, ADR-017);
  every other part is reduced to a SHA-256. Parts are compared through a name-keyed map, so
  zip entry order carries no meaning and differences are reported per part (ADR-033).
- **Tiers.** T1 is the hard gate (CI step `Golden deck gate`). T2 — our merge/post bytes
  stable for fixed input — is a target with unit coverage. T3 (whole-chain bytes) is never a
  v1 gate; `fixtures:verify` reports base byte stability (measured in M0) and expects
  deep/merged bytes to differ.
- **Manifest.** `fixtures/golden/golden-manifest.json`: `fixtureVersion`,
  `upstream.{pptwise,ppt-master}`, `baseRef`/`deepRef`/`mergedRef` with `file`, `sha256`,
  `canonical`, `bytes`, plus `generatedBy`, `command`, `createdAt`. `m0-fixtures.json` is
  the separate M0 record and is not a render gate.
- **Inputs.** `fixtures/hello` commits authored inputs only (IR, manifest, two deep SVGs,
  `post/animations.json`); `theme.json`/`tokens.json`/`master-design.json` are derived by
  `theme ensure` in the scratch copy, so a theme-bridge regression fails this same gate.
- **Compat levels.** `fixtures/golden/compat-levels.json` carries one stable snapshot per level
  (counts, occurrences, applied, findings; no timestamp) at the manifest fixtureVersion.
  `fixtures:verify` recomputes the pass over the fresh merged package, compares each snapshot,
  and asserts the level promises: no morph at `safe`/`standard`, no 2016+ chart at `safe`, no
  2019+ chart below `max`, and no lint finding at any level (MCE pairs complete, every
  `asvg:svgBlip` with its raster sibling) — ADR-037.

## 12. Unified audit gate (M4 part 2)

`dsh-ppt audit <dir> [--json] [--strict] [--pixels] [--file <pptx>] [--compat <level>]` is the
eight-source gate plan §3.8 defines. It emits a `FusionAuditReport`: the `validate` findings
(`{level, source, page?, rule, message}`) plus `strict`, `artifact`, `compatLevel`, `pixels`
and `skipped`.

- **Sources.** `manifest`/`ir`/`deep`/`theme`/`palette` (the `validate` pass, ADR-023);
  `pptwise-validate` and `pptwise-audit` (the front end's own IR validation and geometry
  audit, mapped from `{slide, severity, code, message}`); `svg-quality-check` (re-run on each
  recorded `.dsh-ppt/deep/<project>`: `blocking` becomes an error,
  `introduced`/`inherited`/`source-import` become warnings); `pptx` (OPC integrity plus the P1
  single-master invariant); `pptx-delivery-check` (the engine's delivery gate on the
  artifact); `compat-lint` (ADR-034 at the resolved level). `--pixels` adds the CIELAB
  source-colour comparison of the deep SVGs (`palette-delta-e`, warning only: a 1 % coverage
  floor and ΔE above 10).
- **Artifact.** `--file`, else `out/manifest.json`'s `file`, else the single `*.pptx` under
  `out/`. A missing artifact is an `artifact-missing` error and the package sources are named
  in `skipped`, never silently passed.
- **Strictness.** Errors always fail; `--strict` makes warnings fail too. A source that cannot
  run appears in `skipped` with its reason; `prompt-audit` is skipped until the M6 SKILL
  exists, because the engine command registry does not carry it.
- **Evidence.** On the rendered golden deck the non-strict gate is green with 11 sources and
  five advisories from the SVG quality gate; `--strict` is red on those advisories until the
  fixture is compacted or the strict surface is scoped (ADR-035, M8).

## 13. Source pipeline and URL policy (M5)

- **Owner.** `src/policy/url-policy.ts` owns the URL guard; `src/commands/source.ts` owns
  the conversion flow. Both are used only by `dsh-ppt source` today.
- **URL policy.** http(s) only; no credentials; a host must be given; `localhost`,
  `*.localhost`, `*.local`, `*.internal` and `metadata.google.internal` are refused before
  DNS; the port must be 80 or 443; the URL is at most 2048 characters; and **every**
  resolved address must be public (`loopback`, `private`, `link-local`, `CGNAT`,
  `multicast`, `reserved`, `unspecified`, unique-local IPv6 and IPv4-mapped forms are
  blocked). DNS failure fails closed. The engine also never receives
  `--allow-private-hosts`.
- **Routes.** `.pdf` → `pdf-to-md`, `.docx/.doc/.html/.htm/.epub` → `doc-to-md`,
  `.xlsx/.xlsm/.xls` → `excel-to-md`, `.pptx` → `ppt-to-md`, `.md/.markdown` → `markdown`,
  `.txt` → `text`, URLs → `web-to-md`; the unified `source-to-md` dispatcher is called with
  `-t <type>`. A directory input stands for its files (one level).
- **Outputs.** One Markdown file per input under `-o <dir>` (default `sources/`), named
  after the input and de-duplicated with a `-2` suffix; the engine may also write
  `<stem>.conversion_profile.json`, which is recorded in the manifest. `sources/` receives
  `source-manifest.json` with `{input, type, output, bytes, profile?}` per entry.
- **Images.** `dsh-ppt images search <query> [--from-url <url>]` calls `image-search` with
  `-o assets` and `--manifest assets/image_sources.json`, so the engine appends one entry
  per download: `filename`, `provider`, `author`, `license_name`, `license_url`,
  `license_tier`, `attribution_required`, `attribution_text`, `source_page_url`,
  `download_url`, `search_query`, `slide`, `purpose`, `width`/`height`. The command
  validates every item (`filename`, `provider`, `license_name`, and `attribution_text`
  whenever `attribution_required`) and fails the run otherwise, so a recorded image can never
  be unattributed. `--strict-no-attribution` is passed to the engine and re-checked here;
  `--from-url` passes the same public-http policy as `source`. A filename is required by the
  engine in single-query mode, so one is derived from the query (or the URL extension) when the
  caller does not name it.
- **Caps.** The written Markdown must be non-empty and at most 5 MiB
  (`SOURCE_MAX_BYTES`); anything larger is a `ContractViolation`. Fetch-time MIME and byte
  limits stay the engine's responsibility (it writes Markdown text, and remote images stay
  links unless the caller asks otherwise) — ADR-039.
