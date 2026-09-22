# Architecture

`@dsh-ppt/dsh-ppt-fusion` fuses two upstream engines under one DeepSeek Harness plugin.
This document records the runtime boundary between them, what each layer owns, and the
invariants the code enforces. Plan references are to `PPT-FUSION-PLAN.md` **v4**; the
authoritative arbitration record is `docs/decisions.md` (ADR-001…030) — when they
conflict, the newer ADR wins and the plan is updated to match.

## Dual runtime (S2)

The package is a **Node program that drives a locked Python engine**. There is no
in-process FFI and no shared memory: everything between the two runtimes travels as
argv, files, and exit codes.

```
DSH session (model)
  │  follows skills/dsh-ppt-fusion/SKILL.md
  ▼
dsh-ppt CLI                        node >= 22.19
  │  src/cli.ts → src/commands/*
  ├── src/frontend.ts ────────────► node node_modules/@liustack/pptwise/dist/cli.js
  │      (IR v5 in, pptx out)          npm dependency, version 0.35.0, JS API sealed
  │
  └── src/engine/master.ts ───────► <venv>/Scripts/ppt-master.exe
         (SVG in, pptx out)          PyPI dependency, version 0.1.128, uv venv
             │
             └── src/engine/venv.ts  owns the venv, resolves uv without PATH
```

| Runtime | Installed by | Version pin | Where it lives |
|---|---|---|---|
| Node | the user | >= 22.19 | system |
| pptwise | `pnpm install` | `0.35.0` exactly | this package's `node_modules` |
| ppt-master | `dsh-ppt doctor --repair` | `0.1.128` exactly | `%DSH_HOME%/ppt-fusion/venvs/ppt-master-0.1.128` (uv venv) |

The venv is created on the user's machine from `python-assets/requirements.lock` and is
never shipped: that keeps `PyMuPDF` (AGPL-3.0), which arrives with ppt-master, out of
anything redistributed. `docs/licensing.md` lands with M9 and is the release-time
full/minimal checklist.

## Layers and ownership

| Layer | Owns | Must not |
|---|---|---|
| `dsh/index.js` (M7) | DSH plugin registration, skill registration, preview tool and route | contain generation logic |
| `src/cli.ts` | argv parsing, exit codes, wiring | render anything |
| `src/frontend.ts` | locating and driving the pptwise CLI, JSON parsing, its failure classes | import pptwise internals (its `exports` map seals them) |
| `src/bridge/theme.ts` (M2) | ThemeFile → `tokens.json` → engine palette; colour-consistency audit | edit upstream theme files |
| `src/bridge/route.ts` (M2) | per-page engine choice; deep-page file completeness | degrade silently when a deep page is incomplete |
| `src/bridge/merge.ts` (M4 ✅) | slide-level OOXML merge, closure import, layout remap, content-aware reuse | parse or rewrite shape semantics |
| `src/bridge/post.ts` (M4 part 2 ✅) | the single place animations, transitions and narration are applied | run before the merge |
| `src/bridge/compat.ts` (M4 part 2 ✅) | the compatibility pass (scan, registered downgrades, MCE/PNG stamping through `sharp`, lint) against `src/compat/registry.json` | transform anything the registry does not name |
| `src/engine/venv.ts` | venv lifecycle, uv resolution, lock-file install, repair | install anything on the DSH boot path |
| `src/engine/master.ts` | the only spawn site for Python; timeouts, error classes, logs | accept an unregistered command or a path outside the workspace |
| `src/engine/runner.ts` | the child-process primitive and the environment whitelist | inherit credentials by default |
| `src/audit.ts` (M2/M4) | aggregating pptwise audit, OPC checks, engine checks into one report | swallow a failing gate |
| `src/logging.ts` | per-run diagnostics under `<deck>/.dsh-ppt/logs/` | delete or rewrite deck data |

## Boundaries

**Process boundary.** `src/engine/contracts.ts` registers the engine subcommands this
package may run, each with its enum-validated flags, timeout class and contracted output
files. A command that is not registered is unreachable, which is how the v1 non-goals
(`image-gen`, the `video-*` family) stay unreachable rather than merely undocumented.
Every path argument is proven to sit inside the deck workspace before it reaches argv.

**Module boundary.** pptwise is consumed through its CLI only. Its JavaScript API exists
in `dist/index.js` but is deliberately absent from its `exports` map, so importing it
would be an unsupported dependency on internals.

**Filesystem boundary.** The engine writes inside the deck workspace, `<deck>/.dsh-ppt/`
and its own venv, nowhere else. Published artifacts are written atomically to
`<deck>/out/` only after every gate passes.

