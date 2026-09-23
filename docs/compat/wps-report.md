# WPS real-machine report (S17)

Status: **user-confirmed, 2026-09-22**. The user reported that the WPS 2019+ checklist in
`docs/compat/wps-checklist.md` was executed and passed. The WPS build number and per-item notes
were not captured in the AI session, so the rows below mark the user's confirmation and are to be
filled with concrete observations the next time the machine is available.

| # | check | result |
|---|---|---|
| 1 | opens without repair | user-reported pass |
| 2 | slide count | user-reported pass |
| 3 | one design master | user-reported pass |
| 4 | native chart is editable | user-reported pass |
| 5 | native table is editable | user-reported pass |
| 6 | animation pane plays | user-reported pass |
| 7 | narration plays and advances | user-reported pass |
| 8 | CJK fonts render | user-reported pass |
| 9 | SVG fallback renders | user-reported pass |
| 10 | save and reopen | user-reported pass |
| 11 | page numbers renumber after deleting a page (V6 WP1) | pending user check |
| 12 | profile theme consistency (V7.2 B2) | pending user check |
| 13 | profile background, flat/svg (V7.2 B5) | pending user check |

Rows 11–13 were added after the 2026-09-22 confirmation and still need a run on the WPS machine.

Consequence: the S17 gate is satisfied on the user's confirmation, so the v1 release notes may
claim T1 (the plan's rule). Capture the WPS version and any degradation here on the next run; if
a future run finds a failure, ADR-051 reverts the claim to T2.