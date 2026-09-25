import type { FusionFinding } from '../audit.ts'
import type { FileSystemPort } from '../engine/venv.ts'
import { contrastRatio } from './profile-theme.ts'
import { RENDER_PAGES_SCHEMA_VERSION, type RenderEngineId, type RenderPage } from './render-pages.ts'

/** One text box of a slide, in EMU, with the text it carries. */
export interface RenderTextBox {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly text: string
  /** Largest run size in the box, in points. */
  readonly sizePt: number
  /** Watermark/decorative text the design places over other boxes on purpose. */
  readonly watermark: boolean
}

/** The geometry the pixel rules scale their samples against. */
export interface RenderSlideGeometry {
  /** 1-based slide index. */
  readonly index: number
  readonly canvas: { readonly width: number; readonly height: number }
  readonly boxes: readonly RenderTextBox[]
  /** Storyboard role, used to skip chrome checks on cover/ending/section pages. */
  readonly role?: string
}

/** The chrome declaration the render rules check against. */
export interface RenderChromeDeclaration {
  readonly pageNumber: boolean
  readonly metaFooter: boolean
  readonly sectionMarker: boolean
}

/** Tunables for the pixel rules; every value is calibrated against the reference deck. */
export interface RenderThresholds {
  /** Share of ink below which a page counts as blank. */
  readonly blankInkMin: number
  /** Outer band width as a share of the shorter edge. */
  readonly borderBand: number
  /** Share of the outer band that may be inked before it is reported as bleed (warning). */
  readonly borderInkWarn: number
  /** Ring width in pixels around a text box for the overflow probe. */
  readonly ringPx: number
  /** Share of the ring that may be inked before it counts as overflow (warning). */
  readonly ringInkMax: number
  /** Share of a text box that must be inked for its text to count as rendered. */
  readonly tofuInkMin: number
  /** WCAG contrast ratio the body text must reach against its page background. */
  readonly contrastMin: number
  /** Share of ink-share drift above which two engines are reported as drifting apart. */
  readonly parityMax: number
  /** Page-number band, as a share of canvas width and height, anchored bottom-right. */
  readonly pageNumberBand: { readonly w: number; readonly h: number }
  /** Share of the page-number band that must be inked when the chrome declares numbers. */
  readonly pageNumberInkMin: number
  /** Share of the page-number band that counts as a stray mark when numbers are not declared. */
  readonly pageNumberInkMax: number
}

/** Calibrated defaults (ADR-082); the reference deck passes them with 0 findings. */
export const RENDER_THRESHOLDS: RenderThresholds = {
  blankInkMin: 0.0008,
  borderBand: 0.006,
  borderInkWarn: 0.25,
  ringPx: 3,
  ringInkMax: 0.2,
  tofuInkMin: 0.002,
  contrastMin: 4.5,
  parityMax: 0.06,
  pageNumberBand: { w: 0.12, h: 0.06 },
  pageNumberInkMin: 0.003,
  pageNumberInkMax: 0.03,
}

/** What one `audit --rendered` pass inspected. */
export interface RenderAuditSummary {
  readonly findings: readonly FusionFinding[]
  /** Engines whose snapshots existed and were inspected. */
  readonly engines: readonly RenderEngineId[]
  /** Page images inspected across all engines. */
  readonly pages: number
  /** Why the pass could not run, when it could not. */
  readonly skipped?: string
}

/** Options for {@link auditRenderedPages}. */
export interface RenderAuditOptions {
  /** Absolute `<deck>/.dsh-ppt/render`. */
  readonly renderRoot: string
  /** Deck-relative spelling for messages. */
  readonly renderRelative: string
  /** Slide count from the pptx. */
  readonly slideCount: number
  readonly slides: readonly RenderSlideGeometry[]
  readonly chrome: RenderChromeDeclaration | null
  readonly fs: FileSystemPort
  readonly thresholds?: Partial<RenderThresholds>
}

/** One decoded page image. */
interface PagePixels {
  readonly width: number
  readonly height: number
  /** Modal background colour of the page. */
  readonly background: string
  /** Ink share over the whole page. */
  readonly inkRatio: number
  /** Ink share inside the outer band. */
  readonly borderInk: number
  /** Ink share inside the bottom-right page-number band. */
  readonly pageNumberInk: number
  /** Per text box: ink inside the box, colour-matched ring ink and the box's own ink colour. */
  readonly boxes: readonly { readonly ink: number; readonly ring: number; readonly colour: string | null }[]
}

