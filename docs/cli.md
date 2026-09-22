# CLI

`dsh-ppt` is the package's only user-facing entry point. Anything a model can do with
this toolchain goes through a subcommand here, so the command surface is also the
security surface: the engine whitelist in `src/engine/contracts.ts` contains exactly the
commands listed below as implemented or planned, and nothing else.

## Invocation

| Form | Use |
|---|---|
| `dsh-ppt <command> [options]` | installed bin (`dist/cli.js`) |
| `node <plugin>/dist/cli.js <command>` | how the DSH skill preamble calls it |
| `pnpm dsh-ppt <command>` | source launch through tsx, for development |

## Exit codes

| Code | Meaning |
|---|---|
| 0 | the command did what it was asked |
| 1 | classified failure; stderr carries `dsh-ppt: <code> <message>` |
| 2 | usage error (unknown command, missing argument) |

Every failure line starts with the package name and a stable code from
`src/engine/errors.ts`:

```
dsh-ppt: VenvMissing engine venv is absent at C:\Users\dell\.dsh\ppt-fusion\venvs\ppt-master-0.1.128; run `dsh-ppt doctor --repair`
```

Codes: `PptwiseMissing`, `PptwiseFailed`, `VenvMissing`, `EngineVersionMismatch`,
`UvMissing`, `SpawnFailed`, `EngineTimeout`, `EngineExit`, `OutputMissing`,
`ContractViolation`, `PathOutsideWorkspace`, `DoctorFailed`, `UsageError`.

## Environment

| Variable | Effect |
|---|---|
| `DSH_HOME` | where the engine venv tree lives; defaults to `~/.dsh` |
| `DSH_PPT_UV` | absolute path to `uv`; overrides the search |
| `DSH_PPT_PYPI_INDEX` | package index used by `doctor --repair`; defaults to the Tsinghua mirror |
| `DEEPSEEK_API_KEY` and friends | **not** inherited by any child process; a credential reaches an engine only through an explicit allow list |

## Implemented (M1)

### `dsh-ppt version`

Prints the package version. `-V/--version` does the same.

### `dsh-ppt doctor [--json] [--repair] [--no-self-test]`

Checks, in order:

| Check | Passes when |
|---|---|
| Node runtime | the running Node is >= 22.19 |
| uv | an absolute uv was found (override, Store `local-packages`, `~/.local/bin`, PATH, `python -m uv`) |
| Python interpreter | `python --version` reports 3.12+ |
| Engine venv | the venv holds the interpreter, the dispatcher and the pinned `ppt_master-<version>.dist-info` |
| ppt-master dispatcher | `<venv>/ppt-master --help` exits 0 and lists its commands |
| PNG rasteriser (compat mode) | the engine's own probe finds a renderer that imports *and* writes a PNG; a renderer that imports but cannot render fails too, with the import error in the detail line (`python-assets/probe-png-renderer.py`) |
| pptwise front end | `@liustack/pptwise` resolves and its version matches the pin |
| PowerPoint COM | Windows only: a COM `PowerPoint.Application` can be started and reports its version |
| Self-test render | one cover page renders through the front end and the pptx appears |

`--repair` rebuilds the engine venv first (it never touches deck data). `--json` prints
the full `DoctorReport` for machine consumption. Exit code is 0 only when no check
failed and the self-test passed.

On this machine the PNG rasteriser row is red by design: cairosvg is installed from the
lock but cannot import without a cairo runtime (`docs/compat/probe.md`). The compat pass
compensates by rasterising with Node-side `sharp` (plan B7); until that lands in M4 the
row stays visible on purpose.

## Implemented (M2)

### `dsh-ppt init <dir> [--theme <preset>]`

Creates a deck workspace that already validates: `deck.ir.json` (cover + ending),
`deck.fusion.json`, then `theme ensure` for the bound preset. Refuses to overwrite an
existing manifest.

### `dsh-ppt plan <dir> [--from <file...>] [--confirm]`

Writes `deck.fusion.draft.json`: a schema-valid manifest skeleton plus the list of
fields a model still has to decide (`theme.preset`, `name`, `pages[].route`). With
`--from` it outlines one content page per `##` heading and infers a `data` kind for
numeric headings. `--confirm` copies the draft into `deck.fusion.json`.

### `dsh-ppt validate <dir> [--json]`

Gates, in order: `manifest` (schema, with per-field messages), `ir` (page coverage and
`placeholder: true` on every deep page), `deep` (each deep page directory holds
`page.svg`), `post` (`post.animations` exists), `theme` (theme file matches the binding
and `tokens.json` is in sync), `palette` (warning: a deep page paints a literal outside
the deck palette). Exit 1 when any error is present.

### `dsh-ppt theme ensure <dir> [--json]`

Materialises the bound preset into `theme.json` (skipped when a matching copy exists),
then derives `tokens.json` and `master-design.json`. Idempotent: a second run reports
`0 changes` and starts no process.

### `dsh-ppt theme list [--json]`

