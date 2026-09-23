import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mp3DurationMs } from './audio.ts'

/**
 * Build `count` synthetic MPEG-2 Layer III frames, 48 kbps at 24 kHz, matching the
 * shape of the recorded narration (each frame is 144 bytes and 24 ms).
 */
function syntheticFrames(count: number): Buffer {
  const frame = Buffer.alloc(144)
  frame[0] = 0xff
  frame[1] = 0xf3
  frame[2] = 0x64
  frame[3] = 0xc4
  return Buffer.concat(Array.from({ length: count }, () => frame))
}

/** @returns an ID3v2.3 header of `size` payload bytes. */
function id3v2(size: number): Buffer {
  return Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f, ...Array.from({ length: size }, () => 0)])
}

describe('mp3DurationMs', () => {
  it('sums frame durations for a constant bitrate stream', () => {
    expect(mp3DurationMs(syntheticFrames(650))).toBe(15_600)
    expect(mp3DurationMs(syntheticFrames(1))).toBe(24)
  })

  it('skips an ID3v2 tag and tolerates leading junk before the first sync word', () => {
    expect(mp3DurationMs(Buffer.concat([id3v2(20), syntheticFrames(650)]))).toBe(15_600)
    expect(mp3DurationMs(Buffer.concat([Buffer.from([0x00, 0x01, 0x02]), syntheticFrames(100)]))).toBe(2_400)
  })

  it('ignores a trailing ID3v1 tag', () => {
    const tag = Buffer.alloc(128)
    tag.write('TAG', 0, 'latin1')
    expect(mp3DurationMs(Buffer.concat([syntheticFrames(100), tag]))).toBe(2_400)
  })

  it('returns null when no frame parses', () => {
    expect(mp3DurationMs(Buffer.alloc(0))).toBeNull()
    expect(mp3DurationMs(Buffer.from('not audio at all'))).toBeNull()
    // A plausible sync word with an invalid bitrate index must not count.
    expect(mp3DurationMs(Buffer.from([0xff, 0xf3, 0xf4, 0x00]))).toBeNull()
  })

  it('reproduces the committed narration durations', () => {
    const first = readFileSync(join(process.cwd(), 'fixtures', 'hello', 'narration', '003-p03-native-chart.mp3'))
    const second = readFileSync(join(process.cwd(), 'fixtures', 'hello', 'narration', '004-p04-native-table.mp3'))
    expect(mp3DurationMs(first)).toBe(15_600)
    expect(mp3DurationMs(second)).toBe(13_704)
  })
})
