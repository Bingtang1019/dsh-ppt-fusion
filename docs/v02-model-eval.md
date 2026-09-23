# v0.2 model evaluation (Q4 regression)

V6 WP2 Q4 re-ran the three M6 scenarios through `pnpm eval:run` against the v0.2 toolchain:
the SKILL's storyboard phase, role-based authoring and chrome declaration, the
`validate`/`audit` gates from Q1–Q3, and the Q5 narration fix. The harness and scenario
files are the M6 ones; the rubric gained four error-level checks — `storyboard`,
`role-layout`, `budget` and `chrome` — so a pass now means the deck is a legal plan, not
just a legal package (`tests/eval/rubric.ts`, `fixtures/scenarios/rubric.json`).

## Result: 3/3, GO

| scenario | slides | attempts | wall | tools (failed) | gate failures | audit | new checks |
|---|---|---|---|---|---|---|---|
| topic-only | 5 | 1 | 548 s | 131 (0) | 3 | ok, 0 skipped | storyboard / role-layout / budget / chrome green |
| doc-to-deck | 6 | 1 | 795 s | 168 (0) | 4 | ok, 0 skipped | storyboard / role-layout / budget / chrome green |
| branded-template | 4 | 1 | 734 s | 144 (0) | 3 | ok, 0 skipped | storyboard / role-layout / budget / chrome green |

Every attempt passed on its first try (no retry) and reached checkpoint phase 7. The model
filled `layout` and `budget` from the bound theme's menu as the SKILL teaches, so the
storyboard gate was not a blocker in practice and the degradation ladder (template the
storyboard, never lower the contract) never had to run.

## What the new checks prove

- **storyboard** — `deck.storyboard.json` exists, covers every IR page and agrees with the
  manifest on role, route and page-number participation.
- **role-layout** — every `layout` is a face of the bound theme's menu under a slot the
  page's `role` may use (ADR-059); no cross-theme pin, no unregistered face.
- **budget** — each page's measured words / items / charts / tables / images stay inside its
  declared or role-default budget.
- **chrome** — the manifest declares `chrome` and the audit reports no chrome error
  (coverage, geometry, skip), which is the deck-level consistency R2 asked for (ADR-058).

## Reproduce

```sh
pnpm eval:run            # writes tmp/eval/report.json and tmp/eval/report.md
pnpm eval:run --json
```

The run needs a model key (`DEEPSEEK_API_KEY` or `~/.dsh/.credentials.yaml`) and the engine
venv; the harness boots the headless profile with this checkout's `skills/` mounted and the
built `dist/cli.js` on PATH.

## Human spot check

Q4's acceptance also asks for at least one human sample: open the published pptx under
`tmp/eval/<scenario>/attempt-1/work/deck/out/` and score 观感 / 信息密度 / 叙事. The automated
half is green above; the manual half is recorded in `docs/quality.md` at V7 B5, and the
user's review of these three decks is the pending item.

## Verdict

**GO for v0.2.0**: 3/3 scenarios pass the unified audit gate with the storyboard, role-layout,
budget and chrome checks green on the first attempt; no storyboard fallback was needed.
