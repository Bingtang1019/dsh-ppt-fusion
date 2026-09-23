// Verify the recorded golden deck against a fresh render.
//
// Run with: pnpm fixtures:verify   (a CI gate, next to themes:verify)
//
// The enforced comparison is canonical (tier T1, plan §7.2): the engines stamp
// their own times, so byte equality is reported for orientation but only required
// of the base deck, which M0 measured to be byte-stable (ADR-014).
import { readFileSync } from 'node:fs'
import { auditDeck } from '../src/commands/audit.ts'
import { defaultDependencies } from '../src/commands/context.ts'
import { narrationTimings, showTimingsEnabled } from '../src/bridge/post.ts'
import { OpcPackage } from '../src/bridge/opc.ts'
import { assertCompatLevel, compatSnapshots, readCompatGolden, readGoldenManifest, verifyGolden, GOLDEN_DIR, GOLDEN_WORKSPACE } from './support/golden.ts'

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

// S23 (V6 Q5): a narrated slide must advance on a timer whose number is the
// deterministic recompute (frame-sum duration + the engine's lead-in and padding),
// and the merged package must keep the show-timings flag that makes it effective.
const mergedPackage = await OpcPackage.read(mergedBytes)
const narrated = narrationTimings(mergedPackage).filter((timing) => timing.mediaPart !== null)
if (narrated.length > 0) {
  const timingProblems: string[] = []
  if (!showTimingsEnabled(mergedPackage)) timingProblems.push('presProps.xml does not set p:showPr useTimings="1"')
  for (const timing of narrated) {
    if (timing.advanceMs === null) timingProblems.push(`${timing.slidePart}: narration ${timing.mediaPart ?? '?'} has no readable MPEG frames`)
    else if (timing.advTmMs === null || Math.abs(timing.advTmMs - timing.advanceMs) > 100) {
      timingProblems.push(`${timing.slidePart}: advTm ${timing.advTmMs === null ? 'missing' : String(timing.advTmMs)} but the audio measures ${String(timing.advanceMs)}`)
    }
  }
  if (timingProblems.length > 0) {
    console.error('fixtures:verify: narration auto-advance (S23) failed:')
    for (const problem of timingProblems) console.error(`  ${problem}`)
    process.exit(1)
  }
  console.log(`fixtures:verify: narration auto-advance ok (${String(narrated.length)} narrated slide(s), useTimings=1)`)
}
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

// The pixel (delta E) half of the theme audit: rasterise every deep SVG and
// compare its dominant colours with the bound token palette. Zero findings is the
// gate; the audit's own `--pixels` switch is the same code path users run (ADR-035).
const pixelReport = await auditDeck({ dir: GOLDEN_WORKSPACE, strict: false, pixels: true, deps: defaultDependencies() })
const paletteFindings = pixelReport.findings.filter((finding) => finding.source === 'palette' || finding.rule.startsWith('palette-'))
if (paletteFindings.length > 0) {
  console.error('fixtures:verify: the deep pages paint colours outside the token palette:')
  for (const finding of paletteFindings) console.error(`  ${finding.rule}: ${finding.message}`)
  process.exit(1)
}
console.log(`fixtures:verify: pixels clean (${String(pixelReport.sources.length)} audit source(s), ${String(pixelReport.findings.length)} finding(s) total)`)
