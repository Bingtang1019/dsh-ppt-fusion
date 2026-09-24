# Quality baseline (V7.2 B5)

The v0.3 quality bar has two halves: the automated compliance gate (`audit --profile`, 0 error,
S26) and a human 1–5 rubric over 观感 / 信息密度 / 叙事 (S27). This file records the first
baseline. Automated numbers are machine-derived; the human column stays marked pending until the
user has seen the three samples side by side with the reference deck
(`tmp/quality-demo/preview/preview.html`).

## Samples and automated results

| # | Sample | Artifact | Pages | Native objects | Unified audit | Profile audit |
|---|---|---|---|---|---|---|
| 1 | hello golden fixture | `fixtures/golden/hello-merged.pptx` (fixtureVersion 8) | 5 | chart + table | green (`fixtures:verify`, 14 sources) | n/a (no profile) |
| 2 | `reference-quality` eval, attempt 1 | `tmp/quality-demo/out/reference-quality.pptx` | 12 | chart + table | 0 error / 4 warnings (ea-font slot ×2, non-PPT-safe MiSans on the two deep pages) | 0 error / 4 warnings; all 14 rubric checks green in 1698 s |
| 3 | `doc-to-deck` eval, attempt 1 | `tmp/eval/doc-to-deck/attempt-1/work/deck/out/xinghe-notes-v3-release.pptx` | 6 | chart | 0 error / 7 warnings (font slots) | n/a (no profile) |

The `reference-quality` attempt used 221 tool calls (0 failed, 3 gate retries), one skill load and
seven checkpoint commands. Its storyboard is cover / toc / 4 × (section + content) / one extra
content page / ending; the design pass rewrote 10 titles, 16 body runs, 4 accent runs, 4 section
markers and 1 meta footer, and the background layer applied the flat profile background
(`minContrast` 7.00:1).

## Human rubric (1–5)

| # | Sample | 观感 | 信息密度 | 叙事 | Evidence |
|---|---|---|---|---|---|
| 1 | hello golden | 4 (est.) | 4 (est.) | 4 (est.) | clean chrome, single master, editable chart and table; chrome is not visible in the HTML viewer (ADR-057 backlog) |
| 2 | reference-quality | 4 (est.) | 4 (est.) | 4 (est.) | 12 pages follow the profile's type scale, anchors, cards and chrome; preview at `tmp/quality-demo/preview/preview.html`; the two deep pages warn on MiSans font slots |
| 3 | doc-to-deck | 3 (est.) | 4 (est.) | 4 (est.) | 6 pages, one editable chart; seven font-slot warnings |

`(est.)` marks an assistant estimate from the preview structure and audit facts. The human scores
are pending the user's side-by-side review (S27); update this table with the confirmed numbers and
keep the estimates in git history if they change.

User review (2026-09-24): the three samples were reviewed side by side with the reference deck. The
standing comment is to watch card and element spacing when generating; the confirmed 1–5 numbers
replace the `(est.)` cells once they are transcribed here.

## Reproduce

```sh
pnpm eval:run --scenario reference-quality
node --import tsx src/cli.ts audit <deck> --profile design-profile.json --json
node --import tsx src/cli.ts preview <deck> --html
```

The demo copy of the package, its audit JSON, manifest, compat report and preview live under
`tmp/quality-demo/` (ignored: the deck itself never enters the repository or the package).
