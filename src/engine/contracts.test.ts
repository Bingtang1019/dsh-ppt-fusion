import { describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import {
  applyTemplate,
  assertEnum,
  assertInsideWorkspace,
  imageGenerate,
  imageGenCredentials,
  parseCreatedProjectDir,
  projectInit,
  pptxTemplateImport,
  pptxToSvg,
  qualityCheck,
  registerTemplate,
  stampFallbacks,
  textMeasure,
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
    expect(invocation.outputFiles).toEqual(['out/deep.pptx', 'deep/project/validation/deep.report.json'])
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
    expect(invocation.outputFiles[1]).toBe('p/validation/Deck.report.json')
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
    expect(invocation.outputFiles).toEqual(['deep/validation/svg_quality_report.json'])
    expect(invocation.argv).toContain('--canonical-authoring')
  })
})

describe('pptxToSvg', () => {
  it('pairs --roundtrip with --inheritance-mode both and refuses the other modes', () => {
    const invocation = pptxToSvg({ file: 'out/deck.pptx', output: 'imports/deck', inheritanceMode: 'both', roundtrip: true, strict: true })
    expect(invocation.argv).toEqual(['pptx-to-svg', 'out/deck.pptx', '-o', 'imports/deck', '--inheritance-mode', 'both', '--strict', '--roundtrip'])
    expect(() => pptxToSvg({ file: 'out/deck.pptx', roundtrip: true })).toThrow(/inheritance-mode both/)
    expect(() => pptxToSvg({ file: 'out/deck.pptx', inheritanceMode: 'layered', roundtrip: true })).toThrow(/inheritance-mode both/)
  })
})

describe('pptxTemplateImport', () => {
  it('passes the import flags through', () => {
    const invocation = pptxTemplateImport({ file: 'out/deck.pptx', output: 'imports/deck', inheritanceMode: 'both', embedImages: true })
    expect(invocation.argv).toEqual(['pptx-template-import', 'out/deck.pptx', '-o', 'imports/deck', '--inheritance-mode', 'both', '--embed-images'])
  })
})

describe('applyTemplate', () => {
  it('needs at least one root and repeats --root per kind', () => {
    const invocation = applyTemplate({ projectDir: 'deep/p03', roots: ['templates/deck', 'templates/layout'], dryRun: true })
    expect(invocation.argv).toEqual(['apply-template', 'deep/p03', '--root', 'templates/deck', '--root', 'templates/layout', '--dry-run'])
    expect(() => applyTemplate({ projectDir: 'deep/p03', roots: [] })).toThrow(/at least one --root/)
  })
})

describe('registerTemplate', () => {
  it('carries the id, kind and rebuild flags', () => {
    expect(registerTemplate({ templateId: 'mirror', kind: 'deck' }).argv).toEqual(['register-template', 'mirror', '--kind', 'deck'])
    expect(registerTemplate({ rebuildAll: true, kind: 'brand', dryRun: true }).argv).toEqual(['register-template', '--kind', 'brand', '--rebuild-all', '--dry-run'])
  })
})

describe('stampFallbacks', () => {
  it('only passes --write when asked', () => {
    expect(stampFallbacks({ target: 'deep/svg_output' }).argv).toEqual(['stamp-native-fallbacks', 'deep/svg_output'])
    expect(stampFallbacks({ target: 'deep/svg_output', write: true }).argv).toContain('--write')
  })
})

