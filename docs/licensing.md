# Licensing

`dsh-ppt-fusion` is MIT. This page records every component the package ships or
consumes, and the one deliberate distinction between what is redistributed and
what is built locally.

## Shipped in this package

| Component | Licence | Where |
|---|---|---|
| dsh-ppt-fusion source | MIT | repository root `LICENSE` |
| ppt-master 0.1.128 documentation | MIT | `python-assets/vendor/ppt-master/docs/`, per-file SHA-256 in `python-assets/vendor/manifest.json`, attribution in `python-assets/vendor/NOTICE` |
| pptwise 0.35.0 plugin shell (adapted) | MIT, Copyright (c) 2026 Leon Liu | `dsh/preview-tool.js`, `dsh/client.js`, `dsh/spawnHidden.js`; `dsh/index.js` follows its structure — see root `NOTICE` |
| `@liustack/pptwise` runtime dependency | MIT | installed from npm, not vendored |
| `commander` 13.x | MIT | npm dependency |
| `jszip` 3.10.1 | MIT OR GPL-3.0-or-later (used under MIT) | npm dependency |
| `sharp` 0.35.x | Apache-2.0 | npm dependency |
| `zod` 4.x | MIT | npm dependency |

Development-only dependencies (vitest, tsx, tsup, typescript, eslint,
typescript-eslint, js-yaml and the type packages) are not part of a published
install; their licences are MIT except `typescript` (Apache-2.0).

## Built locally, never redistributed

The Python engine environment lives outside the package, under
`~/.dsh/ppt-fusion/venvs/`, and is created by the user's own
`dsh-ppt doctor --repair` from `python-assets/requirements.lock`. It is not part
of the npm tarball and is not redistributed by this project.

That lock pins `ppt-master==0.1.128` (MIT) and its dependency tree. Two facts
matter for downstream redistribution:

- `cairosvg` (LGPL-3.0-or-later) is declared so Office-compatible PNG fallbacks
  exist where cairo is available.
- **PyMuPDF (AGPL-3.0)** arrives as a transitive dependency of ppt-master and is
  used by the PDF source path only. Because the venv is built locally by each
  user's own `doctor` run, this project never redistributes it; anyone who
  redistributes a built venv must comply with AGPL-3.0 themselves.

The narration path uses `edge-tts` (no key) inside that same venv; the pdf/docx/
xlsx/pptx conversion paths use the packages the lock pins.

## Upstream notices

- ppt-master: <https://github.com/elvisw/ppt-master> (MIT; the wheel README names
  <https://github.com/hugohe3/ppt-master> as the original repository).
- pptwise: `@liustack/pptwise` 0.35.0 (MIT, Copyright (c) 2026 Leon Liu).

Both notices are reproduced in the root `NOTICE` and
`python-assets/vendor/NOTICE`.
