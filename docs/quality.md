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
| 2 | reference-quality | 3.6 (user) | 4 (est.) | 4 (est.) | 12 pages follow the profile's type scale, anchors, cards and chrome; preview at `tmp/quality-demo/preview/preview.html`; the two deep pages warn on MiSans font slots; user page scores below (mean 3.6, page 2 weakest) |
| 3 | doc-to-deck | 3 (est.) | 4 (est.) | 4 (est.) | 6 pages, one editable chart; seven font-slot warnings |

`(est.)` marks an assistant estimate from the preview structure and audit facts. The human scores
are pending the user's side-by-side review (S27); update this table with the confirmed numbers and
keep the estimates in git history if they change.

User review (2026-09-24): the three samples were reviewed side by side with the reference deck. The
standing comment is to watch card and element spacing when generating; the confirmed 1–5 numbers
replace the `(est.)` cells once they are transcribed here.

### S27 page-level alignment (user, 2026-09-24)

The user compared the 12 `reference-quality` pages with the reference deck page by page and scored each
page 1–5 (5 = closest to the reference):

| Page | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Score | 4 | **2** | 4 | 3 | 4 | 3 | 4 | 5 | 4 | 4 | 3 | 3 |

Mean 3.58. Page 2 (toc) is the outlier, and the user located the cause: text hidden behind the four
cards. The design pass had moved the page title to `profile.roles.toc.titlePos` — geometry the extractor
measured from the reference's `01.` number box (5.19, 1.79 in) — so the 40 pt title sat on the card
row's top edge (panels start at 1.94 in) and painted **under** the panels; PowerPoint COM rendered 0 px
of title ink before the fix. ADR-073 keeps the authored anchor on toc pages, and the re-render puts the
title above the cards (title-band ink 3755 px). The other low pages (4/6/11/12 at 3) are the next
candidates; page 8 scored 5. Content pages 4/6/11 were normalised to the reference's equal card
columns and 20 pt accent / 14 pt body card text in ADR-075, and their titles now clear the theme's
corner mark by 8 px at one ladder step down (ADR-077); re-score pending. Without `image-gen` the
design language asks each content page to keep a ≥ 1/4-page illustration area free.

## Reproduce

```sh
pnpm eval:run --scenario reference-quality
node --import tsx src/cli.ts audit <deck> --profile design-profile.json --json
node --import tsx src/cli.ts preview <deck> --html
```

The demo copy of the package, its audit JSON, manifest, compat report and preview live under
`tmp/quality-demo/` (ignored: the deck itself never enters the repository or the package).
## V10 Part A baseline: render snapshots and the render-level gate (v0.5.0 line)

Recorded 2026-09-25 on this machine against the local `reference-quality` deck
(`out/food-safety-internship-report.pptx`, sha256 `736fbecc…`, 12 slides).

| Item | Result |
|---|---|
| `dsh-ppt renderpages` | PowerPoint COM 16.0: 12 pages at 1280×720 in 24 s; LibreOffice Kit 0.1.1 (native): 12 pages at 1280×721 in 11 s (5 s warm); a second run reports both `cached` and starts no renderer |
| `dsh-ppt text-measure` | 36 pt MiSans title measures 572.4 px; `--box 644x80` wraps to one 40.8 px line and reports `fits`; `--box 200x30` reports `overflow: [x, y]` |
| `dsh-ppt audit --rendered` | `ok=true`, only two `render-parity` warnings (engine ink shares drift 6.2 % / 0.5 %); page-count, content-loss, off-page, overlap, contrast, chrome and tofu are clean |
| Rendered baseline | `fixtures/rendered/reference-quality.json` (schemaVersion 1, fixtureVersion 8, both engines with per-page dimensions and sha256); `pnpm fixtures:verify --rendered` with `DSH_PPT_REFERENCE_DECK_DIR` reports "rendered baseline equal", without it reports `skipped` |
| Engine fact worth keeping | LibreOffice draws `wrap="none"` text frames with its own vertical anchor (30–100 px above the declared boxes); PowerPoint paints them exactly at the box, which is why the gate samples text through its enclosing card panel and runs the tofu probe on PowerPoint only (ADR-082) |

S27: the human score for the 12 pages is still the 2026-09-24 review (mean 3.58,
P2 = 2); Part A did not change any page, it made the render state measurable, and
the P2 wording ("text hidden behind the cards") is **not** reproducible in
PowerPoint or LibreOffice — both render the toc title and card texts inside their
cards (see ADR-082's evidence), so the remaining P2 score needs a fresh look with
the user.