The factory catalog: id, occasions, identity strength. 24 presets as of pptwise 0.35.0.

### `dsh-ppt theme new --from <id> -o <file> [--id <new>] [--dir <dir>]`

Copies a preset into a complete ThemeFile v2.

### `dsh-ppt theme fork <id> --primary <hex> [--id <new>] [-o <path>]`

Re-derives the palette from one new primary colour and keeps the page menu.

### `dsh-ppt theme try <ids> [-o <dir>]`

Renders the fitting-room sample under 2–4 candidate themes into a contact sheet, which
is how Phase 2 of the skill picks a theme from images rather than names.

### `dsh-ppt tokens export <preset-id|theme.json> [--master] [-o <file>]`

Without `--master`: the exported token file (colours, fonts, shape, backgrounds, source).
With `--master`: the master projection — role names (`slideBackground`, `cardFill`,
`structure`, `accent`, `bodyText`, `secondaryText`, `line`, `dataSeries`), the font
stacks, and the closed `palette` list a deep page may paint with.

## Implemented (M3)

### `dsh-ppt deep render <dir> [--page <n>] [-o <out>]`

Renders the deck's deep pages through the ppt-master engine into one pptx, in the order
M0 measured: `project init` (temporary, under `<deck>/.dsh-ppt/deep/`) →
`stamp-native-fallbacks --write` → `svg-quality-check --stage final --canonical-authoring`
→ `svg-to-pptx --quick-generate --native-charts-and-tables --with-notes`. It also writes
the `spec_lock.md` the gate demands, derived from the deck (canvas from the page format,
typography anchors from the font sizes the SVGs use, colours from `tokens.json`, primary
language from the pages' script).

The deck must already pass `validate` and have tokens in sync. `--page` renders one page
(the same code path as a batch of one); `--out` is resolved against the deck directory
because the engine only writes inside the workspace. Output paths are printed with the
exporter's report and its `[POSTFLIGHT]` receipt.

## Implemented (M4)

### `dsh-ppt render <dir> [-o <out>] [--compat <level>]`

Renders the whole deck in one pass: pptwise `render --draft` for the standard pages (deep
pages are placeholders in the IR) → `deep render` for the deep pages → slide-level merge
with layout remap and the single-master invariant → OPC and delivery gates → atomic
publish to `out/<name>.pptx` plus `out/manifest.json` (sha256, slide count, exporter
receipts, merge report, staged artifacts).

Every intermediate artifact is staged under `<deck>/.dsh-ppt/render/`, so a gate failure
leaves `out/` untouched and the workspace diagnosable. `--out` resolves against the deck.

When the manifest declares `post.animations`, the post pass applies that configuration after
the merge (transitions and entrances from one place, stripping whatever the engines wrote),
records what it applied in `out/manifest.json`, and fails the render if a selector matches no
shape.

The compatibility pass runs after the post pass and before the structural gates: it scans the
merged package against `src/compat/registry.json`, applies only the downgrades the registry
names (morph and advanced transitions become their MCE fade fallback), stamps the PNG sibling of
any `asvg:svgBlip` with Node `sharp` (B7), and lints MCE pairing and namespace declarations.
The report goes to `out/compat-report.json`, and its sha256, level, level source and counts go
into `out/manifest.json`. `--compat safe|standard|max` overrides the manifest's `compat`
field; the default is `standard`. An error-level finding fails the render before anything is
published.

### `dsh-ppt compat lint <file.pptx> [--dir <dir>] [--compat <level>] [--strict] [--json]`

Scans and lints an already-rendered package against the registry without changing it: the
read-only half of the render chain's compatibility step, useful for re-checking an artifact
against another level. Errors always fail; `--strict` also fails on warnings. `--json`
prints the occurrences and findings.

### `dsh-ppt audit <dir> [--json] [--strict] [--pixels] [--file <pptx>] [--compat <level>]`

Runs the unified audit gate (plan §3.8) over a workspace: the `validate` pass, pptwise's own IR
validation and geometry audit, the deep SVGs' quality gate, the published package's OPC
integrity plus the single-master invariant, the engine's delivery check, the compat lint, and
optionally the CIELAB colour comparison of the deep SVGs (`--pixels`). Errors fail the
command; `--strict` also fails on warnings. Without an artifact the command reports
`artifact-missing` and names the package sources it skipped instead of passing silently.

## Implemented (M5)

### `dsh-ppt post animate <dir> [--config <file>] [--file <pptx>] [-o <out>] [--json]`

Applies the deck's motion configuration to an already published package — the standalone form
of the pass `render` runs between the merge and the compat pass — then re-runs the compat pass
at the deck's level and refreshes `out/compat-report.json` and the compat/post blocks of
`out/manifest.json`. Entrance (`fade`/`wipe`/`fly`), emphasis (`spin`/`grow-shrink`) and
motion paths (`right`/`down`) are supported; blocks play entrance → emphasis → path, and a
selector that matches nothing fails the command. Without `--out`, the input package is
replaced atomically.

### `dsh-ppt narrate <dir> [--provider <p>] [--voice <v>] [--rate <r>] [--volume <v>] [--project <dir>] [-o <dir>] [--sync] [--list-voices]`

Generates per-slide narration audio for the deck newest deep project with `notes-to-audio`
(provider default `edge`, no key needed) and, with `--sync`, derives `narration_animations.json`
through `narration-sync animations` (that mode also needs the engine's own `animations.json`,
which the fusion does not use: its motion lives in `post/animations.json`). The roster is
authored per page as `deep/<page>/notes.md`; `deep render` copies it into the project, where
`notes-to-audio` reads it. The command refuses early when the roster is empty, and picks a
default edge voice from the deck script (Chinese or English). `-o <dir>` writes the audio beside
the deck (for example `narration/`); `deep render` then embeds every `narration/*.mp3` it finds
automatically, matching audio to slides by SVG stem, and sets auto-advance timings. TTS needs
network access to the provider; `--list-voices` is offline.


### `dsh-ppt images search [query] [--dir <dir>] [--provider <p>] [--orientation <o>] [--filename <name>] [--min-width <n>] [--min-height <n>] [--strict-no-attribution] [-o <dir>] [--manifest <file>] [--save-candidates] [--max-candidates <n>] [--from-url <url>] [--purpose <text>] [--slide <n>]`

Searches the openly licensed providers the engine knows (openverse/wikimedia need no key),
downloads one image into `assets/` and records it in `assets/image_sources.json` with its
author, licence, licence URL, source page and ready-made attribution text. Every manifest item
is validated: a missing licence or a required attribution without text fails the command, and
`--strict-no-attribution` refuses attribution-requiring licences outright. `--from-url`
downloads one directly selected image (licence recorded as `manual`) and passes the same
public-http policy as `source`.


### `dsh-ppt source <input...> [-o <dir>] [--dir <dir>] [--type <type>] [--no-images]`

Converts source documents into Markdown through the engine's unified dispatcher: PDF, DOCX
(and HTML/EPUB), XLSX, PPTX, Markdown and plain text by extension, and http(s) URLs through
`web-to-md`. Every URL passes the public-http policy first (scheme, credentials, port, length,
local names and every resolved address); a refusal names the rule and no process is started.
A directory input stands for its files. Outputs go to `sources/` (or `-o <dir>`) with a
`source-manifest.json` recording each entry and the engine's conversion profile.


### `dsh-ppt deep native roundtrip <dir> --file <pptx> [-o <dir>] [--inheritance-mode <mode>] [--keep-hidden] [--strict]`

Imports a published pptx back into the engine's source-preserving SVG workspace
(`--roundtrip --inheritance-mode both`, the minimal path plan §5 M5 item 5 asks for).
The editable slides land in `<output>/authoring-svg-flat/`; the workspace also carries
`analysis/native_structure.json` and `sources/source.pptx`, which is what `apply-template`
consumes as an exact root. Output defaults to `.dsh-ppt/roundtrip/<stem>`.

### `dsh-ppt deep template create <dir> --file <pptx> -o <template-dir> [--kind deck|layout]`

Two engine steps: `pptx-template-import` builds a reference workspace under
`.dsh-ppt/import/<stem>`, then `mirror-template-materialize` publishes the template
(template SVGs, text-slot files, `source_themes.json`, a Design Spec TODO). A
`template-manifest.json` beside it records the kind, the source pptx and the import
workspace. Templates are materialised from non-animated sources; the engine refuses an
import whose animations are not reconstructible (ADR-038).

### `dsh-ppt deep template apply <dir> --project <project> --template <root...> [--dry-run]`

Installs one or more template roots into an initialized project (`apply-template`), e.g.
the mirror template plus an SVG round-trip workspace. Two roots of the same kind are
refused before the engine runs; `--dry-run` prints the plan and the receipt.

### `dsh-ppt deep template register <dir> --kind <brand|style|layout|deck> [--id <id>] [--all] [--dry-run]`

Refreshes the engine's template index for one directory id or a whole kind.

### `dsh-ppt brand extract <file> -o <out> [--from <preset>] [--bind <deck>] [--dir <dir>]`

Reads colours and fonts out of an Office file through pptwise `brand extract` and writes a
ThemeFile v2. With `--bind`, the extracted theme is written into that deck as
`brand.theme.json`, the manifest's theme becomes `{file: "brand.theme.json"}`, and
`theme ensure` derives `tokens.json` and `master-design.json` — one command from a
customer deck to a deck this toolchain renders with.

## Planned

The remaining surface from plan §3.9, with the milestone that lands it:

| Command | Milestone |
|---|---|
| `brand extract`, `theme` file binding via `brand` | M5 |
| `deep check|chart` | M3/M5 |
| `preview`, `serve` | M4 part 2 / M5 |
| `resume`, `skill audit` | M6 |

Options are registered with commander in `src/commands/*.ts`; a change to a documented
option is an ADR, because the skill teaches the surface.