/** @param value - 0-255 channel. @returns two lowercase hex digits. */
function hexByte(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')
}

/** @param rgb - 0-255 channels. @returns `#rrggbb` in lowercase. */
function hex(rgb: readonly [number, number, number]): string {
  return `#${hexByte(rgb[0])}${hexByte(rgb[1])}${hexByte(rgb[2])}`
}

/**
 * Read one stored engine manifest.
 *
 * @param fs - filesystem port.
 * @param renderRoot - absolute render root.
 * @param engine - engine id.
 * @returns the page records, or null when the snapshot is absent or unusable.
 */
function readEnginePages(fs: FileSystemPort, renderRoot: string, engine: RenderEngineId): { pages: readonly RenderPage[] } | null {
  const text = fs.readText(`${renderRoot}/${engine}/manifest.json`)
  if (text === null) return null
  try {
    const parsed = JSON.parse(text) as { schemaVersion?: unknown; engine?: unknown; pages?: unknown }
    if (parsed.schemaVersion !== RENDER_PAGES_SCHEMA_VERSION || parsed.engine !== engine || !Array.isArray(parsed.pages)) return null
    const pages = parsed.pages.filter((page): page is RenderPage => {
      const record = page as Partial<RenderPage>
      return typeof record.index === 'number' && typeof record.file === 'string'
    })
    return pages.length === 0 ? null : { pages }
  } catch {
    return null
  }
}

/**
 * Decode one page image and measure the shares the rules compare.
 *
 * @param bytes - PNG bytes.
 * @param geometry - the slide's geometry, used to scale boxes into image space.
 * @param thresholds - calibrated thresholds.
 * @returns the measurements, or null when the image cannot be decoded.
 */
