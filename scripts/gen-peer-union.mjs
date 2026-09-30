#!/usr/bin/env node
// Write, or check, the `@deepseek-ai/dsh*` peer union in package.json from the single source in
// scripts/runtime-lines.mjs (ADR-079, ADR-090).
//
// The union is eight bands long and hand-editing it went wrong once already: npm's prerelease rule
// needs one band per patch line, while the runtime gate accepts far more, so a range can satisfy the
// gate and still fail to install. `pnpm prepack` runs this with `--check`, so a release cannot ship a
// manifest that disagrees with the declared lines.
//
// Usage: node scripts/gen-peer-union.mjs [--check] [--manifest <file>]
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { COVERED_PATCH_LINES, DSH_PEERS, RUNTIME_LINES, dshPeerRange, governanceProblems } from './runtime-lines.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** @returns the parsed arguments: `--check` is a switch, `--manifest` takes a path. */
function parseArgs(argv) {
  const args = { check: false }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--check') {
      args.check = true
      continue
    }
    if (token === '--manifest') {
      const value = argv[index + 1]
      if (value === undefined) throw new Error('--manifest needs a path')
      args.manifest = value
      index += 1
      continue
    }
    throw new Error(`unexpected argument ${token}`)
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
const manifestPath = resolve(args.manifest ?? join(ROOT, 'package.json'))
const manifestText = readFileSync(manifestPath, 'utf8')
const manifest = JSON.parse(manifestText)

const problems = governanceProblems(RUNTIME_LINES, COVERED_PATCH_LINES)
if (problems.length > 0) {
  console.error(`gen-peer-union: the declared runtime lines are inconsistent:\n  ${problems.join('\n  ')}`)
  process.exit(1)
}
const range = dshPeerRange(COVERED_PATCH_LINES)
const peers = manifest.peerDependencies ?? {}
const drifted = DSH_PEERS.filter((name) => peers[name] !== range)

if (args.check) {
  if (drifted.length > 0) {
    console.error(`gen-peer-union: package.json is not the generated union (run \`node scripts/gen-peer-union.mjs\`):`)
    for (const name of drifted) {
      console.error(`  ${name}:`)
      console.error(`    manifest:  ${String(peers[name])}`)
      console.error(`    generated: ${range}`)
    }
    process.exit(1)
  }
  console.log(`gen-peer-union ok: ${String(DSH_PEERS.length)} peers match the union over ${String(COVERED_PATCH_LINES.length)} patch line(s) and ${String(RUNTIME_LINES.length)} measured line(s)`)
  process.exit(0)
}

if (drifted.length === 0) {
  console.log(`gen-peer-union: no change (${String(DSH_PEERS.length)} peers, ${String(COVERED_PATCH_LINES.length)} bands)`)
  process.exit(0)
}
let next = manifestText
for (const name of drifted) {
  const before = `"${name}": ${JSON.stringify(peers[name])}`
  const after = `"${name}": ${JSON.stringify(range)}`
  if (!next.includes(before)) throw new Error(`package.json does not contain \`${before}\` verbatim; refusing to rewrite it`)
  next = next.replace(before, after)
}
writeFileSync(manifestPath, next, 'utf8')
console.log(`gen-peer-union: updated ${String(drifted.length)} peer range(s) in ${manifestPath}`)
for (const name of drifted) console.log(`  ${name}`)