import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { quoteForCmd, readSessionMetrics } from './harness.ts'

describe('Windows launcher arguments', () => {
  it('quotes the arguments cmd.exe would otherwise interpret', () => {
    expect(quoteForCmd('--profile')).toBe('--profile')
    expect(quoteForCmd('C:/tmp/eval/x/headless.patch.yml')).toBe('C:/tmp/eval/x/headless.patch.yml')
    expect(quoteForCmd('Use the skill (five pages) now')).toBe('"Use the skill (five pages) now"')
    expect(quoteForCmd('a|b')).toBe('"a|b"')
  })

  it('refuses an argument cmd.exe cannot carry', () => {
    expect(() => quoteForCmd('say "hi"')).toThrow(/double quote/)
  })
})

describe('session metrics', () => {
  it('reads a versioned session log one directory deeper', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-eval-home-'))
    try {
      const dir = join(home, 'sessions', '--C-Users-x-work--', 'session-abc123')
      mkdirSync(dir, { recursive: true })
      const events = [
        { type: 'turn/start', time: 100 },
        { type: 'tool/call', data: { name: 'skill', arguments: '{"name":"dsh-ppt-fusion"}', callId: 'c1' } },
        { type: 'tool/result', data: { message: { source: { callId: 'c1' }, content: [{ content: [{ isError: false, text: 'loaded' }] }] } } },
        { type: 'tool/call', data: { name: 'bash', arguments: 'dsh-ppt render', callId: 'c2' } },
        {
          type: 'tool/result',
          data: {
            message: {
              source: { callId: 'c2' },
              content: [{ content: [{ isError: true, text: 'dsh-ppt: EngineExit failed' }] }],
            },
          },
        },
        { type: 'turn/end', time: 200 },
      ]
      // One zstd frame per event, exactly what the CLI appends.
      const bytes = Buffer.concat(events.map((event) => zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`, 'utf8'))))
      writeFileSync(join(dir, 'session.v4.jsonl.zstd'), bytes)
      const metrics = readSessionMetrics(home)
      expect(metrics.sessionFile).toContain('session.v4.jsonl.zstd')
      expect(metrics.turns).toBe(1)
      expect(metrics.toolCalls).toBe(2)
      expect(metrics.skillLoads).toBe(1)
      expect(metrics.gateFailures).toBe(1)
      expect(metrics.toolCallsByName).toMatchObject({ skill: 1, bash: 1 })
      expect(metrics.startedAt).toBe(100)
      expect(metrics.endedAt).toBe(200)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('reports zeroes when the attempt has no session log', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-eval-empty-'))
    try {
      expect(readSessionMetrics(home).sessionFile).toBeNull()
      expect(readSessionMetrics(home).turns).toBe(0)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})