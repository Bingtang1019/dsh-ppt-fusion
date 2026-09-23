---
name: dsh-ppt-fusion
description: Fuse the DSH-native front end (pptwise) with the native DrawingML deep engine (ppt-master): phase routing, theme, storyboard, page authoring, the four-step deep gate, render/post and review.
---

# dsh-ppt-fusion workflow (seven phases + checkpoint)

This SKILL is the authoritative *process*; machine contracts live in `docs/contracts.md` and decisions in `docs/decisions.md` (a newer ADR beats this file). No model name is hardcoded.

## 0. Pick the mode first

| Mode | When | Entry |
|---|---|---|
| **Generate** (default) | A new deck from a topic or document | `init` → `plan` → … → `render` → `audit` |
| **Create Template** | A customer pptx becomes a reusable template | `deep template create` → `deep template apply` |
| **Edit Native PPTX** | An existing deck needs content or motion changes | `deep native roundtrip` → edit SVGs → `deep render`/`render` |
| **Quick** (short phases) | A few pages fast, degradation accepted | `init` → `plan --confirm` → `render` (no deep pages) |

## 1. Phase 1 · Intent and narrative
- Ask for audience, occasion, page ceiling, native charts/tables/formulas, narration/animation, and the brand source.
- Use pptwise narrative presets as vocabulary; one claim per page, a conclusion as the title.
- **BLOCKING**: an unknown audience or purpose means ask, never guess.

## 2. Phase 2 · Theme
- `dsh-ppt theme list` shows 24 presets; shortlist 2–4 with `theme try <ids>`.
- Customer brand: `dsh-ppt brand extract <file> --bind <deck>` (ThemeFile v2 → `{file: ...}` → `theme ensure`).
- **Brand fidelity:** the `brand.theme.json` written by `--bind` is the customer's colours and fonts; never restyle it for looks, and ask the user before any adjustment.
- Always `theme ensure` after binding: deep pages derive `spec_lock.md` from tokens and `validate` fails on stale tokens.

## 3. Phase 3 · Outline → storyboard → planning confirmation (BLOCKING)
- `dsh-ppt init <dir> --theme <preset>`; `dsh-ppt plan <dir>` drafts `deck.fusion.draft.json` (manifest + storyboard skeleton).
- **Storyboard:** `deck.storyboard.json` gives every page its `role`/`layout` (`<theme>:<face>` from the bound theme menu)/`route`/`chrome.pageNumber`/`budget`/`source`. `init`/`plan` already pick the first legal face per role; a content slide's IR `kind` splits it into `data`/`quote`.
- **Declare chrome once:** the manifest `chrome` block sets page numbers (cover/ending skipped by default), footer and section; never draw page furniture per page. A storyboard/manifest conflict resolves in favour of the manifest, and `validate` rejects it.
- `deck.fusion.json` routes every page (`pptwise`/`ppt-master`); a deep page carries `deep: { dir, kind, format }` and its IR slide stays `placeholder: true`.
- Routing table:

| Content | Route |
|---|---|
| Cover/ending/points/cards/timeline/quotes | `pptwise` |
| Charts / tables / formulas | `ppt-master` (native objects; formulas keep the MCE fallback) |
| Image collages, complex vectors | `ppt-master` (PNG fallback matters, B7) |
| A text page that needs motion | `pptwise` (post targets `blk<slide>-<block>`) |

- **BLOCKING:** before `plan --confirm`, put the storyboard in front of the user page by page (role/layout/budget/source) and get an explicit yes; the confirm writes manifest and storyboard together.

## 4. Phase 4 · Author by role
- Follow the storyboard role: `cover`/`ending`/`section` = headline + 1–2 support points; `content` = one claim per page, the title states the conclusion; `data` = a deep page with one main chart/table; `quote` = the quotation and its source.
- Standard pages: write pptwise IR (component vocabulary from `tokens export --master`).
- Deep pages: follow the seven authoring rules (ADR-007): numeric anchors in `spec_lock.md`, `data-pptx-page-role`, `data-pptx-role` ids, disjoint `<g data-pptx-bounds>` with ≤5 % text overflow, font-size banding, `stamp-native-fallbacks` hashes, and the visible fallback fully projected into native markers. Paint only `tokens.json` colours; `audit --pixels` samples ΔE.
- Content must fit the page `budget`: `validate` measures words/items/charts/tables/images and fails over-limit pages; cut content or change the layout, never raise the budget yourself.
- Narration: `deep/<page>/notes.md`; audio in `<deck>/narration/*.mp3` (matched by SVG stem).

