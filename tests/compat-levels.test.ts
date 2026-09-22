import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { assertCompatLevel, compatSnapshots, readCompatGolden } from './support/golden.ts'
import { COMPAT_LEVELS } from '../src/compat/registry.ts'

/**
 * The three-level compat golden (plan §5 M4.11): the recorded merged deck is run
 * through the pass at `safe`, `standard` and `max`, the stable report fields must equal
 * the recorded snapshots, and no level may keep a marker it forbids.
 */
const GOLDEN = 'fixtures/golden/hello-merged.pptx'
const readGolden = (): Buffer => readFileSync(GOLDEN)

describe('compat goldens', () => {
  it('records one snapshot per level', () => {
    const golden = readCompatGolden()
    expect(golden).not.toBeNull()
    expect(Object.keys(golden?.levels ?? {}).sort()).toEqual([...COMPAT_LEVELS].sort())
    expect(golden?.fixtureVersion).toBeGreaterThan(0)
    expect(golden?.registryVersion).toBe(1)
  })

  it('recomputes the same snapshots from the recorded package', async () => {
    const golden = readCompatGolden()
    const fresh = await compatSnapshots(readGolden())
    for (const level of COMPAT_LEVELS) {
      expect(fresh.levels[level], level).toEqual(golden?.levels[level])
    }
  })

  it('leaves no forbidden marker or lint finding at any level', async () => {
    for (const level of COMPAT_LEVELS) {
      expect(await assertCompatLevel(readGolden(), level), level).toEqual([])
    }
  })
})
