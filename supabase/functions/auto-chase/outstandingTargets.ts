// Pure combinator for "who among these targets still owes this action",
// extracted so it's unit-testable without a service-role client (same
// rationale as ./actionDueDate.ts). Reuses the DERIVED-completion predicate
// from _shared/actionCompletion/sectionVoters.ts -- the mirror of the
// frontend's src/features/actions/lib/actionStatus.ts -- so auto-chase and
// the frontend never disagree about whether a section-linked action is done.

import { hasVotedInSection, type SectionVoterIds } from '../_shared/actionCompletion/sectionVoters.ts'

/**
 * Filters `targets` (assigned_to, or every active participant for a
 * whole-group action) down to the users who still owe this action: no
 * `trip_action_completions` row (`completedBy`) AND no vote cast in the
 * action's linked section (`sectionId` + `sectionVoters`). Precedence
 * matches the frontend: derived-vote OR manual-tick = complete, so anyone
 * satisfying either is dropped, never chased.
 */
export function outstandingTargets(
  targets: string[],
  sectionId: string | null,
  completedBy: Set<string>,
  sectionVoters: SectionVoterIds
): string[] {
  return targets.filter((uid) => !completedBy.has(uid) && !hasVotedInSection(sectionId, uid, sectionVoters))
}
