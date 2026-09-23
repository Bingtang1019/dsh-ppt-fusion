import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { OpcPackage } from './opc.ts'
import { applyProfileFonts, slideTypefaces } from './fonts.ts'
import { parseDesignProfile } from '../schema/design-profile.ts'

const fixture = parseDesignProfile(JSON.parse(readFileSync(join(process.cwd(), 'fixtures', 'reference', 'profile.json'), 'utf8')) as unknown)
/** Distinct families so the heading/body/number choice is observable in the XML. */
const profile = { ...fixture, fonts: { heading: 'HeadingFam', body: 'BodyFam', number: 'NumberFam' } }

const SLIDE = `<p:sld><p:cSld><p:spTree>
<p:sp><p:txBody><a:bodyPr/><a:p><a:pPr><a:defRPr sz="4400"><a:latin typeface="Georgia"/><a:ea typeface="Microsoft YaHei"/></a:defRPr></a:pPr><a:r><a:rPr sz="4400" b="1"><a:latin typeface="Georgia"/><a:ea typeface="Microsoft YaHei"/></a:rPr><a:t>Title</a:t></a:r></a:p></p:txBody></p:sp>
<p:sp><p:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="1400"><a:latin typeface="Georgia"/><a:ea typeface="Microsoft YaHei"/></a:rPr><a:t>Body text</a:t></a:r></a:p></p:txBody></p:sp>
<p:sp><p:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="4000"><a:latin typeface="Georgia"/><a:ea typeface="Microsoft YaHei"/></a:rPr><a:t>42</a:t></a:r></a:p></p:txBody></p:sp>
</p:spTree></p:cSld></p:sld>`

/** A package with one slide, enough structure for the font pass. */
function miniPackage(): OpcPackage {
  const pkg = new OpcPackage()
  pkg.declareDefault('rels', 'application/vnd.openxmlformats-package.relationships+xml')
  pkg.declareDefault('xml', 'application/xml')
  pkg.setPart('ppt/slides/slide1.xml', SLIDE)
  pkg.setRelationships('ppt/slides/slide1.xml', [
    { id: 'rId1', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout', target: '../slideLayouts/slideLayout1.xml' },
  ])
  pkg.setPart('ppt/presentation.xml', '<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>')
  pkg.setRelationships('ppt/presentation.xml', [{ id: 'rId1', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide', target: 'slides/slide1.xml' }])
  for (const name of pkg.names()) pkg.ensureContentType(name, 'application/xml')
  return pkg
}

describe('applyProfileFonts', () => {
  it('maps titles, body runs and large numerals to the profile families', () => {
    const pkg = miniPackage()
    const report = applyProfileFonts(pkg, profile)
    const xml = pkg.text('ppt/slides/slide1.xml')
    // Title run and the paragraph default (both 44 pt) take the heading family.
    expect(xml.match(/(<a:latin typeface=")HeadingFam(")/g)).toHaveLength(2)
    expect(xml.match(/(<a:ea typeface=")HeadingFam(")/g)).toHaveLength(2)
    // Body run takes the body family.
    expect(xml).toContain('<a:latin typeface="BodyFam"/>')
    // The numeral run takes the number family.
    expect(xml).toContain('<a:latin typeface="NumberFam"/>')
    expect(report.numberRuns).toBe(1)
    expect(report.runs).toBe(4)
    expect(report.latin).toBe(4)
    expect(report.ea).toBe(4)
    expect(xml).not.toContain('Georgia')
    expect(slideTypefaces(pkg)).toEqual(['BodyFam', 'HeadingFam', 'NumberFam'])
  })

  it('is idempotent', () => {
    const pkg = miniPackage()
    applyProfileFonts(pkg, profile)
    const once = pkg.text('ppt/slides/slide1.xml')
    applyProfileFonts(pkg, profile)
    expect(pkg.text('ppt/slides/slide1.xml')).toBe(once)
  })

  it('leaves a package with no paragraphs untouched', () => {
    const pkg = miniPackage()
    pkg.setPart('ppt/slides/slide1.xml', '<p:sld><p:cSld/></p:sld>')
    expect(applyProfileFonts(pkg, profile).runs).toBe(0)
    expect(slideTypefaces(pkg)).toEqual([])
  })
})
