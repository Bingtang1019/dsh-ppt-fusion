import { describe, expect, it } from 'vitest'
import { packList } from '../scripts/pack-list.mjs'

const payload = [{ id: 'pkg@1.0.0', files: [{ path: 'dist/cli.js' }, { path: 'dsh/index.js' }] }]

describe('pack list parsing', () => {
  it('parses the clean payload npm 11 prints', () => {
    expect(packList(JSON.stringify(payload))?.[0]?.files?.length).toBe(2)
  })

  it('parses the payload npm 10 prints after the prepare script log', () => {
    const stdout = `\n> pkg@1.0.0 build\n> tsup\n\nBuild success\n${JSON.stringify(payload, null, 2)}\n.\n`
    expect(packList(stdout)?.[0]?.files?.map((entry) => entry.path)).toEqual(['dist/cli.js', 'dsh/index.js'])
  })

  it('rejects output without a JSON array', () => {
    expect(packList('> pkg@1.0.0 build\n')).toBeUndefined()
    expect(packList('[] trailing')).toEqual([])
    expect(packList('not json at all')).toBeUndefined()
  })

  it('rejects a JSON object, which is not the pack payload', () => {
    expect(packList('{"pkg": {}}')).toBeUndefined()
  })
})
