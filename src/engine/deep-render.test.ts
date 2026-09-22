import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import {
  CANVAS_VIEWBOX,
  collectFontSizes,
  createDeepRenderer,
  deriveSpecLock,
  detectPrimaryLanguage,
  parsePostflight,
  rosterName,
  type DeepPage,
} from './deep-render.ts'
import { createMasterEngine } from './master.ts'
import { createVenvManager, venvPaths } from './venv.ts'
import { DshPptFailure } from './errors.ts'
import { projectInit } from './contracts.ts'
import { exportTokens, parseThemeFile } from '../schema/tokens.ts'
import { createFakeFileSystem, createFakeRunner, fail, ok, timedOut, type FakeCall, type FakeFileSystem } from '../../tests/support/fake-runner.ts'
import { fakeThemeDocument } from '../../tests/support/fake-pptwise.ts'

const workspace = join(process.cwd(), 'tmp', 'deck')
const dshHome = join(process.cwd(), 'tmp', 'dsh-home')
const engineVersion = '0.1.128'
const paths = venvPaths(dshHome, engineVersion, '3.13')
const tokens = exportTokens(parseThemeFile(fakeThemeDocument('brief')), { kind: 'preset', preset: 'brief' })

const CHART_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720" data-pptx-page-role="content"><text font-size="42">Chart</text><text font-size="22">Body</text><text font-size="16">Note</text></svg>'

function healthyFs(pages: Record<string, string> = {}): FakeFileSystem {
  return createFakeFileSystem({
    files: {
      [paths.pythonExe]: 'binary',
      [paths.engineExe]: 'binary',
      [join(paths.sitePackages, `ppt_master-${engineVersion}.dist-info`, 'METADATA')]: 'Name: ppt-master\n',
      ...pages,
    },
    directories: [paths.root],
  })
}

/** Answers the four pipeline steps the way the real engine does. */
function pipelineRunner(fs: FakeFileSystem, options: { projectDir?: string; postflight?: string; overrides?: (call: FakeCall) => Partial<ReturnType<typeof ok>> | null } = {}) {
  const projectDir = options.projectDir ?? join(workspace, '.dsh-ppt', 'deep', 'deep-p02_ppt169_20260922')
  return createFakeRunner((call) => {
    const override = options.overrides?.(call)
    if (override !== null && override !== undefined) return override
    if (call.args[0] === 'project' && call.args[1] === 'init') {
      fs.mkdirp(join(projectDir, 'svg_output'))
      fs.mkdirp(join(projectDir, 'validation'))
      return ok(`Project created: ${projectDir}\nCanvas: PPT 16:9 (1280×720)\n`)
    }
    if (call.args[0] === 'stamp-native-fallbacks') return ok('Native fallback baselines: mode=write, files=2, changed=0\n')
    if (call.args[0] === 'svg-quality-check') {
      fs.writeText(join(projectDir, 'validation', 'svg_quality_report.json'), '{}')
      return ok('[SCAN] Checking 2 SVG file(s)...\n')
    }
    if (call.args[0] === 'svg-to-pptx') {
      const out = call.args[call.args.indexOf('-o') + 1] ?? 'out/deep.pptx'
      fs.writeText(out.startsWith(join(workspace)) ? out : join(workspace, out), 'PK')
      fs.writeText(join(projectDir, 'validation', 'deep-batch.report.json'), '{}')
      return ok(
        options.postflight ??
          `[POSTFLIGHT] status=passed-with-warnings quality_gate=passed slides=2 warning_categories=1\n[PPTX] ${out}\n`,
      )
    }
    return ok()
  })
}

function build(fs: FakeFileSystem, runner: ReturnType<typeof createFakeRunner>, pageCount = 1) {
  const venv = createVenvManager({
    config: {
      dshHome,
      engineVersion,
      pythonVersion: '3.13',
      requirementsFile: join(process.cwd(), 'python-assets', 'requirements.lock'),
      indexUrl: 'https://example.invalid/simple',
    },
    runner,
    fs,
    env: {},
  })
  const master = createMasterEngine({ workspace, venv })
  const pages: DeepPage[] = Array.from({ length: pageCount }, (_, offset) => {
    const index = offset + 2
    const dir = `deep/p0${String(index)}`
    fs.writeText(join(workspace, dir, 'page.svg'), CHART_SVG)
    return { index, spec: { dir, kind: 'native-chart', format: 'ppt169' }, svgPath: join(workspace, dir, 'page.svg') }
  })
  return { renderer: createDeepRenderer({ master, fs, tokens, format: 'ppt169' }), pages, fs }
}

const codeOf = (run: () => unknown): string => {
  try {
    run()
    return 'no-failure'
  } catch (error) {
    return error instanceof DshPptFailure ? error.code : 'not-a-DshPptFailure'
  }
}

