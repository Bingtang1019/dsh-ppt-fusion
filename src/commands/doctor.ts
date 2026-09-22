import { join } from 'node:path'
import { createFrontend, resolvePptwiseCli } from '../frontend.ts'
import { DshPptFailure, tailOf } from '../engine/errors.ts'
import { buildEnv, type Runner } from '../engine/runner.ts'
import { DEFAULT_PYPI_INDEX, createVenvManager, resolveDshHome, resolveUv, type FileSystemPort, type UvResolution } from '../engine/venv.ts'
import { packageAsset } from '../package-paths.ts'

/** Pinned upstream versions this build is developed and recorded against. */
export const PINNED = {
  pptwise: '0.35.0',
  pptMaster: '0.1.128',
  python: '3.13',
  node: '22.19',
} as const

/** What `python-assets/probe-png-renderer.py` reports. */
export interface RendererProbe {
  /** Renderer name the engine detected at import time, or null when none imports. */
  readonly renderer: string | null
  /** Human-readable status from the engine's own detector. */
  readonly status: string
  /** Install hint the engine offers, or null when it is happy. */
  readonly hint: string | null
  /** Whether the probe actually wrote a PNG. */
  readonly converted: boolean
  readonly pngBytes: number
  /** Failure text when the renderer imported but could not render. */
  readonly error?: string | null
  /** Versions of the distributions the probe looked for; null means absent. */
  readonly installed?: Record<string, string | null>
  /** Why an installed renderer still failed to import (the cairo-runtime case). */
  readonly importError?: string | null
}

/** Outcome of one doctor check. `skipped` means the platform does not have it. */
export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skipped'

/** One doctor check. */
export interface DoctorCheck {
  readonly id: string
  readonly title: string
  readonly status: CheckStatus
  readonly detail: string
  /** Actionable next step, present whenever the status is `warn` or `fail`. */
  readonly fix?: string
}

/** The full doctor report, also printed by `--json`. */
export interface DoctorReport {
  readonly ok: boolean
  readonly checks: readonly DoctorCheck[]
  readonly selfTest: { readonly ok: boolean; readonly detail: string; readonly elapsedMs: number }
  /** Repairs performed by `--repair`, in order. */
  readonly repaired: readonly string[]
}

/** Everything `runDoctor` reads from the outside world, injected for tests. */
export interface DoctorDependencies {
  readonly runner: Runner
  readonly fs: FileSystemPort
  readonly env?: NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
  /** Node version string; defaults to the running process. */
  readonly nodeVersion?: string
  /** Module resolver used to find pptwise. */
  readonly resolveModule?: (specifier: string) => string
  /** Whether the self-test render runs. */
  readonly selfTest?: boolean
}

const SELF_TEST_DECK = {
  version: '5',
  filename: 'dsh-ppt-doctor',
  theme: { id: 'brief' },
  meta: { organization: 'dsh-ppt-fusion', authors: [{ name: 'dsh-ppt doctor' }] },
  assets: { images: {} },
  slides: [
    {
      type: 'cover',
      id: 'p01',
      heading: 'dsh-ppt doctor self-test',
      subheading: 'one-page render through the pptwise front end',
      components: [],
    },
  ],
}

/** @returns the numeric major.minor of a version string, for floor comparisons. */
function versionAtLeast(actual: string, floor: string): boolean {
  const parse = (value: string): number[] => value.replace(/^v/, '').split('.').map((part) => Number.parseInt(part, 10) || 0)
  const [aMajor = 0, aMinor = 0] = parse(actual)
  const [fMajor = 0, fMinor = 0] = parse(floor)
  if (aMajor !== fMajor) return aMajor > fMajor
  return aMinor >= fMinor
}

/**
 * Run the seven environment checks plus a one-page render self-test.
 *
 * @param options.dshHome - `$DSH_HOME`; defaults to the configured or `~/.dsh` location.
 * @param options.engineVersion - pinned engine version.
 * @param options.requirementsFile - locked requirements file.
 * @param options.repair - rebuild the engine venv before reporting.
 * @param options.workspace - scratch workspace for the self-test.
 * @param options.dependencies - injected runner, filesystem, environment and clock.
 * @returns the report; `ok` is true only when no check failed and the self-test passed.
 */
