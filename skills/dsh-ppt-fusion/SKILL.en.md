---
name: dsh-ppt-fusion
description: Fuse the DSH-native front end (pptwise) with the native DrawingML deep engine (ppt-master): phase routing, theme, outline, page authoring, the four-step deep gate, render/post and review.
---

# dsh-ppt-fusion workflow (seven phases + checkpoint)

This SKILL is the authoritative *process*; machine contracts live in `docs/contracts.md` and decisions in `docs/decisions.md` (a newer ADR beats this file).
Model-agnostic by design: no model name is hardcoded; DeepSeek works by default and its capability is verified in M6.

## 0. Pick the mode first

| Mode | When | Entry |
|---|---|---|
| **Generate** (default) | A new deck from a topic, document or outline | `init` → `plan` → … → `render` → `audit` |
| **Create Template** | A customer pptx should become a reusable template | `deep template create` → `deep template apply` |
| **Edit Native PPTX** | An existing deck needs content or motion changes | `deep native roundtrip` → edit SVGs → `deep render`/`render` |
| **Quick** (short phases) | A few pages fast, degradation accepted | `init` → `plan --confirm` → `render` (no deep pages) |

## 1. Phase 1 · Intent and narrative
- Ask for audience, occasion, page ceiling, whether native charts/tables/formulas are needed, whether narration/animation is needed, and the brand source.
- Use pptwise narrative presets as vocabulary; one claim per page, a conclusion as the title.
- **BLOCKING**: an unknown audience or purpose means ask, never guess.

## 2. Phase 2 · Theme
- `dsh-ppt theme list` shows 24 presets; shortlist 2–4 with `theme try <ids>`.
- Customer brand: `dsh-ppt brand extract <file> --bind <deck>` (ThemeFile v2 → `{file: ...}` → `theme ensure`).
- **Brand fidelity:** the `brand.theme.json` written by `--bind` is the customer's colours and fonts; never restyle it for looks. If an adjustment is genuinely needed, ask the user first.
- Always `theme ensure` after binding: deep pages derive `spec_lock.md` from the tokens, and `validate` fails on stale tokens.

## 3. Phase 3 · Outline and spec
- `dsh-ppt init <dir> --theme <preset>`, draft with `plan`, confirm with `plan --confirm`.
- `deck.fusion.json` declares every page: `route: pptwise | ppt-master`; deep pages carry `deep: { dir, kind, format }` and their IR slide must be `placeholder: true`.
- Page routing table:

| Content | Route | Why |
|---|---|---|
| Cover/ending/points/cards/timeline/quotes | `pptwise` | IR components cover text and geometry |
| Charts (bar/line/pie/area/scatter…) | `ppt-master` | Native editable chart objects |
| Tables | `ppt-master` | Native table object |
| Formulas | `ppt-master` | `a14:m` with an MCE linear-text fallback |
| Image/icon collages, complex vectors | `ppt-master` | SVG authoring freedom; PNG fallback matters (B7) |
| Text page that needs motion | `pptwise` | post targets `blk<slide>-<block>` names |

## 4. Phase 4 · Author
- Standard pages: write pptwise IR (component vocabulary: `tokens export --master`).
- Deep pages: follow the seven measured authoring rules (ADR-007): numeric typography anchors in `spec_lock.md`, root `data-pptx-page-role`, ids on `data-pptx-role` elements, disjoint root `<g data-pptx-bounds>` with ≤5 % text overflow, per-page font-size banding, `stamp-native-fallbacks` hashes, and the visible fallback fully projected into native marker payloads.
- Deep pages may only paint palette colours; `audit --pixels` samples ΔE.
- Narration: write `deep/<page>/notes.md`; put audio in `<deck>/narration/*.mp3` (matched by SVG stem).

