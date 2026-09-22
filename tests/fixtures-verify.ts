// Verify the recorded golden deck against a fresh render.
//
// Run with: pnpm fixtures:verify   (a CI gate, next to themes:verify)
//
// The enforced comparison is canonical (tier T1, plan §7.2): the engines stamp
// their own times, so byte equality is reported for orientation but only required
// of the base deck, which M0 measured to be byte-stable (ADR-014).
import { readFileSync } from 'node:fs'
import { assertCompatLevel, compatSnapshots, readCompatGolden, readGoldenManifest, verifyGolden, GOLDEN_DIR } from './support/golden.ts'

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

// The three compat levels are part of the same fixture version: recompute the pass
// over the fresh merged package and compare the stable report fields, then check that
// no level keeps a marker it forbids.
const recordedCompat = readCompatGolden()
if (recordedCompat === null) {
  console.error('fixtures:verify: no compat goldens in ' + GOLDEN_DIR + '; run pnpm fixtures:record first')
  process.exit(1)
}
if (recordedCompat.fixtureVersion !== recorded.fixtureVersion) {
  console.error(`fixtures:verify: compat goldens are fixtureVersion ${String(recordedCompat.fixtureVersion)} but the package manifest is ${String(recorded.fixtureVersion)}; re-record`)
  process.exit(1)
}
const mergedBytes = readFileSync(result.staged.merged)
const fresh = await compatSnapshots(mergedBytes)
for (const level of ['safe', 'standard', 'max'] as const) {
  const expected = JSON.stringify(recordedCompat.levels[level])
  const actual = JSON.stringify(fresh.levels[level])
  if (expected !== actual) {
    console.error(`fixtures:verify: the ${level} compat report no longer matches the recorded snapshot`)
    console.error(`  recorded: ${expected.slice(0, 400)}`)
    console.error(`  fresh:    ${actual.slice(0, 400)}`)
    process.exit(1)
  }
  console.log(`  compat ${level}: snapshot equal`)
  const violations = await assertCompatLevel(mergedBytes, level)
  if (violations.length > 0) {
    console.error(`fixtures:verify: ${level} keeps forbidden markers or findings:`)
    for (const violation of violations) console.error(`  ${violation}`)
    process.exit(1)
  }
}
const baseBytesStable = result.lines[0]?.includes('bytes identical') === true
console.log(`fixtures:verify: canonical equality holds for all three artifacts (base bytes ${baseBytesStable ? 'identical' : 'changed'})`)
