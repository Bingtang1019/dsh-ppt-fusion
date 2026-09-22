import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { OpcPackage } from './opc.ts'

describe('OpcPackage.write determinism', () => {
  it('stamps every zip entry, folders included, with the fixed date', async () => {
    const pkg = new OpcPackage()
    pkg.declareDefault('xml', 'application/xml')
    pkg.setPart('ppt/slides/slide1.xml', '<p:sld/>')
    pkg.ensureContentType('ppt/slides/slide1.xml', 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml')
    pkg.setPart('ppt/presentation.xml', '<p:presentation/>')
    const date = new Date(Date.UTC(1980, 0, 1, 0, 0, 0))
    const zip = await JSZip.loadAsync(await pkg.write())
    const dates = Object.values(zip.files).map((entry) => entry.date.getTime())
    expect(new Set(dates)).toEqual(new Set([date.getTime()]))
    expect(Object.values(zip.files).some((entry) => entry.dir)).toBe(true)
  })

  it('writes identical bytes for identical parts even across a wall-clock boundary', async () => {
    const pkg = new OpcPackage()
    pkg.declareDefault('xml', 'application/xml')
    pkg.setPart('ppt/slides/slide1.xml', '<p:sld/>')
    pkg.ensureContentType('ppt/slides/slide1.xml', 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml')
    const before = await pkg.write()
    await new Promise((resolve) => setTimeout(resolve, 2100))
    const after = await pkg.write()
    expect(after.equals(before)).toBe(true)
  })
})
