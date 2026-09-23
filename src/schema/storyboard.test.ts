import { describe, expect, it } from 'vitest'
import {
  checkStoryboardAgainstManifest,
  checkStoryboardCoverage,
  checkStoryboardLayouts,
  defaultLayoutFor,
  layoutMenuPaths,
  parseStoryboard,
  storyboardRoleFor,
  storyboardSkeleton,
  STORYBOARD_FILE,
} from './storyboard.ts'
import { defaultChrome, parseFusionDeck } from './fusion.ts'
import { DshPptFailure } from '../engine/errors.ts'
import type { IrView } from '../deck.ts'

const deck = parseFusionDeck({
  version: 1,
  name: 'hello',
  pptwiseIr: 'deck.ir.json',
  theme: { preset: 'brief' },
  pages: [
    { index: 1, route: 'pptwise' },
    { index: 2, route: 'ppt-master', deep: { dir: 'deep/p02', kind: 'native-chart', format: 'ppt169' } },
    { index: 3, route: 'pptwise' },
  ],
  chrome: defaultChrome(),
})

const ir: IrView = { slides: [{ type: 'cover' }, { type: 'content', placeholder: true }, { type: 'ending' }] }

const failureOf = (raw: unknown): DshPptFailure => {
  try {
    parseStoryboard(raw)
  } catch (error) {
    if (error instanceof DshPptFailure) return error
    throw error
  }
  throw new Error('expected a failure')
}

describe('parseStoryboard', () => {
  it('accepts a page with every field and rejects unknown keys with their path', () => {
    const page = {
      index: 1,
      role: 'cover',
      layout: 'brief:gauge-verdict',
      route: 'pptwise',
      chrome: { pageNumber: 'skip' },
      budget: { maxWords: 20, maxCharts: 0 },
      source: 'brief.md',
    }
    expect(parseStoryboard({ version: 1, pages: [page] }).pages[0]).toMatchObject({ role: 'cover' })
    expect(failureOf({ version: 1, pages: [{ ...page, layouts: 'x' }] }).message).toContain('pages.0')
    expect(failureOf({ version: 1, pages: [{ ...page, role: 'title' }] }).message).toContain('pages.0.role')
    expect(failureOf({ version: 1, pages: [{ ...page, budget: { maxWords: 0 } }] }).message).toContain('pages.0.budget.maxWords')
    expect(parseStoryboard({ version: 1, pages: [page] }).version).toBe(1)
  })

  it('names the file in its failure message', () => {
    expect(failureOf({ version: 1, pages: [] }).message).toContain(STORYBOARD_FILE)
  })
})

describe('storyboardSkeleton', () => {
  it('derives roles, routes and page-number participation from the manifest and IR', () => {
    const skeleton = storyboardSkeleton(deck, ir)
    expect(skeleton.pages.map((page) => page.role)).toEqual(['cover', 'content', 'ending'])
    expect(skeleton.pages.map((page) => page.route)).toEqual(['pptwise', 'ppt-master', 'pptwise'])
    expect(skeleton.pages.map((page) => page.chrome?.pageNumber)).toEqual(['skip', 'show', 'skip'])
    expect(skeleton.pages.every((page) => page.layout === 'unconfirmed')).toBe(true)
  })

  it('fills each page from the bound theme menu when one is readable', () => {
    const menu = {
      cover: { face: 'gauge-verdict' },
      chapter: { face: 'gauge-section' },
      content: { points: { face: 'narrow-column' }, data: { face: 'gauge-stats' } },
      ending: { face: 'gauge-next' },
    }
    const withData = { slides: [{ type: 'cover' }, { type: 'content', kind: 'data' }, { type: 'ending' }] }
    const skeleton = storyboardSkeleton(deck, withData, { id: 'brief', menu })
    expect(skeleton.pages.map((page) => page.role)).toEqual(['cover', 'data', 'ending'])
    expect(skeleton.pages.map((page) => page.layout)).toEqual(['brief:gauge-verdict', 'brief:gauge-stats', 'brief:gauge-next'])
  })

  it('falls back to content for deep pages without an IR type', () => {
    const skeleton = storyboardSkeleton(deck, { slides: [] })
    expect(skeleton.pages.map((page) => page.role)).toEqual(['content', 'content', 'content'])
  })
})

describe('storyboardRoleFor', () => {
  it('splits content slides by their kind and keeps the structural roles', () => {
    expect(storyboardRoleFor({ type: 'cover' })).toBe('cover')
    expect(storyboardRoleFor({ type: 'section' })).toBe('section')
    expect(storyboardRoleFor({ type: 'ending' })).toBe('ending')
    expect(storyboardRoleFor({ type: 'quote' })).toBe('quote')
    expect(storyboardRoleFor({ type: 'content', kind: 'points' })).toBe('content')
    expect(storyboardRoleFor({ type: 'content', kind: 'data' })).toBe('data')
    expect(storyboardRoleFor({ type: 'content', kind: 'Evidence' })).toBe('data')
    expect(storyboardRoleFor({ type: 'content', kind: 'statement' })).toBe('quote')
    expect(storyboardRoleFor(undefined)).toBe('content')
  })
})

