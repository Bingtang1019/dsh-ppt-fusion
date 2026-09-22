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

## Planned

The remaining surface from plan §3.9, with the milestone that lands it:

| Command | Milestone |
|---|---|
| `brand extract`, `theme` file binding via `brand` | M5 |
| `deep check|chart|template create|template apply|native roundtrip`, `source`, `images search` | M3/M5 |
| `audit`, `post animate`, `narrate`, `preview`, `serve`, `deep template create/apply`, `deep native roundtrip` | M4 part 2 / M5 |
| `resume`, `skill audit` | M6 |

Options are registered with commander in `src/commands/*.ts`; a change to a documented
option is an ADR, because the skill teaches the surface.
