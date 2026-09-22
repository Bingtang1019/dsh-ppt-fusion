import { describe, expect, it } from 'vitest'
import { OpcPackage } from './opc.ts'
import {
  applyPost,
  dedupeShapeIds,
  entranceTimingXml,
  readPostConfig,
  resolveTargets,
  stripMotion,
  transitionXml,
} from './post.ts'
import { PostConfigSchema } from '../schema/post.ts'
import { DshPptFailure } from '../engine/errors.ts'
import { createFakeFileSystem } from '../../tests/support/fake-runner.ts'

const SLIDE = `<p:sld><p:cSld><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/></p:nvGrpSpPr>
<p:sp><p:nvSpPr><p:cNvPr id="5" name="milestone-chart"/></p:nvSpPr></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="6" name="page-heading"/></p:nvSpPr></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="6" name="duplicate-id"/></p:nvSpPr></p:sp>
</p:spTree></p:cSld><p:clrMapOvr><a:overrideClrMapping/></p:clrMapOvr></p:sld>`

/** A package with one slide, enough structure for the post layer. */
function miniPackage(slides: number): OpcPackage {
  const pkg = new OpcPackage()
  pkg.declareDefault('rels', 'application/vnd.openxmlformats-package.relationships+xml')
  pkg.declareDefault('xml', 'application/xml')
  const rows: string[] = []
  const rels = []
  for (let index = 1; index <= slides; index += 1) {
    pkg.setPart(`ppt/slides/slide${String(index)}.xml`, SLIDE)
    pkg.setRelationships(`ppt/slides/slide${String(index)}.xml`, [
      { id: 'rId1', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout', target: '../slideLayouts/slideLayout1.xml' },
    ])
    rels.push({ id: `rId${String(index)}`, type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide', target: `slides/slide${String(index)}.xml` })
    rows.push(`<p:sldId id="${String(255 + index)}" r:id="rId${String(index)}"/>`)
  }
  pkg.setPart('ppt/presentation.xml', `<p:presentation><p:sldIdLst>${rows.join('')}</p:sldIdLst></p:presentation>`)
  pkg.setRelationships('ppt/presentation.xml', rels)
  for (const name of pkg.names()) pkg.ensureContentType(name, 'application/xml')
  return pkg
}

const codeOf = (run: () => unknown): string => {
  try {
    run()
    return 'no-failure'
  } catch (error) {
    return error instanceof DshPptFailure ? error.code : 'not-a-DshPptFailure'
  }
}

describe('transition and timing XML (ported from pptwise)', () => {
  it('writes the duration as p14:dur and the effect as a child element', () => {
    expect(transitionXml('fade')).toBe(
      '<p:transition p14:dur="400" xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main"><p:fade/></p:transition>',
    )
    expect(transitionXml('wipe', 500)).toContain('<p:wipe dir="r"/>')
    expect(transitionXml('push', 250)).toContain('p14:dur="250"')
  })

  it('nests timing exactly mainSeq -> click par -> effect par with the preset ids', () => {
    const timing = entranceTimingXml([{ effect: 'fade', spids: [5, 7] }], 200)
    expect(timing).toContain('nodeType="tmRoot"')
    expect(timing).toContain('nodeType="mainSeq"')
    expect(timing).toContain('presetID="10" presetClass="entr" presetSubtype="0"')
    expect(timing).toContain('nodeType="afterEffect"')
    expect(timing).toContain('nodeType="withEffect"')
    expect(timing).toContain('<p:animEffect transition="in" filter="fade">')
    expect(timing).toContain('<p:spTgt spid="5"/>')
    expect(timing).toContain('<p:spTgt spid="7"/>')
    expect(timing).toContain('<p:bldP spid="5" grpId="0"/><p:bldP spid="7" grpId="0"/>')
    // One p:par path: tmRoot, the mainSeq click par, the entry wrapper and the
    // effect leaf. PowerPoint drops the animation when a fourth layer sneaks in.
    const single = entranceTimingXml([{ effect: 'fade', spids: [5] }], 200)
    expect((single.match(/<p:par>/g) ?? []).length).toBe(4)
    expect((timing.match(/<p:par>/g) ?? []).length).toBe(5) // + one withEffect sibling
  })

  it('returns nothing when no entry has a target', () => {
    expect(entranceTimingXml([{ effect: 'fade', spids: [] }])).toBe('')
  })

  it('carries the wipe and fly filters', () => {
    expect(entranceTimingXml([{ effect: 'wipe', spids: [1] }])).toContain('filter="wipe(down)"')
    expect(entranceTimingXml([{ effect: 'fly', spids: [1] }])).toContain('filter="slide(fromLeft)"')
  })
})

describe('shape id hygiene and selectors', () => {
  it('renumbers a duplicate id but leaves the first occurrence alone', () => {
    const deduped = dedupeShapeIds(SLIDE)
    const ids = [...deduped.matchAll(/<p:cNvPr id="(\d+)"/g)].map((match) => match[1])
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.slice(0, 3)).toEqual(['1', '5', '6'])
    expect(deduped).toContain('name="duplicate-id"')
  })

  it('resolves a name selector and an explicit id list', () => {
    expect(resolveTargets(SLIDE, { match: 'milestone' })).toEqual([5])
    expect(resolveTargets(SLIDE, { match: 'heading' })).toEqual([6])
    expect(resolveTargets(SLIDE, { spids: [9] })).toEqual([9])
    expect(resolveTargets(SLIDE, { match: 'nothing-here' })).toEqual([])
  })

  it('strips a previously written transition and timing', () => {
    const withMotion = SLIDE.replace('</p:sld>', `${transitionXml('fade')}${entranceTimingXml([{ effect: 'fade', spids: [5] }])}</p:sld>`)
    expect(stripMotion(withMotion)).not.toContain('<p:transition')
    expect(stripMotion(withMotion)).not.toContain('<p:timing')
  })
})

describe('applyPost', () => {
  const config = PostConfigSchema.parse({
    slides: [{ index: 1, transition: 'fade', entrance: { effect: 'fade', target: { match: 'milestone' } } }],
  })

  it('applies a transition and an entrance to the named shape', () => {
    const pkg = miniPackage(1)
    const report = applyPost(pkg, config)
    const xml = pkg.text('ppt/slides/slide1.xml')
    expect(report.slides[0]?.animatedSpids).toEqual([5])
    expect(report.unmatched).toEqual([])
    expect(xml).toContain('<p:transition')
    expect(xml).toContain('<p:animEffect transition="in" filter="fade">')
  })

  it('is idempotent: re-applying produces identical bytes', async () => {
    const first = miniPackage(1)
    const second = miniPackage(1)
    applyPost(first, config)
    applyPost(second, config)
    expect((await first.write()).equals(await second.write())).toBe(true)
  })

  it('leaves a slide with no entry untouched but still strips engine motion', () => {
    const pkg = miniPackage(2)
    pkg.setPart('ppt/slides/slide2.xml', SLIDE.replace('</p:sld>', `${transitionXml('fade')}</p:sld>`))
    applyPost(pkg, config)
    expect(pkg.text('ppt/slides/slide2.xml')).not.toContain('<p:transition')
  })

  it('reports a selector that matches nothing without throwing', () => {
    const pkg = miniPackage(1)
    const report = applyPost(
      pkg,
      PostConfigSchema.parse({ slides: [{ index: 1, entrance: { effect: 'fade', target: { match: 'ghost' } } }] }),
    )
    expect(report.unmatched).toEqual([1])
  })

  it('refuses a slide index the deck does not have, and a doubled index', () => {
    const pkg = miniPackage(1)
    expect(codeOf(() => applyPost(pkg, PostConfigSchema.parse({ slides: [{ index: 4, transition: 'fade' }] })))).toBe('ContractViolation')
    expect(
      codeOf(() => applyPost(miniPackage(1), PostConfigSchema.parse({ slides: [{ index: 1, transition: 'fade' }, { index: 1, transition: 'wipe' }] }))),
    ).toBe('ContractViolation')
  })

  it('treats transition "none" as a strip-only instruction', () => {
    const pkg = miniPackage(1)
    pkg.setPart('ppt/slides/slide1.xml', SLIDE.replace('</p:sld>', `${transitionXml('fade')}</p:sld>`))
    applyPost(pkg, PostConfigSchema.parse({ slides: [{ index: 1, transition: 'none' }] }))
    expect(pkg.text('ppt/slides/slide1.xml')).not.toContain('<p:transition')
  })
})

describe('readPostConfig', () => {
  it('reads a valid configuration', () => {
    const fs = createFakeFileSystem({ files: { 'C:/deck/post/animations.json': JSON.stringify({ slides: [{ index: 1, transition: 'fade' }] }) } })
    expect(readPostConfig(fs, 'C:/deck/post/animations.json').slides).toHaveLength(1)
  })

  it('names the offending field for an invalid configuration', () => {
    const fs = createFakeFileSystem({ files: { 'C:/deck/post/animations.json': JSON.stringify({ slides: [{ index: 1, transition: 'zoom' }] }) } })
    expect(codeOf(() => readPostConfig(fs, 'C:/deck/post/animations.json'))).toBe('ContractViolation')
    try {
      readPostConfig(fs, 'C:/deck/post/animations.json')
    } catch (error) {
      expect((error as DshPptFailure).message).toContain('slides.0.transition')
    }
  })

  it('reports a missing file', () => {
    const fs = createFakeFileSystem({})
    expect(codeOf(() => readPostConfig(fs, 'C:/deck/post/animations.json'))).toBe('OutputMissing')
  })
})