describe('imageGenerate', () => {
  it('maps the exposed provider onto the engine backend and names the output file', () => {
    const openai = imageGenerate({ prompt: 'a cat', provider: 'openai-compatible', output: 'assets', filename: 'ai-cat.png' })
    expect(openai.id).toBe('image-gen')
    expect(openai.argv).toEqual(['image-gen', 'a cat', '--backend', 'openai', '-o', 'assets', '--filename', 'ai-cat.png'])
    expect(openai.outputFiles).toEqual(['assets/ai-cat.png'])
    const gemini = imageGenerate({ prompt: 'a cat', provider: 'gemini', output: 'assets', filename: 'ai-cat.png', aspectRatio: '16:9', imageSize: '1K' })
    expect(gemini.argv).toEqual(expect.arrayContaining(['--backend', 'gemini', '--aspect_ratio', '16:9', '--image_size', '1K']))
  })

  it('rejects a malformed prompt, filename, ratio or size', () => {
    expect(() => imageGenerate({ prompt: '  ', provider: 'gemini', output: 'assets', filename: 'ai.png' })).toThrowError(/prompt/)
    expect(() => imageGenerate({ prompt: 'x', provider: 'gemini', output: 'assets', filename: '../ai.png' })).toThrowError(/slug/)
    expect(() => imageGenerate({ prompt: 'x', provider: 'gemini', output: 'assets', filename: 'ai.png', aspectRatio: '--flag' })).toThrowError(/aspect ratio/)
    expect(() => imageGenerate({ prompt: 'x', provider: 'gemini', output: 'assets', filename: 'ai.png', imageSize: '1 K' })).toThrowError(/image size/)
  })

  it('passes only the provider knobs the child may read', () => {
    expect(imageGenCredentials('gemini')).toEqual(['IMAGE_BACKEND', 'GEMINI_API_KEY', 'GEMINI_BASE_URL', 'GEMINI_MODEL'])
    expect(imageGenCredentials('openai-compatible')).toEqual(
      expect.arrayContaining(['IMAGE_BACKEND', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL', 'OPENAI_SIZE_PRESET', 'OPENAI_RESPONSE_FORMAT', 'OPENAI_QUALITY', 'OPENAI_OUTPUT_FORMAT']),
    )
    expect(imageGenCredentials('openai-compatible')).not.toContain('GEMINI_API_KEY')
    expect([...imageGenCredentials('gemini'), ...imageGenCredentials('openai-compatible')]).not.toContain('IMAGE_API_KEY')
  })
})
describe('textMeasure', () => {
  it('batches single lines with the font attributes and JSON switch', () => {
    const invocation = textMeasure({ mode: 'measure', texts: ['alpha', 'beta'], sizePt: 24, family: 'MiSans', weight: 'bold', letterSpacing: 0.5 })
    expect(invocation.id).toBe('text-measure')
    expect(invocation.argv).toEqual(['text-measure', 'measure', 'alpha', 'beta', '--size', '24', '--family', 'MiSans', '--weight', 'bold', '--letter-spacing', '0.5', '--json'])
    expect(invocation.outputFiles).toEqual([])
  })

  it('wraps exactly one paragraph inside the given box', () => {
    const invocation = textMeasure({ mode: 'wrap', texts: ['one paragraph'], sizePt: 14, maxWidth: 300, dy: 17, x: 0 })
    expect(invocation.argv).toEqual(['text-measure', 'wrap', 'one paragraph', '--max-width', '300', '--x', '0', '--dy', '17', '--size', '14', '--json'])
  })

  it('refuses empty text, a multi-paragraph wrap and missing wrap numbers', () => {
    expect(() => textMeasure({ mode: 'measure', texts: [], sizePt: 14 })).toThrowError(/at least one non-empty text/)
    expect(() => textMeasure({ mode: 'measure', texts: ['  '], sizePt: 14 })).toThrowError(/at least one non-empty text/)
    expect(() => textMeasure({ mode: 'measure', texts: ['x'], sizePt: 0 })).toThrowError(/size must be positive/)
    expect(() => textMeasure({ mode: 'wrap', texts: ['a', 'b'], sizePt: 14, maxWidth: 1, dy: 1, x: 0 })).toThrowError(/exactly one paragraph/)
    expect(() => textMeasure({ mode: 'wrap', texts: ['a'], sizePt: 14 })).toThrowError(/needs maxWidth, dy and x/)
  })
})
