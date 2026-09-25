# DSH 0.1.7 probe (V8 Part 0, ADR-079)

Date: 2026-09-25. What the 0.1.7 runtime changes for this plugin, the peer gate it
introduced, and the dual-line evidence that keeps the plugin installable on both
supported runtimes. Measured on this machine; `scripts/dsh-compat.mjs` and
`scripts/dsh-compat-profile.mjs` repeat the checks in the `dsh-compat` CI job.

## Runtimes measured

| Runtime | Path (this machine) | dsh | cordis | dsh-skill / dsh-tools / dsh-client-ui-tool | dsh-attachment | dsh-skill-office |
|---|---|---|---|---|---|---|
| 0.1.2-rc.1 (baseline until 2026-09-25) | `~/dsh-rc1-runtime` | 0.1.2-rc.1 | 4.0.2 | 0.1.2-rc.1 | 0.1.2-rc.1 | **absent** |
| 0.1.7-rc.2 (baseline since 2026-09-25) | `~/dsh-017-runtime` | 0.1.7-rc.2 | 4.0.4 | 0.1.7-rc.2 | 0.1.7-rc.2 | 0.1.7-rc.2 |

The three V9 levers exist on the new line: `dsh-skill-office` ships the LibreOffice
Kit CLI, `dsh-attachment` accepts PNG/JPEG/WebP/GIF prompt attachments, and
`dsh-subagent` / `dsh-tool-subagent` plus `dsh-compaction-image-offload` are
installed. `dsh-skill-office` is not in the 0.1.2 runtime, so the render-snapshot
work (V9 Part A) is 0.1.7+.

## The peer gate (0.1.7 line)

`@deepseek-ai/dsh-app-boot` exports `evaluatePluginCompatibility(manifest, exemptions,
runtimeVersion)`:

- It reads `peerDependencies` and evaluates only names equal to `@deepseek-ai/dsh` or
  starting with `@deepseek-ai/dsh-`; other peers (for example `@deepseek-ai/cordis`)
  are ignored by the gate.
- `workspace:^`, `workspace:~` and `workspace:*` mean the running runtime; any other
  range is checked with prereleases participating.
- A mismatch disables the plugin unless `compatibility.json` in the profile grants an
  exact `name@version` → runtime-version exemption (`dsh plugin allow-version`). The
  file must be written without a BOM: the 0.1.7 reader does not strip one and silently
  ignores the whole file.
- The 0.1.2-rc.1 runtime has **no such gate** (`evaluatePluginCompatibility` and
  `getDshRuntimeVersion` are absent from its app-boot), so only the profile smoke
  applies there.

## This plugin's declaration (ADR-079)

`package.json#peerDependencies`:

| Peer | Range | Why |
|---|---|---|
| `@deepseek-ai/dsh` | the union range below | the runtime the bundle boots in |
| `@deepseek-ai/dsh-skill` | `>=0.1.2-rc.1 <0.2.0` | the `skills` service the plugin registers into |
| `@deepseek-ai/dsh-tools` | `>=0.1.2-rc.1 <0.2.0` | the `tools` service the preview tool registers into |
| `@deepseek-ai/dsh-client-ui-tool` | `>=0.1.2-rc.1 <0.2.0` | the web client inject the client half lists |
| `@deepseek-ai/cordis` | `^4.0.2` | the plugin API shape (`inject`, effects) it is written against |

The ranges are unions with one branch per supported line — `>=0.1.2-rc.1 <0.1.3 || … || >=0.1.7-rc.1
<0.1.8 || >=0.1.8 <0.2.0-0` — because npm and pnpm only admit a prerelease when a comparator on the
same `major.minor.patch` tuple carries a prerelease tag: the earlier `>=0.1.2-rc.1 <0.2.0` passed the
runtime gate (`includePrerelease: true`) but would have failed an install on `0.1.7-rc.2` with
`ERESOLVE`. The runtime's own gate still reads the union as compatible, and `tests/dsh-peers.test.ts`
checks both semantics for every line in `RUNTIME_LINES`, so a newly supported line must extend the
union.

Verified on this machine:

- `node scripts/dsh-compat.mjs --runtime <0.1.7 root>` → `dsh-compat ok` (four dsh peers).
- Negative control (`@deepseek-ai/dsh: ">=9.0.0"`) → the runtime's own
  `pluginCompatibilityWarning`, exit 1, proving the check is the real gate.
- `node scripts/dsh-compat.mjs --runtime <0.1.2 root> --allow-missing-gate true` →
  `skipped` (no gate on that line).
- `node scripts/dsh-compat-profile.mjs` packs the plugin, installs it into a scratch
  profile and composes it: ok on **both** runtimes.

## Scratch smoke of 2026-09-25 (isolated home, recorded in `~/.dsh/CHANGELOG-dsh.md`)

- Official peer gate over the profile's third-party plugins: 54/54 passed on 0.1.7
  rc/alpha lines.
- `@deepseek-ai/dsh-lsp-stdio@0.1.7-rc.1` and `@deepseek-ai/dsh-storage-sqlite@0.1.7-rc.1`
  pin their peers to `0.1.7-rc.1` exactly, so the profile needed an exact-version
  exemption in `compatibility.json`; without it six core entries stay pending
  (storage domain unavailable).
- `@linxin666/dsh-deepseek-usage-dashboard` fails to import on 0.1.7 (removed settings
  API); the user replaced it with `@linxin666/dsh-usage@0.4.2` outside this plugin's
  scope.

## Follow-ups owned by V9

- `docs/compat/dsh-versions.md` will carry the runtime matrix as the V9 docs set grows.
- Part A's LibreOffice engine pins `dsh >= 0.1.7`; the CI render leg runs LibreOffice
  from the distro, not from the Kit.
