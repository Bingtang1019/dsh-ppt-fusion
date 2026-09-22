# M0.G compatibility probe

Date: 2026-09-22. Experiment G of plan v3: measure what the two upstreams actually
emit, which Office versions this machine can verify, and whether the PNG fallback path
the plan depends on works. Raw commands are in the transcript; this file is the record
the registry and the M4 compat pass are built on.

## Machine facts

| Fact | Value |
|---|---|
| Microsoft Office | PowerPoint 16.0, build 20326 (`Microsoft PowerPoint`) — Microsoft 365, so only the "new Office" leg is verifiable locally |
| WPS Office | **not installed** (checked `Program Files (x86)\Kingsoft\WPS Office`, `Program Files\WPS Office`, `%LOCALAPPDATA%\Kingsoft\WPS Office`) |
| LibreOffice | **not installed** (`soffice` not on PATH, no `Program Files\LibreOffice`) |
| python-pptx | available in the engine venv (1.0.2), used as the independent reader |

Consequence: local verification covers T1-Office-365 plus static lint plus python-pptx.
WPS and old Office remain user/VM work (S17), and LibreOffice must be added to the CI
Linux leg (S16) — exactly the path plan §3.14 already prescribes.

## PNG rasteriser (the plan's blocking assumption): **B7 activated**

The exporter needs a PNG rasteriser for its Office compatibility mode. Measured:

| Step | Result |
|---|---|
| `cairosvg` installed from the lock | installs (2.9.1 + cairocffi 1.7.1) but `import cairosvg` raises `OSError: no library called "cairo-2" was found` |
| upstream detector effect | `PNG_RENDERER is None`; upstream prints `Warning: No PNG rendering library installed, cannot use compatibility mode` and silently sets `use_compat_mode = False` ("may not display in Office LTSC 2021 and similar versions") |
| `svglib` + `reportlab` (upstream's own fallback) | detected as `svglib`, but its conversion fails: `cannot import desired renderPM backend rlPyCairo` |
| `rlPyCairo` + `pycairo` | pycairo imports and reports cairo 1.18.4 (its wheel statically links cairo), but `reportlab`/`cairocffi` still resolve libcairo through `ctypes` and fail to find a DLL — and installing rlPyCairo makes it worse: the detector now reports **no** renderer at all |
| net result on this machine | **no Python-side SVG→PNG rasteriser works** |

`docs/compat/probe.md` therefore activates **Plan B7**: the compatibility pass'
`stamp` step will rasterise with the Node-side `sharp` (already proven available by
`pptwise doctor`: `sharp=true`) and inject the PNG blip plus MCE wrapper itself. The
cost lands in M4 (+1–2 pd per the decision matrix), not in M1.

`doctor` reports this honestly instead of letting the degradation stay silent: the
`png-renderer` check fails with `cairosvg 2.9.1 is installed but cannot import: no
library called "cairo-2" was found` and the fix line names both remedies. That is the
M1 acceptance item v3 amended (§3.4 requires the lock to carry cairosvg and `doctor` to
assert the renderer is usable, never to stay green while the renderer is absent).

## What our own output actually carries (the reassuring half)

Marker census over `fixtures/golden/deep.pptx` (native-shape export of five deep pages,
one native chart, one native table):

| Marker | Present? | Meaning |
|---|---|---|
| `p14:dur` | **yes, on all 5 slides** | Office 2010 transition duration; the only version-sensitive marker `pptwise` also emits |
| `asvg:svgBlip` | no | this deck has no SVG-as-image content |
| `mc:AlternateContent` | no | nothing needs an MCE choice/fallback pair yet |
| `a14:m` | no | no formula pages yet |
| `p14:creationId` | no | nothing to de-duplicate yet |

So the PNG-fallback requirement does **not** bite the native-shape path we ship today:
upstream ignores compat mode in native mode (`builder.py`: "Retained for API
compatibility; ignored in native mode"). It becomes real for SVG-image content —
formulas, imported SVG icons, template materialisation — which is M5 material. B7 is
sized accordingly and deferred to M4 with the rest of the compat pass.

The same census confirms §1.5's claim from the other direction: `p14:dur` is the only
version-sensitive namespace in a pptwise-produced deck, which is why the registry's
first entries are cheap single-attribute checks rather than a rewrite engine.

## Independent reader (python-pptx reopen)

`scripts/probe-pptx-reopen.py` walks each deck recursively (group shapes included).

| Deck | slides | shapes | text chars | tables | charts | verdict |
|---|---|---|---|---|---|---|
| `base.pptx` (pptwise) | 5 | 91 | 807 | 0 | 0 | readable |
| `deep.pptx` (ppt-master native) | 5 | 55 | 464 | 1 | 1 | readable |
| `merged-chart.pptx` (merged) | 5 | 68 | 715 | 0 | 1 | readable |

One pitfall worth keeping: without descending into group shapes the same probe reports
`deep.pptx` as 14 shapes with **zero** text, which looks exactly like data loss.
ppt-master emits group-heavy slides, so any S16 assertion must count recursively — a
non-recursive check would have produced a false alarm in the compatibility matrix.

## What the probe hands to the later milestones

- **M4** owns `bridge/compat.ts` and the B7 rasteriser; `src/compat/registry.json` starts
  with the entries measured here (`p14:dur`, morph, advanced transitions, bounce
  animations, `asvg` + PNG, `a14:m`, chart-type tiers, audio formats, `a:ea` fonts).
- **M8** owns the matrix: LibreOffice headless on CI Linux, python-pptx reopen (this
  script), `pnpm compat:lint` over every golden, and the WPS checklist that needs user
  resources.
- **M1** owns the honest `doctor` row that keeps the rasteriser gap visible until then.
