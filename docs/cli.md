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
dsh-ppt: VenvMissing engine venv is absent at %USERPROFILE%\.dsh\ppt-fusion\venvs\ppt-master-0.1.128; run `dsh-ppt doctor --repair`
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
| `DSH_PPT_ASSET_DIRS` | path list of user asset libraries; each directory needs `asset-manifest.json` with a licence per item |
| `DSH_PPT_OFFICE_ROOTS` | `<category>=<dir>` entries (or bare `<dir>` for clip-art) the office discovery probes in addition to the install defaults |
| `DSH_PPT_ENABLE_IMAGE_GEN` | `1` enables the optional `images generate` extension; unset or `0` refuses with the asset fallback order |
| `GEMINI_API_KEY` / `OPENAI_API_KEY` | read only by an enabled `images generate` call, through that provider's explicit credential allowlist; no other child inherits them |
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

### `dsh-ppt init <dir> [--theme <preset>] [--profile <file>]`

Creates a deck workspace that already validates: `deck.ir.json` (cover + ending),
`deck.fusion.json`, `deck.storyboard.json`, then `theme ensure` for the bound preset. Refuses
to overwrite an existing manifest. The storyboard is written after the theme is materialised,
so each skeleton page gets the first layout its role may use in that theme's menu (V6 WP2).
With `--profile`, the deck-local `theme.json` is rewritten from the design profile (keeping the
preset id and menu), tokens/master-design are re-derived, chrome follows the profile (a reference
deck without page numbers writes `{pageNumber: {show: false}}`), the storyboard uses the patched
menu, and the profile is copied into the deck as `design-profile.json` with the manifest's
`designProfile` field pointing at it (ADR-066).

### `dsh-ppt plan <dir> [--from <file...>] [--confirm]`

Writes `deck.fusion.draft.json`: a schema-valid manifest skeleton plus the storyboard and the
list of fields a model still has to decide (`theme.preset`, `name`, `pages[].route`,
`storyboard`). With `--from` it outlines one content page per `##` heading and infers a `data`
kind for numeric headings. When the workspace already has a readable theme, the draft's
storyboard layouts are filled from that theme's menu; otherwise they stay `unconfirmed` until
the model fills them from `pptwise layouts`. The storyboard carries `role`, `layout`, `route`,
`chrome` and `budget` per page, and `plan --confirm` writes both `deck.fusion.json` and
`deck.storyboard.json`.

### `dsh-ppt validate <dir> [--json]`

