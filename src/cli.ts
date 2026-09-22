import { readFileSync } from 'node:fs'
import { Command, Option } from 'commander'
import { formatDoctorReport, runDoctor } from './commands/doctor.ts'
import { formatFailure } from './engine/errors.ts'
import { spawnRunner } from './engine/runner.ts'
import { nodeFileSystem } from './engine/venv.ts'

/**
 * Read the package version from the manifest next to this file.
 *
 * The same relative location works for the source entry (`src/cli.ts`) and for
 * the bundle (`dist/cli.js`), so no build-time constant can drift.
 *
 * @returns the declared version, or `0.0.0` when the manifest is unreadable.
 */
function readVersion(): string {
  try {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }
    return manifest.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * Build the `dsh-ppt` command line.
 *
 * M1 exposes `version` and `doctor`; the deck commands (`validate`, `render`,
 * `audit`, `theme`, …) land in M2–M5 as `src/commands/*.ts` and are attached
 * here.
 *
 * @returns the configured commander program.
 */
export function buildProgram(): Command {
  const program = new Command()
  program
    .name('dsh-ppt')
    .description('Fusion deck toolchain: pptwise front end plus the ppt-master deep engine')
    .version(readVersion(), '-V, --version', 'print the dsh-ppt version')

  program
    .command('version')
    .description('print the dsh-ppt version')
    .action(() => {
      process.stdout.write(`${readVersion()}\n`)
    })

  program
    .command('doctor')
    .description('check the runtime, both upstreams, PowerPoint COM, and render one self-test page')
    .option('--json', 'print the full report as JSON')
    .option('--repair', 'rebuild the engine venv before reporting')
    .addOption(new Option('--no-self-test', 'skip the one-page self-test render'))
    .action((options: { json?: boolean; repair?: boolean; selfTest?: boolean }) => {
      const report = runDoctor({
        repair: options.repair === true,
        dependencies: { runner: spawnRunner, fs: nodeFileSystem, selfTest: options.selfTest !== false },
      })
      if (options.json === true) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      else process.stdout.write(`${formatDoctorReport(report)}\n`)
      process.exitCode = report.ok ? 0 : 1
    })

  return program
}

try {
  await buildProgram().parseAsync(process.argv)
} catch (error) {
  process.stderr.write(`${formatFailure(error)}\n`)
  process.exitCode = 1
}
