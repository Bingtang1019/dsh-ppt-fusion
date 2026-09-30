#!/usr/bin/env node
// Install the packed plugin into a scratch DSH profile and compose it with a pinned
// runtime. This is the second half of the compatibility CI (ADR-079, ADR-089): the
// tarball must install, satisfy the runtime's own peer gate, and compose its bundle
// layer. A runtime whose gate refuses the plugin fails here, so a range that npm
// accepts but the gate rejects cannot pass unnoticed; `--exempt` rehearses the
// documented escape hatch (`compatibility.json`) instead of hiding a bad range.
//
// Usage: node scripts/dsh-compat-profile.mjs --runtime <dir> --plugin <tarball>
//        [--home <dir>] [--expect <version>] [--exempt]
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** @returns the parsed arguments; `--exempt` is a switch, every other flag takes a value. */
function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) throw new Error(`unexpected argument ${token}`)
    const name = token.slice(2)
    if (name === 'exempt') {
      args[name] = 'true'
      continue
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${token} needs a value`)
    args[name] = value
    index += 1
  }
  return args
}

/** @param command - executable. @param args - argv. @param options - spawn options; `shell` builds one quoted command line (npm is a .cmd on Windows). @returns stdout. */
function run(command, args, options) {
  const { shell, ...spawnOptions } = options ?? {}
  const target = shell === true ? [command, ...args].map((part) => (/[\s"]/.test(part) ? `"${part.replace(/"/g, '\\"')}"` : part)).join(' ') : command
  const argv = shell === true ? [] : args
  const result = spawnSync(target, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: shell === true, ...spawnOptions })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited ${String(result.status)}:\n${result.stdout ?? ''}\n${result.stderr ?? ''}`)
  }
  return result.stdout ?? ''
}

/** @returns the absolute directory that carries `@deepseek-ai/dsh-app-boot`, or null when the line predates it. */
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
  return null
}

const args = parseArgs(process.argv.slice(2))
if (!args.runtime || !args.plugin) throw new Error('usage: node scripts/dsh-compat-profile.mjs --runtime <dir> --plugin <tarball> [--home <dir>] [--expect <version>] [--exempt]')
const runtime = resolve(args.runtime)
const plugin = resolve(args.plugin)
const bin = join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
if (!existsSync(bin)) throw new Error(`no dsh bin under ${runtime}`)
const runtimeVersion = JSON.parse(readFileSync(join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')).version
if (args.expect !== undefined && args.expect !== runtimeVersion) {
  throw new Error(`runtime ${runtime} reports dsh ${runtimeVersion}, expected ${args.expect}`)
}

const home = resolve(args.home ?? join(ROOT, 'tmp', `dsh-compat-${runtimeVersion}`))
rmSync(home, { recursive: true, force: true })
const profileDir = join(home, 'profiles', 'probe')
mkdirSync(profileDir, { recursive: true })
const tarballName = plugin.split(/[\\/]/).pop()
// `--package`/`--entry` name this repository's plugin by default; the negative
// control for the gate rehearses another package without editing the script.
const pluginName = args.package ?? 'dsh-ppt-flashmade'
const entryId = args.entry ?? 'dsh-ppt-fusion'
writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({
  name: 'dsh-compat-probe',
  private: true,
  type: 'module',
  dependencies: { [pluginName]: `file:${plugin.replace(/\\/g, '/')}` },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', pluginName] } },
}, null, 2)}\n`)
run('npm', ['install', '--no-audit', '--no-fund', '--loglevel', 'error'], { cwd: profileDir, shell: true, env: { ...process.env, npm_config_registry: process.env.npm_config_registry ?? 'https://registry.npmjs.org' } })

const installed = JSON.parse(readFileSync(join(profileDir, 'node_modules', pluginName, 'package.json'), 'utf8'))
const appBootDir = resolveAppBoot(runtime)
let gateNote = 'no peer gate on this line'
if (appBootDir !== null) {
  const appBoot = await import(pathToFileURL(join(appBootDir, 'lib', 'index.js')).href)
  if (typeof appBoot.evaluatePluginCompatibility === 'function') {
    const issue = appBoot.evaluatePluginCompatibility(installed)
    // A mismatching peer always yields an issue object; `exempted` is what the loader
    // reads to decide whether the profile may run it anyway.
    if (issue === undefined) {
      gateNote = 'peer gate clean'
    } else if (issue.exempted === true) {
      gateNote = 'exemption already active'
    } else if (args.exempt !== 'true') {
      throw new Error(`${appBoot.pluginCompatibilityWarning(issue)}\n\nThe packed plugin is refused by dsh ${runtimeVersion}. Fix the peer range, or pass --exempt to rehearse the profile exemption.`)
    } else if (typeof appBoot.readProfileCompatibility !== 'function') {
      // The exemption file is a 0.2.0 contract; an older gate has no reader for it, so
      // a refused plugin cannot be admitted on that line at all.
      throw new Error(`dsh ${runtimeVersion} refuses the packed plugin and has no profile exemption reader; fix the peer range`)
    } else {
      // The gate reads `<profileDir>/compatibility.json`: exact `name@version` keys,
      // each mapped to the exact runtime versions it may run on.
      const key = `${installed.name}@${installed.version}`
      writeFileSync(join(profileDir, 'compatibility.json'), `${JSON.stringify({ [key]: [runtimeVersion] }, null, 2)}\n`)
      const { exemptions, warnings } = appBoot.readProfileCompatibility(profileDir)
      for (const warning of warnings ?? []) console.error(`warning: ${warning}`)
      const exempted = appBoot.evaluatePluginCompatibility(installed, exemptions, runtimeVersion)
      if (exempted === undefined || exempted.exempted !== true) {
        throw new Error(`the exemption ${key} on dsh ${runtimeVersion} did not take effect`)
      }
      gateNote = `exemption exercised (${key} on dsh ${runtimeVersion})`
    }
  }
}

const dump = run(process.execPath, [bin, '--profile', 'probe', '--dump-config'], { cwd: profileDir, env: { ...process.env, DSH_HOME: home } })
if (!dump.includes(pluginName)) throw new Error(`the composed profile does not carry the plugin layer:\n${dump.slice(0, 400)}`)
if (!dump.includes(`id: ${entryId}`)) throw new Error(`the composed profile does not mount the plugin entry:\n${dump.slice(0, 400)}`)
console.log(`dsh-compat profile ok: dsh ${runtimeVersion} composes ${pluginName}@${installed.version} from ${tarballName} (${gateNote})`)
