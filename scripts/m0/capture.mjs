// Capture a subprocess's stdout/stderr/exit code into UTF-8 files.
//
// PowerShell's `>` redirection re-encodes child output through the console
// code page, which corrupted JSON snapshots during M0. This is the M0/M1
// snapshot primitive: one process per capture, byte-exact UTF-8 output.
//
// Usage: node capture.mjs --out <file> [--err <file>] [--exit <file>] -- <cmd> [args...]
import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const argv = process.argv.slice(2)
const options = {}
let index = argv.indexOf('--')
if (index < 0) {
  console.error('usage: node capture.mjs --out <file> [--err <file>] [--exit <file>] -- <cmd> [args...]')
  process.exit(2)
}
const head = argv.slice(0, index)
const command = argv.slice(index + 1)
for (let i = 0; i < head.length; i += 2) {
  const key = head[i].replace(/^--/, '')
  options[key] = head[i + 1]
}
if (command.length === 0 || options.out === undefined) {
  console.error('usage: node capture.mjs --out <file> [--err <file>] [--exit <file>] -- <cmd> [args...]')
  process.exit(2)
}

const result = spawnSync(command[0], command.slice(1), { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 })
const stdout = result.stdout ?? ''
const stderr = result.stderr ?? ''
const status = result.status ?? (result.error ? 1 : 0)

mkdirSync(dirname(options.out), { recursive: true })
writeFileSync(options.out, stdout, 'utf8')
if (options.err !== undefined) writeFileSync(options.err, stderr, 'utf8')
if (options.exit !== undefined) writeFileSync(options.exit, String(status), 'utf8')
if (result.error) process.stderr.write(`capture: ${result.error.message}\n`)
console.log(JSON.stringify({ status, stdoutBytes: stdout.length, stderrBytes: stderr.length, out: options.out }))
