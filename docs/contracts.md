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
| `mirror-template-materialize <import_ws> <template_ws> [--kind deck\|layout]` | — | deterministic mirror template (M5) |
| `image-search <query> [--provider …] [--strict-no-attribution]` | `--provider {openverse,wikimedia,pexels,pixabay}` | downloads into the project, writes attribution data (M5) |
| `source-to-md` family (`pdf-to-md`, `doc-to-md`, `excel-to-md`, `ppt-to-md`, `web-to-md`) | — | Markdown into `sources/` (M5) |
| `notes-to-audio`, `narration-sync {fingerprint,animations,subtitles}` | `--provider` (default `edge`, no key) | per-slide audio + timeline (M5) |

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