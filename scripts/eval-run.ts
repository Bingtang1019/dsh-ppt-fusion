/**
 * `pnpm eval:run` — the M6 model evaluation driver.
 *
 * Runs the three scenarios in `fixtures/scenarios/` through the headless agent
 * (at most `maxAttempts` sessions each), judges every attempt with
 * `tests/eval/harness.ts`, writes `tmp/eval/report.json` and `tmp/eval/report.md`,
 * and exits non-zero unless every scenario passed.
 *
 * Environment: `DSH_HARNESS_ROOT` points at a DeepSeek Harness checkout; without
 * it an installed `dsh` command is used. `DEEPSEEK_API_KEY` (or the user's
 * `~/.dsh/.credentials.yaml`) is required.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { listScenarios, loadScenario, repositoryRoot, runScenario, writeEvalReport, type ScenarioRun } from '../tests/eval/harness.ts'

interface Options {
  readonly scenario?: string
  readonly attempts?: number
  readonly json: boolean
}

/** @returns parsed command-line options. @throws Error for an unknown flag. */
function parseArgs(argv: readonly string[]): Options {
  const options: { scenario?: string; attempts?: number; json: boolean } = { json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--scenario') options.scenario = argv[++index]
    else if (flag === '--attempts') {
      const value = Number(argv[++index])
      if (!Number.isInteger(value) || value < 1) throw new Error('--attempts needs a positive integer')
      options.attempts = value
    } else if (flag === '--json') options.json = true
    else throw new Error(`unknown argument ${String(flag)}`)
  }
  return options
}

/** @returns the process exit code. */
async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2))
  const root = repositoryRoot(import.meta.url)
  if (!existsSync(join(root, 'dist', 'cli.js'))) {
    process.stderr.write(`eval: dist/cli.js is missing; run \`pnpm build\` first\n`)
    return 2
  }
  const names = options.scenario === undefined ? listScenarios(root) : [options.scenario]
  if (names.length === 0) {
    process.stderr.write('eval: no scenarios under fixtures/scenarios/\n')
    return 2
  }
  const runs: ScenarioRun[] = []
  for (const name of names) {
    const scenario = loadScenario(root, name)
    const limit = Math.min(scenario.maxAttempts, options.attempts ?? scenario.maxAttempts)
    if (!options.json) process.stdout.write(`eval ${name}: up to ${String(limit)} attempt(s)\n`)
    const run = await runScenario(root, scenario, options.attempts === undefined ? {} : { maxAttempts: options.attempts })
    runs.push(run)
    if (!options.json) {
      const last = run.attempts[run.attempts.length - 1]
      process.stdout.write(`eval ${name}: ${run.passed ? 'PASS' : 'FAIL'} after ${String(run.attempts.length)} attempt(s), ${String(Math.round((last?.wallTimeMs ?? 0) / 1000))}s\n`)
      for (const check of last?.checks ?? []) {
        if (!check.passed) process.stdout.write(`  FAIL ${check.id}: ${check.message}\n`)
      }
    }
  }
  const report = writeEvalReport(root, runs)
  const passed = runs.filter((run) => run.passed).length
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ scenarios: runs.length, passed, failures: runs.length - passed, report: report.json }, null, 2)}\n`)
  } else {
    process.stdout.write(`eval: ${String(passed)}/${String(runs.length)} scenario(s) passed; report at ${report.json}\n`)
  }
  return passed === runs.length ? 0 : 1
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    process.stderr.write(`eval: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  },
)
