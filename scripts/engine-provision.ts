// Provision the engine venv without running `doctor`'s platform checks. CI uses
// this before the golden/matrix gates: those gates need a ready venv, and the
// doctor's png-renderer row is red by design on hosts without cairo (ADR-020/025),
// which would otherwise fail an unrelated step.
//
// `DSH_PPT_UV=uv` (or a uv on PATH) is required; see src/engine/venv.ts resolveUv.
import { defaultDependencies, venvManagerFor } from '../src/commands/context.ts'

const manager = venvManagerFor(defaultDependencies())
const state = manager.ensure({ force: true })
process.stdout.write(`engine venv ready: ${state.root} (ppt-master ${state.engineVersion})\n`)
