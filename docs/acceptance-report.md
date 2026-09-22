# Acceptance report (S1–S17)

Plan chapter 6 maps the leader-facing questions to seventeen scenarios. This page records the
automated evidence behind each one on the development machine, and names the checks that need a
machine this host does not have (a WPS 2019+ box, a Linux runner with LibreOffice). "Verified"
means the listed command or test was executed and passed; the evidence file or ADR is named in
the row.

| # | scenario | evidence | status |
|---|---|---|---|
| S1 | install as a plugin, no environment tinkering | scratch profile `~/.dsh/profiles/ppt-eval`: `dsh plugin --profile ppt-eval add -w link:<checkout>` (dependency + bundle entry), `--dump-config` shows the `# == @dsh-ppt/dsh-ppt-fusion` layer, boot on port 3098 logs no plugin error, `GET /dsh-ppt/preview/*` answers with `x-dsh-ppt-preview: 1`, `remove -w` leaves no residue (ADR-050); `dsh-ppt doctor` eight rows green (M1, ADR-020/024) | verified; the browser card still needs one human look |
| S2 | technology stack is the project's choice | `docs/architecture.md` (dual runtime, boundaries, invariants) + ADRs 001–051 | verified (documentation) |
| S3 | a deck that can be edited, not a picture | `pnpm eval:run --scenario topic-only`: PASS attempt 1, 811 s / 133 tool calls, 5 slides, single master, audit ok, native table page; `docs/m6-model-eval.md` | verified |
| S4 | 24 themes are swappable | `pnpm themes:verify` (24 token snapshots), `theme list --json` returns 24 ids, `pnpm matrix:verify` covers six menu families end-to-end | verified |
| S5 | reuse the company deck's colours | real `brand extract --bind` run + a reference extraction compared against the bound palette (M7 spot check); M6 found the model rewrote the palette once → SKILL brand-fidelity rule + rubric follow-up (ADR-047) | verified with the finding recorded |
| S6 | charts must be editable | M6 doc-to-deck: 4 native chart parts; PowerPoint COM reads series values `31,42`, `6.1,8.6`, `65,68`, `46,27,18,9`; golden `ppt/charts/chart101.xml` root `c:chartSpace` | verified |
| S7 | animation and transitions | ADR-042 COM probe: emphasis type 61 and path type 149 with `behaviours >= 1`; golden v5 carries `p:transition` and `p:timing` | verified |
| S8 | narration | M5: real edge-tts MP3s 93600 B / 82224 B plus SRTs; golden v5 embeds media with auto-advance timings; `fixtures:verify` recomputes them | verified |
| S9 | the CLI has what it should | M8 item 3: every leaf command accepts `--json`, enforced by `src/cli.test.ts`; `dsh-ppt audit` carries `schemaVersion: 1` | verified |
| S10 | no keys, no model, no network | credentials cleared and `HTTP_PROXY=http://127.0.0.1:9` set: `dsh-ppt render tmp/s10` exits 0 with 5 slides / 196839 B; COM opens it; `docs/architecture.md` network boundary | verified |
| S11 | no generated images | real Pexels search recorded `assets/image_sources.json` with licence/author/attribution (ADR-048); the command surface has no `image-gen` (CLI coverage test) | verified |
| S12 | Chinese typography | the M6 CJK decks render and open in COM; the only audit advisories are warning-level `ea-font-slot` findings (no registered downgrade) | verified; human glyph review is an M8/M9 nicety |
| S13 | opens without a repair prompt | `scripts/win-com-smoke.ps1` on the golden (5 slides), the S10 render (5) and the M6 eval decks (6 / 4 / 5): all `ok`, `unchanged` | verified |
| S14 | one design master | P1 single-master invariant in `audit`/`opc` and in every matrix snapshot; python-pptx reports one master across all 10 matrix artifacts (`docs/compat/matrix.md`) | verified |
| S15 | other Office versions | `pnpm compat:matrix`: 10/10 artifacts pass `compat lint` at `safe`/`standard`/`max`; golden compat-level snapshots equal in `fixtures:verify` | verified |
| S16 | WPS and older Office | python-pptx reopen 10/10 (`docs/compat/matrix.md`); LibreOffice headless conversion is wired into `pnpm compat:matrix` and installed by CI, but `soffice` is absent on this machine | python-pptx verified; LibreOffice pending CI |
| S17 | signed off on a real WPS machine | checklist prepared in `docs/compat/wps-checklist.md`; no WPS on this machine | pending user machine; v1 claims stay at T2 (ADR-051) |

## What is deliberately not claimed

- **T1 (canonical equality) is proven for this repository's fixtures**, not for every customer
  deck; the tier definitions live in `docs/architecture.md` and ADR-033/037.
- **LibreOffice conversion** runs in CI (ubuntu-latest installs `libreoffice-impress`) but has
  not executed on this machine; `compat:matrix` reports it as `skipped` when `soffice` is
  missing rather than pretending it ran.
- **WPS** is untested; per ADR-051 the v1 release notes may only claim T2 until S17 is signed
  off on a user-provided machine.
- **The preview card** was verified server-side (route + logs); the in-browser card needs one
  human look (the same deferral M0 recorded for the plugin card, ADR-002).