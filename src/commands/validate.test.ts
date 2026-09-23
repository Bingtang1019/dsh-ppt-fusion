import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { validateDeck } from './validate.ts'
import { defaultDependencies } from './context.ts'
import { createThemeBridge } from '../bridge/theme.ts'
import { createFrontend } from '../frontend.ts'
import { parseFusionDeck, type FusionDeck } from '../schema/fusion.ts'
import { storyboardSkeleton } from '../schema/storyboard.ts'
import { createFakeFileSystem, createFakeRunner, type FakeFileSystem } from '../../tests/support/fake-runner.ts'
import { fakeThemeDocument, installFakePptwise, themeHandler } from '../../tests/support/fake-pptwise.ts'

const workspace = join(process.cwd(), 'tmp', 'deck')
const packageDir = join(process.cwd(), 'tmp', 'pptwise')

/** Build a workspace whose theme files are already in sync, then let the caller break it. */
function buildDeck(options: {
  deck: FusionDeck
  slides: Record<string, unknown>[]
  deepFiles?: Record<string, string>
}): { fs: FakeFileSystem; dir: string } {
  const fs = createFakeFileSystem({
    files: {
      [join(workspace, 'deck.ir.json')]: JSON.stringify({ version: '5', slides: options.slides }),
      ...Object.fromEntries(Object.entries(options.deepFiles ?? {}).map(([relative, content]) => [join(workspace, relative), content])),
    },
  })
  installFakePptwise(fs, { packageDir })
  const runner = createFakeRunner(themeHandler(fs, { workspace, documents: { brief: fakeThemeDocument('brief') } }))
  const frontend = createFrontend({
    cli: { packageDir, cliPath: join(packageDir, 'dist', 'cli.js'), version: '0.35.0' },
    workspace,
    runner,
    env: {},
  })
  createThemeBridge({ workspace, frontend, fs, upstream: '0.35.0' }).ensure(options.deck)
  fs.writeText(join(workspace, 'deck.fusion.json'), JSON.stringify(options.deck))
  // Every deck carries a storyboard from v0.2 on; tests that need it absent or
  // broken overwrite this file afterwards.
  const slides = options.slides.map((slide) => ({ type: String((slide as { type?: unknown }).type ?? '') }))
  fs.writeText(join(workspace, 'deck.storyboard.json'), JSON.stringify(storyboardSkeleton(options.deck, { slides })))
  return { fs, dir: workspace }
}

const validate = (fs: FakeFileSystem, dir = workspace) =>
  validateDeck({ dir, deps: defaultDependencies({ fs, cwd: workspace, resolveModule: installFakePptwise(fs, { packageDir }).resolveModule }) })

const deepDeck = (dir = 'deep/p02') =>
  parseFusionDeck({
    version: 1,
    name: 'hello',
    pptwiseIr: 'deck.ir.json',
    theme: { preset: 'brief' },
    pages: [
      { index: 1, route: 'pptwise' },
      { index: 2, route: 'ppt-master', deep: { dir, kind: 'native-chart', format: 'ppt169' } },
    ],
  })

