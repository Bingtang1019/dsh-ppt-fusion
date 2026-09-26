// `prepack` gate: the published package must carry the plugin shell, the skill,
// the vendored reference docs and the built CLI, and the package.json must
// declare them so a tarball cannot silently drop one.
//
// Runs after `pnpm build` (see the prepack script). `npm pack --ignore-scripts
// --dry-run` lists the real tarball contents; npm 10 still runs `prepare` there,
// so the payload is extracted by `packList` instead of parsed raw.
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packList } from './pack-list.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/** Every path the runtime needs, relative to the package root. */
const required = [
  'dist/cli.js',
  'dsh/index.js',
  'dsh/preview-tool.js',
  'dsh/review-tool.js',
  'dsh/propose-tool.js',
  'dsh/client.js',
  'dsh/spawnHidden.js',
  'cordis.patch.yml',
  'skills/dsh-ppt-fusion/SKILL.md',
  'skills/dsh-ppt-fusion/SKILL.en.md',
  'skills/dsh-ppt-fusion/prompt_audit_manifest.json',
  'skills/dsh-ppt-fusion/references/design-language.md',
  'python-assets/requirements.in',
  'python-assets/requirements.lock',
  'python-assets/probe-png-renderer.py',
  'python-assets/vendor/manifest.json',
  'python-assets/vendor/NOTICE',
  'python-assets/vendor/ppt-master/docs/svg-pipeline.md',
  'docs/contracts.md',
  'docs/decisions.md',
  'NOTICE',
  'CHANGELOG.md',
]

/** Directory entries the `files` list must cover. */
const requiredFilesEntries = ['dist', 'dsh', 'cordis.patch.yml', 'skills', 'python-assets', 'docs']

const problems = []
for (const path of required) {
  const absolute = join(root, path)
  if (!existsSync(absolute)) problems.push(`missing on disk: ${path}`)
  else if (statSync(absolute).isDirectory()) problems.push(`is a directory, expected a file: ${path}`)
}
const files = Array.isArray(manifest.files) ? manifest.files.map(String) : []
for (const entry of requiredFilesEntries) {
  if (!files.includes(entry)) problems.push(`package.json files is missing ${JSON.stringify(entry)}`)
}
if (manifest.main !== './dsh/index.js') problems.push(`package.json main must be ./dsh/index.js, got ${String(manifest.main)}`)
if (manifest.exports?.['.'] !== './dsh/index.js') problems.push('package.json exports["."] must be ./dsh/index.js')
if (manifest.exports?.['./client'] !== './dsh/client.js') problems.push('package.json exports["./client"] must be ./dsh/client.js')
if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') problems.push('package.json dsh.bundle.patch must be ./cordis.patch.yml')
if (manifest.dsh?.client?.immediately !== true) problems.push('package.json dsh.client.immediately must be true (the client module table is lazy)')

if (problems.length === 0) {
  // The tarball view: every required path must actually be packed, and the map
  // is the only one npm honours, so a stray .npmignore cannot re-hide a file
  // the list above already checked on disk.
  let packed
  try {
    packed = packList(execSync('npm pack --ignore-scripts --dry-run --json', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
  } catch (error) {
    problems.push(`npm pack --dry-run failed: ${error instanceof Error ? error.message : String(error)}`)
    packed = undefined
  }
  const names = new Set((packed?.[0]?.files ?? []).map((entry) => entry.path))
  for (const path of required) {
    if (!names.has(path)) problems.push(`not in the tarball: ${path}`)
  }
  // Deck discipline (V7.2): no deck, media file or local design profile may ship,
  // whatever the files whitelist happens to say next.
  const forbidden = [
    { rule: /(^|\/)fixtures\//i, reason: 'deck fixtures never ship' },
    { rule: /\.(pptx|ppt|potx|ppsx|thmx|pdf|mp3|mp4|mov|webm|m4a|wav)$/i, reason: 'deck/media artifacts never ship' },
    { rule: /(^|\/)(design|ref)-profile\.json$/i, reason: 'local design profiles never ship' },
  ]
  for (const path of names) {
    for (const { rule, reason } of forbidden) {
      if (rule.test(path)) problems.push(`forbidden in the tarball (${reason}): ${path}`)
    }
  }
}

if (problems.length > 0) {
  process.stderr.write(`pack check failed:\n${problems.map((problem) => `  - ${problem}`).join('\n')}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`pack check ok: ${String(required.length)} required files are on disk and in the tarball\n`)
}
