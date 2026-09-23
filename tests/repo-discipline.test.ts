import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Deck discipline (V7.2): the project's own golden fixtures are tracked, but no user
 * deck, its media or a local design profile may enter the repository or the published
 * package. This test is the git-side half of that rule; the tarball half lives in
 * `scripts/check-pack.mjs`, and `.gitignore` blocks reference material from being
 * staged in the first place.
 */

/** Deck and media formats that may not be tracked outside `fixtures/golden/`. */
const DECK_FILE = /\.(pptx|ppt|potx|ppsx|thmx|pdf|mp4|mov|webm|m4a|wav)$/i

describe('repository deck discipline', () => {
  it('tracks no deck outside fixtures/golden and no reference-deck material', () => {
    const tracked = execFileSync('git', ['ls-files'], { cwd: process.cwd(), encoding: 'utf8' })
      .split('\n')
      .filter((path) => path !== '')
    expect(tracked.filter((path) => DECK_FILE.test(path) && !path.startsWith('fixtures/golden/'))).toEqual([])
    expect(tracked.filter((path) => path.startsWith('fixtures/reference/') && path !== 'fixtures/reference/profile.json')).toEqual([])
  })

  it('keeps deck workspaces out of the published file map', () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { files?: string[] }
    const files = manifest.files ?? []
    expect(files.filter((entry) => entry === 'fixtures' || entry.startsWith('fixtures/'))).toEqual([])
    expect(files.filter((entry) => /tmp|reference/i.test(entry))).toEqual([])
  })
})
