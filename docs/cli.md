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
| pptwise front end | `@liustack/pptwise` resolves and its version matches the pin |
| PowerPoint COM | Windows only: a COM `PowerPoint.Application` can be started and reports its version |
| Self-test render | one cover page renders through the front end and the pptx appears |

`--repair` rebuilds the engine venv first (it never touches deck data). `--json` prints
the full `DoctorReport` for machine consumption. Exit code is 0 only when no check
failed and the self-test passed.

## Planned

The remaining surface from plan §3.9, with the milestone that lands it:

| Command | Milestone |
|---|---|
| `init`, `plan`, `theme ensure/list/new/fork/try`, `brand extract`, `tokens export`, `validate` | M2 |
| `deep check/chart`, `source`, `images search` | M3/M5 |
| `render`, `audit`, `post animate`, `narrate`, `preview`, `serve`, `deep template create/apply`, `deep native roundtrip` | M4/M5 |
| `resume`, `skill audit` | M6 |

Options are registered with commander in `src/commands/*.ts`; a change to a documented
option is an ADR, because the skill teaches the surface.
