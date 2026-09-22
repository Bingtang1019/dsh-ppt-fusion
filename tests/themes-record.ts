// Record the per-theme token snapshots under fixtures/themes.
//
// Run with: pnpm themes:record
//
// The fixture set is what `tests/theme-snapshots.test.ts` verifies, so an
// upstream theme change shows up as a reviewable diff rather than a silent
// palette shift. Recording requires pptwise to be installed; it never needs the
// network or the engine venv.
import { catalogIds, captureThemes, tryResolvePptwise, writeSnapshot } from './support/theme-snapshots.ts'

const cli = tryResolvePptwise()
if (cli === null) {
  console.error('themes:record: pptwise is not installed; run pnpm install first')
  process.exit(1)
}

const ids = catalogIds(cli)
const captured = captureThemes(ids)
for (const id of ids) {
  const snapshot = captured[id]
  if (snapshot === undefined) throw new Error(`no capture for ${id}`)
  writeSnapshot(id, snapshot)
}
console.log(`recorded ${String(ids.length)} theme snapshots: ${ids.join(', ')}`)
