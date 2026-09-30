#!/usr/bin/env node
// Windows sandbox probe (V11 A4): run the plugin's subprocess chain under the 0.2.0 line's own
// ACL confinement, and again unconﬁned on a workspace whose DACLs already carry the sandbox's
// standing edits, then report pass/denied per probe.
//
// The sandbox backend (`@deepseek-ai/dsh-sandbox-windows-acl`) restricts writes with a
// WRITE_RESTRICTED token: a confined child may write into the workspace and a private temp
// directory, everything else is denied. Two ways to hit it matter for this plugin:
//   confined   - the child runs through `lib/runner.js`, i.e. as if the plugin's own spawns were
//                sandboxed;
//   standing   - the session created the grant earlier (the workspace ACE, the world
//                FILE_DELETE_CHILD deny and the Low label stand by design), and the plugin's own
//                children run unconfined on that workspace. This is what a user actually gets,
//                because the plugin spawns its children itself instead of through `ctx.sandbox`.
//
// Usage: node scripts/win-sandbox-probe.mjs [--workspace <dir>] [--runtime <dir>] [--json]
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** @returns the parsed arguments. */
function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--json') {
      args.json = true
      continue
    }
    if (token === '--debug') {
      args.debug = true
      continue
    }
    if (token === '--rows') {
      const value = argv[index + 1]
      if (value === undefined) throw new Error('--rows needs a comma-separated list')
      args.rows = value.split(',').map((row) => row.trim()).filter((row) => row !== '')
      index += 1
      continue
    }
    if (token === '--workspace' || token === '--runtime') {
      const value = argv[index + 1]
      if (value === undefined) throw new Error(`${token} needs a path`)
      args[token.slice(2)] = value
      index += 1
      continue
    }
    throw new Error(`unexpected argument ${token}`)
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
const runtime = resolve(args.runtime ?? join(tmpdir(), 'dsh020-runtime'))
const runner = join(runtime, 'node_modules', '@deepseek-ai', 'dsh-sandbox-windows-acl', 'lib', 'runner.js')
if (!existsSync(runner)) throw new Error(`no sandbox runner under ${runtime}; install @deepseek-ai/dsh@0.2.0-rc.2 first`)
const workspace = resolve(args.workspace ?? join(ROOT, 'tmp', 'sandbox-probe'))
const tempRoot = join(tmpdir(), 'dsh-ppt-sandbox-temp')
const cli = join(ROOT, 'dist', 'cli.js')
if (!existsSync(cli)) throw new Error(`build the CLI first: ${cli} is missing`)
const fixture = join(ROOT, 'fixtures', 'golden', 'hello-merged.pptx')
const shimDir = join(process.env.USERPROFILE ?? '', '.dsh', 'ppt-fusion', 'bin')
// A user's plugin home sits outside the workspace (~/.dsh/ppt-fusion): the probe keeps that
// shape so the confined rows show what actually happens to the venv, caches and logs.
const probeHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')

try {
  rmSync(workspace, { recursive: true, force: true })
} catch (error) {
  // The standing grant denies directory deletes inside the tree to everyone; a leftover
  // workspace from an earlier probe can therefore refuse to disappear. Report it as the
  // first finding instead of aborting: it is exactly the effect this probe measures.
  process.stderr.write(`workspace cleanup failed: ${String(error).slice(0, 200)}\n`)
}
rmSync(tempRoot, { recursive: true, force: true })
mkdirSync(join(workspace, 'probe'), { recursive: true })
mkdirSync(join(workspace, 'out'), { recursive: true })
mkdirSync(tempRoot, { recursive: true })
writeFileSync(join(workspace, 'probe', 'seed.txt'), 'seed\n', 'utf8')

