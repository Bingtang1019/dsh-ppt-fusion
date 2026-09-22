import { readFileSync } from 'node:fs'
import { Command, Option } from 'commander'
import { formatDoctorReport, runDoctor } from './commands/doctor.ts'
import { defaultDependencies, resolveDeckDir, type CommandDependencies } from './commands/context.ts'
import { initDeck } from './commands/init.ts'
import { confirmPlan, planDeck } from './commands/plan.ts'
import { formatResumeReport, runResume } from './commands/resume.ts'
import { validateDeck } from './commands/validate.ts'
import { themeEnsure, themeFork, themeList, themeNew, themeTry } from './commands/theme.ts'
import { tokensExport } from './commands/tokens.ts'
import { deepRender } from './commands/deep.ts'
import { renderDeck } from './commands/render.ts'
import { compatLint, compatLintDocument, formatCompatLint } from './commands/compat.ts'
import { auditDeck } from './commands/audit.ts'
import { formatSkillAuditReport, runSkillAudit } from './commands/skill.ts'
import { brandExtract } from './commands/brand.ts'
import { deepNativeRoundtrip } from './commands/roundtrip.ts'
import { deepTemplateApply, deepTemplateCreate, templateRegister } from './commands/template.ts'
import { SOURCE_TYPES, sourceConvert } from './commands/source.ts'
import { formatImagesSearch, imagesSearch } from './commands/images.ts'
import { postAnimate } from './commands/post.ts'
import { narrate, narrationVoices } from './commands/narrate.ts'
import { COMPAT_LEVELS, asCompatLevel } from './compat/registry.ts'
import { DshPptFailure, formatFailure } from './engine/errors.ts'
import { formatFindings } from './audit.ts'
import { spawnRunner } from './engine/runner.ts'
import { nodeFileSystem } from './engine/venv.ts'
import { IMAGE_ORIENTATIONS, IMAGE_PROVIDERS, INHERITANCE_MODES, NARRATION_PROVIDERS, TEMPLATE_KINDS, TEMPLATE_REGISTRY_KINDS } from './engine/contracts.ts'

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
    .command('resume')
    .description('read .dsh-ppt/checkpoint.json and print the phase, artifacts and next commands')
    .argument('<dir>', 'deck directory')
    .option('--json', 'print the full report as JSON')
    .option('--write', 'also write the brief to .dsh-ppt/resume.md')
    .action((dir: string, options: { json?: boolean; write?: boolean }) => {
      const report = runResume({ dir, write: options.write === true, deps })
      if (options.json === true) printJson(report)
      else process.stdout.write(`${formatResumeReport(report)}\n`)
      process.exitCode = report.ok ? 0 : 1
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

  program
    .command('audit')
    .description('run the unified audit gate: validate, pptwise, engine gates, package, compat, pixels')
    .argument('<dir>', 'deck directory')
    .option('--json', 'print the full report as JSON')
    .option('--strict', 'fail on warnings as well as errors')
    .option('--pixels', 'also sample the deep SVGs and compare their colours with the palette')
    .option('--file <pptx>', 'audit this package instead of the last published render')
    .addOption(new Option('--compat <level>', 'compatibility level for the package lint').choices([...COMPAT_LEVELS]))
    .action(async (dir: string, options: { json?: boolean; strict?: boolean; pixels?: boolean; file?: string; compat?: string }) => {
      const compat = options.compat === undefined ? null : asCompatLevel(options.compat)
      if (options.compat !== undefined && compat === null) {
        throw new DshPptFailure('UsageError', '--compat must be one of ' + COMPAT_LEVELS.join(', '))
      }
      const report = await auditDeck({
        dir,
        strict: options.strict === true,
        pixels: options.pixels === true,
        deps,
        ...(options.file === undefined ? {} : { file: options.file }),
        ...(compat === null ? {} : { compat }),
      })
      if (options.json === true) {
        printJson(report)
      } else {
        const errors = report.findings.filter((finding) => finding.level === 'error').length
        process.stdout.write(
          `audit ${report.ok ? 'ok' : 'failed'} (${String(report.sources.length)} source(s), ${String(errors)} error(s), ${String(report.findings.length - errors)} warning(s))` +
            `${report.artifact === null ? '' : ` artifact=${report.artifact}`}${report.compatLevel === null ? '' : ` compat=${report.compatLevel}`}` +
            '\n',
        )
        if (report.findings.length > 0) process.stdout.write(`${formatFindings(report.findings)}\n`)
        for (const note of report.skipped) process.stdout.write(`skipped ${note}\n`)
      }
      process.exitCode = report.ok ? 0 : 1
    })

  const skill = program.command('skill').description('audit the shipped SKILL documents and their vendored references')
  skill
    .command('audit')
    .description('run the engine prompt-audit budget gate (tokens, references, duplicates)')
    .option('--json', 'print the full report as JSON')
    .option('--strict', 'fail on warnings as well as errors')
    .action((options: { json?: boolean; strict?: boolean }) => {
      const report = runSkillAudit({ strict: options.strict === true, deps })
      if (options.json === true) printJson(report)
      else process.stdout.write(`${formatSkillAuditReport(report)}\n`)
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
    .command('source')
    .description('convert pdf/docx/xlsx/pptx/web sources into Markdown')
    .argument('<input...>', 'files, directories or http(s) URLs, resolved against --dir')
    .option('-o, --output <dir>', 'output directory for the Markdown', 'sources')
    .option('--dir <dir>', 'workspace the paths resolve against', '.')
    .addOption(new Option('--type <type>', 'force a conversion type').choices([...SOURCE_TYPES]).default('auto'))
    .option('--no-images', 'keep remote images as links instead of downloading them')
    .action(async (inputs: string[], options: { output: string; dir: string; type: string; images: boolean }) => {
      const result = await sourceConvert({
        dir: options.dir,
        inputs,
        output: options.output,
        type: options.type as (typeof SOURCE_TYPES)[number],
        noImages: options.images === false,
        deps,
      })
      for (const entry of result.entries) {
        process.stdout.write(`${entry.type} ${entry.input} -> ${entry.output} (${String(entry.bytes)} bytes)\n`)
      }
      process.stdout.write(`wrote ${result.manifestPath}\n`)
    })

  program
    .command('narrate')
    .description('generate per-slide narration audio for the deck\'s deep pages')
    .argument('<dir>', 'deck workspace')
    .addOption(new Option('--provider <provider>', 'TTS provider; edge needs no key').choices([...NARRATION_PROVIDERS]).default('edge'))
    .option('--voice <voice>', 'provider voice name')
    .option('--rate <rate>', 'speaking rate, for example +10%')
    .option('--volume <volume>', 'speaking volume, for example +0%')
    .option('--project <dir>', 'project directory; defaults to the newest .dsh-ppt/deep/*')
    .option('-o, --output <dir>', 'audio output directory')
    .option('--sync', 'also derive narration_animations.json from the audio and SRTs')
    .option('--list-voices', 'print the curated edge-tts voice list and exit')
    .action((dir: string, options: { provider: string; voice?: string; rate?: string; volume?: string; project?: string; output?: string; sync?: boolean; listVoices?: boolean }) => {
      if (options.listVoices === true) {
        process.stdout.write(narrationVoices(deps, dir))
        return
      }
      const result = narrate({
        dir,
        provider: options.provider as (typeof NARRATION_PROVIDERS)[number],
        sync: options.sync === true,
        deps,
        ...(options.voice === undefined ? {} : { voice: options.voice }),
        ...(options.rate === undefined ? {} : { rate: options.rate }),
        ...(options.volume === undefined ? {} : { volume: options.volume }),
        ...(options.project === undefined ? {} : { project: options.project }),
        ...(options.output === undefined ? {} : { output: options.output }),
      })
      process.stdout.write(`narrated ${result.projectDir}: ${String(result.audio.length)} audio file(s), ${String(result.subtitles.length)} SRT file(s)${result.synced ? ', timeline synced' : ''}
`)
      for (const file of result.audio) process.stdout.write(`  ${file}
`)
    })

  const post = program.command('post').description('apply a deck\'s motion configuration')
  post
    .command('animate')
    .description('apply post/animations.json to a published package, then re-run the compat pass')
    .argument('<dir>', 'deck workspace')
    .option('--config <file>', 'config override, resolved against the deck')
    .option('--file <pptx>', 'package to animate; defaults to out/<name>.pptx')
    .option('-o, --out <file>', 'output package; defaults to replacing the input')
    .option('--json', 'print the applied report as JSON')
    .action(async (dir: string, options: { config?: string; file?: string; out?: string; json?: boolean }) => {
      const result = await postAnimate({
        dir,
        deps,
        ...(options.config === undefined ? {} : { config: options.config }),
        ...(options.file === undefined ? {} : { file: options.file }),
        ...(options.out === undefined ? {} : { output: options.out }),
      })
      if (options.json === true) {
        printJson({ file: result.file, outputFile: result.outputFile, sha256: result.sha256, bytes: result.bytes, slides: result.slides, post: result.report, compat: { level: result.compat.level, counts: result.compat.counts } })
      } else {
        process.stdout.write(`animated ${result.file} -> ${result.outputFile} (${String(result.slides)} slide(s))
`)
        for (const slide of result.report.slides) {
          const parts = [slide.transition === null ? null : `transition ${slide.transition}`, slide.emphasis === null ? null : `emphasis ${slide.emphasis}`, slide.path === null ? null : `path ${slide.path}`].filter((part): part is string => part !== null)
          if (parts.length === 0) continue
          process.stdout.write(`  slide ${String(slide.index)}: ${parts.join(', ')}
`)
        }
        process.stdout.write(`sha256 ${result.sha256}
`)
      }
    })

  const images = program.command('images').description('find openly licensed images for a deck')
  images
    .command('search')
    .description('search, download and record one openly licensed image')
    .argument('[query]', 'search terms (1-4 concrete keywords work best); omit with --from-url')
    .option('--dir <dir>', 'workspace the paths resolve against', '.')
    .addOption(new Option('--provider <provider>', 'image source').choices([...IMAGE_PROVIDERS]))
    .addOption(new Option('--orientation <orientation>', 'picture orientation').choices([...IMAGE_ORIENTATIONS]).default('any'))
    .option('--filename <name>', 'filename to save under')
    .option('--min-width <n>', 'minimum width in pixels', (value: string) => Number.parseInt(value, 10))
    .option('--min-height <n>', 'minimum height in pixels', (value: string) => Number.parseInt(value, 10))
    .option('--strict-no-attribution', 'refuse licence terms that require attribution')
    .option('-o, --output <dir>', 'download directory (default assets)')
    .option('--manifest <file>', 'attribution manifest path')
    .option('--save-candidates', 'save ranked previews and download no original')
    .option('--max-candidates <n>', 'preview page size', (value: string) => Number.parseInt(value, 10))
    .option('--from-url <url>', 'download one directly selected URL (recorded as manual)')
    .option('--purpose <text>', 'purpose recorded in the manifest')
    .option('--slide <n>', 'slide number recorded in the manifest', (value: string) => Number.parseInt(value, 10))
    .action(async (query: string | undefined, options: Record<string, string | number | boolean | undefined>) => {
      const result = await imagesSearch({
        dir: String(options.dir ?? '.'),
        query: query ?? '',
        deps,
        ...(options.provider === undefined ? {} : { provider: options.provider as (typeof IMAGE_PROVIDERS)[number] }),
        ...(options.orientation === undefined ? {} : { orientation: options.orientation as (typeof IMAGE_ORIENTATIONS)[number] }),
        ...(options.filename === undefined ? {} : { filename: String(options.filename) }),
        ...(options.minWidth === undefined ? {} : { minWidth: Number(options.minWidth) }),
        ...(options.minHeight === undefined ? {} : { minHeight: Number(options.minHeight) }),
        ...(options.strictNoAttribution === true ? { strictNoAttribution: true } : {}),
        ...(options.output === undefined ? {} : { output: String(options.output) }),
        ...(options.manifest === undefined ? {} : { manifest: String(options.manifest) }),
        ...(options.saveCandidates === true ? { saveCandidates: true } : {}),
        ...(options.maxCandidates === undefined ? {} : { maxCandidates: Number(options.maxCandidates) }),
        ...(options.fromUrl === undefined ? {} : { fromUrl: String(options.fromUrl) }),
        ...(options.purpose === undefined ? {} : { purpose: String(options.purpose) }),
        ...(options.slide === undefined ? {} : { slide: Number(options.slide) }),
      })
      process.stdout.write(`${formatImagesSearch(result)}\n`)
    })

  const brand = program.command('brand').description('read a customer deck brand into a theme')
  brand
    .command('extract')
    .description('extract colours and fonts from an Office file into a ThemeFile v2')
    .argument('<file>', 'Office file (pptx/docx), resolved against --dir')
    .option('-o, --output <file>', 'output theme file, resolved against --dir')
    .option('--from <preset>', 'start from this pptwise preset')
    .option('--bind <deck>', 'bind the theme to this deck and derive its tokens')
    .option('--dir <dir>', 'workspace the paths resolve against', '.')
    .action((file: string, options: { output?: string; from?: string; bind?: string; dir: string }) => {
      const result = brandExtract({
        dir: options.dir,
        file,
        deps,
        ...(options.output === undefined ? {} : { output: options.output }),
        ...(options.from === undefined ? {} : { from: options.from }),
        ...(options.bind === undefined ? {} : { bind: options.bind }),
      })
      process.stdout.write(`wrote ${result.outputFile} (theme "${result.themeId}")\n`)
      if (result.bound !== null) {
        process.stdout.write(`bound ${result.bound.deckDir} to ${result.bound.themeFile}; theme ensure wrote ${String(result.bound.ensured.length)} file(s)\n`)
      }
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
    .addOption(new Option('--compat <level>', 'compatibility target; overrides the manifest field').choices([...COMPAT_LEVELS]))
    .action(async (dir: string, options: { out?: string; compat?: string }) => {
      const compat = options.compat === undefined ? null : asCompatLevel(options.compat)
      if (options.compat !== undefined && compat === null) {
        throw new DshPptFailure('UsageError', '--compat must be one of ' + COMPAT_LEVELS.join(', '))
      }
      const result = await renderDeck({
        dir,
        deps,
        ...(options.out === undefined ? {} : { output: options.out }),
        ...(compat === null ? {} : { compat }),
      })
      process.stdout.write(`wrote ${result.outputFile} (${String(result.slides)} slides, ${String(result.bytes)} bytes)\n`)
      process.stdout.write(`sha256 ${result.sha256}\n`)
      process.stdout.write(
        `compat ${result.compat.report.level}: ${String(result.compat.report.counts.occurrences)} occurrence(s), ${String(result.compat.report.counts.downgrades)} downgrade(s), ${String(result.compat.report.counts.stamps)} stamp(s), ${String(result.compat.report.counts.warnings)} warning(s)` + '\n',
      )
      if (result.postflight.deep !== undefined) {
        process.stdout.write(
          `deep postflight status=${result.postflight.deep.status} quality_gate=${result.postflight.deep.qualityGate} slides=${String(result.postflight.deep.slides)}\n`,
        )
      }
      process.stdout.write(
        `merge: ${String(result.merge.replaced.length)} page(s) replaced, ${String(Object.keys(result.merge.imported).length)} part(s) imported, ${String(result.merge.multiMaster ? 'multi-master' : 'single master')}\n`,
      )
    })

  const compat = program.command('compat').description('inspect a rendered package against the compatibility registry')
  compat
    .command('lint')
    .description('scan and lint one pptx against a compat level without changing it')
    .argument('<file>', 'pptx file, resolved against --dir')
    .option('--dir <dir>', 'workspace the file path is resolved against', '.')
    .addOption(new Option('--compat <level>', 'compatibility target level').choices([...COMPAT_LEVELS]).default('standard'))
    .option('--strict', 'treat warning-level findings as failures')
    .option('--json', 'print the full report as JSON')
    .action(async (file: string, options: { dir: string; compat: string; strict?: boolean; json?: boolean }) => {
      const level = asCompatLevel(options.compat)
      if (level === null) throw new DshPptFailure('UsageError', '--compat must be one of ' + COMPAT_LEVELS.join(', '))
      const result = await compatLint({ dir: options.dir, file, level, strict: options.strict === true, deps })
      if (options.json === true) printJson(compatLintDocument(result))
      else process.stdout.write(`${formatCompatLint(result)}` + '\n')
      process.exitCode = result.ok ? 0 : 1
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

  const template = deep.command('template').description('materialise and install mirror templates')
  template
    .command('create')
    .description('round-trip a pptx and materialise a mirror template from it')
    .argument('<dir>', 'deck workspace')
    .requiredOption('--file <pptx>', 'source pptx, resolved against the workspace')
    .requiredOption('-o, --output <dir>', 'template workspace to write')
    .addOption(new Option('--kind <kind>', 'template kind').choices([...TEMPLATE_KINDS]).default('deck'))
    .action((dir: string, options: { file: string; output: string; kind: string }) => {
      const result = deepTemplateCreate({
        dir,
        file: options.file,
        output: options.output,
        kind: options.kind === 'layout' ? 'layout' : 'deck',
        deps,
      })
      process.stdout.write(`import ${result.importDir} (${String(result.slides.length)} slide SVG(s))\n`)
      process.stdout.write(`wrote template ${result.templateDir} (kind ${result.kind})\n`)
    })
  template
    .command('apply')
    .description('install template workspace roots into an initialized project')
    .argument('<dir>', 'deck workspace')
    .requiredOption('--project <dir>', 'project root that receives the templates')
    .requiredOption('--template <dir...>', 'template workspace root; repeat for several kinds')
    .option('--dry-run', 'plan the installation without writing')
    .action((dir: string, options: { project: string; template: string[]; dryRun?: boolean }) => {
      const result = deepTemplateApply({
        dir,
        project: options.project,
        templates: options.template,
        deps,
        ...(options.dryRun === true ? { dryRun: true } : {}),
      })
      process.stdout.write(`project ${result.projectDir}: ${String(result.roots.length)} root(s) [${result.kinds.map((kind) => kind ?? 'untyped').join(', ')}]\n`)
      if (result.stdout.trim() !== '') process.stdout.write(`${result.stdout.trim()}\n`)
    })
  template
    .command('register')
    .description('register a template directory in the engine template index')
    .argument('<dir>', 'deck workspace')
    .addOption(new Option('--kind <kind>', 'index the template under this kind').choices([...TEMPLATE_REGISTRY_KINDS]).default('deck'))
    .option('--id <id>', 'template directory id under templates/<kind>/')
    .option('--all', 'rebuild every index entry of that kind')
    .option('--dry-run', 'show what would be written')
    .action((dir: string, options: { kind: string; id?: string; all?: boolean; dryRun?: boolean }) => {
      const stdout = templateRegister({
        dir,
        kind: options.kind as (typeof TEMPLATE_REGISTRY_KINDS)[number],
        deps,
        ...(options.id === undefined ? {} : { templateId: options.id }),
        ...(options.all === true ? { rebuildAll: true } : {}),
        ...(options.dryRun === true ? { dryRun: true } : {}),
      })
      process.stdout.write(`${stdout.trim() === '' ? 'template register: done' : stdout.trim()}\n`)
    })
  const native = deep.command('native').description('native pptx round-trip import')
  native
    .command('roundtrip')
    .description('import a pptx back into the source-preserving SVG workspace')
    .argument('<dir>', 'deck workspace')
    .requiredOption('--file <pptx>', 'pptx to import, resolved against the workspace')
    .option('-o, --output <dir>', 'output workspace; defaults to .dsh-ppt/roundtrip/<stem>')
    .addOption(new Option('--inheritance-mode <mode>', 'SVG inheritance layout').choices([...INHERITANCE_MODES]).default('both'))
    .option('--keep-hidden', 'keep hidden shapes in the imported SVGs')
    .option('--strict', 'stop on the first unsupported construct')
    .action((dir: string, options: { file: string; output?: string; inheritanceMode: string; keepHidden?: boolean; strict?: boolean }) => {
      const result = deepNativeRoundtrip({
        dir,
        file: options.file,
        inheritanceMode: options.inheritanceMode as (typeof INHERITANCE_MODES)[number],
        deps,
        ...(options.output === undefined ? {} : { output: options.output }),
        ...(options.keepHidden === true ? { keepHidden: true } : {}),
        ...(options.strict === true ? { strict: true } : {}),
      })
      process.stdout.write(`imported ${result.file} -> ${result.outputDir} (${String(result.slides.length)} slide SVG(s))\n`)
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