## 5. Phase 5 · Gates (BLOCKING: any red stops the run)
1. `dsh-ppt validate <dir>`.
2. `dsh-ppt deep render <dir>` runs the fixed four steps: `stamp-native-fallbacks --write` → `svg-quality-check --stage final --canonical-authoring` → `svg-to-pptx --quick-generate --native-charts-and-tables --with-notes` → read `validation/<stem>.report.json` (never stdout, ADR-009).
3. `dsh-ppt audit <dir>`: the eight-source gate (validate, pptwise validate/audit, svg-quality, OPC+P1, delivery, compat, optional pixels).
4. Never degrade quality to pass a gate: no hand-edited binaries, no skipping `--stage final`, no silently demoting a deep page to a standard page.

## 6. Phase 6 · Render and post
- `dsh-ppt render <dir> [-o out.pptx] [--compat safe|standard|max]`: base → deep → merge (single master) → post (the only motion owner) → compat → structural/delivery gates → atomic publish plus `out/manifest.json` and `out/compat-report.json`.
- Motion: `post/animations.json` supports `transition` plus `entrance`/`emphasis`/`path` (played in that order); a selector that matches nothing fails the render.
- Narration: `dsh-ppt narrate <dir> -o narration` (edge by default, no key; needs a notes roster), then `render` embeds the audio and sets auto-advance.
- Motion-only changes: `dsh-ppt post animate <dir>` re-runs the compat pass and refreshes the manifest.

## 7. Phase 7 · Review
- `dsh-ppt audit <dir> --pixels`, `--strict` when warnings must fail.
- `dsh-ppt preview <dir> --html` (the `dsh_ppt_preview` tool in a DSH session) renders every page into a browsable preview: standard pages through pptwise, deep pages from their authored SVGs.
- Read `out/manifest.json` and `compat-report.json`; check single master, editable chart/table, palette consistency, complete attribution.
- Revision round: change only the owning phase, then re-run that phase and the gates after it; never restart the whole chain.

## checkpoint / resume
- After each phase write `.dsh-ppt/checkpoint.json`: `{ version, phase, deck, updatedAt, artifacts, gates, notes }` with relative artifact paths. **This is required**, not a final step.
- **A new session starts with** `dsh-ppt resume <dir>`: it prints the phase, the artifacts already produced and the next command; `--write` also persists the brief to `.dsh-ppt/resume.md`. Do not re-run from memory.
- A claimed artifact that is missing makes `resume` exit non-zero: fix the work or the checkpoint before continuing.
- When the checkpoint and `out/manifest.json` disagree, the manifest sha256 wins.

## Image rules
- Only `dsh-ppt images search` (openverse/wikimedia need no key; pexels/pixabay need one); a missing licence or attribution fails the command.
- If the user asks for generated art: **not supported** (`image-gen` is not whitelisted). Offer a stock search or the user own asset, and never fabricate provenance.

## Reference budget (guarded by prompt-audit)
- Load 8–12 phase-relevant files from `python-assets/vendor/ppt-master/docs/` by default: `svg-pipeline.md`, `svg-contract.md`, `native-data.md`, `pptx-animations.md`, `pptx-transitions.md`, `narration.md`, `image.md`, `template-tools.md`, `project.md`, `conversion.md`, `troubleshooting.md`, `prompt_audit.md`.
- Read the rest on demand; never load the whole set (the budget gate will fail).
- `dsh-ppt skill audit` is the budget gate: the corpus ceiling is 120000 tokens (the command prints the current total); when it fails, read less, do not raise the budget.
- The upstream `references/`/`workflows/` trees are not shipped in the wheel; fetch them from upstream when needed (see the vendor manifest note).

## Command surface (this SKILL teaches only these)
`version · doctor · init · plan · resume · validate · theme ensure|list|new|fork|try · tokens export · brand extract · source · images search · deep render · deep native roundtrip · deep template create|apply|register · post animate · narrate · render · preview · compat lint · audit · skill audit`

## When something fails
- Every error is `dsh-ppt: <code> <message>`; read the code, then the newest log under `<deck>/.dsh-ppt/logs/`.
- The png-renderer row of `dsh-ppt doctor` is red by design on this machine (no cairo; B7 rasterises with sharp, ADR-020/025); do not run `--repair` while the other rows are green.
- Run `dsh-ppt doctor --repair` only when Node/uv/venv/the engine itself is missing; never edit the venv by hand.