/** One probe: a command plus the environment it needs. */
const PROBES = [
  {
    id: 'ffprobe',
    goal: 'the ffprobe shim reads a duration from a real audio file',
    // The shim answers one question (`format=duration`) and takes the file as its only argument;
    // an unknown flag like `-version` fails by design.
    command: 'ffprobe',
    args: [join(ROOT, 'fixtures', 'hello', 'narration', '003-p03-native-chart.mp3')],
  },
  {
    id: 'engine-venv',
    goal: 'both upstreams answer (ppt-master venv python included)',
    command: process.execPath,
    args: [cli, 'doctor', '--json', '--no-self-test'],
    timeoutMs: 300000,
    // `doctor` exits non-zero for any failing check, including ones this machine fails
    // outside the sandbox (the png renderer's cairo library); the probe's question is
    // narrower, so it judges the engine checks and names the others.
    judge: (result) => {
      const parsed = parseDoctor(stdoutJson(String(result.stdout ?? '')))
      if (parsed === null) return null
      const engine = ['node', 'python', 'venv', 'ppt-master', 'pptwise'].map((id) => parsed.checks.find((check) => check.id === id))
      const broken = engine.filter((check) => check === undefined || check.status !== 'ok').map((check) => `${check?.id ?? '?'}=${check?.status ?? 'missing'}`)
      const other = parsed.checks.filter((check) => !engine.includes(check)).filter((check) => check.status !== 'ok').map((check) => `${check.id}=${check.status}`)
      return { status: broken.length === 0 ? 'ok' : 'failed', detail: broken.length === 0 ? `engine ok${other.length === 0 ? '' : ` (this machine also reports: ${other.join(', ')})`}` : `engine checks: ${broken.join(', ')}` }
    },
  },
  {
    id: 'sharp',
    goal: 'the sharp native addon loads and resizes an image',
    command: process.execPath,
    args: ['-e', `const sharp=require(require.resolve('sharp',{paths:[process.argv[2]]}));sharp({create:{width:4,height:4,channels:4,background:{r:1,g:2,b:3,alpha:1}}}).png().toFile(process.argv[1]).then(()=>console.log('sharp ok'))`, join(workspace, 'probe', 'sharp.png'), ROOT],
    timeoutMs: 120000,
  },
  {
    id: 'libreoffice-render',
    goal: 'renderpages rasterises page images with the LibreOffice engine (cache bypassed)',
    command: process.execPath,
    args: [cli, 'renderpages', workspace, '--file', fixture, '--outside', '--output-dir', join(workspace, 'out', 'lo'), '--engine', 'libreoffice', '--force', '--json'],
    timeoutMs: 300000,
    judge: renderJudge('libreoffice'),
  },
  {
    id: 'powerpoint-render',
    goal: 'renderpages rasterises page images with the PowerPoint COM engine (cache bypassed)',
    command: process.execPath,
    args: [cli, 'renderpages', workspace, '--file', fixture, '--outside', '--output-dir', join(workspace, 'out', 'com'), '--engine', 'powerpoint', '--force', '--json'],
    timeoutMs: 300000,
    judge: renderJudge('powerpoint'),
  },
  {
    id: 'fs-write-workspace',
    goal: 'create, write and delete a file and a directory inside the workspace',
    command: process.execPath,
    args: ['-e', `const fs=require('node:fs');const p=require('node:path');const root=process.argv[1];fs.mkdirSync(p.join(root,'probe','dir','inner'),{recursive:true});fs.writeFileSync(p.join(root,'probe','dir','inner','a.txt'),'x');fs.rmSync(p.join(root,'probe','dir'),{recursive:true,force:true});fs.writeFileSync(p.join(root,'probe','file.txt'),'x');fs.rmSync(p.join(root,'probe','file.txt'));console.log('fs ok')`, join(workspace)],
    timeoutMs: 60000,
  },
  {
    id: 'fs-write-plugin-home',
    goal: 'write where a real plugin home lives (outside the workspace and the private temp)',
    command: process.execPath,
    args: ['-e', `const fs=require('node:fs');const p=process.argv[1];fs.mkdirSync(require('node:path').dirname(p),{recursive:true});fs.writeFileSync(p,'x');fs.rmSync(p);console.log('home ok')`, join(process.env.USERPROFILE ?? '', '.dsh', 'ppt-fusion', 'win-sandbox-probe.tmp')],
    timeoutMs: 60000,
  },
]

/**
 * @param row - the matrix row.
 * @param probe - the probe being run.
 * @returns the command and argv for it. The two unconfined rows spawn the probe directly;
 *   the confined rows wrap it in the runtime's own runner (`node runner.js … -- <probe>`),
 *   which is the argv shape the sandbox seam itself uses.
 */
function invocationFor(row, probe) {
  if (row === 'control' || row === 'standing-workspace-write') return { command: probe.command, argv: [...probe.args] }
  const mode = row === 'confined-read-only' ? 'read-only' : 'workspace-write'
  return { command: process.execPath, argv: [runner, '--workspace', workspace, '--temp', tempRoot, '--mode', mode, '--', probe.command, ...probe.args] }
}

/** @param text - stdout that should carry one JSON document. @returns the parsed value, or null. */
function stdoutJson(text) {
  const start = text.indexOf('{')
  if (start < 0) return null
  try {
    return JSON.parse(text.slice(start))
  } catch {
    return null
  }
}

/** @param parsed - a parsed `doctor --json` report. @returns its checks, or null. */
function parseDoctor(parsed) {
  if (parsed === null || !Array.isArray(parsed.checks)) return null
  return { checks: parsed.checks.map((check) => ({ id: String(check.id ?? '?'), status: String(check.status ?? '?'), detail: String(check.detail ?? '') })) }
}

/**
 * @param engine - the rasteriser id the probe asked for.
 * @returns a judge that reads `renderpages --json` instead of the exit code: an engine the run
 *   recorded as `skipped` is not evidence that it worked, and a page count of zero is not a render.
 */
