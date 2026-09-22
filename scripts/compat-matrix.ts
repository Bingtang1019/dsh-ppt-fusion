// Compatibility matrix (plan M8.8 / S15-S16): every committed golden artifact and
// every locally staged theme-matrix / model-eval package through
//   1. compat lint at all three levels,
//   2. python-pptx reopen (recursive shape/text/table/picture/chart counts),
//   3. LibreOffice headless PDF conversion when `soffice` is available, with the
//      PDF page count compared against the pptx slide count.
//
// Writes docs/compat/matrix.md and tmp/compat/matrix.json; exits 1 when any
// structural or lint check fails. LibreOffice being absent is reported as
// `skipped`, not as a failure: CI installs it (ubuntu-latest) and runs the same
// script, which is where the rendering half is enforced.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { compatLint } from '../src/commands/compat.ts'
import { defaultDependencies, venvManagerFor } from '../src/commands/context.ts'
import { COMPAT_LEVELS } from '../src/compat/registry.ts'
import { tailOf } from '../src/engine/errors.ts'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const REPORT = join(ROOT, 'docs', 'compat', 'matrix.md')
const JSON_REPORT = join(ROOT, 'tmp', 'compat', 'matrix.json')
const PROBE = join(ROOT, 'scripts', 'probe-pptx-reopen.py')

/** One file the matrix covers. */
interface Artifact {
  readonly path: string
  readonly label: string
}

/** One artifact's row of evidence. */
interface Row {
  readonly label: string
  readonly file: string
  readonly slides: number
  readonly probeOk: boolean
  readonly probe: Record<string, number> | null
  readonly probeError: string | null
  readonly pdfPages: number | null
  readonly libreoffice: string
  readonly lint: Record<string, { ok: boolean; findings: number; errors: number }>
  readonly problems: readonly string[]
}

/** @returns every deck `out/*.pptx` under `dir`, skipping agent scratch trees. */
function findPptx(dir: string, found: string[] = []): string[] {
  if (!existsSync(dir)) return found
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return found
  }
  for (const name of names) {
    // A staged `DSH_HOME` carries symlinked node_modules trees that loop.
    if (name === 'node_modules' || name === '.git' || name === 'home' || name === '.sessions') continue
    const path = join(dir, name)
    let stat
    try {
      stat = statSync(path)
    } catch {
      continue
    }
    if (stat.isDirectory()) findPptx(path, found)
    else if (name.toLowerCase().endsWith('.pptx') && dir.split(sep).pop() === 'out') found.push(path)
  }
  return found
}