async function measurePage(bytes: Buffer, geometry: RenderSlideGeometry | undefined, thresholds: RenderThresholds): Promise<PagePixels | null> {
  const { default: sharp } = await import('sharp')
  let data: Buffer
  let info: { width: number; height: number; channels: number }
  try {
    const decoded = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    data = decoded.data
    info = { width: decoded.info.width, height: decoded.info.height, channels: decoded.info.channels }
  } catch {
    return null
  }
  const { width, height, channels: step } = info
  /** @param offset - pixel byte offset. @returns the quantised colour key. */
  const keyOf = (offset: number): string => `${String((data[offset] ?? 0) >> 4)},${String((data[offset + 1] ?? 0) >> 4)},${String((data[offset + 2] ?? 0) >> 4)}`
  const counts = new Map<string, number>()
  for (let offset = 0; offset + 3 < data.length; offset += step) {
    if ((data[offset + 3] ?? 0) < 128) continue
    const key = keyOf(offset)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  let backgroundKey = '15,15,15'
  let backgroundCount = -1
  for (const [key, count] of counts) {
    if (count > backgroundCount) {
      backgroundKey = key
      backgroundCount = count
    }
  }
  /** @param key - quantised colour key. @returns the bin's centre colour. */
  const colourOf = (key: string): [number, number, number] => {
    const parts = key.split(',').map((part) => Number(part) * 16 + 8)
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0]
  }
  const backgroundRgb = colourOf(backgroundKey)
  /** @param offset - pixel byte offset. @returns true when the pixel differs from the modal background. */
  const isInk = (offset: number): boolean =>
    Math.max(
      Math.abs((data[offset] ?? 0) - backgroundRgb[0]),
      Math.abs((data[offset + 1] ?? 0) - backgroundRgb[1]),
      Math.abs((data[offset + 2] ?? 0) - backgroundRgb[2]),
    ) > 24
  let ink = 0
  let total = 0
  for (let offset = 0; offset + 3 < data.length; offset += step) {
    if ((data[offset + 3] ?? 0) < 128) continue
    total += 1
    if (isInk(offset)) ink += 1
  }
  const band = Math.max(1, Math.round(Math.min(width, height) * thresholds.borderBand))
  let borderInk = 0
  let borderTotal = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (x >= band && x < width - band && y >= band && y < height - band) continue
      borderTotal += 1
      if (isInk((y * width + x) * step)) borderInk += 1
    }
  }
  const numberBandWidth = Math.max(1, Math.round(width * thresholds.pageNumberBand.w))
  const numberBandHeight = Math.max(1, Math.round(height * thresholds.pageNumberBand.h))
  let numberInk = 0
  let numberTotal = 0
  for (let y = height - numberBandHeight; y < height; y += 1) {
    for (let x = width - numberBandWidth; x < width; x += 1) {
      numberTotal += 1
      if (isInk((y * width + x) * step)) numberInk += 1
    }
  }
  const boxes = (geometry?.boxes ?? []).map((box) => {
    const scaleX = width / (geometry?.canvas.width ?? width)
    const scaleY = height / (geometry?.canvas.height ?? height)
    const left = Math.max(0, Math.floor(box.x * scaleX))
    const top = Math.max(0, Math.floor(box.y * scaleY))
    const right = Math.min(width, Math.ceil((box.x + box.w) * scaleX))
    const bottom = Math.min(height, Math.ceil((box.y + box.h) * scaleY))
    const colours = new Map<string, number>()
    let inside = 0
    let insideTotal = 0
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        const offset = (y * width + x) * step
        insideTotal += 1
        if (!isInk(offset)) continue
        inside += 1
        const key = keyOf(offset)
        colours.set(key, (colours.get(key) ?? 0) + 1)
      }
    }
    // Text is darker than the card fills and accents that can share a text box, so
    // the contrast rule takes the darkest colour covering at least a tenth of the
    // box's ink rather than the most common one.
    // Text is darker than the card fills and accents that can share a text box, and
    // anti-aliasing spreads its core colour thin, so the contrast rule takes the
    // darkest colour that still covers a twentieth of the box's ink.
    let boxKey: string | null = null
    let boxLuminance = Number.POSITIVE_INFINITY
    let boxInk = 0
    for (const count of colours.values()) boxInk += count
    const boxThreshold = Math.max(2, Math.round(boxInk * 0.05))
    for (const [key, count] of colours) {
      if (count < boxThreshold) continue
      const [r, g, b] = colourOf(key)
      const value = 0.2126 * (r / 255) + 0.7152 * (g / 255) + 0.0722 * (b / 255)
      if (value < boxLuminance) {
        boxKey = key
        boxLuminance = value
      }
    }
    const boxRgb = boxKey === null ? null : colourOf(boxKey)
    const ring = thresholds.ringPx
    let outside = 0
    let outsideTotal = 0
    for (let y = Math.max(0, top - ring); y < Math.min(height, bottom + ring); y += 1) {
      for (let x = Math.max(0, left - ring); x < Math.min(width, right + ring); x += 1) {
        if (x >= left && x < right && y >= top && y < bottom) continue
        outsideTotal += 1
        const offset = (y * width + x) * step
        if (!isInk(offset) || boxRgb === null) continue
        if (
          Math.abs((data[offset] ?? 0) - boxRgb[0]) <= 24 &&
          Math.abs((data[offset + 1] ?? 0) - boxRgb[1]) <= 24 &&
          Math.abs((data[offset + 2] ?? 0) - boxRgb[2]) <= 24
        ) {
          outside += 1
        }
      }
    }
    return {
      ink: insideTotal === 0 ? 0 : inside / insideTotal,
      ring: outsideTotal === 0 ? 0 : outside / outsideTotal,
      colour: boxKey === null ? null : hex(colourOf(boxKey)),
    }
  })
  return {
    width,
    height,
    background: hex(backgroundRgb),
    inkRatio: total === 0 ? 0 : ink / total,
    borderInk: borderTotal === 0 ? 0 : borderInk / borderTotal,
    pageNumberInk: numberTotal === 0 ? 0 : numberInk / numberTotal,
    boxes,
  }
}

/**
 * Run the render-level rules over the stored snapshots.
 *
 * The pass is additive: without snapshots it returns `skipped` instead of a
 * finding, so ordinary audits keep working on machines with no renderer. Every
 * finding names the engine and page so the fix goes back to the owning layer.
 *
 * @param options - snapshots root, slide geometry, chrome declaration and thresholds.
 * @returns the findings plus what was inspected.
 */
