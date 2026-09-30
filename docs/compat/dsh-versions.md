# DSH version support matrix (V11 A5)

Current as of 2026-10-01. Authoritative for which DSH lines this plugin claims; the ranges live in
`package.json` and are generated from `scripts/runtime-lines.mjs` (ADR-090).

## Lines

| DSH line | Status | CI evidence | Runtime evidence | Notes |
|---|---|---|---|---|
| `0.2.0-rc.2` | **first-class** (current) | `dsh-compat (0.2.0-rc.2)` leg: gate + packed smoke (ADR-089) | four-scenario model run on a scratch install, `docs/v020-eval.md`; registration probe on the desktop app's bundled runtime, ADR-079 update | `npm dist-tags` `latest` = `next` |
| `0.1.7-rc.2` | **first-class** | `dsh-compat (0.1.7-rc.2)` leg: gate + packed smoke | four-scenario model run, `docs/quality.md` v0.6.0 section; the profile that has been running since ADR-085 | carries the peer gate |
| `0.1.5-rc.2` | **supported, no dedicated leg** | — (not a `dsh-compat` leg) | registration re-measure 2026-09-29 (no activation warning, ADR-079 update); the WebUI profile still runs it | covered by the union's `0.1.5-rc.1`-band; a line the plugin must not break while WebUI stays on it |
| `0.1.2-rc.1` | **legacy — EOL candidate after v0.8** | `dsh-compat (0.1.2-rc.1)` leg: install + composition only | original baseline, `docs/dsh017-probe.md` | predates the peer gate, so that leg cannot prove gate compliance |

## What each row's evidence means

- **CI leg** — the pinned runtime is installed in CI, `scripts/dsh-compat.mjs` runs the runtime's own
  `evaluatePluginCompatibility` against the packed manifest, and `scripts/dsh-compat-profile.mjs` installs
  the tarball into a scratch profile, requires the gate verdict to be clean (or an explicit `--exempt`
  rehearsal) and asserts the composed tree carries the plugin layer and entry.
- **Runtime evidence** — what was measured by hand on a real profile: model scenario runs, the
  registration probe, or both. A line with runtime evidence but no CI leg is one the plugin must not break,
  yet nothing guards it on every push.
- **Gate semantics** — from 0.1.7 on, `@deepseek-ai/dsh-app-boot` evaluates every `@deepseek-ai/dsh*` peer
  with `includePrerelease`, while npm/pnpm resolve prereleases strictly. The union therefore carries one
  band per patch line (`COVERED_PATCH_LINES`); see ADR-079's updates and ADR-090.

## Support policy

- Adding a line = one edit in `scripts/runtime-lines.mjs` (the measured line, and the patch line when it is
  new), regenerate with `node scripts/gen-peer-union.mjs`, add the CI leg, and record a probe
  (`docs/dshXXX-probe.md`) plus a scenario run. `pnpm prepack` refuses a manifest that disagrees with the
  declared lines.
- Dropping a line = remove it from `RUNTIME_LINES`/`COVERED_PATCH_LINES`, delete its CI leg, and note the
  removal in the CHANGELOG. **`0.1.2-rc.1` is the first EOL candidate** once v0.8 ships and the migration off
  it is signed off; it stays until then because it is the documented fallback.
- The union deliberately refuses the next unmeasured minor (`0.3.0-rc.1`) and `1.0.0`, so a line the plugin
  never ran on cannot install by accident.