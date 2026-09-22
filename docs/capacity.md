# Capacity (plan M8.4)

Last measured with `pnpm capacity:run` (2026-09-22):

- deck: 60 standard pages (no deep pages), theme `brief`, synthesized from the `init` skeleton
- wall time: 2.6 s (2634 ms)
- package: 60 slide(s), 175885 bytes
- merge: 0 page(s) replaced, 0 part(s) imported, single master
- compat: level standard, 60 occurrence(s), 0 warning(s)

Guardrail: a future change that makes this probe exceed roughly twice the recorded wall time or
bytes at the same page count needs an ADR explaining the regression or the new baseline. The
probe is a manual gate (`pnpm capacity:run`), not part of `pnpm test`, because it renders a
60-page deck.
