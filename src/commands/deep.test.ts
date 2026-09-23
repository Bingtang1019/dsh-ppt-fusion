import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { deepRender } from './deep.ts'
import { defaultDependencies } from './context.ts'
import { createThemeBridge } from '../bridge/theme.ts'
import { createFrontend } from '../frontend.ts'
import { parseFusionDeck } from '../schema/fusion.ts'
import { storyboardSkeleton } from '../schema/storyboard.ts'
import { DshPptFailure } from '../engine/errors.ts'
import { createFakeFileSystem, createFakeRunner, type FakeFileSystem } from '../../tests/support/fake-runner.ts'
import { fakeThemeDocument, installFakePptwise, themeHandler } from '../../tests/support/fake-pptwise.ts'

const workspace = join(process.cwd(), 'tmp', 'deck')
const packageDir = join(process.cwd(), 'tmp', 'pptwise')

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720" data-pptx-page-role="content"><text font-size="42">T</text></svg>'

/** Build a deck whose theme files are in sync and whose deep page exists. */
function buildDeck(options: { manifest: unknown; slides: unknown[]; svg?: string | null }): FakeFileSystem {
  const fs = createFakeFileSystem({
    files: {
      [join(workspace, 'deck.ir.json')]: JSON.stringify({ version: '5', slides: options.slides }),
      ...(options.svg === null ? {} : { [join(workspace, 'deep', 'p02', 'page.svg')]: options.svg ?? SVG }),
    },
  })
  installFakePptwise(fs, { packageDir })
  const frontend = createFrontend({
    cli: { packageDir, cliPath: join(packageDir, 'dist', 'cli.js'), version: '0.35.0' },
    workspace,
    runner: createFakeRunner(themeHandler(fs, { workspace, documents: { brief: fakeThemeDocument('brief') } })),
    env: {},
  })
  const deck = parseFusionDeck(options.manifest)
  createThemeBridge({ workspace, frontend, fs, upstream: '0.35.0' }).ensure(deck)
  fs.writeText(join(workspace, 'deck.fusion.json'), JSON.stringify(deck))
  const slides = (options.slides as readonly { type?: unknown }[]).map((slide) => ({ type: String(slide.type ?? '') }))
  fs.writeText(join(workspace, 'deck.storyboard.json'), JSON.stringify(storyboardSkeleton(deck, { slides })))
  return fs
}

const depsWith = (fs: FakeFileSystem) =>
  defaultDependencies({ fs, runner: createFakeRunner(), cwd: workspace, resolveModule: installFakePptwise(fs, { packageDir }).resolveModule })

const codeOf = (run: () => unknown): string => {
  try {
    run()
    return 'no-failure'
  } catch (error) {
    return error instanceof DshPptFailure ? error.code : 'not-a-DshPptFailure'
  }
}

const deepPage = (index: number, format = 'ppt169', dir = 'deep/p02') => ({
  index,
  route: 'ppt-master',
  deep: { dir, kind: 'native-chart', format },
})

describe('deep render command guards', () => {
  it('refuses a deck with no deep page', () => {
    const fs = buildDeck({
      manifest: { version: 1, name: 'deck', pptwiseIr: 'deck.ir.json', theme: { preset: 'brief' }, pages: [{ index: 1, route: 'pptwise' }] },
      slides: [{ type: 'cover' }],
    })
    expect(codeOf(() => deepRender({ dir: workspace, deps: depsWith(fs) }))).toBe('UsageError')
  })

  it('refuses a page selector that names a standard page', () => {
    const fs = buildDeck({
      manifest: {
        version: 1,
        name: 'deck',
        pptwiseIr: 'deck.ir.json',
        theme: { preset: 'brief' },
        pages: [{ index: 1, route: 'pptwise' }, deepPage(2)],
      },
      slides: [{ type: 'cover' }, { type: 'content', placeholder: true }],
    })
    expect(codeOf(() => deepRender({ dir: workspace, page: 1, deps: depsWith(fs) }))).toBe('UsageError')
  })

  it('refuses an invalid deck before spawning anything', () => {
    const fs = buildDeck({
      manifest: { version: 1, name: 'deck', pptwiseIr: 'deck.ir.json', theme: { preset: 'brief' }, pages: [{ index: 1, route: 'pptwise' }] },
      slides: [{ type: 'cover' }, { type: 'ending' }],
    })
    expect(codeOf(() => deepRender({ dir: workspace, deps: depsWith(fs) }))).toBe('ContractViolation')
  })

  it('refuses a deep page with no authored SVG', () => {
    const fs = buildDeck({
      manifest: {
        version: 1,
        name: 'deck',
        pptwiseIr: 'deck.ir.json',
        theme: { preset: 'brief' },
        pages: [{ index: 1, route: 'pptwise' }, deepPage(2)],
      },
      slides: [{ type: 'cover' }, { type: 'content', placeholder: true }],
      svg: null,
    })
    expect(codeOf(() => deepRender({ dir: workspace, deps: depsWith(fs) }))).toBe('ContractViolation')
  })

  it('refuses stale tokens, which the spec lock depends on', () => {
    const fs = buildDeck({
      manifest: {
        version: 1,
        name: 'deck',
        pptwiseIr: 'deck.ir.json',
        theme: { preset: 'brief' },
        pages: [{ index: 1, route: 'pptwise' }, deepPage(2)],
      },
      slides: [{ type: 'cover' }, { type: 'content', placeholder: true }],
    })
    fs.writeText(join(workspace, 'tokens.json'), JSON.stringify({ schema: 'dsh-ppt-fusion.tokens.v1', themeId: 'brief' }))
    const code = codeOf(() => deepRender({ dir: workspace, deps: depsWith(fs) }))
    expect(code).toBe('ContractViolation')
  })
})