export function runDoctor(options: {
  dshHome?: string
  engineVersion?: string
  requirementsFile?: string
  repair?: boolean
  workspace?: string
  dependencies: DoctorDependencies
}): DoctorReport {
  const env = options.dependencies.env ?? process.env
  const platform = options.dependencies.platform ?? process.platform
  const fs = options.dependencies.fs
  const runner = options.dependencies.runner
  const dshHome = options.dshHome ?? resolveDshHome(env)
  const engineVersion = options.engineVersion ?? PINNED.pptMaster
  const requirementsFile = options.requirementsFile ?? packageAsset('python-assets/requirements.lock')
  const workspace = options.workspace ?? join(dshHome, 'ppt-fusion', 'doctor')
  const checks: DoctorCheck[] = []
  const repaired: string[] = []

  // 1. Node
  const nodeVersion = options.dependencies.nodeVersion ?? process.versions.node
  checks.push(
    versionAtLeast(nodeVersion, PINNED.node)
      ? { id: 'node', title: 'Node runtime', status: 'ok', detail: `v${nodeVersion}` }
      : {
          id: 'node',
          title: 'Node runtime',
          status: 'fail',
          detail: `v${nodeVersion} is below the >=${PINNED.node} floor`,
          fix: 'install Node 22.19 or newer',
        },
  )

  // 2. uv
  let uv: UvResolution | undefined
  try {
    uv = resolveUv({ runner, fs, env, platform })
    checks.push({ id: 'uv', title: 'uv', status: 'ok', detail: `${uv.command} (found via ${uv.source})` })
  } catch (error) {
    checks.push({
      id: 'uv',
      title: 'uv',
      status: 'fail',
      detail: error instanceof DshPptFailure ? error.message : String(error),
      fix: 'python -m pip install --user uv, or set DSH_PPT_UV to an absolute path',
    })
  }

  // 3. Python available to build the venv with
  const pythonCommand = platform === 'win32' ? 'python' : 'python3'
  const pythonProbe = runner(pythonCommand, ['--version'], {
    cwd: dshHome,
    timeoutMs: 30_000,
    env: buildEnv({ source: env }),
  })
  const pythonVersion = `${pythonProbe.stdout} ${pythonProbe.stderr}`.match(/(\d+\.\d+\.\d+)/)?.[1]
  if (pythonProbe.status === 0 && pythonVersion !== undefined && versionAtLeast(pythonVersion, '3.12')) {
    checks.push({ id: 'python', title: 'Python interpreter', status: 'ok', detail: `${pythonCommand} ${pythonVersion}` })
  } else {
    checks.push({
      id: 'python',
      title: 'Python interpreter',
      status: 'fail',
      detail: `\`${pythonCommand} --version\` did not report 3.12+: ${tailOf(pythonProbe.stderr) || tailOf(pythonProbe.stdout) || 'no output'}`,
      fix: 'install CPython 3.12+ and make sure it is on PATH',
    })
  }

  // 4. Engine venv (and 6. the dispatcher inside it)
  const manager = createVenvManager({
    config: {
      dshHome,
      engineVersion,
      pythonVersion: PINNED.python,
      requirementsFile,
      indexUrl: env.DSH_PPT_PYPI_INDEX ?? DEFAULT_PYPI_INDEX,
    },
    runner,
    fs,
    env,
    platform,
  })
  if (options.repair === true) {
    try {
      manager.ensure({ force: true })
      repaired.push(`rebuilt engine venv at ${manager.paths.root}`)
    } catch (error) {
      repaired.push(`venv rebuild failed: ${error instanceof DshPptFailure ? error.message : String(error)}`)
    }
  }
  const state = manager.state()
  checks.push(
    state.ok
      ? { id: 'venv', title: 'Engine venv', status: 'ok', detail: `${state.paths.root} (ppt_master ${state.installedVersion ?? 'unknown'})` }
      : {
          id: 'venv',
          title: 'Engine venv',
          status: 'fail',
          detail: state.problems.join('; '),
          fix: 'dsh-ppt doctor --repair',
        },
  )

  if (state.ok) {
    const probe = runner(state.paths.engineExe, ['--help'], {
      cwd: dshHome,
      timeoutMs: 120_000,
      env: buildEnv({ source: env, extra: { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } }),
    })
    // The dispatcher prints one command per line as `  <name><padding><description>`.
    const commands = probe.stdout.split(/\r?\n/).filter((line) => /^ {2}[a-z][a-z0-9-]+ {2,}\S/.test(line)).length
    checks.push(
      probe.status === 0 && commands > 0
        ? { id: 'ppt-master', title: 'ppt-master dispatcher', status: 'ok', detail: `ppt-master ${engineVersion}, ${String(commands)} subcommands` }
        : {
            id: 'ppt-master',
            title: 'ppt-master dispatcher',
            status: 'fail',
            detail: tailOf(probe.stderr) || `exit ${String(probe.status)}`,
            fix: 'dsh-ppt doctor --repair',
          },
    )
  } else {
    checks.push({
      id: 'ppt-master',
      title: 'ppt-master dispatcher',
      status: 'fail',
      detail: 'skipped because the engine venv is unusable',
      fix: 'dsh-ppt doctor --repair',
    })
  }

  // 8. PNG rasteriser, which the exporter''s Office compatibility mode needs.
  // Upstream degrades to pure SVG mode in silence when no renderer imports, and
  // Office LTSC 2021 and WPS may then show nothing for SVG-backed images, so the
  // check runs the engine''s own probe: a renderer that imports but cannot write
  // a PNG counts as a failure too (M0.G measured exactly that case).
  if (!state.ok) {
    checks.push({
      id: 'png-renderer',
      title: 'PNG rasteriser (compat mode)',
      status: 'fail',
      detail: 'skipped because the engine venv is unusable',
      fix: 'dsh-ppt doctor --repair',
    })
  } else {
    const scriptsDir = join(state.paths.sitePackages, 'skills', 'ppt-master', 'scripts')
    const probe = runner(state.paths.pythonExe, [packageAsset('python-assets/probe-png-renderer.py'), scriptsDir], {
      cwd: dshHome,
      timeoutMs: 180_000,
      env: buildEnv({ source: env, extra: { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } }),
    })
    let parsed: RendererProbe | null = null
    try {
      parsed = JSON.parse(probe.stdout.trim()) as RendererProbe
    } catch {
      parsed = null
    }
    if (parsed === null) {
      checks.push({
        id: 'png-renderer',
        title: 'PNG rasteriser (compat mode)',
        status: 'fail',
        detail: tailOf(probe.stderr) || `the probe produced no JSON (exit ${String(probe.status)})`,
        fix: 'install a cairo runtime for the engine venv, or rely on the Node-side rasteriser (plan B7)',
      })
    } else if (parsed.renderer === null) {
      // Distinguish "not installed" from "installed but the native library is
      // missing": the second case is what this machine hits, and the upstream
      // detector reports both as simply absent.
      const cairosvg = parsed.installed?.cairosvg ?? null
      const detail =
        cairosvg === null
          ? `no SVG-to-PNG renderer imports in the engine venv ${parsed.status}`
          : `cairosvg ${cairosvg} is installed but cannot import: ${parsed.importError ?? 'unknown error'}`
      checks.push({
        id: 'png-renderer',
        title: 'PNG rasteriser (compat mode)',
        status: 'fail',
        detail,
        fix: 'provide a cairo runtime so cairosvg imports, or rely on the Node-side rasteriser (plan B7)',
      })
    } else if (!parsed.converted) {
      checks.push({
        id: 'png-renderer',
        title: 'PNG rasteriser (compat mode)',
        status: 'fail',
        detail: `renderer ${parsed.renderer} imports but produced no PNG ${parsed.error === null || parsed.error === undefined ? '' : `(${parsed.error})`}`,
        fix: 'install a cairo runtime, or rely on the Node-side rasteriser (plan B7)',
      })
    } else {
      checks.push({
        id: 'png-renderer',
        title: 'PNG rasteriser (compat mode)',
        status: 'ok',
        detail: `${parsed.renderer} ${parsed.status} produced a ${String(parsed.pngBytes)}-byte PNG`,
      })
    }
  }

  // 5. pptwise
  try {
    const cli = resolvePptwiseCli({ resolve: options.dependencies.resolveModule })
    checks.push(
      cli.version === PINNED.pptwise
        ? { id: 'pptwise', title: 'pptwise front end', status: 'ok', detail: `${cli.version} at ${cli.packageDir}` }
        : {
            id: 'pptwise',
            title: 'pptwise front end',
            status: 'fail',
            detail: `installed ${cli.version}, pinned ${PINNED.pptwise}`,
            fix: `pnpm add @liustack/pptwise@${PINNED.pptwise}`,
          },
    )
  } catch (error) {
    checks.push({
      id: 'pptwise',
      title: 'pptwise front end',
      status: 'fail',
      detail: error instanceof DshPptFailure ? error.message : String(error),
      fix: `pnpm add @liustack/pptwise@${PINNED.pptwise}`,
    })
  }

  // 7. PowerPoint COM (Windows only)
  if (platform !== 'win32') {
    checks.push({ id: 'powerpoint-com', title: 'PowerPoint COM', status: 'skipped', detail: 'not a Windows host' })
  } else {
    const comProbe = runner(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'try { $app = New-Object -ComObject PowerPoint.Application; $version = $app.Version; $app.Quit(); Write-Output ("ok " + $version) } catch { Write-Output ("fail " + $_.Exception.Message); exit 1 }',
      ],
      { cwd: dshHome, timeoutMs: 120_000, env: buildEnv({ source: env }) },
    )
    const output = (comProbe.stdout || comProbe.stderr).trim()
    checks.push(
      comProbe.status === 0 && output.startsWith('ok')
        ? { id: 'powerpoint-com', title: 'PowerPoint COM', status: 'ok', detail: `PowerPoint ${output.slice(3).trim()}` }
        : {
            id: 'powerpoint-com',
            title: 'PowerPoint COM',
            status: 'fail',
            detail: tailOf(output) || `exit ${String(comProbe.status)}`,
            fix: 'install Microsoft Office with PowerPoint, or skip the COM gate on this machine',
          },
    )
  }

  const selfTest = runSelfTest({ options, manager, runner, env, workspace, fs })

  const ok = checks.every((check) => check.status !== 'fail') && selfTest.ok
  return { ok, checks, selfTest, repaired }
}