export async function auditRenderedPages(options: RenderAuditOptions): Promise<RenderAuditSummary> {
  const thresholds: RenderThresholds = { ...RENDER_THRESHOLDS, ...options.thresholds }
  const engines: RenderEngineId[] = []
  const findings: FusionFinding[] = []
  const geometryByIndex = new Map(options.slides.map((slide) => [slide.index, slide]))
  const pixelsByEngine = new Map<RenderEngineId, Map<number, PagePixels>>()
  for (const engine of ['powerpoint', 'libreoffice'] as const) {
    const stored = readEnginePages(options.fs, options.renderRoot, engine)
    if (stored === null) continue
    engines.push(engine)
    if (stored.pages.length !== options.slideCount) {
      findings.push({
        level: 'error',
        source: 'render',
        rule: 'render-page-count',
        message: `${engine} rendered ${String(stored.pages.length)} page(s) for a ${String(options.slideCount)}-slide deck`,
      })
    }
    const decoded = new Map<number, PagePixels>()
    for (const page of stored.pages) {
      const bytes = options.fs.readBytes(`${options.renderRoot}/${engine}/${page.file}`)
      if (bytes === null) {
        findings.push({ level: 'error', source: 'render', page: page.index, rule: 'render-content-loss', message: `${engine} page ${String(page.index)} is missing on disk (${page.file})` })
        continue
      }
      const pixels = await measurePage(bytes, geometryByIndex.get(page.index), thresholds)
      if (pixels === null) {
        findings.push({ level: 'error', source: 'render', page: page.index, rule: 'render-content-loss', message: `${engine} page ${String(page.index)} is not a decodable PNG` })
        continue
      }
      decoded.set(page.index, pixels)
      if (pixels.inkRatio < thresholds.blankInkMin) {
        findings.push({
          level: 'error',
          source: 'render',
          page: page.index,
          rule: 'render-content-loss',
          message: `${engine} page ${String(page.index)} renders blank (ink share ${(pixels.inkRatio * 100).toFixed(3)}%)`,
        })
      }
      if (pixels.borderInk > thresholds.borderInkWarn) {
        findings.push({
          level: 'warning',
          source: 'render',
          page: page.index,
          rule: 'render-off-page',
          message: `${engine} page ${String(page.index)} paints ${(pixels.borderInk * 100).toFixed(1)}% of the outer band; a full-bleed element may be intended, but nothing should be clipped`,
        })
      }
      for (const [offset, box] of (geometryByIndex.get(page.index)?.boxes ?? []).entries()) {
        const measured = pixels.boxes[offset]
        if (measured === undefined || box.watermark) continue
        if (measured.colour !== null) {
          const ratio = contrastRatio(measured.colour, pixels.background)
          const minimum = box.sizePt >= 18 ? 3 : thresholds.contrastMin
          if (ratio < minimum) {
            findings.push({
              level: 'error',
              source: 'render',
              page: page.index,
              rule: 'render-contrast',
              message: `${engine} page ${String(page.index)} text "${box.text.slice(0, 20)}" (${String(box.sizePt)} pt) is ${measured.colour} on ${pixels.background}: ${ratio.toFixed(2)}:1, below ${String(minimum)}:1`,
            })
          }
        }
        if (box.text.trim() !== '' && measured.ink < thresholds.tofuInkMin) {
          findings.push({
            level: 'warning',
            source: 'render',
            page: page.index,
            rule: 'render-tofu',
            message: `${engine} page ${String(page.index)} shows no ink where the text box "${box.text.slice(0, 24)}" sits; glyphs may be missing or the text is hidden`,
          })
        }
        if (measured.ring > thresholds.ringInkMax) {
          findings.push({
            level: 'warning',
            source: 'render',
            page: page.index,
            rule: 'render-overflow',
            message: `${engine} page ${String(page.index)} paints ${(measured.ring * 100).toFixed(1)}% of the ${String(thresholds.ringPx)}px ring around "${box.text.slice(0, 24)}" in the text's own colour`,
          })
        }
      }
    }    pixelsByEngine.set(engine, decoded)
  }
  if (options.chrome !== null) {
    for (const engine of engines) {
      for (const [index, pixels] of pixelsByEngine.get(engine) ?? []) {
        const role = geometryByIndex.get(index)?.role
        if (role === 'section' || role === 'cover' || role === 'ending') continue
        if (options.chrome.pageNumber && pixels.pageNumberInk < thresholds.pageNumberInkMin) {
          findings.push({ level: 'error', source: 'render', page: index, rule: 'render-chrome', message: `${engine} page ${String(index)} has no page number in the declared band` })
        }
        if (!options.chrome.pageNumber && pixels.pageNumberInk > thresholds.pageNumberInkMin) {
          findings.push({
            level: 'error',
            source: 'render',
            page: index,
            rule: 'render-chrome',
            message: `${engine} page ${String(index)} paints a mark in the page-number band although the profile declares no page numbers`,
          })
        }
      }
    }
  }
  const left = pixelsByEngine.get('powerpoint')
  const right = pixelsByEngine.get('libreoffice')
  if (left !== undefined && right !== undefined) {
    for (const [index, a] of left) {
      const b = right.get(index)
      if (b === undefined) continue
      const drift = Math.abs(a.inkRatio - b.inkRatio) + Math.abs(a.borderInk - b.borderInk)
      if (drift > thresholds.parityMax) {
        findings.push({
          level: 'warning',
          source: 'render',
          page: index,
          rule: 'render-parity',
          message: `page ${String(index)} drifts between engines (ink share ${(a.inkRatio * 100).toFixed(2)}% vs ${(b.inkRatio * 100).toFixed(2)}%)`,
        })
      }
    }
  }
  return {
    findings,
    engines,
    pages: [...pixelsByEngine.values()].reduce((sum, map) => sum + map.size, 0),
    ...(engines.length === 0 ? { skipped: `no snapshots under ${options.renderRelative}; run \`dsh-ppt renderpages\` first` } : {}),
  }
}

