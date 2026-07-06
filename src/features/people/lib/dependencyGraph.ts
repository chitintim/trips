/**
 * Conditional confirmation dependency graph.
 *
 * The legacy ConditionalDependencyDisplay only resolves one hop (a
 * participant's direct conditional_user_ids against the participant list) —
 * it never follows chains, never detects cycles beyond the immediate pair,
 * and its `conditionsMet` prop is never actually computed by a caller.
 *
 * This module builds a proper directed graph over conditional_user_ids,
 * with cycle-safe traversal (ported from the pattern in the legacy
 * ConfirmationDashboard.tsx's private getEffectiveDeadline, generalized
 * into reusable, testable primitives), transitive closure ("if X confirms,
 * who unblocks — including indirectly"), and keystone identification (the
 * single person whose confirmation would unblock the most others).
 */
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'

export interface DependencyEdge {
  /** The participant who is waiting (conditional). */
  from: string
  /** The participant being waited on. */
  to: string
}

export interface DependencyNode {
  userId: string
  /** True if this participant has any unmet conditional dependency. */
  isWaiting: boolean
  /** Direct (one-hop) user ids this participant is waiting on. */
  dependsOn: string[]
  /** All participants (direct + transitive) this participant is ultimately blocked by. */
  transitiveDependsOn: string[]
  /** True if this node participates in a dependency cycle. */
  inCycle: boolean
}

export interface DependencyGraph {
  nodes: Map<string, DependencyNode>
  edges: DependencyEdge[]
  /**
   * Keystone participants ranked by unlock impact: confirming this person
   * would fully resolve the most other waiting participants (counting
   * transitive unlocks — someone who unblocks A, who in turn unblocks B,
   * counts both A and B).
   */
  keystones: Array<{ userId: string; unlocksCount: number; unlocksUserIds: string[] }>
}

/**
 * A participant is "waiting" (has an active conditional dependency on
 * people) when status is 'conditional' with conditional_type 'users' or
 * 'both' and at least one conditional_user_id. (Pure date conditionals
 * don't appear in the graph — nobody else can resolve them.)
 */
function isWaitingOnUsers(p: Pick<ParticipantWithUser, 'confirmation_status' | 'conditional_type' | 'conditional_user_ids'>): boolean {
  return (
    p.confirmation_status === 'conditional' &&
    (p.conditional_type === 'users' || p.conditional_type === 'both') &&
    !!p.conditional_user_ids &&
    p.conditional_user_ids.length > 0
  )
}

/** Cycle-safe transitive closure: every user id ultimately upstream of `userId`, direct or indirect. */
function collectTransitive(
  userId: string,
  byId: Map<string, ParticipantWithUser>,
  visited: Set<string> = new Set()
): { all: string[]; inCycle: boolean } {
  if (visited.has(userId)) {
    return { all: [], inCycle: true }
  }
  visited.add(userId)

  const participant = byId.get(userId)
  if (!participant || !isWaitingOnUsers(participant)) {
    return { all: [], inCycle: false }
  }

  const direct = (participant.conditional_user_ids || []).filter((id) => byId.has(id) && id !== userId)
  const all = new Set<string>(direct)
  let inCycle = false

  for (const depId of direct) {
    const { all: deeper, inCycle: deeperCycle } = collectTransitive(depId, byId, new Set(visited))
    deeper.forEach((id) => all.add(id))
    if (deeperCycle) inCycle = true
  }

  return { all: Array.from(all), inCycle }
}

/**
 * Build the full dependency graph for a trip's participants. O(n^2) worst
 * case (n = participants), which is fine at trip-group scale (tens of
 * people, not thousands).
 */
export function buildDependencyGraph(participants: ParticipantWithUser[]): DependencyGraph {
  const byId = new Map(participants.map((p) => [p.user_id, p]))
  const nodes = new Map<string, DependencyNode>()
  const edges: DependencyEdge[] = []

  for (const p of participants) {
    const waiting = isWaitingOnUsers(p)
    const dependsOn = waiting ? (p.conditional_user_ids || []).filter((id) => byId.has(id) && id !== p.user_id) : []
    const { all: transitive, inCycle } = waiting ? collectTransitive(p.user_id, byId) : { all: [], inCycle: false }

    nodes.set(p.user_id, {
      userId: p.user_id,
      isWaiting: waiting,
      dependsOn,
      transitiveDependsOn: transitive,
      inCycle,
    })

    for (const depId of dependsOn) {
      edges.push({ from: p.user_id, to: depId })
    }
  }

  // Keystone ranking: for each candidate "to" node, count how many waiting
  // participants have them in their transitive dependency set (i.e. would
  // eventually be unblocked, directly or via a chain, once this person
  // confirms) — but only counting participants not already confirmed.
  const unresolvedWaiters = participants.filter((p) => isWaitingOnUsers(p) && p.confirmation_status !== 'confirmed')

  const unlockMap = new Map<string, Set<string>>()
  for (const waiter of unresolvedWaiters) {
    const node = nodes.get(waiter.user_id)
    if (!node) continue
    for (const upstreamId of node.transitiveDependsOn) {
      const upstreamParticipant = byId.get(upstreamId)
      // Only counts as a real "keystone unlock" if the upstream person
      // hasn't already confirmed (already-confirmed people can't be
      // nudged further) and isn't the waiter themselves.
      if (!upstreamParticipant || upstreamParticipant.confirmation_status === 'confirmed') continue
      if (!unlockMap.has(upstreamId)) unlockMap.set(upstreamId, new Set())
      unlockMap.get(upstreamId)!.add(waiter.user_id)
    }
  }

  const keystones = Array.from(unlockMap.entries())
    .map(([userId, unlocks]) => ({ userId, unlocksCount: unlocks.size, unlocksUserIds: Array.from(unlocks) }))
    .filter((k) => k.unlocksCount > 0)
    .sort((a, b) => b.unlocksCount - a.unlocksCount)

  return { nodes, edges, keystones }
}

/** Convenience: the single top keystone (or null if nobody is waiting on anybody). */
export function getTopKeystone(graph: DependencyGraph) {
  return graph.keystones[0] ?? null
}
