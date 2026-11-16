/**
 * Closing a group-vote question (the organizer "decide" flow) and reading
 * its recorded outcome back.
 *
 * The model already had all the pieces but no explicit record of *what won*:
 *   - planning_sections.status: 'completed' = the question is closed
 *   - the winner was only ever inferred from tallies or
 *     from a timeline event's source_option_id (planItems.ts absorption)
 * Both inferences break when the organizer overrides the tally (picks a
 * non-leader) or when votes are tied. So the close flow now *stamps the
 * decision* onto the section's metadata (additive jsonb, same pattern as
 * decision_shape): `{ decided_option_id }`, plus `{ followup_action_id }`
 * when a follow-up action is created from the outcome banner.
 *
 * Pure (no React/Supabase) so the resolution rules are unit-testable.
 */
import { resolveWinner, resolveWinnerId, type ResolverOption } from './resolveDecision'
import type { OptionVote } from '../../../lib/queries/usePlanning'
import type { Json } from '../../../types/database.types'

export interface DecisionMetadata {
  decided_option_id?: string
  followup_action_id?: string
}

function readMetadataObject(metadata: Json | null | undefined): Record<string, Json | undefined> {
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    return metadata as Record<string, Json | undefined>
  }
  return {}
}

export function readDecidedOptionId(metadata: Json | null | undefined): string | null {
  const value = readMetadataObject(metadata).decided_option_id
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function readFollowupActionId(metadata: Json | null | undefined): string | null {
  const value = readMetadataObject(metadata).followup_action_id
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Merge a decision stamp into the section's existing metadata WITHOUT
 * dropping other keys (decision_shape etc. must survive a close).
 */
export function buildDecisionMetadata(existing: Json | null | undefined, stamp: DecisionMetadata): Json {
  return { ...readMetadataObject(existing), ...stamp } as Json
}

export interface ResolvableSection {
  status: string
  metadata: Json | null
  voting_method: string | null
  options: ResolverOption[]
}

/**
 * Is the open tally tied at the top? `pickedOptionId` is the option the
 * shared tie-break would choose (what the close sheet pre-selects) and
 * `tiedOptionIds` every option sharing the top score, so the sheet can say
 * "Tied: A, B, C. Tie-break picks A. Choose another if you prefer."
 */
export function resolveTieInfo(
  section: ResolvableSection,
  votes: OptionVote[]
): { tied: boolean; pickedOptionId: string | null; tiedOptionIds: string[] } {
  const r = resolveWinner(section, votes, { ignoreStamp: true })
  return { tied: r.tied, pickedOptionId: r.optionId, tiedOptionIds: r.tiedOptionIds }
}

/**
 * What a CLOSED section decided: the explicit metadata stamp when present
 * (organizer may have overridden the tally), else the tally leader under the
 * shared tie rule (resolveDecision.ts). Null for open sections and for closed
 * sections with neither stamp nor votes.
 */
export function resolveDecidedOptionId(section: ResolvableSection, votes: OptionVote[]): string | null {
  if (section.status !== 'completed') return null
  return resolveWinnerId(section, votes)
}

/** Default title for the follow-up action suggested when a decision closes. */
export function followupActionTitle(winnerTitle: string): string {
  return `Book "${winnerTitle}"`
}
