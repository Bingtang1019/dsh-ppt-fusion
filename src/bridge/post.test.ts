import { describe, expect, it } from 'vitest'
import { OpcPackage } from './opc.ts'
import {
  applyPost,
  dedupeShapeIds,
  ensureShowTimings,
  entranceTimingXml,
  narratedAdvanceMs,
  narrationTimings,
  readPostConfig,
  resolveTargets,
  showTimingsEnabled,
  stripMotion,
  transitionElementOf,
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

describe('emphasis and motion paths (M5 breadth)', () => {
  it('writes the catalog XML for a spin emphasis and a rightward path', () => {
    const pkg = miniPackage(1)
    const config = PostConfigSchema.parse({
      slides: [
        {
          index: 1,
          emphasis: { effect: 'spin', target: { match: 'milestone-chart' }, durationMs: 1200 },
          path: { effect: 'right', target: { match: 'page-heading' }, durationMs: 900 },
        },
      ],
    })
    const report = applyPost(pkg, config)
    const xml = pkg.text('ppt/slides/slide1.xml')
    expect(xml).toContain('presetClass="emph"')
    expect(xml).toContain('presetID="8"')
    expect(xml).toContain('<p:animRot by="21600000">')
    expect(xml).toContain('dur="1200"')
    expect(xml).toContain('presetClass="path"')
    expect(xml).toContain('presetID="63"')
    expect(xml).toContain('path="M 0 0 L 0.25 0 E"')
    expect(xml).toContain('dur="900"')
    // Two shapes are targeted, so the build list names both exactly once.
    expect(xml.match(/<p:bldP spid=/g)).toHaveLength(2)
    expect(report.slides[0]).toMatchObject({ emphasis: 'spin', path: 'right' })
    expect([...(report.slides[0]?.animatedSpids ?? [])].sort()).toEqual([5, 6])
    expect(report.unmatched).toEqual([])
  })

  it('stays idempotent when all three block kinds share one target', () => {
    const pkg = miniPackage(1)
    const config = PostConfigSchema.parse({
      slides: [
        {
          index: 1,
          entrance: { effect: 'fade', target: { spids: [5] } },
          emphasis: { effect: 'grow-shrink', target: { spids: [5] }, delayMs: 100 },
          path: { effect: 'down', target: { spids: [5] } },
        },
      ],
    })
    const first = applyPost(pkg, config)
    expect(first.unmatched).toEqual([])
    expect(pkg.text('ppt/slides/slide1.xml')).toContain('presetID="6"')
    expect(pkg.text('ppt/slides/slide1.xml')).toContain('path="M 0 0 L 0 0.25 E"')
    const once = pkg.text('ppt/slides/slide1.xml')
    applyPost(pkg, config)
    expect(pkg.text('ppt/slides/slide1.xml')).toBe(once)
    // The entrance and the two effects target shape 5, so the build list has one entry.
    expect(once.match(/<p:bldP spid=/g)).toHaveLength(1)
  })

  it('reports a selector that matches nothing without dropping the blocks that did', () => {
    const pkg = miniPackage(1)
    const config = PostConfigSchema.parse({
      slides: [
        {
          index: 1,
          emphasis: { effect: 'spin', target: { match: 'no-such-shape' } },
          path: { effect: 'down', target: { spids: [5] } },
        },
      ],
    })
    const report = applyPost(pkg, config)
    expect(report.unmatched).toEqual([1])
    const xml = pkg.text('ppt/slides/slide1.xml')
    expect(xml).toContain('presetClass="path"')
    expect(xml).not.toContain('presetClass="emph"')
    expect(report.slides[0]).toMatchObject({ emphasis: 'spin', path: 'down', animatedSpids: [5] })
  })
})

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

describe('narration auto-advance (V6 Q5)', () => {
  /** @returns one MPEG-2 Layer III frame of 48 kbps / 24 kHz (144 bytes, 24 ms). */
  function frame(): Buffer {
    const bytes = Buffer.alloc(144)
    bytes[0] = 0xff
    bytes[1] = 0xf3
    bytes[2] = 0x64
    bytes[3] = 0xc4
    return bytes
  }

  /** A package whose slide 1 carries recorded narration; extra slides stay plain. */
  function narratedPackage(frames = 650, slideCount = 1): OpcPackage {
    const pkg = miniPackage(slideCount)
    const slide = 'ppt/slides/slide1.xml'
    pkg.setPart(
      slide,
      SLIDE.replace(
        '</p:sld>',
        '<p:pic><p:nvPicPr><p:nvPr><a:audioFile r:link="rId9"/></p:nvPr></p:nvPicPr></p:pic><p:transition p14:dur="400" advClick="0" advTm="99999"><p:fade/></p:transition></p:sld>',
      ),
    )
    pkg.setRelationships(slide, [
      ...pkg.relationshipsOf(slide),
      { id: 'rId9', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/audio', target: '../media/narration1.mp3' },
    ])
    pkg.setPart('ppt/media/narration1.mp3', Buffer.concat(Array.from({ length: frames }, () => frame())))
    pkg.setPart('ppt/presProps.xml', '<p:presentationPr xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>')
    return pkg
  }

  it('recomputes the advance from the embedded bytes instead of the ffprobe number', () => {
    const pkg = narratedPackage()
    const slide = 'ppt/slides/slide1.xml'
    expect(narratedAdvanceMs(pkg, slide, pkg.text(slide))).toBe(16_500)
    applyPost(pkg, PostConfigSchema.parse({ slides: [{ index: 1, transition: 'wipe', durationMs: 500 }] }))
    const xml = pkg.text(slide)
    expect(xml).toContain('p14:dur="500"')
    expect(xml).toContain('advClick="0"')
    expect(xml).toContain('advTm="16500"')
    expect(xml).not.toContain('99999')
  })

  it('keeps the engine transition and its effect when the config omits the slide', () => {
    const pkg = narratedPackage(650, 2)
    applyPost(pkg, PostConfigSchema.parse({ slides: [{ index: 2, transition: 'fade' }] }))
    const xml = pkg.text('ppt/slides/slide1.xml')
    expect(xml).toContain('advClick="0" advTm="16500"')
    expect(xml).toContain('<p:fade/>')
  })

  it('falls back to the recorded advance when the audio cannot be measured', () => {
    const pkg = narratedPackage(650, 2)
    pkg.setPart('ppt/media/narration1.mp3', Buffer.from('not audio'))
    applyPost(pkg, PostConfigSchema.parse({ slides: [{ index: 2, transition: 'fade' }] }))
    expect(pkg.text('ppt/slides/slide1.xml')).toContain('advTm="99999"')
  })

  it('reports the auto-advance per slide and finds the transition element', () => {
    const pkg = narratedPackage()
    const report = applyPost(pkg, PostConfigSchema.parse({ slides: [{ index: 1, transition: 'fade' }] }))
    expect(report.slides[0]?.autoAdvanceMs).toBe(16_500)
    expect(transitionElementOf('<p:sld><p:transition p14:dur="400"/></p:sld>')).toBe('<p:transition p14:dur="400"/>')
    expect(transitionElementOf('<p:sld/>')).toBeNull()
  })

  it('sets useTimings once when a slide carries a timed advance', () => {
    const pkg = narratedPackage()
    expect(ensureShowTimings(pkg)).toBe(true)
    expect(pkg.text('ppt/presProps.xml')).toContain('<p:showPr useTimings="1"/>')
    expect(ensureShowTimings(pkg)).toBe(false)
  })

  it('reports per-slide narration timing facts for gates', () => {
    const pkg = narratedPackage()
    const timings = narrationTimings(pkg)
    expect(timings[0]).toMatchObject({
      slidePart: 'ppt/slides/slide1.xml',
      mediaPart: 'ppt/media/narration1.mp3',
      durationMs: 15_600,
      advanceMs: 16_500,
      advTmMs: 99_999,
    })
    expect(showTimingsEnabled(pkg)).toBe(false)
    ensureShowTimings(pkg)
    expect(showTimingsEnabled(pkg)).toBe(true)
  })

  it('leaves a deck without timed advance alone', () => {
    const pkg = miniPackage(1)
    pkg.setPart('ppt/presProps.xml', '<p:presentationPr xmlns:p="x"/>')
    expect(ensureShowTimings(pkg)).toBe(false)
    expect(pkg.text('ppt/presProps.xml')).toBe('<p:presentationPr xmlns:p="x"/>')
  })
})
