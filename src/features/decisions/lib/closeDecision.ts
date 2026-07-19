/**
 * Closing a group-vote question (the organizer "decide" flow) and reading
 * its recorded outcome back.
 *
 * The model already had all the pieces but no explicit record of *what won*:
 *   - planning_sections.status: 'completed' = the question is closed
 *   - the winner was only ever inferred from tallies (brief/costBand.ts) or
 *     from a timeline event's source_option_id (planItems.ts absorption)
 * Both inferences break when the organizer overrides the tally (picks a
 * non-leader) or when votes are tied. So the close flow now *stamps the
 * decision* onto the section's metadata (additive jsonb, same pattern as
 * decision_shape): `{ decided_option_id }`, plus `{ followup_action_id }`
 * when a follow-up action is created from the outcome banner.
 *
 * Pure (no React/Supabase) so the resolution rules are unit-testable.
 */
import { tallyVotes, getWinner, type VotingMethod } from './voting'
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
  options: Array<{ id: string; status: string }>
}

/**
 * The section's current tally leader (excluding cancelled options), or null
 * when nobody has voted. Used to pre-select the winner in the close sheet
 * and as the fallback outcome for sections closed before the explicit
 * decided_option_id stamp existed.
 */
export function resolveTallyLeaderId(section: ResolvableSection, votes: OptionVote[]): string | null {
  const optionIds = section.options.filter((o) => o.status !== 'cancelled').map((o) => o.id)
  const sectionVotes = votes.filter((v) => optionIds.includes(v.option_id))
  const winner = getWinner(tallyVotes(optionIds, sectionVotes, (section.voting_method as VotingMethod) || 'single'))
  return winner?.optionId ?? null
}

/**
 * What a CLOSED section decided: the explicit metadata stamp when present
 * (organizer may have overridden the tally), else the tally leader (legacy
 * sections closed before the stamp existed). Null for open sections and for
 * closed sections with neither stamp nor votes.
 */
export function resolveDecidedOptionId(section: ResolvableSection, votes: OptionVote[]): string | null {
  if (section.status !== 'completed') return null
  const stamped = readDecidedOptionId(section.metadata)
  if (stamped && section.options.some((o) => o.id === stamped)) return stamped
  return resolveTallyLeaderId(section, votes)
}

/** Default title for the follow-up action suggested when a decision closes. */
export function followupActionTitle(winnerTitle: string): string {
  return `Book "${winnerTitle}"`
}
