/**
 * Section-voter derivation: the pure join between a planning section's
 * votes and a trip_action's linked `section_id`, underpinning DERIVED
 * action completion (casting a vote in the action's linked section counts
 * as completing that action -- see src/features/actions/lib/actionStatus.ts
 * for the full precedence rule: derived-vote OR manual-tick = complete).
 *
 * Dependency-free (no zod, no Database types) so it can be mirrored
 * verbatim into supabase/functions/_shared/actionCompletion -- both the
 * frontend (deriving completion for display) and the auto-chase edge
 * function (deciding who still needs chasing) must agree on this exact
 * predicate. See scripts/check-contract-drift.mjs for the CI gate that
 * keeps the two copies byte-identical (modulo import specifiers/comments).
 */

/**
 * section_id -> the set of userIds who have cast an `option_votes` row for
 * any option under that section.
 */
export type SectionVoterIds = Map<string, Set<string>>

/** Minimal shapes needed to derive `SectionVoterIds` from already-fetched options + votes. */
export interface OptionForSectionVoters {
  id: string
  section_id: string
}
export interface VoteForSectionVoters {
  option_id: string
  user_id: string
}

/**
 * Build the section_id -> voter-ids map action completion reads from. Pure
 * join of two already-fetched lists (options, option_votes) -- no new
 * query, per the DERIVED-approach design (self-heals on vote retraction,
 * no new write path/RLS surface).
 */
export function buildSectionVoters(options: OptionForSectionVoters[], votes: VoteForSectionVoters[]): SectionVoterIds {
  const sectionIdByOption = new Map(options.map((o) => [o.id, o.section_id]))
  const result: SectionVoterIds = new Map()
  for (const vote of votes) {
    const sectionId = sectionIdByOption.get(vote.option_id)
    if (!sectionId) continue
    const voters = result.get(sectionId)
    if (voters) {
      voters.add(vote.user_id)
    } else {
      result.set(sectionId, new Set([vote.user_id]))
    }
  }
  return result
}

/**
 * Whether `userId` has cast a vote in `sectionId` (false when `sectionId`
 * is null/undefined or no vote data was supplied). Takes a bare
 * `sectionId` rather than a full action row so this stays independent of
 * any particular caller's action shape (the frontend's generated `ActionRow`
 * vs. the edge function's hand-picked query result).
 */
export function hasVotedInSection(
  sectionId: string | null | undefined,
  userId: string,
  sectionVoters: SectionVoterIds | undefined
): boolean {
  if (!sectionId || !sectionVoters) return false
  return sectionVoters.get(sectionId)?.has(userId) ?? false
}
