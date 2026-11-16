/**
 * EDGE SUBSET of src/features/actions/lib/actionStatus.ts: only
 * `withClosedSections` (the rest of that file needs the frontend DB types and
 * date helpers). The function body is checked against the original by
 * scripts/check-contract-drift.mjs (function-level pair).
 */
import type { SectionVoterIds } from '../../actionCompletion/sectionVoters.ts'

export function withClosedSections(
  sectionVoters: SectionVoterIds,
  sections: ReadonlyArray<{ id: string; status?: string | null }>,
  participantIds: ReadonlyArray<string>
): SectionVoterIds {
  const result: SectionVoterIds = new Map()
  for (const [id, voters] of sectionVoters) result.set(id, new Set(voters))
  for (const section of sections) {
    if (section.status !== 'completed') continue
    const voters = result.get(section.id) ?? new Set<string>()
    for (const uid of participantIds) voters.add(uid)
    result.set(section.id, voters)
  }
  return result
}
