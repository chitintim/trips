import { useMemo } from 'react'
import { UserAvatar, Badge, EmptyState } from '../../../components/ui'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'
import { buildDependencyGraph, getTopKeystone } from '../lib/dependencyGraph'

interface DependencyGraphProps {
  participants: ParticipantWithUser[]
}

const NODE_RADIUS = 22
const ROW_HEIGHT = 72

function displayName(p: ParticipantWithUser): string {
  return p.user?.full_name || p.user?.email || 'Unknown'
}

/** avatar_data is a raw Json column — pull the emoji out defensively. */
function avatarEmoji(avatarData: unknown): string {
  if (avatarData && typeof avatarData === 'object' && 'emoji' in avatarData) {
    const emoji = (avatarData as { emoji?: unknown }).emoji
    if (typeof emoji === 'string' && emoji) return emoji
  }
  return '🙂'
}

/**
 * Compact SVG directed graph of "who's waiting on whom" (conditional
 * confirmations with conditional_type 'users'/'both'). Waiters are laid
 * out on the left, the people they depend on ("targets") on the right;
 * an arrow points from waiter to target. The keystone — the person whose
 * confirmation would transitively unblock the most others — is
 * highlighted with a ring and called out below the graph.
 *
 * Layout is a simple two-column bipartite arrangement rather than a force
 * layout: at trip-group scale (tens of people, a handful of conditionals)
 * this stays readable without a graph layout dependency, and the plan
 * explicitly asks for "no new npm dependencies".
 */
export function DependencyGraph({ participants }: DependencyGraphProps) {
  const graph = useMemo(() => buildDependencyGraph(participants), [participants])
  const byId = useMemo(() => new Map(participants.map((p) => [p.user_id, p])), [participants])

  const waiters = participants.filter((p) => graph.nodes.get(p.user_id)?.isWaiting)
  const targetIds = Array.from(new Set(graph.edges.map((e) => e.to)))
  const targets = targetIds.map((id) => byId.get(id)).filter((p): p is ParticipantWithUser => !!p)

  if (waiters.length === 0) {
    return (
      <EmptyState
        compact
        icon="🔗"
        title="No dependencies yet"
        description="When someone sets a conditional status depending on others confirming, the chain shows up here."
      />
    )
  }

  const keystone = getTopKeystone(graph)
  const keystoneParticipant = keystone ? byId.get(keystone.userId) : null

  const width = 560
  const leftX = 90
  const rightX = width - 90
  const height = Math.max(waiters.length, targets.length) * ROW_HEIGHT + 40

  const waiterY = (i: number) => 40 + i * ROW_HEIGHT + ROW_HEIGHT / 2
  const targetY = (i: number) => 40 + i * ROW_HEIGHT + ROW_HEIGHT / 2

  const waiterIndex = new Map(waiters.map((p, i) => [p.user_id, i]))
  const targetIndex = new Map(targets.map((p, i) => [p.user_id, i]))

  return (
    <div className="space-y-4">
      {keystoneParticipant && keystone && (
        <div className="flex items-start gap-3 bg-accent-50 border border-accent-200 rounded-[var(--radius-md)] p-3">
          <UserAvatar avatarData={keystoneParticipant.user} size="sm" />
          <div className="text-sm">
            <p className="text-accent-900">
              <strong>{displayName(keystoneParticipant)}</strong> is the keystone — if they confirm,{' '}
              <strong>{keystone.unlocksCount}</strong> {keystone.unlocksCount === 1 ? 'person' : 'people'} could
              resolve their conditions.
            </p>
          </div>
        </div>
      )}

      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          width="100%"
          height={height}
          role="img"
          aria-label="Confirmation dependency graph"
          className="min-w-[420px]"
        >
          <title>Who's waiting on whom</title>
          <defs>
            <marker id="dep-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="var(--color-neutral-400, #9ca3af)" />
            </marker>
          </defs>

          {/* Edges */}
          {graph.edges.map((edge, i) => {
            const fromI = waiterIndex.get(edge.from)
            const toI = targetIndex.get(edge.to)
            if (fromI === undefined || toI === undefined) return null
            const y1 = waiterY(fromI)
            const y2 = targetY(toI)
            const isKeystoneEdge = keystone?.userId === edge.to
            return (
              <path
                key={`${edge.from}-${edge.to}-${i}`}
                d={`M ${leftX + NODE_RADIUS} ${y1} C ${width / 2} ${y1}, ${width / 2} ${y2}, ${rightX - NODE_RADIUS - 8} ${y2}`}
                fill="none"
                stroke={isKeystoneEdge ? 'var(--color-accent-500, #1f9d90)' : 'var(--color-neutral-300, #d1d5db)'}
                strokeWidth={isKeystoneEdge ? 2.5 : 1.5}
                markerEnd="url(#dep-arrow)"
              />
            )
          })}

          {/* Waiter nodes (left) */}
          {waiters.map((p, i) => {
            const y = waiterY(i)
            const node = graph.nodes.get(p.user_id)
            return (
              <g key={p.user_id}>
                <circle
                  cx={leftX}
                  cy={y}
                  r={NODE_RADIUS}
                  fill="var(--color-neutral-0, #fff)"
                  stroke={node?.inCycle ? 'var(--color-warn-500, #d97706)' : 'var(--color-neutral-300, #d1d5db)'}
                  strokeWidth={node?.inCycle ? 2.5 : 1.5}
                  strokeDasharray={node?.inCycle ? '4 3' : undefined}
                />
                <text x={leftX} y={y + 5} textAnchor="middle" fontSize="16">
{avatarEmoji(p.user?.avatar_data)}
                </text>
                <text x={leftX} y={y + NODE_RADIUS + 16} textAnchor="middle" fontSize="11" fill="var(--color-neutral-600, #4b5563)">
                  {displayName(p).split(' ')[0]}
                </text>
              </g>
            )
          })}

          {/* Target nodes (right) */}
          {targets.map((p, i) => {
            const y = targetY(i)
            const isKeystone = keystone?.userId === p.user_id
            return (
              <g key={p.user_id}>
                <circle
                  cx={rightX}
                  cy={y}
                  r={NODE_RADIUS}
                  fill={isKeystone ? 'var(--color-accent-50, #effcfa)' : 'var(--color-neutral-0, #fff)'}
                  stroke={isKeystone ? 'var(--color-accent-500, #1f9d90)' : 'var(--color-neutral-300, #d1d5db)'}
                  strokeWidth={isKeystone ? 3 : 1.5}
                />
                <text x={rightX} y={y + 5} textAnchor="middle" fontSize="16">
{avatarEmoji(p.user?.avatar_data)}
                </text>
                <text x={rightX} y={y + NODE_RADIUS + 16} textAnchor="middle" fontSize="11" fill="var(--color-neutral-600, #4b5563)">
                  {displayName(p).split(' ')[0]}
                </text>
              </g>
            )
          })}
        </svg>
      </div>

      <div className="flex flex-wrap gap-2">
        {waiters.some((p) => graph.nodes.get(p.user_id)?.inCycle) && (
          <Badge variant="warning" size="sm">
            ⚠ Circular dependency detected — dashed nodes are stuck waiting on each other
          </Badge>
        )}
      </div>
    </div>
  )
}