## 5. Phase 5 · Gates (BLOCKING: any red stops the run)
1. `dsh-ppt validate <dir>`: manifest / IR / **storyboard (existence, coverage, role↔layout, budgets)** / deep files / theme.
2. `dsh-ppt deep render <dir>` runs the fixed four steps: `stamp-native-fallbacks --write` → `svg-quality-check --stage final --canonical-authoring` → `svg-to-pptx --quick-generate --native-charts-and-tables --with-notes` → read `validation/<stem>.report.json` (never stdout, ADR-009).
3. `dsh-ppt audit <dir>`: the eight-source gate (validate, pptwise validate/audit, svg-quality, OPC+P1, delivery, compat, optional pixels).
4. Never degrade quality to pass a gate: no hand-edited binaries, no skipping `--stage final`, no silently demoting a deep page to a standard page.

## 6. Phase 6 · Render and post
- `dsh-ppt render <dir> [-o out.pptx] [--compat safe|standard|max]`: base → deep → merge (single master) → post (the only motion owner) → compat → structural/delivery gates → atomic publish plus `out/manifest.json`/`compat-report.json`.
- Motion: `post/animations.json` supports `transition` plus `entrance`/`emphasis`/`path` (played in that order); a selector that matches nothing fails the render.
- Narration: `dsh-ppt narrate <dir> -o narration` (edge by default, no key; needs a notes roster), then `render` embeds the audio and sets auto-advance.
- Motion-only changes: `dsh-ppt post animate <dir>` re-runs the compat pass and refreshes the manifest.

## 7. Phase 7 · Review
- `dsh-ppt audit <dir> --pixels`, `--strict` when warnings must fail.
- `dsh-ppt preview <dir> --html` (the `dsh_ppt_preview` tool in a DSH session) renders a browsable preview: standard pages via pptwise, deep pages from their authored SVGs.
- Read `out/manifest.json` and `compat-report.json`; check single master, editable chart/table, palette consistency, complete attribution.
- Revision round: change only the owning phase, then re-run that phase and the gates after it; never restart the whole chain.

## checkpoint / resume
- After each phase write `.dsh-ppt/checkpoint.json`: `{ version, phase, deck, updatedAt, artifacts, gates, notes }`, artifact paths relative; **phase 3 also writes `"storyboard": "deck.storyboard.json"`**. **This is required.**
- **A new session starts with** `dsh-ppt resume <dir>`: it prints the phase, the artifacts produced and the next command; `--write` also persists `.dsh-ppt/resume.md`. Do not re-run from memory.
- A missing claimed artifact makes `resume` exit non-zero: fix the work or the checkpoint first; when the checkpoint and `out/manifest.json` disagree, the manifest sha256 wins.

## Image rules
- Only `dsh-ppt images search` (openverse/wikimedia need no key; pexels/pixabay need one); a missing licence or attribution fails the command.
- Generated art is **not supported** (`image-gen` is not whitelisted). Offer a stock search or the user's own asset, and never fabricate provenance.

## Reference budget (guarded by prompt-audit)
- Load 8–12 phase-relevant files from `python-assets/vendor/ppt-master/docs/` by default (svg-pipeline, svg-contract, native-data, narration, conversion, template-tools, troubleshooting, …); read the rest on demand, never all at once (the budget gate fails).
- `dsh-ppt skill audit` is the budget gate: the corpus ceiling is 120000 tokens; when it fails, read less, do not raise the budget.
- The upstream `references/`/`workflows/` trees are not shipped in the wheel; fetch them from upstream when needed (see the vendor manifest note).

## Command surface (this SKILL teaches only these)
`version · doctor · init · plan · resume · validate · theme ensure|list|new|fork|try · tokens export · brand extract · source · images search · deep render · deep native roundtrip · deep template create|apply|register · post animate · narrate · render · preview · compat lint · audit · skill audit`

## When something fails
- Every error is `dsh-ppt: <code> <message>`; read the code, then the newest `.dsh-ppt/logs/` entry.
- The png-renderer row of `dsh-ppt doctor` is red by design here (no cairo; B7 rasterises with sharp, ADR-020/025); do not `--repair` while the other rows are green.
- Run `dsh-ppt doctor --repair` only when Node/uv/venv/the engine itself is missing; never edit the venv by hand.
