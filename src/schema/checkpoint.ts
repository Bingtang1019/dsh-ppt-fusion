import { z } from 'zod'
import { DshPptFailure } from '../engine/errors.ts'
import { describeIssues } from './fusion.ts'

/**
 * Phases the SKILL writes into the checkpoint.
 *
 * `0` is the routing decision; `1`–`7` are the workflow phases the SKILL names.
 */
export const CHECKPOINT_PHASES = ['0', '1', '2', '3', '4', '5', '6', '7'] as const
export type CheckpointPhase = (typeof CHECKPOINT_PHASES)[number]

/**
 * `.dsh-ppt/checkpoint.json`: the hand-off file the SKILL writes after every phase.
 *
 * Unknown keys are ignored rather than rejected: this file is written by a model
 * under time pressure, and a stray field must not make the resume path unusable.
 * Known fields still fail with their path, like every other schema in this package.
 */
export const CheckpointSchema = z.object({
  version: z.union([z.literal(1), z.literal('1')]).transform(() => 1 as const),
  phase: z.union([
    z.enum(CHECKPOINT_PHASES),
    z
      .number()
      .int()
      .min(0)
      .max(7)
      .transform((value) => String(value) as CheckpointPhase),
  ]),
  /** Deck name the model chose; not required to be the directory name. */
  deck: z.string().min(1).optional(),
  updatedAt: z.string().min(1).optional(),
  /** Workspace-relative paths of the products this phase finished. */
  artifacts: z.array(z.string().min(1)).default([]),
  /** Gate results the model recorded; shape is free-form by design. */
  gates: z.record(z.string(), z.unknown()).default({}),
  notes: z.string().default(''),
})

/** A validated checkpoint. */
export type Checkpoint = z.infer<typeof CheckpointSchema>

/**
 * Parse a `checkpoint.json` document.
 *
 * @param raw - parsed JSON of the checkpoint.
 * @returns the validated checkpoint.
 * @throws DshPptFailure `ContractViolation` listing every field that is wrong.
 */
export function parseCheckpoint(raw: unknown): Checkpoint {
  const result = CheckpointSchema.safeParse(raw)
  if (!result.success) {
    const messages = describeIssues(result.error.issues)
    throw new DshPptFailure('ContractViolation', `checkpoint.json is invalid: ${messages.join('; ')}`, {
      detail: { issues: messages },
    })
  }
  return result.data
}