describe('validateDeck', () => {
  it('passes a deck whose manifest, IR, deep files and theme agree', () => {
    const deck = parseFusionDeck({
      version: 1,
      name: 'hello',
      pptwiseIr: 'deck.ir.json',
      theme: { preset: 'brief' },
      pages: [{ index: 1, route: 'pptwise' }],
    })
    const { fs } = buildDeck({ deck, slides: [{ type: 'cover' }] })
    const report = validate(fs)
    expect(report.findings).toEqual([])
    expect(report.ok).toBe(true)
    expect(report.sources).toContain('theme')
  })

  it('reports a deep page that is missing page.svg, naming the file', () => {
    const deck = deepDeck()
    const { fs } = buildDeck({ deck, slides: [{ type: 'cover' }, { type: 'content', placeholder: true }] })
    const report = validate(fs)
    const finding = report.findings.find((entry) => entry.rule === 'deep-page-missing-file')
    expect(finding?.level).toBe('error')
    expect(finding?.message).toContain('deep/p02/page.svg')
    expect(report.ok).toBe(false)
  })

  it('reports a deep page whose IR slide is not a placeholder', () => {
    const deck = deepDeck()
    const { fs } = buildDeck({
      deck,
      slides: [{ type: 'cover' }, { type: 'content' }],
      deepFiles: { 'deep/p02/page.svg': '<svg/>' },
    })
    const report = validate(fs)
    expect(report.findings.some((entry) => entry.rule === 'deep-page-not-placeholder')).toBe(true)
  })

  it('warns when a deep page paints outside the palette but stays ok', () => {
    const deck = deepDeck()
    const { fs } = buildDeck({
      deck,
      slides: [{ type: 'cover' }, { type: 'content', placeholder: true }],
      deepFiles: { 'deep/p02/page.svg': '<rect fill="#FF0000"/>' },
    })
    const report = validate(fs)
    const finding = report.findings.find((entry) => entry.rule === 'palette-unknown-color')
    expect(finding?.level).toBe('warning')
    expect(report.ok).toBe(true)
    expect(report.sources).toContain('palette')
  })

  it('reports stale tokens and a missing theme', () => {
    const deck = parseFusionDeck({
      version: 1,
      name: 'hello',
      pptwiseIr: 'deck.ir.json',
      theme: { preset: 'brief' },
      pages: [{ index: 1, route: 'pptwise' }],
    })
    const { fs } = buildDeck({ deck, slides: [{ type: 'cover' }] })
    fs.writeText(join(workspace, 'tokens.json'), JSON.stringify({ schema: 'dsh-ppt-fusion.tokens.v1', themeId: 'brief' }))
    expect(validate(fs).findings.some((entry) => entry.rule === 'tokens-stale')).toBe(true)

    fs.removeTree(join(workspace, 'theme.json'))
    const missing = validate(fs)
    expect(missing.findings.some((entry) => entry.rule === 'theme-missing')).toBe(true)
    expect(missing.findings.find((entry) => entry.rule === 'theme-missing')?.message).toContain('theme ensure')
  })

  it('rejects a manifest typo with the offending field path', () => {
    const fs = createFakeFileSystem({
      files: {
        [join(workspace, 'deck.fusion.json')]: JSON.stringify({ version: 1, name: 'hello', pptwiseIR: 'x', theme: { preset: 'brief' }, pages: [{ index: 1, route: 'pptwise' }] }),
        [join(workspace, 'deck.ir.json')]: JSON.stringify({ slides: [{ type: 'cover' }] }),
      },
    })
    const report = validate(fs)
    expect(report.ok).toBe(false)
    expect(report.findings[0]?.rule).toBe('manifest-invalid')
    expect(report.findings[0]?.message).toContain('pptwiseIR')
  })

  it('reports a page-coverage gap', () => {
    const deck = parseFusionDeck({
      version: 1,
      name: 'hello',
      pptwiseIr: 'deck.ir.json',
      theme: { preset: 'brief' },
      pages: [{ index: 1, route: 'pptwise' }],
    })
    const { fs } = buildDeck({ deck, slides: [{ type: 'cover' }, { type: 'ending' }] })
    const finding = validate(fs).findings.find((entry) => entry.rule === 'page-coverage')
    expect(finding?.message).toContain('missing index 2')
  })

  it('reports an absent post.animations file', () => {
    const deck = parseFusionDeck({
      version: 1,
      name: 'hello',
      pptwiseIr: 'deck.ir.json',
      theme: { preset: 'brief' },
      pages: [{ index: 1, route: 'pptwise' }],
      post: { animations: 'post/animations.json' },
    })
    const { fs } = buildDeck({ deck, slides: [{ type: 'cover' }] })
    expect(validate(fs).findings.some((entry) => entry.rule === 'post-animations-missing')).toBe(true)
  })

  it('reports a missing manifest instead of throwing', () => {
    const fs = createFakeFileSystem({})
    const report = validate(fs)
    expect(report.ok).toBe(false)
    expect(report.findings[0]?.rule).toBe('manifest-missing')
  })

  it('reports a page section while chrome.section is absent', () => {
    const deck = parseFusionDeck({
      version: 1,
      name: 'hello',
      pptwiseIr: 'deck.ir.json',
      theme: { preset: 'brief' },
      pages: [{ index: 1, route: 'pptwise', section: 'Intro' }],
      chrome: { pageNumber: { show: true, skipRoles: ['ending'] } },
    })
    const { fs } = buildDeck({ deck, slides: [{ type: 'cover' }] })
    const finding = validate(fs).findings.find((entry) => entry.rule === 'chrome-section-undeclared')
    expect(finding?.level).toBe('error')
    expect(finding?.message).toContain('chrome.section')
  })

  it('reports a chrome logo file that is not in the deck', () => {
    const deck = parseFusionDeck({
      version: 1,
      name: 'hello',
      pptwiseIr: 'deck.ir.json',
      theme: { preset: 'brief' },
      pages: [{ index: 1, route: 'pptwise' }],
      chrome: { pageNumber: { show: true, skipRoles: ['ending'] }, logo: { file: 'assets/logo.png' } },
    })
    const { fs } = buildDeck({ deck, slides: [{ type: 'cover' }] })
    const finding = validate(fs).findings.find((entry) => entry.rule === 'chrome-logo-missing')
    expect(finding?.message).toContain('assets/logo.png')
  })

  it('reports a page-number contract that skips every page', () => {
    const deck = parseFusionDeck({
      version: 1,
      name: 'hello',
      pptwiseIr: 'deck.ir.json',
      theme: { preset: 'brief' },
      pages: [{ index: 1, route: 'pptwise' }],
      chrome: { pageNumber: { show: true, skipRoles: ['cover'] } },
    })
    const { fs } = buildDeck({ deck, slides: [{ type: 'cover' }] })
    expect(validate(fs).findings.some((entry) => entry.rule === 'chrome-skip-all')).toBe(true)
  })

  it('leaves a deck without a chrome block untouched', () => {
    const deck = parseFusionDeck({
      version: 1,
      name: 'hello',
      pptwiseIr: 'deck.ir.json',
      theme: { preset: 'brief' },
      pages: [{ index: 1, route: 'pptwise' }],
    })
    const { fs } = buildDeck({ deck, slides: [{ type: 'cover' }] })
    expect(validate(fs).findings.filter((entry) => entry.rule.startsWith('chrome-'))).toEqual([])
  })

  it('reports a missing storyboard', () => {
    const deck = parseFusionDeck({
      version: 1,
      name: 'hello',
      pptwiseIr: 'deck.ir.json',
      theme: { preset: 'brief' },
      pages: [{ index: 1, route: 'pptwise' }],
    })
    const { fs } = buildDeck({ deck, slides: [{ type: 'cover' }] })
    fs.files.delete(join(workspace, 'deck.storyboard.json'))
    const finding = validate(fs).findings.find((entry) => entry.rule === 'storyboard-missing')
    expect(finding?.level).toBe('error')
    expect(finding?.message).toContain('deck.storyboard.json')
  })

  it('reports an invalid storyboard and a coverage gap', () => {
    const deck = parseFusionDeck({
      version: 1,
      name: 'hello',
      pptwiseIr: 'deck.ir.json',
      theme: { preset: 'brief' },
      pages: [
        { index: 1, route: 'pptwise' },
        { index: 2, route: 'pptwise' },
      ],
    })
    const { fs } = buildDeck({ deck, slides: [{ type: 'cover' }, { type: 'content' }] })
    fs.writeText(join(workspace, 'deck.storyboard.json'), JSON.stringify({ version: 2, pages: [] }))
    expect(validate(fs).findings.some((entry) => entry.rule === 'storyboard-invalid')).toBe(true)
    fs.writeText(
      join(workspace, 'deck.storyboard.json'),
      JSON.stringify({ version: 1, pages: [{ index: 1, role: 'cover', layout: 'x', route: 'pptwise' }] }),
    )
    const coverage = validate(fs).findings.find((entry) => entry.rule === 'storyboard-coverage')
    expect(coverage?.message).toContain('missing page 2')
  })

  it('reports a storyboard that disagrees with the manifest', () => {
    const deck = parseFusionDeck({
      version: 1,
      name: 'hello',
      pptwiseIr: 'deck.ir.json',
      theme: { preset: 'brief' },
      pages: [{ index: 1, route: 'pptwise' }],
    })
    const { fs } = buildDeck({ deck, slides: [{ type: 'cover' }] })
    fs.writeText(
      join(workspace, 'deck.storyboard.json'),
      JSON.stringify({ version: 1, pages: [{ index: 1, role: 'content', layout: 'x', route: 'ppt-master' }] }),
    )
    const problems = validate(fs).findings.filter((entry) => entry.rule === 'storyboard-manifest')
    expect(problems.some((entry) => entry.message.includes('routes ppt-master'))).toBe(true)
    expect(problems.some((entry) => entry.message.includes('role content'))).toBe(true)
  })
})
