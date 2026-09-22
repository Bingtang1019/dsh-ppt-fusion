import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { postAnimate } from './post.ts'
import { defaultDependencies } from './context.ts'
import { OpcPackage, auditPackage } from '../bridge/opc.ts'
import { createFakeFileSystem, type FakeFileSystem } from '../../tests/support/fake-runner.ts'

const workspace = join(process.cwd(), 'tmp', 'post-animate-deck')

const SLIDE = `<p:sld><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/></p:nvGrpSpPr><p:sp><p:nvSpPr><p:cNvPr id="5" name="milestone-chart"/></p:nvSpPr></p:sp><p:sp><p:nvSpPr><p:cNvPr id="6" name="page-heading"/></p:nvSpPr></p:sp></p:spTree></p:cSld></p:sld>`

/** A one-slide package the post pass can animate. */
async function deckPackage(): Promise<Buffer> {
  const pkg = new OpcPackage()
  pkg.declareDefault('rels', 'application/vnd.openxmlformats-package.relationships+xml')
  pkg.declareDefault('xml', 'application/xml')
  pkg.setPart('ppt/slides/slide1.xml', SLIDE)
  pkg.setRelationships('ppt/slides/slide1.xml', [
    { id: 'rId1', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout', target: '../slideLayouts/slideLayout1.xml' },
  ])
  pkg.setPart('ppt/slideLayouts/slideLayout1.xml', '<p:sldLayout/>')
  pkg.setPart('ppt/slideMasters/slideMaster1.xml', '<p:sldMaster/>')
  pkg.setPart('ppt/presentation.xml', '<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>')
  pkg.setRelationships('ppt/presentation.xml', [
    { id: 'rId1', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide', target: 'slides/slide1.xml' },
    { id: 'rId2', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster', target: 'slideMasters/slideMaster1.xml' },
  ])
  for (const name of pkg.names()) pkg.ensureContentType(name, 'application/xml')
  return pkg.write()
}

/** A deck workspace with a published package and the given post config. */
async function build(options: { config?: unknown | null; withPackage?: boolean } = {}): Promise<FakeFileSystem> {
  const fs = createFakeFileSystem({
    files: {
      [join(workspace, 'deck.ir.json')]: JSON.stringify({ version: '5', slides: [{ type: 'cover' }] }),
      [join(workspace, 'deck.fusion.json')]: JSON.stringify({
        version: 1,
        name: 'deck',
        pptwiseIr: 'deck.ir.json',
        theme: { preset: 'brief' },
        pages: [{ index: 1, route: 'pptwise' }],
        post: { animations: 'post/animations.json' },
      }),
      [join(workspace, 'out', 'manifest.json')]: JSON.stringify({ name: 'deck', file: 'out/deck.pptx', sha256: 'old', bytes: 1, slides: 1 }),
      ...(options.config === null
        ? {}
        : {
            [join(workspace, 'post', 'animations.json')]: JSON.stringify(
              options.config ?? {
                staggerMs: 200,
                slides: [
                  {
                    index: 1,
                    transition: 'fade',
                    entrance: { effect: 'fade', target: { match: 'milestone-chart' } },
                    emphasis: { effect: 'spin', target: { match: 'milestone-chart' } },
                    path: { effect: 'right', target: { match: 'page-heading' } },
                  },
                ],
              },
            ),
          }),
    },
    directories: [workspace],
  })
  if (options.withPackage !== false) fs.writeBytes(join(workspace, 'out', 'deck.pptx'), await deckPackage())
  return fs
}

const depsFor = (fs: FakeFileSystem) => defaultDependencies({ fs, cwd: workspace })

/** @returns the stable failure code of a rejected `postAnimate`, or undefined when it resolved. */
const codeOf = async (run: () => Promise<unknown>): Promise<string | undefined> => {
  try {
    await run()
    return undefined
  } catch (error) {
    return (error as { code?: string }).code
  }
}

describe('postAnimate', () => {
  it('applies the deck motion to the published package and refreshes its records', async () => {
    const fs = await build()
    const result = await postAnimate({ dir: workspace, deps: depsFor(fs) })
    expect(result.file).toBe('out/deck.pptx')
    expect(result.outputFile).toBe('out/deck.pptx')
    expect(result.sha256).not.toBe('old')
    expect(result.report.slides).toHaveLength(1)
    expect(result.report.slides[0]).toMatchObject({ transition: 'fade', emphasis: 'spin', path: 'right' })
    expect(result.compat.level).toBe('standard')

    const written = fs.readBytes(join(workspace, 'out', 'deck.pptx'))
    expect(written).not.toBeNull()
    const pkg = await OpcPackage.read(written ?? Buffer.alloc(0))
    const xml = pkg.text('ppt/slides/slide1.xml')
    expect(xml).toContain('<p:transition')
    expect(xml).toContain('presetClass="emph"')
    expect(xml).toContain('presetClass="path"')
    expect(auditPackage(pkg, { requireSingleMaster: true }).map((finding) => finding.rule)).toEqual([])

    const manifest = JSON.parse(fs.readText(join(workspace, 'out', 'manifest.json')) ?? 'null') as { sha256: string; post?: unknown; compat?: { level?: string } }
    expect(manifest.sha256).toBe(result.sha256)
    expect(manifest.post).toBeDefined()
    expect(manifest.compat?.level).toBe('standard')
    expect(fs.readText(join(workspace, 'out', 'compat-report.json'))).toContain('dsh-ppt-fusion.compat-report.v1')
  })

  it('writes to --out and leaves the input alone', async () => {
    const fs = await build()
    const before = fs.readBytes(join(workspace, 'out', 'deck.pptx'))
    const result = await postAnimate({ dir: workspace, output: 'out/animated.pptx', deps: depsFor(fs) })
    expect(result.outputFile).toBe('out/animated.pptx')
    expect(fs.readBytes(join(workspace, 'out', 'deck.pptx'))?.equals(before ?? Buffer.alloc(0))).toBe(true)
    expect(fs.readBytes(join(workspace, 'out', 'animated.pptx'))).not.toBeNull()
  })

  it('refuses a missing config, a missing package and an unmatched selector', async () => {
    const noConfig = await build({ config: null })
    expect(await codeOf(() => postAnimate({ dir: workspace, config: 'post/missing.json', deps: depsFor(noConfig) }))).toBe('OutputMissing')

    const noPackage = await build({ withPackage: false })
    expect(await codeOf(() => postAnimate({ dir: workspace, deps: depsFor(noPackage) }))).toBe('OutputMissing')

    const unmatched = await build({ config: { slides: [{ index: 1, entrance: { effect: 'fade', target: { match: 'no-such-shape' } } }] } })
    expect(await codeOf(() => postAnimate({ dir: workspace, deps: depsFor(unmatched) }))).toBe('ContractViolation')
  })
})
