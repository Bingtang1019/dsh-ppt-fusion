#!/usr/bin/env node
// Evaluate this plugin's manifest with an installed DSH runtime's own peer gate.
//
// The gate lives in `@deepseek-ai/dsh-app-boot` (`evaluatePluginCompatibility`):
// it checks every `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peer range against the
// running runtime version, with prereleases participating. CI runs this against
// both supported runtime lines (ADR-079) so a peer range that would disable the
// plugin on either line fails the build instead of the user's profile.
//
// Usage: node scripts/dsh-compat.mjs --runtime <dir> [--manifest <file>] [--expect <version>]
import { readFileSync, existsSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** @returns the parsed `--name value` arguments. */
function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) throw new Error(`unexpected argument ${token}`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${token} needs a value`)
    args[token.slice(2)] = value
    index += 1
  }
  return args
}

/** @returns the absolute directory that carries `@deepseek-ai/dsh-app-boot`. */
function resolveAppBoot(runtime) {
  const candidates = [runtime]
  const dshLink = join(runtime, 'node_modules', '@deepseek-ai', 'dsh')
  if (existsSync(dshLink)) candidates.push(realpathSync(dshLink))
  for (const base of candidates) {
    try {
      const require = createRequire(join(base, 'noop.js'))
      return dirname(require.resolve('@deepseek-ai/dsh-app-boot/package.json'))
    } catch {
      // try the next candidate
    }
  }
  throw new Error(`cannot resolve @deepseek-ai/dsh-app-boot from ${runtime}`)
}

const args = parseArgs(process.argv.slice(2))
if (!args.runtime) throw new Error('usage: node scripts/dsh-compat.mjs --runtime <dir> [--manifest <file>] [--expect <version>]')
const runtime = resolve(args.runtime)
const manifestPath = resolve(args.manifest ?? join(ROOT, 'package.json'))
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const appBootDir = resolveAppBoot(runtime)
const appBoot = await import(pathToFileURL(join(appBootDir, 'lib', 'index.js')).href)
// The peer gate only exists on the 0.1.7 line; 0.1.2 predates it, so CI passes
// `--allow-missing-gate` for the older leg and relies on the profile smoke there.
if (typeof appBoot.evaluatePluginCompatibility !== 'function') {
  if (args['allow-missing-gate'] === 'true') {
    const version = JSON.parse(readFileSync(join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')).version
    console.log(`dsh-compat skipped: dsh ${version} has no peer gate; run the profile smoke instead`)
    process.exit(0)
  }
  throw new Error(`dsh-app-boot in ${runtime} has no evaluatePluginCompatibility; pass --allow-missing-gate to skip`)
}
// `getDshRuntimeVersion` only exists on newer app-boot builds; the runtime manifest
// carries the same version everywhere.
const runtimeVersion = typeof appBoot.getDshRuntimeVersion === 'function'
  ? appBoot.getDshRuntimeVersion()
  : JSON.parse(readFileSync(join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')).version
if (args.expect !== undefined && args.expect !== runtimeVersion) {
  throw new Error(`runtime ${runtime} reports dsh ${runtimeVersion}, expected ${args.expect}`)
}
const issue = appBoot.evaluatePluginCompatibility(manifest)
if (issue !== undefined) {
  console.error(appBoot.pluginCompatibilityWarning(issue))
  process.exit(1)
}
const peers = Object.keys(manifest.peerDependencies ?? {}).filter((name) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
console.log(`dsh-compat ok: ${manifest.name}@${manifest.version} vs dsh ${runtimeVersion} (${peers.length} dsh peer(s): ${peers.join(', ')})`)
