import { describe, expect, it } from 'vitest'
import { checkPageCoverage, describeIssues, parseFusionDeck, FusionDeckSchema } from './fusion.ts'
import { DshPptFailure } from '../engine/errors.ts'

const valid = {
  version: 1,
  name: 'hello',
  pptwiseIr: 'deck.ir.json',
  theme: { preset: 'brief' },
  pages: [{ index: 1, route: 'pptwise' }],
}

const failureOf = (raw: unknown): DshPptFailure => {
  try {
    parseFusionDeck(raw)
  } catch (error) {
    if (error instanceof DshPptFailure) return error
    throw error
  }
  throw new Error('expected a failure')
}

describe('parseFusionDeck', () => {
  it('accepts a minimal manifest and a deep page', () => {
    expect(parseFusionDeck(valid).name).toBe('hello')
    const withDeep = parseFusionDeck({
      ...valid,
      pages: [
        { index: 1, route: 'pptwise' },
        { index: 2, route: 'ppt-master', deep: { dir: 'deep/p02', kind: 'native-chart', format: 'ppt169' } },
      ],
    })
    expect(withDeep.pages[1]).toMatchObject({ route: 'ppt-master' })
  })

  it('names the field path for an unknown key so a typo cannot pass silently', () => {
    const failure = failureOf({ ...valid, pptwiseIR: 'deck.ir.json' })
    expect(failure.code).toBe('ContractViolation')
    expect(failure.message).toContain('pptwiseIR')
    expect(failure.message).toContain('unknown field')
  })

  it('rejects an unknown deep kind with its index in the path', () => {
    const failure = failureOf({
      ...valid,
      pages: [{ index: 1, route: 'ppt-master', deep: { dir: 'deep/p01', kind: 'chart', format: 'ppt169' } }],
    })
    expect(failure.message).toContain('pages.0.deep.kind')
  })

  it('requires a deep declaration on a ppt-master page', () => {
    const failure = failureOf({ ...valid, pages: [{ index: 1, route: 'ppt-master' }] })
    expect(failure.message).toContain('pages.0.deep')
  })

  it('rejects two theme bindings at once', () => {
    const failure = failureOf({ ...valid, theme: { preset: 'brief', file: 'theme.json' } })
    expect(failure.message).toContain('theme')
  })

  it('rejects a non-slug deck name', () => {
    expect(FusionDeckSchema.safeParse({ ...valid, name: 'two words' }).success).toBe(false)
  })
})

describe('describeIssues', () => {
  it('renders the root path for document-level issues', () => {
    expect(describeIssues([{ code: 'unrecognized_keys', path: [], message: 'x', keys: ['extra'] }])).toEqual([
      '(root): unknown field "extra"',
    ])
  })
})

describe('checkPageCoverage', () => {
  it('accepts a contiguous full cover', () => {
    const deck = parseFusionDeck({ ...valid, pages: [{ index: 1, route: 'pptwise' }, { index: 2, route: 'pptwise' }] })
    expect(checkPageCoverage(deck, 2)).toEqual([])
  })

  it('reports a gap against the IR slide count', () => {
    const deck = parseFusionDeck({ ...valid, pages: [{ index: 1, route: 'pptwise' }, { index: 3, route: 'pptwise' }] })
    const problems = checkPageCoverage(deck, 3)
    expect(problems.join(' ')).toContain('missing index 2')
    expect(problems.join(' ')).toContain('contiguous')
  })

  it('reports an index beyond the IR', () => {
    const deck = parseFusionDeck({ ...valid, pages: [{ index: 1, route: 'pptwise' }, { index: 2, route: 'pptwise' }] })
    expect(checkPageCoverage(deck, 1).join(' ')).toContain('only 1 slides')
  })
})
