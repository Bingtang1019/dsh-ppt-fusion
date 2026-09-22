# Upstream upgrade drill (M8.6)

Plan M8.6 asks for one patch-level bump per upstream, a fixture re-record and a record of the
break points. On 2026-09-22 both upstreams are already at their newest release, so the drill is
split into the version check that establishes that fact and the drift rehearsal that proves the
gates catch a bump when one appears.

## Version check

| upstream | pinned here | newest available | source |
|---|---|---|---|
| pptwise | 0.35.0 | 0.35.0 | `npm view @liustack/pptwise versions` (npmmirror) |
| ppt-master | 0.1.128 | 0.1.128 | the Tsinghua PyPI mirror's index: 121 releases scanned, none newer |

## Drift rehearsal

`pnpm matrix:verify` treats the pins as part of the snapshot identity: a changed
`PINNED.pptMaster` / `PINNED.pptwise`, a changed theme snapshot, or a schema bump fails with a
named problem. `tests/theme-matrix.test.ts` pins that behaviour (upstream drift, theme drift,
schema drift), so the detection itself runs in `pnpm test` ahead of any real bump.

## Procedure when a newer release appears

1. Bump the pin: `package.json` for pptwise, or `python-assets/requirements.in` plus
   `pnpm engine:lock` for ppt-master.
2. Rebuild the engine: `pnpm engine:provision`, or `dsh-ppt doctor --repair` interactively.
3. `pnpm fixtures:verify`: the canonical comparison names the artifacts that changed
   (`base`/`deep`/`merged`) and the compat snapshots that moved.
4. `pnpm matrix:verify`: fails on the upstream drift line until the matrix is re-recorded.
5. Record the break points (which parts changed, which findings appeared) in an ADR, then run
   `pnpm fixtures:record` / `pnpm matrix:record` and raise the fixture versions, or revert the
   pin.

The golden and matrix gates already compare upstream versions explicitly, so a silent bump is
not possible: the failure message names the recorded and current version.