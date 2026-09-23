/**
 * MPEG audio timing read straight from the bytes (V6 Q5, ADR-060).
 *
 * The exporter derives a narrated slide's auto-advance from the host's `ffprobe`
 * (ADR-055), so the same deck rendered on two machines carried different
 * `advTm` numbers. Post recomputes the value from the embedded media instead:
 * the frame headers are deterministic and the audio bytes are already in the
 * package, so no probe, host or network is involved.
 */

/** MPEG version by the two bits in the frame header. */
type MpegVersion = 0 | 2 | 3

/** Layer by the two bits in the frame header (3 = Layer I, 1 = Layer III). */
type MpegLayer = 1 | 2 | 3

const SAMPLE_RATES: Record<MpegVersion, readonly number[]> = {
  3: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  0: [11025, 12000, 8000],
}

/**
 * Bitrate tables in kbps, indexed by the header's layer bits (3 = Layer I,
 * 2 = Layer II, 1 = Layer III) and then by its 4-bit bitrate index.
 *
 * Index 0 (free format) and 15 (invalid) never appear in a real frame.
 */
const BITRATES: Record<MpegVersion, Record<MpegLayer, readonly number[]>> = {
  3: {
    3: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  },
  2: {
    3: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    1: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  },
  0: {
    3: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    1: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  },
}

/** @returns the byte offset after an ID3v2 tag, or 0 when the bytes do not start with one. */
function afterId3v2(bytes: Buffer): number {
  if (bytes.length < 10 || bytes.toString('latin1', 0, 3) !== 'ID3') return 0
  const size = ((bytes[6] ?? 0) & 0x7f) * 0x200000 + ((bytes[7] ?? 0) & 0x7f) * 0x4000 + ((bytes[8] ?? 0) & 0x7f) * 0x80 + ((bytes[9] ?? 0) & 0x7f)
  const footer = ((bytes[5] ?? 0) & 0x10) === 0 ? 0 : 10
  return Math.min(bytes.length, 10 + size + footer)
}

/** One decoded frame header. */
interface FrameHeader {
  readonly length: number
  readonly seconds: number
}

/** @returns the frame at `offset`, or null when the header is invalid. */
function frameAt(bytes: Buffer, offset: number): FrameHeader | null {
  if (offset + 4 > bytes.length) return null
  const first = bytes[offset] ?? 0
  const second = bytes[offset + 1] ?? 0
  const third = bytes[offset + 2] ?? 0
  if (first !== 0xff || (second & 0xe0) !== 0xe0) return null
  const versionBits = (second >> 3) & 0x03
  if (versionBits === 1) return null
  const version = versionBits as MpegVersion
  const layerBits = (second >> 1) & 0x03
  if (layerBits === 0) return null
  const layer = layerBits as MpegLayer
  const bitrateIndex = (third >> 4) & 0x0f
  const sampleRateIndex = (third >> 2) & 0x03
  if (bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) return null
  const bitrate = (BITRATES[version][layer][bitrateIndex] ?? 0) * 1000
  const sampleRate = SAMPLE_RATES[version][sampleRateIndex] ?? 0
  if (bitrate === 0 || sampleRate === 0) return null
  const padding = (third >> 1) & 0x01
  const samples = layer === 3 ? 384 : layer === 2 ? 1152 : version === 3 ? 1152 : 576
  const length = layer === 3 ? (Math.floor((12 * bitrate) / sampleRate) + padding) * 4 : Math.floor((samples / 8) * (bitrate / sampleRate)) + padding
  if (length < 4) return null
  return { length, seconds: samples / sampleRate }
}

/**
 * Read the duration of an MPEG audio track (MP3) from its bytes.
 *
 * Frames are summed one by one, so both constant and variable bitrate files are
 * handled; an ID3v2 tag is skipped and a trailing ID3v1 tag is ignored.
 *
 * @param bytes - the audio part's bytes.
 * @returns the duration in milliseconds, or null when no frame parses.
 */
export function mp3DurationMs(bytes: Buffer): number | null {
  let offset = afterId3v2(bytes)
  let frames = 0
  let seconds = 0
  while (offset + 4 <= bytes.length) {
    // A trailing ID3v1 tag is 128 bytes at the end; stop before interpreting it.
    if (bytes.length - offset <= 128 && bytes.toString('latin1', offset, offset + 3) === 'TAG') break
    const frame = frameAt(bytes, offset)
    if (frame === null) {
      // Resynchronise byte by byte: ID3v2 padding and decoder junk are common.
      offset += 1
      continue
    }
    frames += 1
    seconds += frame.seconds
    offset += frame.length
  }
  if (frames === 0) return null
  return Math.round(seconds * 1000)
}
