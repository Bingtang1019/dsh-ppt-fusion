// Verify the recorded per-theme token snapshots against the installed upstream.
//
// Run with: pnpm themes:verify   (part of the CI gates)
//
// This is a separate gate rather than a vitest case on purpose: it drives the
// real pptwise CLI 24 times synchronously, which blocks the test worker past
// vitest's own RPC timeout. `tests/theme-snapshots.test.ts` keeps the cheap
// structural checks plus a single-theme re-capture in the unit suite.
import { catalogIds, captureThemes, readSnapshot, tryResolvePptwise } from './support/theme-snapshots.ts'

const cli = tryResolvePptwise()
if (cli === null) {
  console.error('themes:verify: pptwise is not installed; run pnpm install first')
  process.exit(1)
}

const ids = catalogIds(cli)
const captured = captureThemes(ids)
const problems: string[] = []

for (const id of ids) {
  const recorded = readSnapshot(id)
  if (recorded === null) {
    problems.push(`${id}: no snapshot recorded (run pnpm themes:record)`)
    continue
  }
  const fresh = captured[id]
  if (fresh === undefined) {
    problems.push(`${id}: capture produced nothing`)
    continue
  }
  if (JSON.stringify(fresh.tokens) !== JSON.stringify(recorded.tokens)) problems.push(`${id}: tokens drifted from the snapshot`)
  if (JSON.stringify(fresh.master) !== JSON.stringify(recorded.master)) problems.push(`${id}: master projection drifted from the snapshot`)
  // The snapshot must still be a 1:1 projection of the upstream theme style groups.
  if (fresh.tokens.colors.bg !== fresh.tokens.defaultBackgrounds.cover?.value && fresh.tokens.defaultBackgrounds.cover?.kind === 'color') {
    problems.push(`${id}: token colours do not mirror the theme style groups`)
  }
}

if (problems.length > 0) {
  console.error(`themes:verify: ${String(problems.length)} problem(s)`)
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}
console.log(`themes:verify: ${String(ids.length)} theme snapshots match the installed pptwise ${cli.version}`)