describe('deep render helpers', () => {
  it('collects distinct font sizes in ascending order', () => {
    expect(collectFontSizes([CHART_SVG, '<text font-size="28"/>'])).toEqual([16, 22, 28, 42])
  })

  it('detects a Chinese deck from its text and defaults to English otherwise', () => {
    expect(detectPrimaryLanguage([CHART_SVG])).toBe('en')
    expect(detectPrimaryLanguage(['<text>中文标题与说明文字</text>'])).toBe('zh-CN')
  })

  it('parses the exporter receipt and returns null when it is absent', () => {
    expect(parsePostflight('[POSTFLIGHT] status=passed quality_gate=passed slides=5 warning_categories=0')).toEqual({
      status: 'passed',
      qualityGate: 'passed',
      slides: 5,
      warningCategories: 0,
    })
    expect(parsePostflight('nothing here')).toBeNull()
  })

  it('names roster files so the deck order survives the export', () => {
    expect(rosterName({ index: 3, spec: { dir: 'deep/p03-native-chart', kind: 'native-chart', format: 'ppt169' }, svgPath: '' })).toBe(
      '003-p03-native-chart.svg',
    )
  })

  it('writes a spec lock whose typography covers the sizes the pages use', () => {
    const page: DeepPage = { index: 2, spec: { dir: 'deep/p02', kind: 'native-chart', format: 'ppt169' }, svgPath: 'x' }
    const lock = deriveSpecLock({ pages: [page], svgTexts: [CHART_SVG], format: 'ppt169', tokens })
    expect(lock).toContain(`- viewBox: ${CANVAS_VIEWBOX.ppt169}`)
    expect(lock).toContain('- body: 16')
    expect(lock).toContain('- title: 42')
    expect(lock).toContain('- size_22: 22')
    expect(lock).toContain('- primary_language: en')
    expect(lock).toContain(`- bg: ${tokens.colors.bg.toUpperCase()}`)
    expect(lock).toContain('- mode: flat')
    expect(lock).toContain('- P02: native-chart')
  })

  it('refuses to invent typography when the pages declare no font size', () => {
    const page: DeepPage = { index: 2, spec: { dir: 'deep/p02', kind: 'native-chart', format: 'ppt169' }, svgPath: 'x' }
    expect(codeOf(() => deriveSpecLock({ pages: [page], svgTexts: ['<svg/>'], format: 'ppt169', tokens }))).toBe('ContractViolation')
  })
})

describe('deep render pipeline', () => {
  it('runs the four measured steps in order: init, stamp, quality, export', () => {
    const fs = healthyFs()
    const runner = pipelineRunner(fs)
    const { renderer, pages } = build(fs, runner, 2)
    const result = renderer.render({ pages, outputFile: join(workspace, 'out', 'deep-batch.pptx') })
    expect(runner.calls.map((call) => call.args[0])).toEqual(['project', 'stamp-native-fallbacks', 'svg-quality-check', 'svg-to-pptx'])
    expect(result.postflight).toMatchObject({ status: 'passed-with-warnings', qualityGate: 'passed', slides: 2 })
    expect(result.pages).toEqual([2, 3])
    expect(result.reportPath.endsWith('deep-batch.report.json')).toBe(true)
  })

  it('writes the spec lock and the roster into the temporary project', () => {
    const fs = healthyFs()
    const runner = pipelineRunner(fs)
    const { renderer, pages } = build(fs, runner, 1)
    const { projectDir } = renderer.prepare(pages)
    const lock = fs.readText(join(projectDir, 'spec_lock.md')) ?? ''
    expect(lock).toContain('- primary_language: en')
    expect(fs.readText(join(projectDir, 'svg_output', '002-p02.svg'))).toBe(CHART_SVG)
  })

  it('reuses one project per page set and clears the previous run', () => {
    const fs = healthyFs()
    const runner = pipelineRunner(fs)
    const { renderer, pages } = build(fs, runner, 1)
    fs.writeText(join(renderer.projectsRoot, 'deep-p02_ppt169_20260101', 'stale.txt'), 'old')
    const { projectDir } = renderer.prepare(pages)
    expect(fs.exists(join(renderer.projectsRoot, 'deep-p02_ppt169_20260101'))).toBe(false)
    expect(projectDir).toContain('deep-p02_ppt169_')
  })

  it('refuses an empty page set', () => {
    const fs = healthyFs()
    const runner = pipelineRunner(fs)
    const { renderer } = build(fs, runner, 1)
    expect(codeOf(() => renderer.prepare([]))).toBe('ContractViolation')
  })

  it('reports a page whose SVG is missing', () => {
    const fs = healthyFs()
    const runner = pipelineRunner(fs)
    const { renderer, pages } = build(fs, runner, 1)
    fs.removeTree(join(workspace, 'deep', 'p02', 'page.svg'))
    expect(codeOf(() => renderer.prepare(pages))).toBe('OutputMissing')
  })
})