/** Render one page through the front end and confirm the pptx appears. */
function runSelfTest(input: {
  options: { dependencies: DoctorDependencies; engineVersion?: string }
  manager: ReturnType<typeof createVenvManager>
  runner: Runner
  env: NodeJS.ProcessEnv
  workspace: string
  fs: FileSystemPort
}): DoctorReport['selfTest'] {
  if (input.options.dependencies.selfTest === false) {
    return { ok: true, detail: 'skipped by request', elapsedMs: 0 }
  }
  const started = Date.now()
  if (!input.manager.state().ok) {
    return { ok: false, detail: 'skipped: engine venv is unusable', elapsedMs: 0 }
  }
  try {
    input.fs.mkdirp(input.workspace)
    const deckPath = join(input.workspace, 'deck.ir.json')
    input.fs.writeText(deckPath, JSON.stringify(SELF_TEST_DECK, null, 2))
    const frontend = createFrontend({
      cli: resolvePptwiseCli({ resolve: input.options.dependencies.resolveModule }),
      workspace: input.workspace,
      runner: input.runner,
      env: input.env,
    })
    const outputFile = join(input.workspace, 'self-test.pptx')
    frontend.render(deckPath, { output: outputFile })
    if (!input.fs.exists(outputFile)) {
      return { ok: false, detail: `render reported success but ${outputFile} is absent`, elapsedMs: Date.now() - started }
    }
    return { ok: true, detail: `rendered 1 page to ${outputFile}`, elapsedMs: Date.now() - started }
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof DshPptFailure ? `${error.code} ${error.message}` : String(error),
      elapsedMs: Date.now() - started,
    }
  }
}

/**
 * Render the report for humans: one line per check plus the self-test summary.
 *
 * @param report - doctor output.
 * @returns printable text, one check per line.
 */
export function formatDoctorReport(report: DoctorReport): string {
  const symbol: Record<CheckStatus, string> = { ok: 'OK  ', warn: 'WARN', fail: 'FAIL', skipped: 'SKIP' }
  const lines = report.checks.map((check) => `[${symbol[check.status]}] ${check.title}: ${check.detail}${check.fix === undefined ? '' : `\n        fix: ${check.fix}`}`)
  lines.push(`[${report.selfTest.ok ? 'OK  ' : 'FAIL'}] Self-test render: ${report.selfTest.detail}`)
  for (const entry of report.repaired) lines.push(`[REPAIRED] ${entry}`)
  lines.push(report.ok ? 'doctor: all checks passed' : 'doctor: failures present')
  return lines.join('\n')
}
