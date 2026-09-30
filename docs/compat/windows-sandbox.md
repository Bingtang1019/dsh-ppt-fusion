# Windows sandbox matrix (V11 A4, ADR-091)

Measured 2026-10-01 on this machine with the 0.2.0 line's own confinement runner
(`@deepseek-ai/dsh-sandbox-windows-acl/lib/runner.js` from a scratch install of
`@deepseek-ai/dsh@0.2.0-rc.2`). Reproduce with:

```
node scripts/win-sandbox-probe.mjs --json          # writes tmp/sandbox/probe-<stamp>.json
node scripts/win-sandbox-probe.mjs --rows confined-workspace-write --debug
```

## What the sandbox does on this platform

`AclSandbox` duplicates the caller's token into a `WRITE_RESTRICTED`, Low-integrity token whose
restricting SIDs carry a workspace capability and a per-session private-temp capability. Each grant edits
the directory's DACL and label in one call: the capability-SID allow ACE, a Deny of the ambient
`FILE_DELETE_CHILD` right to the world SID (containers only), and an inheritable **Low** mandatory label.
Consequences that matter to this plugin:

- Writes are confined by the **mandatory label** first: a Low-integrity child may write where the object is
  Low-labelled (the granted roots) or where the label permits write-down; it is denied everything else.
  The restricting SIDs *add* write authority inside the granted roots; they do not remove the user's own
  rights, which is why the standing edits do not break the user's normal tools.
- The workspace grant is **standing** (a reuse cache): after one sandboxed session the workspace keeps the
  ACE, the world delete-deny and the Low label. The temp grant is revoked on dispose.
- Reads, network and process visibility are not restricted; `read-only` has no write SIDs, so it relies on
  the label alone.

## Matrix (2026-10-01, `hello-merged.pptx`, 5 pages)

Rows: `control` = children spawned directly; `standing` = children spawned directly **after** the standing
workspace grant exists; `confined workspace-write` / `confined read-only` = children wrapped in
`runner.js --mode …`.

| Probe | control | standing | confined workspace-write | confined read-only |
|---|---|---|---|---|
| `ffprobe` shim reads a duration | ok | ok | **failed** (python traceback in `imageio_ffmpeg.get_ffmpeg_exe()`) | **failed** (same) |
| `dsh-ppt doctor` engine checks (python, venv, ppt-master, pptwise) | ok | ok | **failed** (`python=fail, ppt-master=fail`) | **failed** (same) |
| sharp loads and resizes | ok | ok | ok | ok |
| `renderpages --engine libreoffice --force` | limited | limited | limited | limited |
| `renderpages --engine powerpoint --force` | ok (5 pages, 63 s) | ok (5 pages, 59 s) | **limited** | **limited** |
| write + delete inside the workspace (file and directory) | ok | ok | ok | ok |
| write into the plugin home (`~/.dsh/ppt-fusion`) | ok | ok | **denied** | **denied** |

## Verdict

**As shipped, the plugin passes on a sandboxed workspace.** The plugin spawns its own children through its
runner port rather than through `ctx.sandbox`, so they run with the user's token while the workspace carries
the sandbox's standing edits. Every probe passes in the `standing` row, including directory deletes inside
the workspace, the COM render and the engine venv — i.e. the sandbox's standing mutations do not break the
plugin for the user who is running a confined session (S48).

**If the plugin's children were confined, three blockers exist** (recorded, not silently accepted):

1. **The Python chain (engine venv, shim).** `doctor` reports `python=fail, ppt-master=fail` because the
   venv lives outside the writable grant (`~/.dsh/ppt-fusion/venvs`), and the ffprobe shim fails inside
   `imageio_ffmpeg.get_ffmpeg_exe()`, which writes its static-binary cache under the user profile. The
   confinement-safe shape is the one the evaluation harness uses: keep `DSH_HOME` inside the workspace (or
   grant the plugin home) and point `IMAGEIO_FFMPEG_EXE` at a binary inside the writable set.
2. **The render engines.** `renderpages` records both engines as `skipped` under confinement: PowerPoint COM
   cannot launch (the confined token's startup profile/Temp interplay) and LibreOffice is unavailable on
   this machine for any mode. A confined session can still publish decks; it just cannot rasterise pages,
   and `--required` would turn that into a failure instead of a skip.
3. **Plugin-home writes.** Anything outside the workspace and the private temp is denied, by design.

**Adapt first, not now.** The plugin stays on its own runner until the confinement path has a tested home
strategy; ADR-091 records the decision, and this file owns the matrix to re-check before any move under
`ctx.sandbox`.

## Machine facts this run surfaced (not sandbox findings)

- `libreoffice` is not installed here (`soffice` absent from both Program Files trees and from `PATH`), so
  `renderpages` correctly records it as `skipped`. **A cache hit is not evidence that an engine works**: the
  earlier "ok" LibreOffice rows were cache hits, and only `--force` distinguishes them, which is why every
  render probe now forces a real run.
- `doctor` reports `png-renderer=fail` (`cairosvg 2.9.1 is installed but cannot import: no library called
  "cairo-2" was found`) in every row, sandboxed or not: a machine-level gap (V11 A4 follow-up), not a
  confinement effect.
- `read-only` mode does **not** block writes inside a workspace that already carries the standing Low label;
  only `~/.dsh`-style paths are denied. Denying workspace writes needs a real read-side policy — the same
  boundary the backend's own README states ("a standing Low label outlives DSH and widens the tree for
  other Low-integrity processes").