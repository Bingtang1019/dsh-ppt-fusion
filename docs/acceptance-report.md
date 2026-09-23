# Acceptance report (S1–S17)

Plan chapter 6 maps the leader-facing questions to seventeen scenarios. This page records the
automated evidence behind each one on the development machine, and names the checks that need a
machine this host does not have (a WPS 2019+ box, a Linux runner with LibreOffice). "Verified"
means the listed command or test was executed and passed; the evidence file or ADR is named in
the row.

| # | scenario | evidence | status |
|---|---|---|---|
| S1 | install as a plugin, no environment tinkering | scratch profile `~/.dsh/profiles/ppt-eval`: `dsh plugin --profile ppt-eval add -w link:<checkout>` (dependency + bundle entry), `--dump-config` shows the `# == dsh-ppt-flashmade` layer, boot on port 3098 logs no plugin error, `GET /dsh-ppt/preview/*` answers with `x-dsh-ppt-preview: 1`, `remove -w` leaves no residue (ADR-050); `dsh-ppt doctor` eight rows green (M1, ADR-020/024) | verified; **browser card user-confirmed 2026-09-22** (M9 prep); real `web`-profile re-check rides the M9 install |
| S2 | technology stack is the project's choice | `docs/architecture.md` (dual runtime, boundaries, invariants) + ADRs 001–051 | verified (documentation) |
| S3 | a deck that can be edited, not a picture | `pnpm eval:run --scenario topic-only`: PASS attempt 1, 811 s / 133 tool calls, 5 slides, single master, audit ok, native table page; `docs/m6-model-eval.md` | verified |
| S4 | 24 themes are swappable | `pnpm themes:verify` (24 token snapshots), `theme list --json` returns 24 ids, `pnpm matrix:verify` covers six menu families end-to-end | verified |
| S5 | reuse the company deck's colours | real `brand extract --bind` run + a reference extraction compared against the bound palette (M7 spot check); M6 first caught the model rewriting the palette; the SKILL rule was added and the confirmation run bound the reference palette field for field (ADR-047) | verified |
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
| S16 | WPS and older Office | python-pptx reopen 10/10 (`docs/compat/matrix.md`); LibreOffice headless conversion runs in `pnpm compat:matrix` — the ubuntu CI leg installs `libreoffice-impress` and compares the rendered PDF page count (run 35761959099, green) | python-pptx verified; LibreOffice verified in CI (PDF page count per artifact) |
| S17 | signed off on a real WPS machine | user confirmed on 2026-09-22 that the ten-point checklist passed (`docs/compat/wps-report.md`, ADR-051); concrete WPS build and per-item notes to be captured next run | **user-confirmed; v1 may claim T1** (ADR-051); a future failure reverts to T2 |

## What is deliberately not claimed

- **T1 (canonical equality) is proven for this repository's fixtures**, not for every customer
  deck; the tier definitions live in `docs/architecture.md` and ADR-033/037.
- **LibreOffice conversion** runs on the ubuntu CI leg (installs `libreoffice-impress`, compares the
  PDF page count per artifact; run 35761959099 green) and is reported as `skipped` on this machine,
  which has no `soffice`.
- **WPS** is user-confirmed (2026-09-22) and ADR-051 allows the v1 release notes to claim
  T1; `docs/compat/wps-report.md` still needs the concrete WPS build and per-item notes on
  the next real-machine run, and any future failure reverts the claim to T2.
- **The preview card** was verified server-side (route + logs) and then user-confirmed
  in-browser on 2026-09-22 (M9 prep); the real `web`-profile card/red-banner check rides
  the M9 install.