/** @returns the artifacts the matrix covers: the golden package first, then staged packages. */
function collectArtifacts(): Artifact[] {
  const artifacts: Artifact[] = []
  const golden = join(ROOT, 'fixtures', 'golden', 'hello-merged.pptx')
  if (existsSync(golden)) artifacts.push({ path: golden, label: 'golden/hello-merged' })
  for (const theme of ['brief', 'almanac', 'thesis', 'terminal', 'runway', 'heritage']) {
    const staged = join(ROOT, 'tmp', 'theme-matrix', theme, '.dsh-ppt', 'render', 'merged.pptx')
    if (existsSync(staged)) artifacts.push({ path: staged, label: `theme-matrix/${theme}` })
  }
  for (const path of findPptx(join(ROOT, 'tmp', 'eval'))) {
    const attempt = relative(ROOT, path).replace(/\\/g, '/').replace(/^tmp\/eval\//, '')
    artifacts.push({ path, label: `eval/${attempt.replace(/\/out\//, ' out ')}` })
  }
  return artifacts
}

/** @returns the engine venv python, or null when the venv is absent. */
function venvPython(): string | null {
  const manager = venvManagerFor(defaultDependencies())
  return existsSync(manager.paths.pythonExe) ? manager.paths.pythonExe : null
}

/** @returns `soffice` on PATH, or null. */
function soffice(): string | null {
  const probe = spawnSync('soffice', ['--version'], { encoding: 'utf8', timeout: 30_000, windowsHide: true })
  return probe.status === 0 ? 'soffice' : null
}

/**
 * Probe one package with python-pptx.
 *
 * @param python - engine venv interpreter.
 * @param file - package to read.
 * @returns the probe record, or an error string.
 */
function probePptx(python: string, file: string): { record: Record<string, unknown> | null; error: string | null } {
  const run = spawnSync(python, [PROBE, file], { encoding: 'utf8', timeout: 120_000, windowsHide: true })
  const line = (run.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).pop()
  if (run.status !== 0 || line === undefined) return { record: null, error: run.stderr.trim() || `probe exited ${String(run.status)}` }
  try {
    return { record: JSON.parse(line) as Record<string, unknown>, error: null }
  } catch (error) {
    return { record: null, error: `probe output is not JSON: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * @param python - engine venv interpreter.
 * @param pdf - converted PDF.
 * @returns the page count, or a reason string when the count cannot be read.
 */
function pdfPages(python: string, pdf: string): number | string {
  const size = existsSync(pdf) ? statSync(pdf).size : 0
  if (size === 0) return 'the converted PDF is empty'
  // `pymupdf` is the supported module name: the old `fitz` alias writes a
  // deprecation warning to stdout, which the page count used to swallow.
  const run = spawnSync(python, ['-c', 'import pymupdf,sys; print(pymupdf.open(sys.argv[1]).page_count)', pdf], { encoding: 'utf8', timeout: 120_000, windowsHide: true })
  const line = (run.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).pop()
  const value = line === undefined ? Number.NaN : Number.parseInt(line, 10)
  if (run.status === 0 && Number.isInteger(value)) return value
  return `${tailOf(run.stderr) || tailOf(run.stdout) || `exit ${String(run.status)}`} (${String(size)} bytes)`
}

/** @returns the report rows. */
async function runMatrix(): Promise<Row[]> {
  const deps = defaultDependencies()
  const python = venvPython()
  const office = soffice()
  const artifacts = collectArtifacts()
  if (artifacts.length === 0) {
    throw new Error('compat-matrix: no artifacts found; run the golden gate or the theme matrix first')
  }
  const rows: Row[] = []
  const scratch = join(ROOT, 'tmp', 'compat', 'pdf')
  rmSync(scratch, { recursive: true, force: true })
  mkdirSync(scratch, { recursive: true })
  for (const artifact of artifacts) {
    const problems: string[] = []
    const dir = dirname(artifact.path)
    const file = artifact.path.slice(dir.length + 1)
    const lint: Row['lint'] = {}
    for (const level of COMPAT_LEVELS) {
      const result = await compatLint({ dir, file, level, strict: false, deps })
      const errors = result.failures.length
      lint[level] = { ok: result.ok, findings: result.inspection.findings.length, errors }
      if (!result.ok) problems.push(`${level}: ${String(errors)} lint error(s)`)
    }
    let probe: Record<string, unknown> | null = null
    let probeError: string | null = null
    if (python === null) probeError = 'engine venv is missing; run pnpm engine:provision'
    else {
      const result = probePptx(python, artifact.path)
      probe = result.record
      probeError = result.error
    }
    const slides = typeof probe?.slides === 'number' ? probe.slides : 0
    if (probeError !== null) problems.push(`python-pptx: ${probeError}`)
    else if (probe?.ok !== true) problems.push('python-pptx: package did not reopen with slides')
    let libreoffice = office === null ? 'skipped (soffice not on PATH; CI installs it)' : 'converted'
    let pdfPageCount: number | null = null
    if (office !== null) {
      // An explicit profile keeps headless LibreOffice from depending on a
      // writable $HOME or on a profile left behind by an earlier run.
      const profile = join(scratch, 'lo-profile')
      mkdirSync(profile, { recursive: true })
      const run = spawnSync(
        office,
        [`-env:UserInstallation=${pathToFileURL(profile).href}`, '--headless', '--convert-to', 'pdf', '--outdir', scratch, artifact.path],
        { encoding: 'utf8', timeout: 300_000, windowsHide: true },
      )
      const pdf = join(scratch, `${file.replace(/\.pptx$/i, '')}.pdf`)
      if (run.status !== 0 || !existsSync(pdf)) {
        libreoffice = `FAILED: ${tailOf(run.stderr) || tailOf(run.stdout) || `exit ${String(run.status)}`}`
        problems.push('LibreOffice conversion failed')
      } else if (python !== null) {
        const count = pdfPages(python, pdf)
        if (typeof count === 'number') {
          pdfPageCount = count
          if (count !== slides) problems.push(`LibreOffice rendered ${String(count)} page(s) for ${String(slides)} slide(s)`)
        } else {
          problems.push(`LibreOffice PDF page count is unreadable: ${count}`)
        }
      }
    }
    rows.push({
      label: artifact.label,
      file: relative(ROOT, artifact.path).replace(/\\/g, '/'),
      slides,
      probeOk: probe?.ok === true,
      probe: probe === null ? null : { shapes: Number(probe.shapes ?? 0), textChars: Number(probe.textChars ?? 0), tables: Number(probe.tables ?? 0), pictures: Number(probe.pictures ?? 0), charts: Number(probe.charts ?? 0) },
      probeError,
      pdfPages: pdfPageCount,
      libreoffice,
      lint,
      problems,
    })
    process.stdout.write(`compat ${artifact.label}: slides=${String(slides)} ${problems.length === 0 ? 'ok' : `problems=${String(problems.length)}`}\n`)
  }
  return rows
}

/** @returns the markdown report. */
function render(rows: readonly Row[], office: string | null): string {
  const lines = [
    '# Compatibility matrix',
    '',
    `Generated by \`pnpm compat:matrix\`. LibreOffice: ${office === null ? 'not on PATH in this run (skipped; CI installs it)' : 'present; conversions compared by PDF page count'}.`,
    '',
    '| artifact | slides | python-pptx | shapes | text chars | tables | pictures | charts | LO pages | safe | standard | max | verdict |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ]
  for (const row of rows) {
    const probe = row.probe
    lines.push(
      `| \`${row.file}\` | ${String(row.slides)} | ${row.probeOk ? 'ok' : 'FAIL'} | ${String(probe?.shapes ?? 0)} | ${String(probe?.textChars ?? 0)} | ${String(probe?.tables ?? 0)} | ${String(probe?.pictures ?? 0)} | ${String(probe?.charts ?? 0)} | ${row.pdfPages === null ? '—' : String(row.pdfPages)} | ` +
        `${row.lint.safe?.ok === true ? 'ok' : 'FAIL'} | ${row.lint.standard?.ok === true ? 'ok' : 'FAIL'} | ${row.lint.max?.ok === true ? 'ok' : 'FAIL'} | ${row.problems.length === 0 ? 'ok' : row.problems.join('; ')} |`,
    )
  }
  lines.push(
    '',
    '`safe`/`standard`/`max` columns are `dsh-ppt compat lint` at that level; a FAIL means at least one error-level finding.',
    'The LibreOffice column is the number of pages the conversion produced, which must equal the slide count.',
    '',
  )
  return lines.join('\n')
}

const rows = await runMatrix()
const office = soffice()
mkdirSync(dirname(JSON_REPORT), { recursive: true })
writeFileSync(JSON_REPORT, `${JSON.stringify({ schemaVersion: 1, libreoffice: office !== null, rows }, null, 2)}\n`, 'utf8')
mkdirSync(dirname(REPORT), { recursive: true })
writeFileSync(REPORT, render(rows, office), 'utf8')
const failed = rows.filter((row) => row.problems.length > 0)
console.log(`compat:matrix: ${String(rows.length - failed.length)}/${String(rows.length)} artifact(s) ok; report at ${relative(ROOT, REPORT).replace(/\\/g, '/')}`)
if (failed.length > 0) {
  for (const row of failed) console.error(`  ${row.label}: ${row.problems.join('; ')}`)
  process.exit(1)
}