**Network boundary.** Rendering never needs a key and never reaches the network
(acceptance S10). Only `doctor --repair` (venv build), `source <url>`, `images search`
and narration providers may touch the network, and each is an explicit command.

**Environment boundary.** `buildEnv` is default-deny: only a fixed list of system
variables plus `ENGINE_ENV` (`PYTHONIOENCODING`, `PYTHONUTF8`, `PYTHONDONTWRITEBYTECODE`,
`PYTHONNOUSERSITE`) reaches a child. A credential (for example a stock-photo API key)
passes only when a caller names it in `allowCredentials`.

## Invariants

- **P1 — single master.** A merged deck contains exactly one
  `ppt/slideMasters/slideMaster*.xml`, and every slide layout resolves to it. Enforced by
  `scripts/opc-invariants.mjs --single-master` and wired into the merge gate — **verified
  on real fixtures at M0 and again at M4** (47 parts, 1 master, ADR-018/028).
- **Deep pages are absolute.** Deep pages are authored as absolutely positioned SVG and
  exported with `--pptx-structure flat`, so remapping their layout onto the receiving
  deck's layout cannot move content.
- **Deterministic tiers.** T1 (semantic equality after canonicalisation —
  `tests/support/canonicalize.ts`, run by `pnpm fixtures:verify`) is the hard CI gate; T2 (our own bytes stable) is a goal; T3 (whole chain byte-identical) is never a
  v1 gate, because the upstream exporter timestamps its output (ADR-014, ADR-017).
- **Model-visible means logged.** Anything that reaches a model request is
  reconstructable from the DSH session log; this package also keeps its own per-run logs
  under `<deck>/.dsh-ppt/logs/`.
- **Failures are classified, never stringly.** Every failure carries a code from a closed
  union in `src/engine/errors.ts`, and the CLI prints `dsh-ppt: <code> <message>`.
- **Compatibility is declared, not assumed.** Every version-sensitive marker is listed in
  `src/compat/registry.json` with its minimum Office version, WPS support and required
  fallback. A package that uses something above the deck's `--compat` level is an error
  unless the registry names a downgrade — silent degradation is the failure mode this
  invariant exists to prevent (v3 §3.14, `docs/compat/probe.md`).

## Environment facts this design depends on

Measured in M0 on the development machine (ADR-003, ADR-016):

- `uv` is not on PATH; it lives in the Windows Store interpreter's `local-packages`
  script directory, so `resolveUv` searches known absolute locations before PATH.
- `uv`-created venvs have no `pip`; all Python package operations go through uv.
- The harness shell is Windows PowerShell 5.1: no `pwsh` on PATH, `Set-Content -Encoding
  utf8` writes a BOM, and `[Content_Types].xml` needs `-LiteralPath` because PowerShell
  treats brackets as a wildcard. Generated files are therefore written by Node.
- Child-process pipes work here; the file-contract style is chosen for replayability and
  large payloads, not because pipes fail (ADR-004).

## Where things live

```
src/cli.ts                 command line entry (bin: dsh-ppt)
src/commands/              one file per subcommand
src/bridge/opc.ts          OPC primitives: parts, rels, content types (M4 ✅)
src/bridge/merge.ts        slide-level merge, layout remap, closure import (M4 ✅)
src/bridge/theme.ts        ThemeFile v2 → tokens → master palette (M2 ✅)
src/bridge/post.ts          animations/transitions applied post-merge (M4 part 2 ✓)
src/bridge/compat.ts        compat pass: scan/transform/stamp/lint (M4 part 2 ✓)
src/compat/registry.json   feature→minOffice→WPS→downgrade table (M0.G measured)
src/engine/runner.ts       child-process primitive + environment whitelist
src/engine/contracts.ts    engine command registry, enums, argv builders
src/engine/venv.ts         venv lifecycle, uv resolution, lock install/repair
src/engine/master.ts       typed engine surface (the only Python spawn site)
src/engine/errors.ts       failure codes
src/frontend.ts            pptwise CLI wrapper
src/logging.ts             per-run diagnostics
tests/support/             T1 canonicalize, golden record/verify, fake engines, theme snapshots
src/audit.ts               multi-source audit aggregation (growing with M4/M5)
python-assets/             requirements.in, requirements.lock, upstream SHA manifest
scripts/                   gates: opc-invariants, win-com-smoke, M0 measurement tools
fixtures/                  hello deck (golden input), deep project, golden packages + golden-manifest.json
docs/                      this file, contracts, cli, decisions, m0-*, compat/, licensing
README.md                  architecture summary and command surface
```