describe('error classification (the five classes the milestone requires)', () => {
  it('VenvMissing when the engine venv is absent', () => {
    const fs = createFakeFileSystem({})
    const runner = createFakeRunner()
    const { renderer, pages } = build(fs, runner, 1)
    expect(codeOf(() => renderer.render({ pages, outputFile: join(workspace, 'out', 'x.pptx') }))).toBe('VenvMissing')
    expect(runner.calls).toHaveLength(0)
  })

  it('EngineTimeout when a step exceeds its budget', () => {
    const fs = healthyFs()
    const runner = pipelineRunner(fs, { overrides: (call) => (call.args[0] === 'svg-quality-check' ? timedOut() : null) })
    const { renderer, pages } = build(fs, runner, 1)
    expect(codeOf(() => renderer.render({ pages, outputFile: join(workspace, 'out', 'x.pptx') }))).toBe('EngineTimeout')
  })

  it('EngineExit when a step exits non-zero', () => {
    const fs = healthyFs()
    const runner = pipelineRunner(fs, { overrides: (call) => (call.args[0] === 'stamp-native-fallbacks' ? fail(1, 'marker payload is not bound') : null) })
    const { renderer, pages } = build(fs, runner, 1)
    try {
      renderer.render({ pages, outputFile: join(workspace, 'out', 'x.pptx') })
      expect.unreachable('expected a failure')
    } catch (error) {
      expect((error as DshPptFailure).code).toBe('EngineExit')
      expect((error as DshPptFailure).message).toContain('marker payload is not bound')
    }
  })

  it('OutputMissing when the exporter writes no report', () => {
    const fs = healthyFs()
    const runner = pipelineRunner(fs, {
      overrides: (call) => {
        if (call.args[0] !== 'svg-to-pptx') return null
        return ok('[POSTFLIGHT] status=passed quality_gate=passed slides=1 warning_categories=0\n')
      },
    })
    const { renderer, pages } = build(fs, runner, 1)
    expect(codeOf(() => renderer.render({ pages, outputFile: join(workspace, 'out', 'x.pptx') }))).toBe('OutputMissing')
  })

  it('OutputMissing when the exporter prints no receipt', () => {
    const fs = healthyFs()
    const runner = pipelineRunner(fs, { postflight: 'export finished without a receipt\n' })
    const { renderer, pages } = build(fs, runner, 1)
    expect(codeOf(() => renderer.render({ pages, outputFile: join(workspace, 'out', 'x.pptx') }))).toBe('OutputMissing')
  })

  it('ContractViolation when the registry refuses an unregistered argument', () => {
    // The registry guards every argv the pipeline can build; an unregistered
    // canvas never reaches a process.
    expect(codeOf(() => projectInit({ name: 'deep', baseDir: '.dsh-ppt/deep', format: 'a4x' as never }))).toBe('ContractViolation')
  })
})

describe('authored notes and narration', () => {
  it('copies notes.md and the deck narration into the project and embeds it', () => {
    const fs = healthyFs()
    const runner = pipelineRunner(fs)
    const { renderer, pages } = build(fs, runner)
    const page = pages[0]
    if (page === undefined) throw new Error('the helper produced no page')
    const stem = rosterName(page).replace(/\.svg$/, '')
    fs.writeText(join(workspace, page.spec.dir, 'notes.md'), '# Notes\n\nNarration text.')
    fs.writeBytes(join(workspace, 'narration', `${stem}.mp3`), Buffer.from([0x49, 0x44, 0x33, 0x04]))

    const result = renderer.render({ pages, outputFile: join(workspace, 'out', 'deep-batch.pptx') })
    expect(fs.readText(join(result.projectDir, 'notes', `${stem}.md`))).toContain('Narration text.')
    expect(result.narration?.audio).toEqual([`${stem}.mp3`])
    expect(fs.exists(join(result.projectDir, 'narration', `${stem}.mp3`))).toBe(true)
    const argv = runner.callsWith('--recorded-narration')[0]?.args ?? []
    expect(argv).toEqual(expect.arrayContaining(['--recorded-narration', 'narration', '--use-narration-timings']))
  })

  it('embeds no narration when the deck has none', () => {
    const fs = healthyFs()
    const runner = pipelineRunner(fs)
    const { renderer, pages } = build(fs, runner)
    const result = renderer.render({ pages, outputFile: join(workspace, 'out', 'deep-batch.pptx') })
    expect(result.narration).toBeUndefined()
    expect(runner.callsWith('--recorded-narration')).toHaveLength(0)
  })
})
