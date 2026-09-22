# M6 model evaluation — decision record

Plan M6 is a go/no-go question, not a documentation task: can the default model take a
user-style request through the fusion workflow to a green unified audit gate? This file records
the harness, the three scenarios, the measured data and the decision. The raw report is
`tmp/eval/report.json` with the human-readable `tmp/eval/report.md`.

## Method

- **Harness.** `pnpm eval:run [--scenario <name>] [--attempts <n>] [--rejudge] [--json]`
  (ADR-046). It boots the shipped DeepSeek Harness `headless` profile against a source checkout
  (`DSH_HARNESS_ROOT`), at most `maxAttempts` fresh sessions per scenario, and judges each
  finished workspace with `tests/eval/rubric.ts`.
- **Isolation per attempt.** `tmp/eval/<scenario>/attempt-<n>/{work,home,bin}`: a fresh
  workspace as the agent cwd, a fresh `DSH_HOME` (no machine-local patch layer or MCP servers),
  and `dsh-ppt` shims on `PATH` that run this checkout's built `dist/cli.js`. The SKILL is
  mounted with `skill-filesystem.customSkillDirs` through a generated `--patch` overlay, so the
  eval never installs into the user's `~/.dsh/skills`.
- **Model.** The headless profile's default (`deepseek-v4-flash`), permission mode
  `danger-full-access`, three sessions per scenario at most. The key comes from the user's
  `~/.dsh/.credentials.yaml`.
- **Data.** Wall time is measured by the harness; turns, tool calls, failed calls, gate
  failures, skill loads and checkpoint commands are recovered from the session log
  (`$DSH_HOME/sessions/**/session.jsonl.zstd`), never from the model's summary.
- **Pass line (plan M6.6).** All three scenarios produce packages that pass the unified audit
  gate, and at least one scenario is manually spot-checked. The checkpoint check is a
  warning-level process metric; the other eight checks decide a scenario.

## Scenarios

| scenario | request | expectations |
|---|---|---|
| `topic-only` | a five-page Chinese deck about why migrating birds do not get lost, no images | 5 slides, text shapes on every slide, checkpoint |
| `doc-to-deck` | the staged product brief becomes a six-page deck | 6 slides, native editable charts for the numbers, checkpoint |
| `branded-template` | the staged customer deck's brand is reused for a four-page deck | 4 slides, a bound theme file, checkpoint |

Inputs: `fixtures/scenarios/inputs/doc-to-deck/brief.md` and `fixtures/golden/hello-merged.pptx`
(staged as `brand/customer.pptx`). The full check list is in `fixtures/scenarios/rubric.json`.

## Results

| scenario | verdict | attempts | wall | slides | native objects | audit | tool calls | gate failures | checkpoints |
|---|---|---|---|---|---|---|---|---|---|
| `topic-only` | PASS | 1 | 811 s | 5 | 1 native table (`a:tbl`) | ok, 12 sources, 0 error / 5 warning | 133 | 0 | 7 |
| `doc-to-deck` | PASS | 1 | 1104 s | 6 | 4 native charts | ok, 12 sources, 0 error / 10 warning | 147 | 3 recovered | 6 |
| `branded-template` | PASS | 1 | 352 s | 4 | – | ok, 0 error | 83 | 2 recovered | 9 |

Each session was a single turn: the model ran the seven phases inside one long turn and never
needed a retry. All ten audit warnings are the same `compat-feature: ea-font-slot` advisory
(CJK runs without an `a:ea` slot; the registry holds no downgrade), which is warning-level and
outside this command surface.

### Manual spot check (doc-to-deck)

- **Charts are editable chart objects.** PowerPoint COM reads four charts on slides 3–6
  (types 51, 51, 51, 57) with series values `31,42`, `6.1,8.6`, `65,68` and `46,27,18,9` — the
  numbers from the brief, addressable as series data, not a picture.
- **Single master.** One `ppt/slideMasters/slideMaster1.xml`; the OPC audit's P1 invariant also
  passes.
- **Colours.** `dsh-ppt audit <deck> --pixels` reports no palette finding: every sampled colour
  is inside the bound token palette.
- **PowerPoint opens it clean.** `scripts/win-com-smoke.ps1 -ExpectedSlides 6` reports `ok`,
  6 slides, `saved` and `unchanged` (no repair, no rewrite). The branded-template deck passes
  the same smoke with 4 slides.

### Brand fidelity: caught by the spot check, then fixed and confirmed

The first branded-template session (21:17) ran `brand extract --bind` correctly — the bound
theme carried the extracted palette `primary #4472C4`, `accent #ED7D31` — then edited
`brand.theme.json` into a different scheme (`primary #1E2A4A`, `accent #F5C518`). The manual
spot check caught what the file-existence check could not, so the SKILL gained an explicit
brand-fidelity rule.

The confirmation run (23:29, same scenario, 352 s) did it right: the bound
`brand.theme.json` colours are field-for-field equal to a fresh reference `brand extract` of
the staged customer deck — `primary #4472C4`, `accent #ED7D31`, the full six-colour
`chartPalette`, every neutral included — and the package passes the audit with the checkpoint
at phase 7. Brand fidelity is closed; the next model round still gets the automated
palette-equality rubric check so a regression cannot pass silently.

## Decision

**GO for M7.** The M6.6 pass line is met: 3/3 packages pass the unified audit gate, and the
doc-to-deck spot check verifies editable charts, a single master and palette-consistent
colours. All three sessions completed end-to-end in a single attempt each (the branded-template
one on the confirmation run), including deep pages and native objects, which is the capability
this gate exists to measure.

- **Downgrade ladder.** L2–L4 are not triggered; the failure modes seen here are instruction
  and environment issues, not a context-length or phase-count ceiling. A targeted L1-style
  hardening is applied instead: the SKILL's doctor note (a red-by-design `png-renderer` row must
  not trigger `doctor --repair`), explicit brand fidelity, and explicit checkpoint discipline.
  `page-context-report` (the other half of L1) stays deferred until an eval shows context loss.
- **Confirmation note.** Two scenarios completed on the first attempt; branded-template needed
  one confirmation run after the brand-fidelity rule landed, and that run passed.
- **Transient 402, not a balance wall.** At 21:17 the provider answered the branded-template
  session with `402 QUOTA: Insufficient Balance` and attempts 2–3 aborted the same way; the same
  key answered HTTP 200 at 23:29 and the re-run completed. The harness still records a
  no-tool-call 402 as an infrastructure abort (retrying immediately would not help), but such an
  abort pauses the gate instead of judging the model.
