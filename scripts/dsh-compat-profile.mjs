#!/usr/bin/env node
// Install the packed plugin into a scratch DSH profile and compose it with a
// pinned runtime. This is the second half of the dual-version compatibility CI
// (ADR-079): the peer gate only exists on the 0.1.7 line, so the older leg proves
// the plugin still installs and its bundle layer composes.
//
// Usage: node scripts/dsh-compat-profile.mjs --runtime <dir> --plugin <tarball> [--home <dir>]
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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

const args = parseArgs(process.argv.slice(2))
if (!args.runtime || !args.plugin) throw new Error('usage: node scripts/dsh-compat-profile.mjs --runtime <dir> --plugin <tarball> [--home <dir>]')
const runtime = resolve(args.runtime)
const plugin = resolve(args.plugin)
const bin = join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
if (!existsSync(bin)) throw new Error(`no dsh bin under ${runtime}`)
const runtimeVersion = JSON.parse(readFileSync(join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')).version

const home = resolve(args.home ?? join(ROOT, 'tmp', `dsh-compat-${runtimeVersion}`))
rmSync(home, { recursive: true, force: true })
const profileDir = join(home, 'profiles', 'probe')
mkdirSync(profileDir, { recursive: true })
const tarballName = plugin.split(/[\\/]/).pop()
writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({
  name: 'dsh-compat-probe',
  private: true,
  type: 'module',
  dependencies: { 'dsh-ppt-flashmade': `file:${plugin.replace(/\\/g, '/')}` },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-ppt-flashmade'] } },
}, null, 2)}\n`)
run('npm', ['install', '--no-audit', '--no-fund', '--loglevel', 'error'], { cwd: profileDir, shell: true, env: { ...process.env, npm_config_registry: process.env.npm_config_registry ?? 'https://registry.npmjs.org' } })
const dump = run(process.execPath, [bin, '--profile', 'probe', '--dump-config'], { cwd: profileDir, env: { ...process.env, DSH_HOME: home } })
if (!dump.includes('dsh-ppt-flashmade')) throw new Error(`the composed profile does not carry the plugin layer:\n${dump.slice(0, 400)}`)
if (!dump.includes('id: dsh-ppt-fusion')) throw new Error(`the composed profile does not mount the plugin entry:\n${dump.slice(0, 400)}`)
console.log(`dsh-compat profile ok: dsh ${runtimeVersion} composes dsh-ppt-flashmade from ${tarballName}`)