describe('layout menu', () => {
  const menu = {
    cover: { face: 'gauge-verdict' },
    chapter: { face: 'gauge-section' },
    content: { points: { face: 'narrow-column' }, data: { face: 'gauge-stats' }, statement: { face: 'quote-stage' } },
    ending: { face: 'gauge-next' },
  }

  it('reads every face with the slots that advertise it', () => {
    const paths = layoutMenuPaths(menu)
    expect(paths.get('gauge-verdict')).toEqual(['cover'])
    expect(paths.get('narrow-column')).toEqual(['content.points'])
    expect(paths.get('gauge-stats')).toEqual(['content.data'])
    expect(paths.get('missing')).toBeUndefined()
    expect(layoutMenuPaths(undefined).size).toBe(0)
  })

  it('picks the first menu face each role may use', () => {
    expect(defaultLayoutFor('cover', 'brief', menu)).toBe('brief:gauge-verdict')
    expect(defaultLayoutFor('data', 'brief', menu)).toBe('brief:gauge-stats')
    expect(defaultLayoutFor('section', 'brief', menu)).toBe('brief:gauge-section')
    expect(defaultLayoutFor('content', 'brief', menu)).toBe('brief:narrow-column')
    expect(defaultLayoutFor('ending', 'brief', menu)).toBe('brief:gauge-next')
    expect(defaultLayoutFor('quote', 'brief', {})).toBeNull()
  })
})

describe('checkStoryboardLayouts', () => {
  const menu = {
    cover: { face: 'gauge-verdict' },
    chapter: { face: 'gauge-section' },
    content: { points: { face: 'narrow-column' }, data: { face: 'gauge-stats' } },
    ending: { face: 'gauge-next' },
  }
  const storyboard = {
    version: 1 as const,
    pages: [
      { index: 1, role: 'cover' as const, layout: 'brief:gauge-verdict', route: 'pptwise' as const },
      { index: 2, role: 'data' as const, layout: 'brief:gauge-stats', route: 'pptwise' as const },
    ],
  }

  it('accepts faces that the bound theme files under a slot the role may use', () => {
    expect(checkStoryboardLayouts(storyboard, { id: 'brief', menu })).toEqual([])
    // A bare face is pinned to the bound theme; `data` may use any data-family slot.
    expect(checkStoryboardLayouts({ version: 1, pages: [{ ...storyboard.pages[1]!, layout: 'gauge-stats' }] }, { id: 'brief', menu })).toEqual([])
  })

  it('reports an unknown face, a foreign theme pin and a role mismatch', () => {
    const problems = checkStoryboardLayouts(
      {
        version: 1,
        pages: [
          { index: 1, role: 'cover', layout: 'brief:nope', route: 'pptwise' },
          { index: 2, role: 'content', layout: 'thesis:narrow-column', route: 'pptwise' },
          { index: 3, role: 'content', layout: 'brief:gauge-next', route: 'pptwise' },
        ],
      },
      { id: 'brief', menu },
    )
    expect(problems.join('\n')).toContain('is not in the "brief" menu')
    expect(problems.join('\n')).toContain('pins layout theme "thesis" but the deck binds "brief"')
    expect(problems.join('\n')).toContain('role "content" cannot use layout "brief:gauge-next"')
  })

  it('stays silent when there is no readable theme', () => {
    expect(checkStoryboardLayouts(storyboard, null)).toEqual([])
  })
})

describe('checkStoryboardCoverage', () => {
  it('accepts a full cover and reports gaps, duplicates and extras', () => {
    const full = storyboardSkeleton(deck, ir)
    expect(checkStoryboardCoverage(full, 3)).toEqual([])
    const short = { version: 1 as const, pages: full.pages.slice(0, 1) }
    expect(checkStoryboardCoverage(short, 3).join(' ')).toContain('missing page 2, 3')
    const duplicated = { version: 1 as const, pages: [full.pages[0]!, full.pages[0]!, full.pages[1]!] }
    expect(checkStoryboardCoverage(duplicated, 3).join(' ')).toContain('more than once')
    const extra = { version: 1 as const, pages: [...full.pages, { ...full.pages[0]!, index: 9 }] }
    expect(checkStoryboardCoverage(extra, 3).join(' ')).toContain('the IR has only 3 pages')
  })
})

describe('checkStoryboardAgainstManifest', () => {
  it('accepts the skeleton and reports route, role and chrome disagreements', () => {
    const skeleton = storyboardSkeleton(deck, ir)
    expect(checkStoryboardAgainstManifest(skeleton, deck, ir)).toEqual([])
    const routeDrift = { version: 1 as const, pages: skeleton.pages.map((page) => (page.index === 2 ? { ...page, route: 'pptwise' as const } : page)) }
    expect(checkStoryboardAgainstManifest(routeDrift, deck, ir).join(' ')).toContain('routes pptwise')
    const roleDrift = { version: 1 as const, pages: skeleton.pages.map((page) => (page.index === 1 ? { ...page, role: 'content' as const } : page)) }
    expect(checkStoryboardAgainstManifest(roleDrift, deck, ir).join(' ')).toContain('role content')
    const chromeDrift = { version: 1 as const, pages: skeleton.pages.map((page) => (page.index === 1 ? { ...page, chrome: { pageNumber: 'show' as const } } : page)) }
    expect(checkStoryboardAgainstManifest(chromeDrift, deck, ir).join(' ')).toContain('implies skip')
  })
})
