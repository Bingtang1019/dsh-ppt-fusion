# WPS 2019+ acceptance checklist (S17)

Run this on a machine with WPS Office 2019 or newer (the development machine has none). Use at
least the golden package and one CJK deck:

- `fixtures/golden/hello-merged.pptx`
- `tmp/eval/topic-only/attempt-1/work/deck/out/deck.pptx`
- `tmp/eval/doc-to-deck/attempt-1/work/deck/out/xinghe-v3-release.pptx`

Record every row (pass / fail / note) in `docs/compat/wps-report.md`.

| # | check | how | expected |
|---|---|---|---|
| 1 | opens without repair | double-click the file | no "repair" dialog; the deck opens at slide 1 |
| 2 | slide count | status bar / slide panel | golden 5, topic-only 5, doc-to-deck 6 |
| 3 | design master | Design / Slide Master view | exactly one master and one master set |
| 4 | native chart is editable | double-click the chart, change a value, click outside | the series updates; no picture placeholder |
| 5 | native table is editable | click into the table on the topic-only deck | cells are text-editable |
| 6 | animation pane | Animation pane on the animated slides | transition and emphasis/path entries are listed and play |
| 7 | narration | the golden deck's audio parts | audio plays and slide timings advance |
| 8 | CJK fonts | the two Chinese decks | no missing-glyph boxes; heading/body fonts render |
| 9 | SVG fallback | zoom the deep pages to 200% | vector fallback renders; no blank page |
| 10 | save and reopen | save as a copy, close, reopen | WPS does not rewrite or degrade the deck |

Notes for the tester:

- WPS may re-save a package with its own producer string; that is expected and does not fail the
  checklist — only content loss does.
- If a check fails, keep the file, note the WPS build number, and open an ADR with the evidence
  before any v1 claim mentions T1.