function renderJudge(engine) {
  return (result) => {
    const parsed = stdoutJson(String(result.stdout ?? ''))
    const entry = parsed?.result?.engines?.find?.((candidate) => candidate.engine === engine) ?? parsed?.engines?.find?.((candidate) => candidate.engine === engine)
    if (entry === undefined) return { status: 'failed', detail: `no ${engine} entry in the report: ${String(result.stderr ?? '').slice(0, 200)}` }
    const pages = Array.isArray(entry.pages) ? entry.pages.length : 0
    if (entry.status === 'skipped' || pages === 0) return { status: 'limited', detail: `${engine} reported ${String(entry.status ?? '?')} (${pages} page(s))${entry.reason === undefined ? '' : `: ${String(entry.reason)}`}` }
    return { status: 'ok', detail: `${engine} ${String(entry.status ?? 'rendered')}, ${pages} page(s)` }
  }
}

/** @param result - a spawnSync result. @returns the probe verdict; a probe may supply its own judge. */
function classify(result, probe) {
  if (result.error !== undefined) return { status: 'error', detail: String(result.error).slice(0, 300) }
  if (typeof probe?.judge === 'function') {
    const judged = probe.judge(result)
    if (judged !== null) return judged
  }
  const stderr = String(result.stderr ?? '')
  const stdout = String(result.stdout ?? '')
  const denial = /denied|EACCES|EPERM|Access is denied|0x5\b/i.test(stderr)
  if (result.status === 0) return { status: 'ok', detail: stdout.trim().split('\n').at(-1)?.slice(0, 160) ?? '' }
  // Keep the head of stderr: a Node crash prints its cause there, not on the last line.
  const head = stderr.trim().split('\n').slice(0, 3).join(' | ')
  return { status: denial ? 'denied' : 'failed', detail: (head === '' ? `exit ${String(result.status)}` : head).slice(0, 400) }
}

const env = {
  ...process.env,
  DSH_HOME: probeHome,
  PATH: `${shimDir};${process.env.PATH ?? ''}`,
  DSH_TELEMETRY_DISABLED: '1',
}

// The standing row needs the grant to exist before the probes run: one trivial confined child
// materialises the workspace ACE, the world delete-deny and the Low label, which stay.
if (existsSync(runner)) {
  const materialise = spawnSync(process.execPath, [runner, '--workspace', workspace, '--temp', tempRoot, '--mode', 'workspace-write', '--', process.execPath, '-e', 'console.log("grant")'], { encoding: 'utf8', env, cwd: workspace, timeout: 120000 })
  if (materialise.status !== 0) throw new Error(`could not materialise the standing grant: ${String(materialise.stderr).slice(0, 300)}`)
}

const allRows = ['control', 'standing-workspace-write', 'confined-workspace-write', 'confined-read-only']
const rows = args.rows === undefined ? allRows : allRows.filter((row) => args.rows.includes(row))
const report = []
for (const mode of rows) {
  for (const probe of PROBES) {
    const started = Date.now()
    const { command, argv } = invocationFor(mode, probe)
    const result = spawnSync(command, argv, { encoding: 'utf8', env, cwd: join(workspace, 'probe'), timeout: probe.timeoutMs ?? 120000 })
    const verdict = classify(result, probe)
    if (verdict.status !== 'ok' && args.debug === true) {
      const stderrBytes = Buffer.from(String(result.stderr ?? ''), 'utf8')
      process.stderr.write(`  argv: ${JSON.stringify([command, ...argv]).slice(0, 300)}\n`)
      process.stderr.write(`  stderr hex: ${stderrBytes.subarray(0, 48).toString('hex')}\n`)
      process.stderr.write(`  stderr text: ${JSON.stringify(stderrBytes.subarray(0, 160).toString('utf8'))}\n`)
    }
    report.push({ mode, probe: probe.id, status: verdict.status, ms: Date.now() - started, detail: verdict.detail })
    process.stderr.write(`${mode.padEnd(26)} ${probe.id.padEnd(22)} ${verdict.status.padEnd(7)} ${String(Date.now() - started).padStart(6)} ms  ${verdict.detail.slice(0, 90)}\n`)
  }
}

if (args.json === true) {
  const file = join(ROOT, 'tmp', 'sandbox', `probe-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify({ runtime, workspace, generatedAt: new Date().toISOString(), probes: PROBES.map((probe) => ({ id: probe.id, goal: probe.goal })), rows: report }, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ file, summary: rows.map((mode) => ({ mode, ok: report.filter((entry) => entry.mode === mode && entry.status === 'ok').length, denied: report.filter((entry) => entry.mode === mode && entry.status === 'denied').length, limited: report.filter((entry) => entry.mode === mode && entry.status === 'limited').length, failed: report.filter((entry) => entry.mode === mode && entry.status === 'failed').length })) }, null, 2)}\n`)
} else {
  process.stdout.write(`${rows.map((mode) => `${mode}: ${report.filter((entry) => entry.mode === mode && entry.status === 'ok').length}/${PROBES.length} ok`).join('\n')}\n`)
}