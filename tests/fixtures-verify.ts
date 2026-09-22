// Verify the recorded golden deck against a fresh render.
//
// Run with: pnpm fixtures:verify   (a CI gate, next to themes:verify)
//
// The enforced comparison is canonical (tier T1, plan §7.2): the engines stamp
// their own times, so byte equality is reported for orientation but only required
// of the base deck, which M0 measured to be byte-stable (ADR-014).
import { readGoldenManifest, verifyGolden, GOLDEN_DIR } from './support/golden.ts'

const recorded = readGoldenManifest()
if (recorded === null) {
  console.error(`fixtures:verify: no golden manifest in ${GOLDEN_DIR}; run pnpm fixtures:record first`)
  process.exit(1)
}

console.log(`verifying fixtureVersion ${String(recorded.fixtureVersion)} (upstream pptwise ${recorded.upstream.pptwise}, ppt-master ${recorded.upstream['ppt-master']})`)
const result = await verifyGolden(recorded)
for (const line of result.lines) console.log(`  ${line}`)

if (!result.ok) {
  console.error('fixtures:verify: the golden deck no longer matches; if the change is intended, run pnpm fixtures:record and raise fixtureVersion with an explanation')
  process.exit(1)
}
const baseBytesStable = result.lines[0]?.includes('bytes identical') === true
console.log(`fixtures:verify: canonical equality holds for all three artifacts (base bytes ${baseBytesStable ? 'identical' : 'changed'})`)
