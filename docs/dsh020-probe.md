# DSH 0.2.0 probe (V11 Track A, ADR-079 update, ADR-089)

Measured 2026-09-30 on this machine. Companion records: `docs/dsh017-probe.md` (the 0.1.7 line this one
extends), `docs/v020-eval.md` (the four-scenario model run), `docs/compat/dsh-versions.md` (the support
matrix, V11 A5).

## Runtimes measured

| Runtime | Path (this machine) | dsh | gate | how |
|---|---|---|---|---|
| 0.2.0-rc.2 | `%TEMP%\dsh020-runtime` (scratch `npm install`) | 0.2.0-rc.2 | `@deepseek-ai/dsh-app-boot` `evaluatePluginCompatibility` | A1 CI leg + local gate/smoke |
| 0.2.0-rc.2 (desktop) | desktop app bundled runtime | 0.2.0-rc.2 | same | registration probe, ADR-079 update |
| 0.1.7-rc.2 | `%TEMP%\dsh017-runtime` (scratch install) | 0.1.7-rc.2 | same API | A1 CI leg + local gate/smoke |
| 0.1.5-rc.2 | WebUI profile's runtime | 0.1.5-rc.2 | same API | registration re-measure, ADR-079 update |

`npm dist-tags` at the time of measurement: `latest` = `next` = `0.2.0-rc.2`, `alpha` = `0.1.7-alpha.2`.
The 0.2.0 line is assembled from ~40 `@deepseek-ai/dsh-*` packages; the plugin binds to five of them.

## The peer gate on the 0.2.0 line

`@deepseek-ai/dsh-app-boot` exports `evaluatePluginCompatibility(manifest, exemptions = {},
runtimeVersion = getDshRuntimeVersion())`, `pluginCompatibilityWarning(issue)`,
`readProfileCompatibility(profileDir)` and `PROFILE_COMPATIBILITY_FILENAME = "compatibility.json"`.

- The gate collects the peer names it governs (`@deepseek-ai/dsh`, `@deepseek-ai/dsh-*`) whose range does
  **not** satisfy the runtime under `includePrerelease: true`, and returns `undefined` when none is left.
- A mismatch returns an issue object — always, exempted or not — carrying `{name, version, runtimeVersion,
  peers, exempted}`. `exempted` is true when `compatibility.json` maps the exact `name@version` key to a
  list that contains the exact runtime version. The profile file is read with `readProfileCompatibility`,
  which reports a missing file as "no exemptions" and an unparsable one as a warning instead of failing.
- `--dump-config` is **not** evidence of admission: a plugin the gate refuses still appears in the composed
  tree. Only the verdict (and the runtime's own load-time behaviour) says whether it may run, which is why
  `scripts/dsh-compat-profile.mjs` now asks the runtime before it asserts on the dump (ADR-089).
- Measured trap, same shape as ADR-079's union lesson: a range of `>=0.1.2-rc.1 <0.2.0` **passes** the gate
  on 0.2.0-rc.2 (`includePrerelease`), while npm's install-time resolution does not put `0.2.0-rc.2` in it.
  A plugin can therefore install cleanly and still be refused at load, or satisfy the gate and not install.
  Both semantics are why `tests/dsh-peers.test.ts` asserts npm and gate behaviour for every line.

## This plugin's declaration

Five peers, each an 8-branch union ending in `|| >=0.2.0-rc.1 <0.3.0-0`:
`@deepseek-ai/dsh` (the runtime the bundle boots in), `@deepseek-ai/dsh-skill` (`ctx.skills.register`),
`@deepseek-ai/dsh-tools` (`ctx.tools.register`), `@deepseek-ai/dsh-client-ui-tool` (the web client
inject the client half lists) and `@deepseek-ai/cordis` (`^4.0.2`, the plugin API shape the package is
written against). `RUNTIME_LINES` in `tests/dsh-peers.test.ts` is `0.1.2-rc.1`, `0.1.7-rc.2`,
`0.2.0-rc.2`; `0.3.0-rc.1` and `1.0.0` are asserted **not** to satisfy the union.

## Registration on 0.2.0-rc.2 (measured, see ADR-079 update for the desktop run)

| Surface | Result |
|---|---|
| Skill | `dsh-ppt-fusion` registers (6,830 bytes) |
| Tools | `dsh_ppt_preview` registers with its schema; `dsh_ppt_review` binds to the scoped `attachments` service; `dsh_ppt_propose` registers |
| `webServer` routes | `/dsh-ppt-preview`, `/dsh-ppt-propose`, `/dsh-ppt-pptx` register in the plugin's own scope |
| Activation | count identical to the same profile without the plugin; no activation warning |
| 0.1.5-rc.2 re-measure | no warning at all |

The package imports no `@deepseek-ai/*` module: `dsh/index.js` uses Node builtins plus its own files and
binds only through `ctx.skills` / `ctx.tools` / scoped `ctx.inject`, which is why the same code runs on all
four lines.

## Gate and packed-plugin smoke on 0.2.0-rc.2

```
$ node scripts/dsh-compat.mjs --runtime %TEMP%\dsh020-runtime --expect 0.2.0-rc.2
dsh-compat ok: dsh-ppt-flashmade@0.6.1 vs dsh 0.2.0-rc.2 (4 dsh peer(s): @deepseek-ai/dsh,
  @deepseek-ai/dsh-client-ui-tool, @deepseek-ai/dsh-skill, @deepseek-ai/dsh-tools)

$ node scripts/dsh-compat-profile.mjs --runtime %TEMP%\dsh020-runtime --plugin <tgz> --expect 0.2.0-rc.2
dsh-compat profile ok: dsh 0.2.0-rc.2 composes dsh-ppt-flashmade@0.6.1 from dsh-ppt-flashmade-0.6.1.tgz
  (peer gate clean)
```

Negative control (a probe plugin ranging `>=0.1.2-rc.1 <0.1.3`, which npm installs but the gate refuses):
the smoke exits non-zero with the runtime's own `pluginCompatibilityWarning`; with `--exempt` it writes
`compatibility.json`, re-reads it through `readProfileCompatibility`, requires `exempted: true`, and then
reports `exemption exercised (dsh-ppt-refusal-probe@0.0.1 on dsh 0.2.0-rc.2)` with the profile composing.

## CLI and engine chain

The four scenarios in `docs/v020-eval.md` drive `dsh-ppt` end to end on this runtime (theme → storyboard →
per-page SVG → native PPTX → validate/quality gates → render pages → audit), so the CLI, the Python engine
venv and the rendering engines are exercised on 0.2.0-rc.2 by that run rather than by a separate smoke.
The Windows sandbox/ACL matrix for the subprocess chain is V11 A4.

## Follow-ups

- A2 finishes with `docs/v020-eval.md` and acceptance S46.
- A3 replaces the hand-written union with `scripts/gen-peer-union.mjs` driven by `RUNTIME_LINES`.
- A4 covers the Windows sandbox/ACL probes (venv python, sharp, LibreOffice/COM, ffprobe).
- A5 publishes the four-line support matrix in `docs/compat/dsh-versions.md` and marks 0.1.2-rc.1 as the
  first EOL candidate after v0.8.