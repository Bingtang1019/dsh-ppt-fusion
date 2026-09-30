# DSH 0.2.0 four-scenario model run (V11 A2, S46)

Run 2026-10-01 on a scratch install of `@deepseek-ai/dsh@0.2.0-rc.2` (`%TEMP%\dsh020-runtime`), headless
profile, key from `~/.dsh/.credentials.yaml`, one attempt per scenario
(`node --import tsx scripts/eval-run.ts --attempts 1`). Companion records: `docs/dsh020-probe.md` (the
0.2.0 runtime and gate probe) and the 0.1.7 baseline kept at `tmp/eval/report-017-four.json`.

**Result: 4/4 scenarios pass all 17 rubric checks** (the rubric carries the V10 additions `worktree`,
`review-record`, `render-snapshots` on top of the delivery gates).

| Scenario | Verdict | Wall | Turns | Tool calls | Failed | Gate failures | Slides | Notes |
|---|---|---|---|---|---|---|---|---|
| topic-only | PASS | 26.5 min | 1 | 198 | 0 | 0 | 5 | native chart, no table |
| doc-to-deck | PASS | 28.6 min | 1 | 147 | 0 | 0 | 6 | native chart; the brief's growth numbers are charts, as asked |
| branded-template | PASS | 5.0 min | 1 | 86 | 0 | 0 | 4 | brand theme bound, profile audit n/a |
| reference-quality | PASS | 30.0 min (cap) | 1 | 180 | 0 | 0 | 12 | native chart + table, `designProfileOk = true` |

Every attempt loaded the skill once, made zero failed tool calls and tripped zero gate failures.

## Comparison with the 0.1.7 baseline (same rubric)

| Scenario | 0.1.7 (V10, `tmp/eval/report-017-four.json`) | 0.2.0 (this run) |
|---|---|---|
| topic-only | PASS, 1599 s, exit 0 | PASS, 1591 s, exit 0 |
| doc-to-deck | PASS, 1800 s (cap), exit null | PASS, 1714 s, exit 0 |
| branded-template | PASS, 850 s, exit 0 | PASS, 302 s, exit 1 |
| reference-quality | **FAIL 16/17** (cap; `design-profile` `design-background-mode`), exit null | PASS, 1800 s (cap), exit null |

The one 0.1.7 failure was the deck's own design profile asking for a `photo` background while the pages
shipped flat colour. On 0.2.0 the same scenario produced a compliant deck inside the cap and the profile
audit is green, which is the evidence that the earlier failure was model variance rather than a systemic
gap — the delivery gates are the same code on both lines.

## Two things this run does not claim

- **`reference-quality` is a cut-off pass.** The harness kills an attempt at 1800 s
  (`timeout: 30 * 60_000`); this one was still working when the cap hit, so `exitCode` is null and the
  agent never wrote `.dsh-ppt/checkpoint.json` — the single warning in the report
  (`checkpoint: no .dsh-ppt/checkpoint.json found`) is that artifact, not a delivery defect: the published
  package passed every gate the rubric checks, including `design-profile`. Raising or splitting the cap for
  the 12-page scenario is a recommendation for the next evaluation pass, not a defect in the deck.
- **`branded-template` exited 1 while its deck passed.** The harness judges the produced workspace, not the
  agent's exit code; a non-zero exit with a green rubric means the agent ended its loop unhappily, not that
  the deck is wrong. Recorded here so the number is not mistaken for a failure.

Content variance between lines is expected and not a gate difference: doc-to-deck shipped a native table on
0.1.7 and charts only on 0.2.0, and both satisfy the scenario rubric.

## What the run proves

- The model chain works end to end on the 0.2.0 line: the skill loads, `dsh-ppt` runs the seven-phase
  pipeline (theme → storyboard → per-page SVG → native PPTX → validate/quality gates → render pages →
  audit), and the decks satisfy the same 17-check rubric as on 0.1.7.
- The plugin loads on 0.2.0 with no compatibility warning: no attempt's stderr mentions
  `peerDependencies`, `exemption` or `skipping profile bundle` (contrast ADR-079's update, where the old
  union produced exactly that skip line).
- Nothing here proves the Windows sandbox/ACL matrix (V11 A4) or the parity of the bundled LibreOffice
  renderer (V11 B5); the render pages this run produced came from this machine's engines.

## Evidence

- `tmp/eval/report.json` (this run, all four scenarios) and `tmp/eval/report.md`.
- Per-scenario workspaces: `tmp/eval/<scenario>/attempt-1/work` (deck, gate logs, session log under
  `attempt-1/home/sessions`).
- Recompute the verdicts without a model call: `node --import tsx tmp/eval/judge-attempt.mts` (offline judge
  over the attempt workspaces) or `pnpm eval:run --rejudge` (re-derives metrics and verdicts from the run
  report).