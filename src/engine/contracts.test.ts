import { describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import {
  assertEnum,
  assertInsideWorkspace,
  parseCreatedProjectDir,
  projectInit,
  qualityCheck,
  stampFallbacks,
  svgToPptx,
  toWorkspaceRelative,
  PPTX_STRUCTURES,
  SLIDE_FORMATS,
} from './contracts.ts'
import { DshPptFailure } from './errors.ts'

const workspace = join(process.cwd(), 'tmp', 'deck')

const codeOf = (run: () => unknown): string => {
  try {
    run()
    return 'no-failure'
  } catch (error) {
    return error instanceof DshPptFailure ? error.code : 'not-a-DshPptFailure'
  }
}

describe('assertEnum', () => {
  it('accepts members and rejects outsiders with the allowed set', () => {
    expect(assertEnum('format', 'ppt169', SLIDE_FORMATS)).toBe('ppt169')
    expect(() => assertEnum('format', 'a4-portrait', SLIDE_FORMATS)).toThrowError(/ppt169|must be one of/)
    expect(codeOf(() => assertEnum('structure', 'sideways', PPTX_STRUCTURES))).toBe('ContractViolation')
  })
})

describe('workspace containment', () => {
  it('accepts paths inside the workspace and rejects escapes', () => {
    expect(assertInsideWorkspace(workspace, 'deep/p03/page.svg', 'page')).toBe(resolve(workspace, 'deep/p03/page.svg'))
    expect(codeOf(() => assertInsideWorkspace(workspace, '../../etc/passwd', 'page'))).toBe('PathOutsideWorkspace')
    expect(codeOf(() => assertInsideWorkspace(workspace, resolve(workspace, '..', 'other'), 'page'))).toBe('PathOutsideWorkspace')
  })

  it('reports workspace-relative paths with forward slashes for the Python engine', () => {
    expect(toWorkspaceRelative(workspace, join(workspace, 'deep', 'p03', 'page.svg'))).toBe('deep/p03/page.svg')
  })
})

describe('projectInit', () => {
  it('builds the documented argv for a slug name', () => {
    const invocation = projectInit({ name: 'hello', baseDir: 'deep', format: 'ppt169' })
    expect(invocation.argv).toEqual(['project', 'init', 'hello', '--format', 'ppt169', '--dir', 'deep'])
    expect(invocation.outputFiles).toEqual([])
    expect(invocation.timeoutMs).toBeGreaterThan(0)
  })

  it('rejects names that are paths or contain spaces', () => {
    expect(codeOf(() => projectInit({ name: '../escape', baseDir: 'deep', format: 'ppt169' }))).toBe('ContractViolation')
    expect(codeOf(() => projectInit({ name: 'two words', baseDir: 'deep', format: 'ppt169' }))).toBe('ContractViolation')
  })

  it('parses the created directory from the engine receipt', () => {
    expect(parseCreatedProjectDir('[OK] Project created: fixtures\\hello_ppt169_20260922\n')).toBe('fixtures\\hello_ppt169_20260922')
    expect(parseCreatedProjectDir('nothing here')).toBeNull()
  })
})

describe('svgToPptx', () => {
  it('defaults to the measured deep pipeline and contracts the report file', () => {
    const invocation = svgToPptx({ projectDir: 'deep/project', outputFile: 'out/deep.pptx' })
    expect(invocation.argv).toContain('--quick-generate')
    expect(invocation.argv).toContain('--native-charts-and-tables')
    expect(invocation.argv).toContain('--with-notes')
    expect(invocation.outputFiles).toEqual(['out/deep.pptx', 'validation/deep.report.json'])
  })

  it('omits the opt-outs and validates enumerated flags', () => {
    const invocation = svgToPptx({
      projectDir: 'p',
      outputFile: 'out/p.pptx',
      quickGenerate: false,
      nativeObjects: false,
      withNotes: false,
      structure: 'flat',
      format: 'ppt43',
    })
    expect(invocation.argv).not.toContain('--quick-generate')
    expect(invocation.argv).not.toContain('--native-charts-and-tables')
    expect(invocation.argv).toContain('--pptx-structure')
    expect(invocation.argv).toContain('flat')
    expect(invocation.argv).toContain('ppt43')
    expect(codeOf(() => svgToPptx({ projectDir: 'p', outputFile: 'o.pptx', structure: 'wrong' as never }))).toBe('ContractViolation')
  })

  it('derives the report stem for paths with directories and mixed case', () => {
    const invocation = svgToPptx({ projectDir: 'p', outputFile: 'out/nested/Deck.PPTX' })
    expect(invocation.outputFiles[1]).toBe('validation/Deck.report.json')
  })
})

describe('qualityCheck', () => {
  it('requires a page selector for --stage page', () => {
    expect(codeOf(() => qualityCheck({ target: 'deep', stage: 'page' }))).toBe('ContractViolation')
    const invocation = qualityCheck({ target: 'deep', stage: 'page', page: '03-bars.svg' })
    expect(invocation.argv).toEqual(['svg-quality-check', 'deep', '--stage', 'page', '--page', '03-bars.svg', '--json'])
  })

  it('contracts the recorded report file', () => {
    const invocation = qualityCheck({ target: 'deep', stage: 'final', quickGenerate: true, canonicalAuthoring: true })
    expect(invocation.outputFiles).toEqual(['validation/svg_quality_report.json'])
    expect(invocation.argv).toContain('--canonical-authoring')
  })
})

describe('stampFallbacks', () => {
  it('only passes --write when asked', () => {
    expect(stampFallbacks({ target: 'deep/svg_output' }).argv).toEqual(['stamp-native-fallbacks', 'deep/svg_output'])
    expect(stampFallbacks({ target: 'deep/svg_output', write: true }).argv).toContain('--write')
  })
})