/**
 * Overlap rule (geometry only): two text boxes on one slide must not share more
 * than a fifth of the smaller box, which catches stacked or mis-placed shapes
 * without depending on any renderer.
 *
 * @param slides - slide geometry.
 * @returns one error finding per overlapping pair.
 */
export function overlapFindings(slides: readonly RenderSlideGeometry[]): FusionFinding[] {
  const findings: FusionFinding[] = []
  for (const slide of slides) {
    for (let left = 0; left < slide.boxes.length; left += 1) {
      for (let right = left + 1; right < slide.boxes.length; right += 1) {
        const a = slide.boxes[left]
        const b = slide.boxes[right]
        if (a === undefined || b === undefined) continue
        const overlapWidth = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
        const overlapHeight = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
        if (overlapWidth <= 0 || overlapHeight <= 0) continue
        const overlap = overlapWidth * overlapHeight
        const smaller = Math.min(a.w * a.h, b.w * b.h)
        if (smaller <= 0 || overlap / smaller <= 0.2) continue
        findings.push({
          level: 'error',
          source: 'render',
          page: slide.index,
          rule: 'render-overlap',
          message: `page ${String(slide.index)} text boxes "${a.text.slice(0, 20)}" and "${b.text.slice(0, 20)}" overlap by ${((overlap / smaller) * 100).toFixed(0)}% of the smaller box`,
        })
      }
    }
  }
  return findings
}

/**
 * Off-page rule (geometry only): a non-decorative text box must stay inside the
 * canvas. This catches shapes dragged past the slide edge before any renderer runs.
 *
 * @param slides - slide geometry.
 * @returns one error finding per text box that leaves the canvas.
 */
export function offPageFindings(slides: readonly RenderSlideGeometry[]): FusionFinding[] {
  const findings: FusionFinding[] = []
  for (const slide of slides) {
    for (const box of slide.boxes) {
      if (box.watermark) continue
      // 0.5 % of each axis: the ppt-master master can be a hair smaller than the template canvas
      const toleranceX = slide.canvas.width * 0.005
      const toleranceY = slide.canvas.height * 0.005
      const outside = box.x < -toleranceX || box.y < -toleranceY || box.x + box.w > slide.canvas.width + toleranceX || box.y + box.h > slide.canvas.height + toleranceY
      if (!outside) continue
      findings.push({
        level: 'error',
        source: 'render',
        page: slide.index,
        rule: 'render-off-page',
        message: `page ${String(slide.index)} text box "${box.text.slice(0, 24)}" leaves the ${String(Math.round(slide.canvas.width))}x${String(Math.round(slide.canvas.height))} canvas`,
      })
    }
  }
  return findings
}