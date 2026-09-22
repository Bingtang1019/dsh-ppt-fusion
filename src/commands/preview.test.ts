import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { previewDeck } from './preview.ts'
import { defaultDependencies } from './context.ts'
import { createFakeFileSystem, createFakeRunner, ok, type FakeFileSystem } from '../../tests/support/fake-runner.ts'
import { installFakePptwise } from '../../tests/support/fake-pptwise.ts'

const workspace = join(process.cwd(), 'tmp', 'preview-deck')
const packageDir = join(process.cwd(), 'tmp', 'pptwise-preview')
const placeholderSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="10" height="10"/></svg>'
const coverSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="30" height="30"/></svg>'
const deepSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><g data-pptx-role="chart"><rect width="20" height="20"/></g></svg>'

/** A two-page deck whose second page is deep, plus a fake pptwise that writes a preview. */
function build(): { fs: FakeFileSystem; deps: ReturnType<typeof defaultDependencies> } {
  const fs = createFakeFileSystem({
    files: {
      [join(workspace, 'deck.fusion.json')]: JSON.stringify({
        version: 1,
        name: 'deck',
        pptwiseIr: 'deck.ir.json',
        theme: { preset: 'brief' },
        pages: [
          { index: 1, route: 'pptwise' },
          { index: 2, route: 'ppt-master', deep: { dir: 'deep/p02', kind: 'native-chart', format: 'ppt169' } },
        ],
      }),
      [join(workspace, 'deck.ir.json')]: JSON.stringify({ version: '5', slides: [{ type: 'cover' }, { type: 'content', placeholder: true }] }),
      [join(workspace, 'deep', 'p02', 'page.svg')]: deepSvg,
    },
  })
  const { resolveModule } = installFakePptwise(fs, { packageDir })
  const runner = createFakeRunner((call) => {
    if (call.args[1] !== 'preview') return ok()
    const output = call.args[call.args.indexOf('-o') + 1] ?? ''
    const base = join(workspace, output)
    fs.writeText(
      join(base, 'manifest.json'),
      `${JSON.stringify({ manifestVersion: 1, pages: [{ page: 1, file: '001-cover.svg' }, { page: 2, file: '002-content.svg', placeholder: true }] }, null, 2)}\n`,
    )
    fs.writeText(join(base, '001-cover.svg'), coverSvg)
    fs.writeText(join(base, '002-content.svg'), placeholderSvg)
    fs.writeText(join(base, 'preview.html'), `<html><body>${coverSvg}${placeholderSvg}</body></html>`)
    return ok('wrote 2 SVG files\n')
  })
  return { fs, deps: defaultDependencies({ fs, cwd: workspace, runner, resolveModule }) }
}

describe('previewDeck', () => {
  it('overlays the authored deep SVG and patches the viewer', () => {
    const { fs, deps } = build()
    const result = previewDeck({ dir: workspace, html: true, deps })

    expect(result.pages).toHaveLength(2)
    expect(result.overlaid).toEqual([2])
    expect(result.placeholders).toEqual([])
    expect(result.htmlPatched).toBe(true)
    expect(fs.readText(join(workspace, '.dsh-ppt', 'preview', '002-content.svg'))).toBe(deepSvg)
    const manifest = JSON.parse(fs.readText(join(workspace, '.dsh-ppt', 'preview', 'manifest.json')) ?? '{}') as { pages: { page: number; placeholder?: boolean; deep?: boolean }[] }
    expect(manifest.pages[1]).toEqual({ page: 2, file: '002-content.svg', deep: true })
    const html = fs.readText(join(workspace, '.dsh-ppt', 'preview', 'preview.html')) ?? ''
    expect(html).toContain(deepSvg)
    expect(html).not.toContain(placeholderSvg)
  })

  it('reports a deep page without an authored SVG as a placeholder', () => {
    const { fs, deps } = build()
    const deep = join(workspace, 'deep', 'p02', 'page.svg')
    fs.files.delete(deep)
    const result = previewDeck({ dir: workspace, html: false, deps })

    expect(result.overlaid).toEqual([])
    expect(result.placeholders).toEqual([2])
    expect(result.htmlFile).toBeNull()
    expect(fs.readText(join(workspace, '.dsh-ppt', 'preview', '002-content.svg'))).toBe(placeholderSvg)
  })

  it('fails when pptwise writes no manifest', () => {
    const fs = createFakeFileSystem({
      files: {
        [join(workspace, 'deck.fusion.json')]: JSON.stringify({ version: 1, name: 'deck', pptwiseIr: 'deck.ir.json', theme: { preset: 'brief' }, pages: [{ index: 1, route: 'pptwise' }] }),
        [join(workspace, 'deck.ir.json')]: JSON.stringify({ version: '5', slides: [{ type: 'cover' }] }),
      },
    })
    const { resolveModule } = installFakePptwise(fs, { packageDir })
    const deps = defaultDependencies({ fs, cwd: workspace, runner: createFakeRunner(), resolveModule })
    expect(() => previewDeck({ dir: workspace, html: true, deps })).toThrowError(/wrote no manifest/)
  })
})