Gates, in order: `manifest` (schema, with per-field messages), `ir` (page coverage and
`placeholder: true` on every deep page), `storyboard` (the file exists, covers every page,
agrees with the manifest on role/route/page number, every `layout` is a face of the bound
theme's menu under a slot its `role` may use, and every page stays inside its budget), `deep`
(each deep page directory holds `page.svg`), `post` (`post.animations` exists), `theme` (theme
file matches the binding and `tokens.json` is in sync), `palette` (warning: a deep page paints
a literal outside the deck palette), `chrome` (a declared `section` without `chrome.section`, a
missing `chrome.logo.file`, and — as a warning — a contract that skips every page). Exit 1 when
any error is present. Layout and budget problems report as `storyboard-layout` and
`budget-exceeded`.

### `dsh-ppt theme apply-profile <profile> [-o <file>] [--from <preset>] [--dir <dir>] [--json]`

Writes a ThemeFile v2 that combines one factory preset's menu/shape/story with a design
profile's palette, fonts and backgrounds. The output defaults to `<deck>/theme.json`, and the
theme keeps the preset's id so the deck's IR still resolves it (pptwise reads a deck-local
theme first); an existing file with a different id is refused rather than rebound to another
menu (ADR-052). The palette must clear the WCAG floor (`body|muted|title` on `bg`/`surface`
≥ 4.5, `onAccent` on `accent` and `accent` on `bg` ≥ 3.0); a failing palette is reported with
its ratios and never silently adjusted (ADR-066).

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

### `dsh-ppt render <dir> [-o <out>] [--compat <level>] [--no-storyboard]`

Renders the whole deck in one pass: pptwise `render --draft` for the standard pages (deep
pages are placeholders in the IR) → `deep render` for the deep pages → slide-level merge
with layout remap and the single-master invariant → OPC and delivery gates → atomic
publish to `out/<name>.pptx` plus `out/manifest.json` (sha256, slide count, exporter
receipts, merge report, staged artifacts).

Render refuses a deck whose `validate` reports errors, including the storyboard gates
(`storyboard-layout`, `budget-exceeded`) and a declared `designProfile` that is missing or
invalid; `--no-storyboard` drops the `storyboard` findings and exists for debugging only
(plan §4.1). A deck that declares `designProfile` also gets the profile's fonts applied after
the merge (runs ≥ 28 pt → heading family, digit-only runs ≥ 32 pt → number family, the rest →
body family, EA slot following), recorded in `out/manifest.json` as
`design: {fontPass, typefaces}` (ADR-066).

The same profile drives the post background layer, applied after motion and before chrome:
`flat` writes a solid `p:bg`, `svg` inserts a deterministic per-role SVG picture (built only
from blends of the profile's own colours) with an overlay shape at `background.overlayOpacity`,
and the pass refuses to publish when the overlay-blended background drops the profile's
title/body/muted inks below 4.5:1. The SVG picture is left for the compat pass to stamp with
its PNG sibling, so Office 2013 and 2016+ both render it; `out/manifest.json` records the
applied mode, per-slide roles, generated parts and `minContrast`. `photo`, `office` and `user`
have no asset reference in the profile yet, so they apply the flat colour and say so under
`design.background.notes` (ADR-067). When the same profile drives the standard pages, `render`
also applies its type scale, role anchors, card gaps and chrome before the font pass
(`design.pass` in `out/manifest.json`); deep pages keep their authored composition (ADR-069).

Every intermediate artifact is staged under `<deck>/.dsh-ppt/render/`, so a gate failure
leaves `out/` untouched and the workspace diagnosable. `--out` resolves against the deck.

When the manifest declares `post.animations`, the post pass applies that configuration after
the merge (transitions and entrances from one place, stripping whatever the engines wrote),
records what it applied in `out/manifest.json`, and fails the render if a selector matches no
shape. A deck with recorded narration gets its narration auto-advance recomputed from the
embedded audio bytes (no host probe) and, when a slide carries `advTm`, the package regains
`p:showPr useTimings="1"`; `out/manifest.json` records `showTimings`.

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

### `dsh-ppt audit <dir> [--json] [--strict] [--pixels] [--file <pptx>] [--compat <level>] [--profile <file>] [--roles <spec>]`

Runs the unified audit gate (plan §3.8) over a workspace: the `validate` pass, pptwise's own IR
validation and geometry audit, the deep SVGs' quality gate, the published package's OPC
integrity plus the single-master invariant, the chrome contract (V6 WP1: coverage, skip,
geometry, footer/section text, logo reference, baked page-number strip, and an overlap warning),
the engine's delivery check, the compat lint, and optionally the CIELAB colour comparison of the
deep SVGs (`--pixels`). Errors fail the command; `--strict` also fails on warnings. Without an
artifact the command reports `artifact-missing` and names the package sources it skipped instead
of passing silently.

`--profile <design-profile.json>` adds the `design` source (ADR-062): the package is
re-measured with the extractor's own procedure and compared against the profile inside fixed
tolerances — title/body size ±1 pt, colour ΔE ≤ 3, title anchor and card gap ±0.05 in, section
watermark size, chrome booleans, the column count, the background mode, the SVG PNG fallback
and the `office`/`user` picture provenance. Picture pages are read as pixels: body text must
keep 4.5:1 over at least 70 % of the picture under it (after the overlay blend); a page
without an overlay shape reports the same measurement as a warning. Roles come from the
storyboard/IR when the deck loads, else from `--roles "cover=1;toc=2;content=3,4;ending=5"`
(or a JSON index map); a `--file` outside the workspace audits the package only and names the
workspace sources in `skipped`, so `--profile` can check a reference deck in place.

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

### `dsh-ppt images generate "<prompt>" [--provider gemini|openai-compatible] [--dir <dir>] [-o <dir>] [--filename <name>] [--aspect-ratio <ratio>] [--image-size <size>] [--purpose <text>] [--slide <n>] [--json]`

The optional image-generation extension (V7.2 B5.5, ADR-064). Disabled by default: without
`DSH_PPT_ENABLE_IMAGE_GEN=1` it fails `ContractViolation` and prints the asset fallback order
(`svg → user → office (when discovered) → flat → photo (images search)`). Enabled, it requires
the provider key (`GEMINI_API_KEY`, or `OPENAI_API_KEY` for `openai-compatible`), calls the
engine's `image-gen` with only that provider's environment knobs, writes the image into
`assets/` (default `ai-<prompt slug>.png`) and records `provider: ai-image-*`, the prompt
summary, size, the review note and attribution text in `assets/image_sources.json`; the same
file name replaces its record and a new name appends. A generated image is never returned
without that record, and the default render path never touches this module.


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

## Implemented (M6)

### `dsh-ppt resume <dir> [--json] [--write]`

Reads `.dsh-ppt/checkpoint.json`, checks every artifact the checkpoint claims — including the
`storyboard` path phase 3 and later must reference — against the filesystem, and prints the
phase, the published package from `out/manifest.json` (`file`/`sha256`/`bytes`/`slides`) and the
entry commands of the next phase. Missing artifacts make the report `ok: false` and the exit
code 1; an unreadable checkpoint is a `ContractViolation` naming the field. `--write` also
persists the brief to `.dsh-ppt/resume.md` for a fresh session.

### `dsh-ppt skill audit [--json] [--strict]`

Runs the engine's `prompt-audit` over `skills/dsh-ppt-fusion/**/*.md` and the vendored
ppt-master docs with `skills/dsh-ppt-fusion/prompt_audit_manifest.json`: token budgets,
per-file and per-load-set ceilings, local reference integrity, duplicate paragraphs and the
authority graph. Errors fail; `--strict` makes warnings fail too. The corpus measures
109 510 tokens against the 120 000-token ceiling (ADR-044).

## Implemented (M7)

### `dsh-ppt preview <dir> [-o <dir>] [--html] [--json]`

Renders every page to SVG for review. Standard pages come from pptwise `preview` over the
deck's IR; each deep page's placeholder is replaced by the authored `deep/<dir>/page.svg`, and
with `--html` the self-contained viewer is patched in place when its inline markup still
matches. Default output `.dsh-ppt/preview`. The plugin's `dsh_ppt_preview` tool calls this
command and serves the result through `/dsh-ppt/preview` (ADR-049).

### DSH plugin bundle

`dsh/index.js` + `cordis.patch.yml` + `dsh/client.js` register the `dsh-ppt-fusion` skill, the
`dsh_ppt_preview` tool and the preview card. `pnpm prepack` builds and then runs
`scripts/check-pack.mjs`, which refuses a tarball that misses any of the 17 runtime files
(CLI, plugin shell, skill, vendored docs, lock). Install/uninstall, the `-w` requirement and
the M7.5 scratch-profile rehearsal are documented in [install.md](install.md) (ADR-050).

## Implemented (v0.3)

### `dsh-ppt design profile extract <file> [-o <output>] [--roles <spec>] [--copy-media] [--dir <dir>] [--json]`

Reads the numeric design system out of one reference `.pptx` and writes
`design-profile.json` (default name, resolved against `--dir`): canvas EMU, palette hex,
fonts, per-role title/body styles, per-role title anchor and column geometry, chrome booleans
and a background mode with overlay opacity. The extractor runs under the engine venv's Python
(python-pptx); the output is validated by the strict schema in `src/schema/design-profile.ts`.
It carries no text, no media and no input path. `--roles` overrides the measured roles, e.g.
`cover=1;content=2,3`; `--copy-media` is off by default and, when given, copies the deck's media
into `<output dir>/.dsh-ppt/design-media` (an ignored scratch directory). `pnpm design:verify`
re-extracts the deck named by `DSH_PPT_REFERENCE_DECK` and compares it with
`fixtures/reference/profile.json`; without that variable it skips (ADR-061).

### `dsh-ppt assets discover --source office [-o <file>] [--dir <dir>] [--json]`

Probes the machine's Office/WPS asset roots (`CLIPART`, `Templates`, `LiveContent`, plus any
`DSH_PPT_OFFICE_ROOTS` entries) and records every probed root with its per-format counts and the
supported files in `office-assets.json`, by default under
`<DSH_HOME>/ppt-fusion/assets/`. A discovery that finds no supported file fails with the
svg/user/flat fallback instead of writing an empty record; a record is a machine property, so it
never lives in a deck (ADR-067).

### `dsh-ppt assets list --source <office|user> [--record <file>] [--category <c>] [--format <f>] [--dir <dir>] [--json]`

Lists the offices recorded by `discover`, or the user libraries named by `DSH_PPT_ASSET_DIRS`
and/or `<deck>/assets/asset-manifest.json`. Every user item needs a licence; a missing manifest,
licence, supported format, escaping path, duplicate id or absent file is reported
(`ContractViolation`/`OutputMissing`), and an office record whose files disappeared asks for a
fresh `discover`.

### `dsh-ppt assets copy <id> --source <office|user> [-o <dir>] [--as <file>] [--force] [--record <file>] [--dir <dir>] [--json]`

Copies one listed item into the deck (default `assets/<id>.<format>`); `--as` may rename but must
keep the item's extension. The destination must stay inside the deck, different existing bytes
are refused without `--force`, and identical bytes are reported as `unchanged`, so reruns are
idempotent (ADR-067).

## Implemented (V10 Part A)

### `dsh-ppt renderpages <dir> [-o <dir>] [--file <pptx>] [--engine powerpoint|libreoffice|both] [--scale 1|2] [--max-pages <n>] [--max-pixels <n>] [--required] [--force] [--json]`

Rasterises the deck's published pptx into page images for the render-level gates and the model
review loop (ADR-081). Each engine writes `<deck>/.dsh-ppt/render/<engine>/page-NNNN.png` plus
`manifest.json` — engine version, source sha256, scale/dpi, limits, and per-page size and sha256 —
and the run rewrites `.dsh-ppt/render/pages.json` with the same records. The cache key is
`sha256(source bytes + engine + engine version + scale + limits)`, so an untouched deck re-runs with
every engine marked `cached`; `--force` re-renders. `--engine both` runs PowerPoint COM first
(Windows hosts only; `scripts/win-com-export-pages.ps1` opens the deck read-only and headless and
leaves its bytes unchanged) and the LibreOffice Kit second. Kit discovery follows the plan's order:
`DSH_PPT_LOKIT_CLI` (plus `DSH_PPT_LOKIT_NODE`) → a Kit installed beside the plugin or inside a DSH
runtime under `$HOME` → system `soffice` with `pdftoppm`. `--scale 2` exports at 192 dpi;
`--max-pages` defaults to 30 and `--max-pixels` to 16777216 per page. An engine that cannot run is
recorded as `skipped` with its reason and a fix hint, unless `--required` turns it into a
`ContractViolation`.
### `dsh-ppt text-measure [text...] --size <pt> [--dir <dir>] [--family <font>] [--weight <w>] [--letter-spacing <px>] [--box <WxH>] [--line-height <px>] [--json]`

Measures text with the engine's DrawingML estimator (`ppt-master text-measure`, V10 Part A), so
"will this fit?" becomes a number before any SVG is written. Without `--box` every argument is
measured as a single line in one engine call; with `--box` the arguments join into one paragraph
that is wrapped against the box, and the report says whether it fits or overflows on either axis
(`overflow: ["x"]` for a line wider than the box — an unbreakable word — and `["y"]` for a block
taller than it). `--size` is mandatory; `--family`/`--weight`/`--letter-spacing` mirror the
authoring style, and `--line-height` defaults to `1.2 × size`. The measurement itself is
deck-independent; `--dir` only chooses the workspace whose engine venv and log directory are used.
## JSON output

Every leaf command accepts `--json` and prints one JSON document on stdout (exit codes are
unchanged). `version` prints its version string only. Report-shaped commands carry a
`schemaVersion` field where the shape is a contract: `dsh-ppt audit` emits
`{schemaVersion: 1, ok, strict, findings, sources, artifact, compatLevel, pixels, skipped}`,
`dsh-ppt resume` and `dsh-ppt skill audit` carry their own report objects, and receipt commands
(e.g. `init`, `render`, `deep render`) print their result object. A CLI test walks the built
program and fails when a leaf command loses `--json`.

## Planned

The remaining surface from plan §3.9, with the milestone that lands it:

| Command | Milestone |
|---|---|
| — | — |

`deep check|chart` and `serve` were dropped in v0.2.0 rather than carried indefinitely:
neither is on a release path and the CLI must not advertise a surface no milestone owns
(ADR-065, CHANGELOG v0.2.0). Options are registered with commander in `src/commands/*.ts`;
a change to a documented option is an ADR, because the skill teaches the surface.
