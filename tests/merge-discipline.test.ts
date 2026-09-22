import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import JSZip from 'jszip'
import { OpcPackage, auditPackage, listSlides } from '../src/bridge/opc.ts'
import { findAlternateContents } from '../src/bridge/compat.ts'

/**
 * Discipline checks over the recorded merged golden package (plan §5 M4.10): the
 * bytes a real merge published must be a plain, unencrypted OPC zip, must hold every
 * MCE pair intact, and must not carry duplicate `p14:creationId` values per slide.
 */
const GOLDEN = 'fixtures/golden/hello-merged.pptx'

describe('merged golden package discipline', () => {
  it('is a plain zip: unique entries, no directory entries, no encryption, one content-types part', async () => {
    const zip = await JSZip.loadAsync(readFileSync(GOLDEN))
    const entries = Object.values(zip.files)
    const names = entries.map((entry) => entry.name)
    // No duplicate entry names, and nothing hidden behind a stream cipher.
    expect(new Set(names).size).toBe(names.length)
    expect(entries.filter((entry) => (entry.options as { encrypted?: boolean }).encrypted === true)).toEqual([])
    // Directory entries are legal in OPC; every file entry must be exactly one part.
    const files = entries.filter((entry) => entry.dir !== true).map((entry) => entry.name)
    expect(entries.filter((entry) => entry.dir === true).every((entry) => entry.name.endsWith('/'))).toBe(true)
    const pkg = await OpcPackage.read(readFileSync(GOLDEN))
    expect([...files].sort()).toEqual([...pkg.names()].sort())
    expect(files.filter((name) => name === '[Content_Types].xml')).toHaveLength(1)
    expect(files.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))).toHaveLength(5)
    expect(files.some((name) => name.endsWith('.rels'))).toBe(true)
  })

  it('holds every MCE pair intact and no duplicate creationId inside one slide', async () => {
    const pkg = await OpcPackage.read(readFileSync(GOLDEN))
    for (const slide of listSlides(pkg)) {
      const xml = pkg.text(slide)
      for (const block of findAlternateContents(xml)) {
        expect(block.fallback, `${slide} has a broken mc:AlternateContent block`).not.toBeNull()
        expect(block.choices.length, `${slide} lost its mc:Choice`).toBeGreaterThan(0)
      }
      const ids = [...xml.matchAll(/p14:creationId="(\d+)"/g)].map((match) => match[1] ?? '')
      expect(new Set(ids).size, `${slide} repeats a p14:creationId`).toBe(ids.length)
    }
  })

  it('passes the package audit with the single-master invariant', async () => {
    const pkg = await OpcPackage.read(readFileSync(GOLDEN))
    expect(auditPackage(pkg, { requireSingleMaster: true })).toEqual([])
  })
})
