import { z } from 'zod'

/** Slide transition effects the post layer can write. */
export const TRANSITION_EFFECTS = ['fade', 'push', 'wipe', 'none'] as const
export type TransitionEffect = (typeof TRANSITION_EFFECTS)[number]

/** Entrance effects, mapped to the animEffect filters PowerPoint uses. */
export const ENTRANCE_EFFECTS = ['fade', 'wipe', 'fly'] as const
export type EntranceEffect = (typeof ENTRANCE_EFFECTS)[number]

/**
 * Which shapes an entrance applies to.
 *
 * `match` is a substring of the shape's `p:cNvPr name`, which is how both engines
 * label the shapes a deck author knows about: deep pages carry the SVG group id
 * (`milestone-chart`), and pptwise standard pages carry `blk<slide>-<block>`
 * markers when the IR opts into element animations. `spids` is the escape hatch
 * for a shape with no useful name.
 */
export const SelectorSchema = z.union([
  z.strictObject({ match: z.string().min(1) }),
  z.strictObject({ spids: z.array(z.number().int().positive()).min(1) }),
])

const EntranceSchema = z.strictObject({
  effect: z.enum(ENTRANCE_EFFECTS),
  /** Animation duration in milliseconds. */
  durationMs: z.number().int().positive().max(10_000).optional(),
  target: SelectorSchema,
})

const SlideSchema = z.strictObject({
  /** 1-based deck position. */
  index: z.number().int().positive(),
  transition: z.enum(TRANSITION_EFFECTS).optional(),
  /** Slide transition duration in milliseconds. */
  durationMs: z.number().int().positive().max(10_000).optional(),
  entrance: EntranceSchema.optional(),
})

/** `post/animations.json`: the single place a deck's motion is declared. */
export const PostConfigSchema = z.strictObject({
  /** Delay between successive entrance blocks; matches pptwise's default. */
  staggerMs: z.number().int().min(0).max(5_000).optional(),
  slides: z.array(SlideSchema).min(1),
})

/** Parsed post configuration. */
export type PostConfig = z.infer<typeof PostConfigSchema>

/** One slide's declaration. */
export type SlidePostConfig = z.infer<typeof SlideSchema>
