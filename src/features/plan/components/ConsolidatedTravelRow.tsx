import { useState } from 'react'
import { Badge } from '../../../components/ui'
import { formatTime } from '../../timeline/lib/categoryConfig'
import {
  formatTravelNameSummary,
  travelMemberDisplayName,
  travelMemberFirstName,
  type TravelGroup,
  type TravelUserLike,
} from '../lib/travelGrouping'
import type { PlanItem } from '../lib/planItems'

export interface ConsolidatedTravelRowProps {
  group: TravelGroup<PlanItem>
  /** user_id -> users row, for traveller names (falls back to the event title's "X arrives" shape). */
  usersById: Map<string, TravelUserLike>
  /** Opens the tapped person's own plan item — the same PlanItemSheet path a standalone travel card uses today, so per-person detail/edit permissions are unchanged. */
  onOpenMember: (item: PlanItem) => void
}

/**
 * One consolidated travel row (see travelGrouping.ts): several people on
 * the same flight / landing at the same minute render as a single line —
 * "3:55 PM · ✈️ Tim, Raine, Leo +3 arrive · EZY8287" — with a people-count
 * badge. Tapping the row expands an inline sunken list (the same nested
 * treatment as PlanBoard's "who picked what" expansion) with every
 * traveller's own time/flight, each tappable through to their individual
 * item sheet. Purely presentational: the underlying per-person DB rows are
 * untouched.
 */
export function ConsolidatedTravelRow({ group, usersById, onOpenMember }: ConsolidatedTravelRowProps) {
  const [expanded, setExpanded] = useState(false)

  const verb = group.direction === 'arrival' ? 'arrive' : 'depart'
  const time = group.startTime ? formatTime(group.startTime) : null
  // ✈️ when anyone's leg is a flight (flight ref present sets category
  // 'flight' in TravelDetailsSheet), otherwise the transfer emoji.
  const emoji = group.members.some((m) => m.item.category === 'flight') ? '✈️' : '🚌'
  const nameSummary = formatTravelNameSummary(group.members.map((m) => travelMemberFirstName(m, usersById)))
  const detail = [...group.flightRefs, ...group.airportCodes].join(' · ')

  return (
    <div className="w-full rounded-[var(--radius-lg)] border border-[var(--border-default)] bg-[var(--surface-raised)] transition-colors hover:border-accent-300">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        className="w-full flex items-center gap-2 px-3 py-2 text-left cursor-pointer"
      >
        {time && <span className="shrink-0 text-xs font-medium text-[var(--text-secondary)]">{time}</span>}
        <span className="shrink-0 text-sm" aria-hidden="true">
          {emoji}
        </span>
        <span className="min-w-0 flex-1 text-sm">
          <span className="font-medium text-[var(--text-primary)] break-words">
            {nameSummary} {verb}
          </span>
          {detail && <span className="text-xs text-[var(--text-muted)] break-words"> · {detail}</span>}
        </span>
        <Badge variant="neutral" size="sm" className="shrink-0">
          👥 {group.members.length}
        </Badge>
        <span className="shrink-0 text-xs text-[var(--text-muted)]" aria-hidden="true">
          {expanded ? '▲' : '▾'}
        </span>
      </button>

      {expanded && (
        <div className="mx-2 mb-2 space-y-0.5 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-1.5">
          {group.members.map((member) => {
            const memberBits = [
              !member.item.allDay && member.item.startTime ? formatTime(member.item.startTime) : null,
              member.flightRef,
              member.airportCode,
            ].filter(Boolean)
            return (
              <button
                key={member.item.id}
                type="button"
                onClick={() => onOpenMember(member.item)}
                className="w-full flex items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left cursor-pointer hover:bg-[var(--surface-raised)]"
              >
                <span className="min-w-0 flex-1 truncate text-sm text-[var(--text-primary)]">
                  {travelMemberDisplayName(member, usersById)}
                </span>
                {memberBits.length > 0 && (
                  <span className="shrink-0 text-xs text-[var(--text-muted)]">{memberBits.join(' · ')}</span>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
