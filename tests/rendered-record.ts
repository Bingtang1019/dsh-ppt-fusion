// Record the rendered page baseline for a local reference deck.
//
// Run with: DSH_PPT_REFERENCE_DECK_DIR=<deck workspace> pnpm rendered:record [-- --name reference-quality]
//
// The deck and its page images never enter the repository: only the baseline JSON
// (source digest, engine versions, per-page dimensions and sha256) is committed,
// and `fixtures:verify --rendered` compares a machine that has the deck.
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildRenderedBaseline, writeRenderedBaseline } from './rendered-baseline.ts'
import { readGoldenManifest } from './support/golden.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const deckDir = process.env.DSH_PPT_REFERENCE_DECK_DIR ?? ''
const nameFlag = process.argv.indexOf('--name')
const name = nameFlag >= 0 ? (process.argv[nameFlag + 1] ?? 'reference-quality') : 'reference-quality'

if (deckDir === '') {
  console.error('rendered:record: set DSH_PPT_REFERENCE_DECK_DIR to the reference deck workspace (the directory holding out/ and .dsh-ppt/)')
  process.exit(1)
}
const golden = readGoldenManifest()
const fixtureVersion = golden?.fixtureVersion ?? 0
const baseline = buildRenderedBaseline(deckDir, name, fixtureVersion)
const target = join(root, 'fixtures', 'rendered', `${name}.json`)
mkdirSync(dirname(target), { recursive: true })
writeRenderedBaseline(target, baseline)
const engines = Object.entries(baseline.engines)
  .map(([engine, entry]) => `${engine} ${entry?.version ?? '?'} (${String(entry?.pages.length ?? 0)} page(s))`)
  .join(', ')
console.log(`rendered:record: ${name} fixtureVersion ${String(fixtureVersion)} source ${baseline.source.sha256.slice(0, 12)}…, ${engines} → ${target}`)