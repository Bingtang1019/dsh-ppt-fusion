import { readFileSync } from 'node:fs'
import { Command, Option } from 'commander'
import { formatDoctorReport, runDoctor } from './commands/doctor.ts'
import { defaultDependencies, resolveDeckDir, type CommandDependencies } from './commands/context.ts'
import { initDeck } from './commands/init.ts'
import { confirmPlan, planDeck } from './commands/plan.ts'
import { validateDeck } from './commands/validate.ts'
import { themeEnsure, themeFork, themeList, themeNew, themeTry } from './commands/theme.ts'
import { tokensExport } from './commands/tokens.ts'
import { deepRender } from './commands/deep.ts'
import { renderDeck } from './commands/render.ts'
import { formatFailure } from './engine/errors.ts'
import { formatFindings } from './audit.ts'
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

/** Print a JSON document to stdout with a trailing newline. */
function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

/**
 * Build the `dsh-ppt` command line.
 *
 * @param deps - command dependencies; tests pass an in-memory filesystem and a
 *   scripted runner, production uses the defaults.
 * @returns the configured commander program.
 */
export function buildProgram(deps: CommandDependencies = defaultDependencies()): Command {
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
        dependencies: {
          runner: deps.runner,
          fs: deps.fs,
          env: deps.env,
          resolveModule: deps.resolveModule,
          selfTest: options.selfTest !== false,
        },
      })
      if (options.json === true) printJson(report)
      else process.stdout.write(`${formatDoctorReport(report)}\n`)
      process.exitCode = report.ok ? 0 : 1
    })

  program
    .command('init')
    .description('create a deck workspace that already validates')
    .argument('<dir>', 'deck directory to create')
    .option('--theme <preset>', 'factory preset to bind', 'brief')
    .action((dir: string, options: { theme: string }) => {
      const result = initDeck({ dir: resolveDeckDir(deps, dir), theme: options.theme, deps })
      for (const path of result.created) process.stdout.write(`created ${path}\n`)
    })

  program
    .command('plan')
    .description('write a manifest draft and list the fields a model still has to decide')
    .argument('<dir>', 'deck directory')
    .option('--from <file...>', 'source markdown files, workspace-relative')
    .option('--confirm', 'copy the confirmed draft into deck.fusion.json')
    .action((dir: string, options: { from?: string[]; confirm?: boolean }) => {
      const workspace = resolveDeckDir(deps, dir)
      if (options.confirm === true) {
        process.stdout.write(`wrote ${confirmPlan({ dir: workspace, deps })}\n`)
        return
      }
      const result = planDeck({ dir: workspace, deps, ...(options.from === undefined ? {} : { sources: options.from }) })
      process.stdout.write(`wrote ${result.draftPath} (${String(result.pageCount)} pages)\n`)
      process.stdout.write('needs confirmation:\n')
      for (const field of result.needsConfirmation) process.stdout.write(`  - ${field}\n`)
    })

  program
    .command('validate')
    .description('check the manifest, IR page list, deep page files and theme files')
    .argument('<dir>', 'deck directory')
    .option('--json', 'print the full report as JSON')
    .action((dir: string, options: { json?: boolean }) => {
      const report = validateDeck({ dir: resolveDeckDir(deps, dir), deps })
      if (options.json === true) printJson(report)
      else {
        if (report.findings.length === 0) process.stdout.write(`OK ${String(report.sources.length)} gates: ${report.sources.join(', ')}\n`)
        else process.stdout.write(`${formatFindings(report.findings)}\n`)
        process.stdout.write(report.ok ? 'validate: ok\n' : 'validate: failed\n')
      }
      process.exitCode = report.ok ? 0 : 1
    })

  const theme = program.command('theme').description('bind, create and compare deck themes')
  theme
    .command('ensure')
    .description('materialise the bound theme and derive tokens.json and master-design.json (idempotent)')
    .argument('<dir>', 'deck directory')
    .option('--json', 'print the result as JSON')
    .action((dir: string, options: { json?: boolean }) => {
      const result = themeEnsure({ dir: resolveDeckDir(deps, dir), deps })
      if (options.json === true) {
        printJson({ themePath: result.themePath, tokensPath: result.tokensPath, masterPath: result.masterPath, changed: result.changed })
      } else if (result.changed.length === 0) process.stdout.write('theme ensure: 0 changes\n')
      else for (const path of result.changed) process.stdout.write(`wrote ${path}\n`)
    })
  theme
    .command('list')
    .description('list the factory presets')
    .option('--json', 'print the catalog as JSON')
    .action((options: { json?: boolean }) => {
      const themes = themeList({ deps })
      if (options.json === true) printJson(themes)
      else for (const entry of themes) process.stdout.write(`${entry.id.padEnd(12)} ${(entry.occasions ?? []).join('/')}  ${entry.identity ?? ''}\n`)
    })
  theme
    .command('new')
    .description('copy a preset into a complete theme file')
    .requiredOption('--from <id>', 'source preset id')
    .requiredOption('-o, --output <file>', 'output theme file')
    .option('--id <id>', 'id to write into the copy')
    .option('--dir <dir>', 'workspace the CLI runs in', '.')
    .action((options: { from: string; output: string; id?: string; dir: string }) => {
      const written = themeNew({
        dir: resolveDeckDir(deps, options.dir),
        from: options.from,
        output: options.output,
        deps,
        ...(options.id === undefined ? {} : { id: options.id }),
      })
      process.stdout.write(`wrote ${written.outputFile}\n`)
    })
  theme
    .command('fork')
    .description('re-derive a theme from one new primary colour, keeping its page menu')
    .argument('<id>', 'theme id or file to fork')
    .requiredOption('--primary <hex>', 'new primary colour')
    .option('--id <id>', 'id for the fork')
    .option('-o, --output <path>', 'output directory or file')
    .option('--dir <dir>', 'workspace the CLI runs in', '.')
    .action((id: string, options: { primary: string; id?: string; output?: string; dir: string }) => {
      const result = themeFork({
        dir: resolveDeckDir(deps, options.dir),
        id,
        primary: options.primary,
        deps,
        ...(options.id === undefined ? {} : { newId: options.id }),
        ...(options.output === undefined ? {} : { output: options.output }),
      })
      process.stdout.write(result.stdout.trim() === '' ? 'theme fork: done\n' : `${result.stdout.trim()}\n`)
    })
  theme
    .command('try')
    .description('render the fitting-room sample under 2-4 candidate themes')
    .argument('<ids>', 'comma-separated theme ids')
    .option('-o, --output <dir>', 'output directory')
    .option('--dir <dir>', 'workspace the CLI runs in', '.')
    .action((ids: string, options: { output?: string; dir: string }) => {
      const result = themeTry({
        dir: resolveDeckDir(deps, options.dir),
        ids,
        deps,
        ...(options.output === undefined ? {} : { output: options.output }),
      })
      process.stdout.write(`${result.stdout.trim()}\n`)
    })

  program
    .command('tokens')
    .description('export the palette contract a deep page authors against')
    .command('export')
    .argument('<input>', 'factory preset id or theme file')
    .option('--master', 'emit the master projection (palette plus role names)')
    .option('-o, --output <file>', 'write to a file instead of stdout')
    .action((input: string, options: { master?: boolean; output?: string }) => {
      const result = tokensExport({
        input,
        deps,
        ...(options.master === true ? { master: true } : {}),
        ...(options.output === undefined ? {} : { output: options.output }),
      })
      if (result.outputFile === null) printJson(result.document)
      else process.stdout.write(`wrote ${result.outputFile}\n`)
    })

  program
    .command('render')
    .description('render the whole deck: standard pages, deep pages, merge, then publish')
    .argument('<dir>', 'deck directory')
    .option('-o, --out <file>', 'output pptx path, resolved against the deck')
    .action(async (dir: string, options: { out?: string }) => {
      const result = await renderDeck({
        dir,
        deps,
        ...(options.out === undefined ? {} : { output: options.out }),
      })
      process.stdout.write(`wrote ${result.outputFile} (${String(result.slides)} slides, ${String(result.bytes)} bytes)\n`)
      process.stdout.write(`sha256 ${result.sha256}\n`)
      if (result.postflight.deep !== undefined) {
        process.stdout.write(
          `deep postflight status=${result.postflight.deep.status} quality_gate=${result.postflight.deep.qualityGate} slides=${String(result.postflight.deep.slides)}\n`,
        )
      }
      process.stdout.write(
        `merge: ${String(result.merge.replaced.length)} page(s) replaced, ${String(Object.keys(result.merge.imported).length)} part(s) imported, ${String(result.merge.multiMaster ? 'multi-master' : 'single master')}\n`,
      )
    })

  const deep = program.command('deep').description('deep-page engine operations')
  deep
    .command('render')
    .description('render the deep pages through ppt-master; --page selects one page')
    .argument('<dir>', 'deck directory')
    .option('--page <n>', 'render only this 1-based page index', (value: string) => Number.parseInt(value, 10))
    .option('-o, --out <file>', 'output pptx path')
    .action((dir: string, options: { page?: number; out?: string }) => {
      const result = deepRender({
        dir,
        deps,
        ...(options.page === undefined ? {} : { page: options.page }),
        ...(options.out === undefined ? {} : { output: options.out }),
      })
      process.stdout.write(`wrote ${result.pptxPath}\n`)
      process.stdout.write(`report ${result.reportPath}\n`)
      process.stdout.write(
        `postflight status=${result.postflight.status} quality_gate=${result.postflight.qualityGate} slides=${String(result.postflight.slides)}\n`,
      )
    })

  return program
}

if (process.env.DSH_PPT_NO_RUN !== '1') {
  try {
    await buildProgram(defaultDependencies({ runner: spawnRunner, fs: nodeFileSystem })).parseAsync(process.argv)
  } catch (error) {
    process.stderr.write(`${formatFailure(error)}\n`)
    process.exitCode = 1
  }
}