// M0.8 probe: which child-process stdio modes survive the DSH sandbox?
//
// The plan's §2.6 claims piped stdout capture fails with EPERM under the DSH
// sandbox on Windows. This script measures that instead of assuming it, for
// both a plain Windows binary and the ppt-master venv interpreter.
//
// Usage: node tests/m0/spawn-probe.mjs <path-to-python.exe> [<path-to-ppt-master.exe>]
import { spawn, spawnSync, execSync } from 'node:child_process'
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const python = process.argv[2]
const pptMaster = process.argv[3]
if (!python) {
  console.error('usage: node spawn-probe.mjs <python.exe> [ppt-master.exe]')
  process.exit(2)
}

const results = []
const record = (name, run) => {
  try {
    results.push({ name, ...run() })
  } catch (error) {
    results.push({ name, error: `${error.code ?? ''} ${error.message}`.trim() })
  }
}
const summarize = (r) => ({
  ok: r.error === undefined,
  status: r.status,
  stdout: (r.stdout ?? '').slice(0, 60),
  stderr: (r.stderr ?? '').slice(0, 120),
  error: r.error,
})

const PROBE = 'import sys; sys.stdout.write("OUT"); sys.stdout.flush(); sys.stderr.write("ERR"); sys.stderr.flush()'

record('spawnSync python pipe', () => {
  const r = spawnSync(python, ['-c', PROBE], { encoding: 'utf8', timeout: 30000 })
  return summarize(r)
})

record('spawnSync cmd pipe', () => {
  const r = spawnSync('cmd', ['/c', 'echo PIPE_OK'], { encoding: 'utf8', timeout: 30000 })
  return summarize(r)
})

record('execSync cmd', () => {
  const out = execSync('cmd /c echo EXEC_OK', { encoding: 'utf8', timeout: 30000 })
  return { ok: true, stdout: out.trim() }
})

record('spawn inherit', () => {
  const r = spawnSync(python, ['-c', 'print("INHERIT_OK")'], { stdio: 'inherit', timeout: 30000 })
  return { ok: r.status === 0, status: r.status, error: r.error && String(r.error) }
})

record('spawnSync ignore', () => {
  const r = spawnSync(python, ['-c', 'print("IGNORED")'], { stdio: 'ignore', timeout: 30000 })
  return { ok: r.status === 0, status: r.status }
})

record('spawnSync shell:true redirect to file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spawn-probe-'))
  const out = join(dir, 'out.txt')
  const r = spawnSync('cmd', ['/c', `"${python}" -c "${PROBE}" > "${out}" 2>&1`], { stdio: 'ignore', timeout: 30000 })
  let content = ''
  try {
    content = readFileSync(out, 'utf8')
  } catch (error) {
    content = `<missing: ${error.code}>`
  }
  return { ok: r.status === 0, status: r.status, file: content.trim().slice(0, 60) }
})

// Async spawn with piped stdio is the exact shape the plan forbids.
const asyncProbe = await new Promise((resolve) => {
  let stdout = ''
  let stderr = ''
  let settled = false
  const finish = (extra) => {
    if (!settled) {
      settled = true
      resolve({ name: 'spawn async pipe (collect)', stdout: stdout.slice(0, 60), stderr: stderr.slice(0, 160), ...extra })
    }
  }
  try {
    const child = spawn(python, ['-c', PROBE], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 })
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => finish({ error: `${error.code ?? ''} ${error.message}`.trim() }))
    child.on('close', (code) => finish({ ok: code === 0, status: code }))
    setTimeout(() => finish({ error: 'TIMEOUT' }), 40000).unref()
  } catch (error) {
    finish({ error: `${error.code ?? ''} ${error.message}`.trim() })
  }
})

if (pptMaster) {
  record('ppt-master --version via pipe', () => {
    const r = spawnSync(pptMaster, ['--help'], { encoding: 'utf8', timeout: 120000 })
    return { ok: r.status === 0, status: r.status, stdoutBytes: (r.stdout ?? '').length, error: r.error && String(r.error) }
  })
  record('ppt-master --help to file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spawn-probe-'))
    writeFileSync(join(dir, 'note.txt'), '')
    const r = spawnSync(pptMaster, ['--help'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 })
    return { ok: r.status === 0, status: r.status, stdoutBytes: (r.stdout ?? '').length, stderrBytes: (r.stderr ?? '').length }
  })
}

console.log(JSON.stringify({ platform: process.platform, node: process.version, results, asyncProbe }, null, 2))
