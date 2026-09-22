import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { deepTemplateApply, deepTemplateCreate } from './template.ts'
import { defaultDependencies } from './context.ts'
import { createFakeFileSystem, createFakeRunner, ok, type FakeFileSystem, type FakeRunner } from '../../tests/support/fake-runner.ts'
import { installFakeVenv } from '../../tests/support/fake-venv.ts'

const workspace = join(process.cwd(), 'tmp', 'template-deck')
const dshHome = join(process.cwd(), 'tmp', 'template-dsh')

/** A workspace with a pptx, a fake venv and a scripted template-import/materialise. */
function build(options: { importSlides?: boolean } = {}): { fs: FakeFileSystem; runner: FakeRunner; deps: ReturnType<typeof defaultDependencies> } {
  const fs = createFakeFileSystem({ files: { [join(workspace, 'out', 'deck.pptx')]: 'ppt-bytes' } })
  installFakeVenv(fs, { dshHome })
  const runner = createFakeRunner((call) => {
    if (call.args.includes('pptx-template-import') && options.importSlides !== false) {
      const output = call.args[call.args.indexOf('-o') + 1] ?? ''
      for (const name of ['slide_01.svg', 'slide_02.svg']) fs.writeText(join(workspace, output, 'svg', name), '<svg/>')
      return ok('imported 2 slides\n')
    }
    if (call.args.includes('mirror-template-materialize')) return ok('materialized template\n')
    if (call.args.includes('apply-template')) return ok('[OK] installed 3 file(s)\n')
    return ok()
  })
  return { fs, runner, deps: defaultDependencies({ fs, cwd: workspace, env: { DSH_HOME: dshHome }, runner }) }
}

describe('deepTemplateCreate', () => {
  it('imports with pptx-template-import and materialises a template with a manifest', () => {
    const { fs, runner, deps } = build()
    const result = deepTemplateCreate({ dir: workspace, file: 'out/deck.pptx', output: 'templates/mirror-deck', deps })
    expect(result.kind).toBe('deck')
    expect(result.importDir).toBe('.dsh-ppt/import/deck')
    expect(result.slides).toEqual(['.dsh-ppt/import/deck/svg/slide_01.svg', '.dsh-ppt/import/deck/svg/slide_02.svg'])
    const manifest = JSON.parse(fs.readText(join(workspace, 'templates/mirror-deck/template-manifest.json')) ?? 'null') as Record<string, unknown>
    expect(manifest).toMatchObject({
      schema: 'dsh-ppt-fusion.template-manifest.v1',
      kind: 'deck',
      source: 'out/deck.pptx',
      importWorkspace: '.dsh-ppt/import/deck',
    })
    const argv = runner.callsWith('mirror-template-materialize')[0]?.args ?? []
    expect(argv).toEqual(expect.arrayContaining(['mirror-template-materialize', '.dsh-ppt/import/deck', 'templates/mirror-deck', '--kind', 'deck']))
  })

  it('refuses an import that wrote no SVG', () => {
    const { deps } = build({ importSlides: false })
    expect(() => deepTemplateCreate({ dir: workspace, file: 'out/deck.pptx', output: 'templates/empty', deps })).toThrow(/wrote no SVG/)
  })
})

describe('deepTemplateApply', () => {
  it('passes one --root per template and reports the typed kinds', () => {
    const { fs, runner, deps } = build()
    fs.writeText(join(workspace, 'templates/a/template-manifest.json'), JSON.stringify({ kind: 'deck' }))
    fs.writeText(join(workspace, 'templates/b/template-manifest.json'), JSON.stringify({ kind: 'layout' }))
    fs.writeText(join(workspace, 'project/keep.txt'), 'x')
    const result = deepTemplateApply({ dir: workspace, project: 'project', templates: ['templates/a', 'templates/b'], dryRun: true, deps })
    expect(result.kinds).toEqual(['deck', 'layout'])
    expect(result.roots).toEqual(['templates/a', 'templates/b'])
    const argv = runner.callsWith('apply-template')[0]?.args ?? []
    expect(argv).toEqual(expect.arrayContaining(['apply-template', 'project', '--root', 'templates/a', '--root', 'templates/b', '--dry-run']))
  })

  it('refuses two roots of the same kind, an unknown root and a missing project', () => {
    const { fs, deps } = build()
    fs.writeText(join(workspace, 'templates/a/template-manifest.json'), JSON.stringify({ kind: 'deck' }))
    fs.writeText(join(workspace, 'templates/b/template-manifest.json'), JSON.stringify({ kind: 'deck' }))
    fs.writeText(join(workspace, 'project/keep.txt'), 'x')
    expect(() => deepTemplateApply({ dir: workspace, project: 'project', templates: ['templates/a', 'templates/b'], deps })).toThrow(/two template roots claim kind deck/)
    expect(() => deepTemplateApply({ dir: workspace, project: 'project', templates: ['templates/missing'], deps })).toThrow(/template root templates\/missing does not exist/)
    expect(() => deepTemplateApply({ dir: workspace, project: 'missing', templates: ['templates/a'], deps })).toThrow(/project directory missing does not exist/)
    expect(() => deepTemplateApply({ dir: workspace, project: 'project', templates: [], deps })).toThrow(/at least one --template root/)
  })
})
