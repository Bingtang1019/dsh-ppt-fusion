// S24 gate: re-extract the reference profile and compare it field by field with
// `fixtures/reference/profile.json`.
//
// The reference deck is a local file that must never enter the repository or the
// package (V7.2 deck discipline), so the gate takes its path from
// `DSH_PPT_REFERENCE_DECK`. Without it — CI, another machine — the gate reports
// `skipped` and exits 0, the same shape as `compat:matrix`'s LibreOffice half.
//
// Run with: pnpm design:verify
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractDesignProfile } from '../src/commands/design.ts'
import { defaultDependencies } from '../src/commands/context.ts'
import { parseDesignProfile } from '../src/schema/design-profile.ts'

/** @returns the value with object keys sorted, so two profiles compare structurally. */
function canonical(value: unknown): string {
  return JSON.stringify(sort(value))
}

/** @returns `value` with every object's keys sorted recursively. */
function sort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sort)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, sort(entry)]),
    )
  }
  return value
}

const root = fileURLToPath(new URL('..', import.meta.url))
const reference = process.env.DSH_PPT_REFERENCE_DECK ?? ''

if (reference === '') {
  console.log('design:verify: skipped (set DSH_PPT_REFERENCE_DECK to the local reference .pptx)')
  process.exit(0)
}
if (!existsSync(reference)) {
  console.error(`design:verify: DSH_PPT_REFERENCE_DECK does not exist: ${reference}`)
  process.exit(1)
}

const fixturePath = join(root, 'fixtures', 'reference', 'profile.json')
const fixtureText = readFileSync(fixturePath, 'utf8')
if (/[^\x20-\x7E\r\n\t]/.test(fixtureText)) {
  console.error('design:verify: the recorded profile contains non-ASCII characters; a profile must carry numbers, colours and font names only')
  process.exit(1)
}
const fixture = parseDesignProfile(JSON.parse(fixtureText) as unknown)

const output = join(root, 'tmp', 'design', 'profile.verify.json')
const result = extractDesignProfile({ file: reference, output, deps: defaultDependencies({ cwd: root }) })
if (canonical(result.profile) !== canonical(fixture)) {
  console.error('design:verify: the extractor no longer reproduces fixtures/reference/profile.json')
  console.error(`  fixture: ${canonical(fixture).slice(0, 400)}`)
  console.error(`  fresh:   ${canonical(result.profile).slice(0, 400)}`)
  console.error('  if the change is intended, re-record the fixture from the reviewed extraction and explain it in ADR-061')
  process.exit(1)
}
console.log(`design:verify: profile matches fixtures/reference/profile.json (${String(Object.keys(result.profile.roles).length)} role(s), ${String(Object.keys(result.profile.typeScale).length)} type row(s))`)
