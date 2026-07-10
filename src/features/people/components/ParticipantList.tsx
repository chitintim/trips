import { UserAvatar, Badge, ConfirmationStatusBadge, Deadline, EmptyState } from '../../../components/ui'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'
import type { Enums } from '../../../types/database.types'
import { getWaitlistQueue } from '../lib/waitlist'

type ConfirmationStatus = Enums<'confirmation_status'>

const STATUS_GROUP_ORDER: ConfirmationStatus[] = ['confirmed', 'conditional', 'interested', 'pending', 'waitlist', 'declined', 'cancelled']

const STATUS_GROUP_LABEL: Record<ConfirmationStatus, string> = {
  confirmed: 'Confirmed',
  conditional: 'Conditional',
  interested: 'Interested',
  pending: 'Awaiting response',
  waitlist: 'Waitlist',
  declined: "Can't make it",
  cancelled: 'Cancelled',
}

interface ParticipantListProps {
  participants: ParticipantWithUser[]
  currentUserId?: string
  onSelect: (participant: ParticipantWithUser) => void
  /**
   * Status-grouped with badges/deadlines/waitlist position (the default) vs.
   * a flat, non-interactive list of just avatar + name + organizer badge --
   * for trips with confirmation tracking off, where confirmation_status has
   * no meaning (People sub-task A: "plain participant list, no status
   * grouping").
   */
  groupByStatus?: boolean
  /** Organizer/admin viewing this list -- shows a per-row "Manage" affordance (remove from trip, etc). */
  canManage?: boolean
  onManage?: (participant: ParticipantWithUser) => void
}

/** Small per-row affordance, shown only when the viewer can manage the roster. A sibling of the row's own button/div (never nested inside it) to keep the markup valid. */
function ManageButton({ participant, onManage }: { participant: ParticipantWithUser; onManage: (participant: ParticipantWithUser) => void }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onManage(participant)
      }}
      aria-label={`Manage ${participant.user?.full_name || participant.user?.email || 'participant'}`}
      className="absolute right-2 top-1/2 -translate-y-1/2 px-2 py-1.5 rounded-[var(--radius-sm)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-sunken)] transition-colors"
    >
      <span aria-hidden="true">⋯</span>
    </button>
  )
}

/**
 * Status-grouped participant list: avatars, notes, waitlist queue
 * position + live offer countdown where relevant.
 */
export function ParticipantList({ participants, currentUserId, onSelect, groupByStatus = true, canManage = false, onManage }: ParticipantListProps) {
  if (participants.length === 0) {
    return <EmptyState compact icon="👥" title="No participants yet" />
  }

  if (!groupByStatus) {
    return (
      <div className="space-y-2">
        {participants.map((p) => (
          <div
            key={p.user_id}
            className={`relative w-full flex items-center gap-3 p-3 rounded-[var(--radius-md)] bg-[var(--surface-raised)] border border-[var(--border-subtle)] ${canManage ? 'pr-12' : ''}`}
          >
            <UserAvatar avatarData={p.user} size="md" />
            <span className="flex-1 min-w-0 font-medium text-[var(--text-primary)] truncate">
              {p.user?.full_name || p.user?.email}
              {p.user_id === currentUserId && <span className="text-[var(--text-muted)] font-normal"> (you)</span>}
            </span>
            {p.role === 'organizer' && (
              <Badge variant="secondary" size="sm">
                Organizer
              </Badge>
            )}
            {canManage && onManage && <ManageButton participant={p} onManage={onManage} />}
          </div>
        ))}
      </div>
    )
  }

  const waitlistQueue = getWaitlistQueue(participants)
  const positionByUserId = new Map(waitlistQueue.map((e) => [e.participant.user_id, e]))

  const groups = STATUS_GROUP_ORDER.map((status) => ({
    status,
    members: participants.filter((p) => (p.confirmation_status || 'pending') === status),
  })).filter((g) => g.members.length > 0)

  return (
    <div className="space-y-6">
      {groups.map((group) => (
        <div key={group.status}>
          <div className="flex items-center gap-2 mb-2.5">
            <h3 className="text-sm font-semibold text-[var(--text-secondary)] uppercase tracking-wide">
              {STATUS_GROUP_LABEL[group.status]}
            </h3>
            <Badge variant="neutral" size="sm">
              {group.members.length}
            </Badge>
          </div>
          <div className="space-y-2">
            {group.members.map((p) => {
              const waitlistEntry = group.status === 'waitlist' ? positionByUserId.get(p.user_id) : undefined
              const isSelf = p.user_id === currentUserId
              const rowContent = (
                <>
                  <UserAvatar avatarData={p.user} size="md" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-[var(--text-primary)] truncate">
                        {p.user?.full_name || p.user?.email}
                        {isSelf && <span className="text-[var(--text-muted)] font-normal"> (you)</span>}
                      </span>
                      {p.role === 'organizer' && (
                        <Badge variant="secondary" size="sm">
                          Organizer
                        </Badge>
                      )}
                    </div>
                    {p.confirmation_note && (
                      <p className="text-sm text-[var(--text-secondary)] truncate mt-0.5 italic">"{p.confirmation_note}"</p>
                    )}
                    {waitlistEntry && (
                      <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                        <Badge variant="info" size="sm">
                          Queue position #{waitlistEntry.position}
                        </Badge>
                        {waitlistEntry.hasActiveOffer && p.waitlist_offer_expires_at && (
                          <Deadline date={p.waitlist_offer_expires_at} kind="offer" size="sm" />
                        )}
                      </div>
                    )}
                    {p.confirmation_status === 'conditional' && p.conditional_date && (
                      <div className="mt-1.5">
                        <Deadline date={p.conditional_date} kind="deadline" size="sm" />
                      </div>
                    )}
                  </div>
                  <ConfirmationStatusBadge status={p.confirmation_status || 'pending'} size="sm" />
                </>
              )
              return (
                <div key={p.user_id} className="relative">
                  {isSelf ? (
                    <button
                      type="button"
                      onClick={() => onSelect(p)}
                      className={`w-full flex items-center gap-3 p-3 rounded-[var(--radius-md)] bg-[var(--surface-raised)] border border-[var(--border-subtle)] hover:border-accent-300 transition-colors text-left ${canManage ? 'pr-12' : ''}`}
                    >
                      {rowContent}
                    </button>
                  ) : (
                    // Non-self rows have nothing to select (only you can edit
                    // your own RSVP) -- render as a plain, non-interactive
                    // row (same treatment as the flat groupByStatus=false
                    // path) instead of a button that silently no-ops on tap.
                    <div
                      className={`w-full flex items-center gap-3 p-3 rounded-[var(--radius-md)] bg-[var(--surface-raised)] border border-[var(--border-subtle)] ${canManage ? 'pr-12' : ''}`}
                    >
                      {rowContent}
                    </div>
                  )}
                  {canManage && onManage && <ManageButton participant={p} onManage={onManage} />}
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
