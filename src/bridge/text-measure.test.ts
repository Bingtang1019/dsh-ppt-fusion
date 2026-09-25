import { describe, expect, it } from 'vitest'
import { buildTextMeasureResult, parseMeasureOutput, parseWrapOutput } from './text-measure.ts'

describe('text-measure payloads', () => {
  it('parses a batched measure payload and rejects malformed entries', () => {
    expect(parseMeasureOutput('[{"text": "a", "width": 12.5}, {"text": "b", "width": 7}]')).toEqual([
      { text: 'a', width: 12.5 },
      { text: 'b', width: 7 },
    ])
    expect(() => parseMeasureOutput('nothing')).toThrow(/no JSON array/)
    expect(() => parseMeasureOutput('[]')).toThrow(/measured no text/)
    expect(() => parseMeasureOutput('[{"text": "a"}]')).toThrow(/unusable measurement/)
  })

  it('parses a wrap payload and rejects unusable numbers', () => {
    expect(parseWrapOutput('{"lines": ["a", "b"], "widths": [4, 5], "max_width": 10, "height": 20}')).toEqual({
      lines: ['a', 'b'],
      widths: [4, 5],
      maxWidth: 10,
      height: 20,
    })
    expect(() => parseWrapOutput('{"lines": ["a"]}')).toThrow(/unusable payload/)
    expect(() => parseWrapOutput('boom')).toThrow(/no JSON object/)
  })

  it('computes fits and overflow against the box', () => {
    const measured = buildTextMeasureResult({
      mode: 'measure',
      sizePt: 14,
      box: { width: 100, height: 20 },
      measurements: [
        { text: 'a', width: 100 },
        { text: 'b', width: 120 },
      ],
    })
    expect(measured.fits).toBe(false)
    expect(measured.overflow).toEqual(['x'])

    const wrapped = buildTextMeasureResult({
      mode: 'wrap',
      sizePt: 14,
      box: { width: 300, height: 40 },
      wrap: { lines: ['a', 'b'], widths: [290, 120], maxWidth: 300, height: 40 },
    })
    expect(wrapped.fits).toBe(true)
    expect(wrapped.items[0]?.height).toBe(40)
    expect(wrapped.items[0]?.width).toBe(290)

    const vertical = buildTextMeasureResult({
      mode: 'wrap',
      sizePt: 14,
      box: { width: 300, height: 40 },
      wrap: { lines: ['a', 'b', 'c'], widths: [290, 120, 90], maxWidth: 300, height: 60 },
    })
    expect(vertical.overflow).toEqual(['y'])
  })

  it('reports both axes when the box is too small in both directions', () => {
    const result = buildTextMeasureResult({
      mode: 'wrap',
      sizePt: 14,
      box: { width: 50, height: 10 },
      wrap: { lines: ['unbreakable'], widths: [90], maxWidth: 50, height: 20 },
    })
    expect(result.overflow).toEqual(['x', 'y'])
    expect(result.fits).toBe(false)
  })
})