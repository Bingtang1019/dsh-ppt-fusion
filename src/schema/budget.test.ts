import { describe, expect, it } from 'vitest'
import { checkBudgets, countWords, formatBudgetViolation, measureDeepSvg, measureIrSlide } from './budget.ts'
import { DEFAULT_BUDGETS, effectiveBudget, type Storyboard } from './storyboard.ts'

describe('countWords', () => {
  it('counts whitespace-separated words, punctuation and all', () => {
    expect(countWords('Two engines, one deck')).toBe(4)
    expect(countWords('dsh-ppt-fusion')).toBe(1)
    expect(countWords('')).toBe(0)
  })

  it('counts CJK characters individually and the rest of a token as one word', () => {
    expect(countWords('深度引擎')).toBe(4)
    expect(countWords('引擎 engine')).toBe(3)
    expect(countWords('Q3 数据')).toBe(3)
  })
})

describe('measureIrSlide', () => {
  it('measures prose, items and native components without counting payload labels', () => {
    const slide = {
      type: 'content',
      kind: 'points',
      heading: 'Two engines, one deck',
      subheading: 'fusion',
      components: [
        { type: 'bullets', style: 'checklist', items: ['alpha beta', 'gamma'] },
        { type: 'chart', title: 'Growth', categories: ['Q1'], series: [{ name: 'Series A', values: [1] }] },
        { type: 'image', src: 'a.png' },
      ],
    }
    expect(measureIrSlide(slide)).toEqual({ words: 9, items: 2, charts: 1, tables: 0, images: 1 })
  })

  it('is empty for a placeholder slide and tolerates unknown shapes', () => {
    expect(measureIrSlide({ type: 'content', placeholder: true })).toEqual({ words: 0, items: 0, charts: 0, tables: 0, images: 0 })
    expect(measureIrSlide(null)).toEqual({ words: 0, items: 0, charts: 0, tables: 0, images: 0 })
    expect(measureIrSlide({ rows: [[{ text: 'cell one' }]], type: 'table' })).toEqual({ words: 2, items: 0, charts: 0, tables: 1, images: 0 })
  })
})

describe('measureDeepSvg', () => {
  it('counts text nodes and native markers, ignoring metadata payloads', () => {
    const svg = [
      '<svg>',
      '<metadata type="application/json">{"name":"chart","type":"column"}</metadata>',
      '<text x="1">Pages delivered</text>',
      '<text x="2">M0</text>',
      '<g data-pptx-replace-with="chart"></g>',
      '<g data-pptx-replace-with="table"></g>',
      '<image href="a.png"/>',
      '</svg>',
    ].join('')
    expect(measureDeepSvg(svg)).toEqual({ words: 3, items: 0, charts: 1, tables: 1, images: 1 })
  })
})

describe('checkBudgets', () => {
  const storyboard: Storyboard = {
    version: 1,
    pages: [
      { index: 1, role: 'cover', layout: 'brief:gauge-verdict', route: 'pptwise', budget: { maxWords: 5 } },
      { index: 2, role: 'content', layout: 'brief:narrow-column', route: 'pptwise' },
    ],
  }

  it('uses the declared budget and falls back to the role defaults per field', () => {
    expect(effectiveBudget(storyboard.pages[1]!)).toEqual(DEFAULT_BUDGETS.content)
    expect(effectiveBudget(storyboard.pages[0]!)).toEqual({ ...DEFAULT_BUDGETS.cover, maxWords: 5 })
  })

  it('reports one violation per exceeded dimension with page, role, measurement and limit', () => {
    const measurements = new Map([
      [1, { words: 6, items: 0, charts: 0, tables: 0, images: 0 }],
      [2, { words: 200, items: 9, charts: 2, tables: 0, images: 0 }],
    ])
    const violations = checkBudgets(storyboard, measurements)
    expect(violations).toEqual([
      { page: 1, role: 'cover', dimension: 'maxWords', measured: 6, limit: 5 },
      { page: 2, role: 'content', dimension: 'maxWords', measured: 200, limit: 90 },
      { page: 2, role: 'content', dimension: 'maxItems', measured: 9, limit: 6 },
      { page: 2, role: 'content', dimension: 'maxCharts', measured: 2, limit: 1 },
    ])
    expect(formatBudgetViolation(violations[0]!)).toBe('page 1 (cover): words measured 6, maxWords limit 5')
  })

  it('skips pages without a measurement and stays empty under budget', () => {
    expect(checkBudgets(storyboard, new Map())).toEqual([])
    expect(checkBudgets(storyboard, new Map([[1, { words: 5, items: 0, charts: 0, tables: 0, images: 0 }]]))).toEqual([])
  })
})
