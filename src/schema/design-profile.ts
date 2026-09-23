import { z } from 'zod'
import { DshPptFailure } from '../engine/errors.ts'
import { describeIssues } from './fusion.ts'

/**
 * `design-profile.json`: the numeric design system of a reference deck (V7.2 B1).
 *
 * A profile carries colours, fonts, sizes and geometry only. It never carries a
 * run's text, a media file or the input path, so a reference deck cannot follow its
 * profile into the repository or the published package (deck discipline, V7.2).
 */

/** Schema version of the profile document. */
export const DESIGN_PROFILE_VERSION = 1

/** Roles a profile describes; the storyboard's vocabulary. */
export const DESIGN_ROLES = ['cover', 'toc', 'section', 'content', 'ending'] as const
export type DesignRole = (typeof DESIGN_ROLES)[number]

/** Background strategies a profile may declare (plan §2 decision 3). */
export const DESIGN_BACKGROUND_MODES = ['photo', 'svg', 'office', 'user', 'flat'] as const
export type DesignBackgroundMode = (typeof DESIGN_BACKGROUND_MODES)[number]

/** One measured text style. */
export interface DesignTextStyle {
  readonly sizePt: number
  readonly bold?: boolean
  readonly color: string
  readonly font: string
}

/** One measured body style. */
export interface DesignBodyStyle {
  readonly sizePt: number
  readonly color: string
  readonly font: string
}

/** The title (and optional body) style of one role. */
export interface DesignRoleType {
  readonly title: DesignTextStyle
  readonly body?: DesignBodyStyle
}

/** The measured geometry of one role. */
export interface DesignRoleGeometry {
  readonly titlePos: { readonly x: number; readonly y: number }
  readonly columns: number
  /** Highest column count seen on the role's slides, when it varied. */
  readonly columnsMax?: number
  readonly cardGapIn?: number
  readonly watermarkSizePt?: number
}

/** One validated design profile. */
export interface DesignProfile {
  readonly version: typeof DESIGN_PROFILE_VERSION
  readonly canvas: { readonly widthEmu: number; readonly heightEmu: number }
  readonly palette: {
    readonly bg: string
    readonly title: string
    readonly accent: string
    readonly body: string
    readonly muted: string
    readonly watermark: string
    readonly onAccent: string
  }
  readonly fonts: { readonly heading: string; readonly body: string; readonly number: string }
  readonly typeScale: Partial<Record<DesignRole, DesignRoleType>>
  readonly roles: Partial<Record<DesignRole, DesignRoleGeometry>>
  readonly chrome: { readonly sectionMarker: boolean; readonly metaFooter: boolean; readonly pageNumber: boolean }
  readonly background: { readonly mode: DesignBackgroundMode; readonly overlayOpacity: number }
}

const HexSchema = z.string().regex(/^#[0-9A-F]{6}$/, 'expected an uppercase #RRGGBB literal')

const TextStyleSchema = z.strictObject({
  sizePt: z.number().positive(),
  bold: z.boolean().optional(),
  color: HexSchema,
  font: z.string().min(1),
})

const BodyStyleSchema = z.strictObject({
  sizePt: z.number().positive(),
  color: HexSchema,
  font: z.string().min(1),
})

const RoleTypeSchema = z.strictObject({
  title: TextStyleSchema,
  body: BodyStyleSchema.optional(),
})

const RoleGeometrySchema = z.strictObject({
  titlePos: z.strictObject({ x: z.number(), y: z.number() }),
  columns: z.number().int().positive(),
  columnsMax: z.number().int().positive().optional(),
  cardGapIn: z.number().nonnegative().optional(),
  watermarkSizePt: z.number().positive().optional(),
})

/** Zod schema for `design-profile.json`; unknown keys and roles are rejected. */
export const DesignProfileSchema = z.strictObject({
  version: z.literal(DESIGN_PROFILE_VERSION),
  canvas: z.strictObject({
    widthEmu: z.number().int().positive(),
    heightEmu: z.number().int().positive(),
  }),
  palette: z.strictObject({
    bg: HexSchema,
    title: HexSchema,
    accent: HexSchema,
    body: HexSchema,
    muted: HexSchema,
    watermark: HexSchema,
    onAccent: HexSchema,
  }),
  fonts: z.strictObject({
    heading: z.string().min(1),
    body: z.string().min(1),
    number: z.string().min(1),
  }),
  typeScale: z.strictObject({
    cover: RoleTypeSchema.optional(),
    toc: RoleTypeSchema.optional(),
    section: RoleTypeSchema.optional(),
    content: RoleTypeSchema.optional(),
    ending: RoleTypeSchema.optional(),
  }),
  roles: z.strictObject({
    cover: RoleGeometrySchema.optional(),
    toc: RoleGeometrySchema.optional(),
    section: RoleGeometrySchema.optional(),
    content: RoleGeometrySchema.optional(),
    ending: RoleGeometrySchema.optional(),
  }),
  chrome: z.strictObject({
    sectionMarker: z.boolean(),
    metaFooter: z.boolean(),
    pageNumber: z.boolean(),
  }),
  background: z.strictObject({
    mode: z.enum(DESIGN_BACKGROUND_MODES),
    overlayOpacity: z.number().min(0).max(1),
  }),
})

/**
 * Parse a design profile document.
 *
 * @param raw - parsed JSON of the profile.
 * @returns the validated profile.
 * @throws DshPptFailure `ContractViolation` listing every field that is wrong.
 */
export function parseDesignProfile(raw: unknown): DesignProfile {
  const result = DesignProfileSchema.safeParse(raw)
  if (!result.success) {
    const messages = describeIssues(result.error.issues)
    throw new DshPptFailure('ContractViolation', `design-profile.json is invalid: ${messages.join('; ')}`, {
      detail: { issues: messages },
    })
  }
  return result.data as DesignProfile
}
