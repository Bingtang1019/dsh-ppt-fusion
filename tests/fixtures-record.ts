// Record the golden deck (fixtures/hello) into fixtures/golden.
//
// Run with: pnpm fixtures:record
//
// Recording is deliberate: it renders the fixture through the whole chain
// (pptwise base, ppt-master deep, merge, post) and stores the three artifacts plus
// their hashes. Bump the fixture version and explain the difference in the same
// commit whenever this changes anything but a mechanical regeneration -- plan §7.3.
import { readFileSync } from 'node:fs'
import { compatSnapshots, readGoldenManifest, renderGolden, writeCompatGolden, writeGolden, GOLDEN_DIR } from './support/golden.ts'

const previous = readGoldenManifest()
const staged = await renderGolden()
const manifest = await writeGolden(staged, previous?.fixtureVersion ?? 0)

console.log(`recorded fixtureVersion ${String(manifest.fixtureVersion)} into ${GOLDEN_DIR}`)
for (const [label, reference] of Object.entries({ base: manifest.baseRef, deep: manifest.deepRef, merged: manifest.mergedRef })) {
  console.log(`  ${label}: ${reference.file} ${String(reference.bytes)} bytes sha256=${reference.sha256.slice(0, 16)}… canonical=${reference.canonical.slice(0, 16)}…`)
}
const compat = writeCompatGolden(await compatSnapshots(readFileSync(staged.merged)), manifest.fixtureVersion)
console.log(`  compat levels: ${Object.keys(compat.levels).join('/')} snapshot(s) written (registry v${String(compat.registryVersion)})`)
console.log(`  previous version: ${previous === null ? 'none' : String(previous.fixtureVersion)}`)
