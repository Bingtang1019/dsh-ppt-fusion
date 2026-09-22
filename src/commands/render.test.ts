import { describe, expect, it } from 'vitest'
import { resolveCompatLevel } from './render.ts'

describe('resolveCompatLevel', () => {
  it('prefers the flag, then the manifest field, then standard', () => {
    expect(resolveCompatLevel('safe', 'max')).toEqual({ level: 'safe', source: 'flag' })
    expect(resolveCompatLevel(undefined, 'max')).toEqual({ level: 'max', source: 'manifest' })
    expect(resolveCompatLevel(undefined, undefined)).toEqual({ level: 'standard', source: 'default' })
  })
})
