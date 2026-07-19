import { useMemo, useState } from 'react'
import { Modal, Badge, Button, Chip, UserAvatar, TextArea, SelectionAvatars } from '../../../components/ui'
import { useAuth } from '../../../hooks/useAuth'
import { usePlaces } from '../../../lib/queries/usePlaces'
import { useParticipants } from '../../../lib/queries/useTrip'
import {
  useSections,
  useVotes,
  useReactions,
  useComments,
  useToggleVote,
  useToggleReaction,
  useCreateComment,
} from '../../../lib/queries/usePlanning'
import { useTimeline, useDeleteTimelineEvent } from '../../../lib/queries/useTimeline'
import { useDeleteOption } from '../../../lib/queries/usePlanning'
import { PlaceChip } from '../../places/components/PlaceChip'
import { PlaceMapThumb } from '../../places/components/PlaceMapThumb'
import { EventEditorSheet } from '../../timeline/components/EventEditorSheet'
import { BookingEditorSheet } from '../../organizer/components/BookingEditorSheet'
import { useBookings } from '../../../lib/queries/useBookings'
import { areVotesVisible, votingInstruction, replaceableSiblingVoteIds } from '../../decisions/lib/voting'
import { formatCostImpact } from '../../decisions/lib/costImpact'
import { OptionEditorSheet } from '../../decisions/components/OptionEditorSheet'
import { getDecisionShape } from '../../decisions/lib/decisionShapes'
import { formatTimeRange, CATEGORY_CONFIG } from '../../timeline/lib/categoryConfig'
import { planItemEditTarget } from '../lib/planItems'
import type { PlanItem } from '../lib/planItems'
import type { Trip } from '../../../types'

const QUICK_REACTIONS = ['🙌', '😬', '💸', '❤️', '👀']

export interface PlanItemSheetProps {
  isOpen: boolean
  onClose: () => void
  trip: Trip
  item: PlanItem | null
  isOrganizer: boolean
  confirmedCount: number
  /** Navigate to the Money space for this item's linked expense. */
  onNavigateToExpense?: (expenseId: string) => void
  /** "Schedule it" — opens a day/time picker to place a decided-but-undated item onto the timeline. */
  onScheduleIt?: (item: PlanItem) => void
}

/**
 * One detail sheet for any PlanItem, regardless of stage (plan §2 "Item
 * detail sheet unifies everything about one item"). Reuses decisions'
 * voting/reaction/comment internals for option-backed items (proposal/
 * idea), and the timeline/organizer editors for edit flows.
 */
export function PlanItemSheet({
  isOpen,
  onClose,
  trip,
  item,
  isOrganizer,
  confirmedCount,
  onNavigateToExpense,
  onScheduleIt,
}: PlanItemSheetProps) {
  const tripId = trip.id
  const { user } = useAuth()
  const { data: places } = usePlaces(tripId)
  const { data: participants } = useParticipants(tripId)
  const { data: sections } = useSections(tripId)
  const { data: votes } = useVotes(tripId)
  const { data: reactions } = useReactions(tripId)
  const { data: events } = useTimeline(tripId)
  const { data: bookings } = useBookings(tripId)
  const sectionIds = useMemo(() => (sections || []).map((s) => s.id), [sections])
  const { data: comments } = useComments(tripId, sectionIds)

  const toggleVote = useToggleVote(tripId)
  const toggleReaction = useToggleReaction(tripId)
  const createComment = useCreateComment(tripId)
  const deleteOption = useDeleteOption(tripId)
  const deleteEvent = useDeleteTimelineEvent(tripId)

  const [showComments, setShowComments] = useState(false)
  const [commentDraft, setCommentDraft] = useState('')
  const [editEventOpen, setEditEventOpen] = useState(false)
  const [editOptionOpen, setEditOptionOpen] = useState(false)
  const [editBookingOpen, setEditBookingOpen] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  if (!item) return null

  const place = item.placeId ? (places || []).find((p) => p.id === item.placeId) : undefined
  const section = item.sectionId ? (sections || []).find((s) => s.id === item.sectionId) : undefined
  const option = section?.options.find((o) => o.id === item.optionId)
  const event = item.eventId ? (events || []).find((e) => e.id === item.eventId) : undefined
  const booking = item.bookingId ? (bookings || []).find((b) => b.id === item.bookingId) : undefined
  const editTarget = planItemEditTarget(item, isOrganizer)

  const optionVotes = item.optionId ? (votes || []).filter((v) => v.option_id === item.optionId) : []
  const myVote = optionVotes.find((v) => v.user_id === user?.id)
  const votesVisible = item.vote
    ? areVotesVisible({ vote_deadline: item.vote.voteDeadline, hide_votes_until_close: item.vote.hideVotesUntilClose })
    : true

  const optionReactions = item.optionId ? (reactions || []).filter((r) => r.option_id === item.optionId) : []
  const reactionCounts = new Map<string, number>()
  optionReactions.forEach((r) => reactionCounts.set(r.emoji, (reactionCounts.get(r.emoji) || 0) + 1))
  const myReactions = new Set(optionReactions.filter((r) => r.user_id === user?.id).map((r) => r.emoji))
  const optionComments = item.optionId ? (comments || []).filter((c) => c.option_id === item.optionId) : []

  const byUserId = new Map((participants || []).map((p) => [p.user_id, p]))

  const costImpactLabel = option
    ? formatCostImpact({ price: option.price, currency: option.currency, priceType: option.price_type, confirmedCount })
    : null

  const category = event ? CATEGORY_CONFIG[event.category] ?? CATEGORY_CONFIG.other : null
  const timeRange = event ? formatTimeRange(event.all_day, event.start_time, event.end_time) : null

  const handleVote = () => {
    if (!user || !item.optionId) return
    if (myVote) {
      toggleVote.mutate({ optionId: item.optionId, userId: user.id, action: 'remove', voteId: myVote.id })
    } else {
      // Radio semantics for single-choice polls: casting here replaces any
      // vote I already have on a sibling option (see useToggleVote).
      const replaceVoteIds = section
        ? replaceableSiblingVoteIds(
            section.options.map((o) => o.id),
            votes || [],
            user.id,
            item.optionId,
            item.vote?.votingMethod ?? 'single'
          )
        : []
      toggleVote.mutate({ optionId: item.optionId, userId: user.id, action: 'add', replaceVoteIds })
    }
  }

  const handleReaction = (emoji: string) => {
    if (!user || !item.optionId) return
    const existing = optionReactions.find((r) => r.user_id === user.id && r.emoji === emoji)
    if (existing) {
      toggleReaction.mutate({ targetType: 'option', targetId: item.optionId, userId: user.id, emoji, action: 'remove', reactionId: existing.id })
    } else {
      toggleReaction.mutate({ targetType: 'option', targetId: item.optionId, userId: user.id, emoji, action: 'add' })
    }
  }

  const handleAddComment = () => {
    if (!user || !commentDraft.trim() || !item.optionId) return
    createComment.mutate({ option_id: item.optionId, user_id: user.id, content: commentDraft.trim() })
    setCommentDraft('')
  }

  const handleDelete = async () => {
    if (item.idKind === 'event' && item.eventId) {
      await deleteEvent.mutateAsync(item.eventId)
    } else if (item.idKind === 'option' && item.optionId) {
      await deleteOption.mutateAsync(item.optionId)
    }
    setConfirmingDelete(false)
    onClose()
  }

  const stageBadge = {
    idea: { variant: 'neutral' as const, label: 'Idea' },
    proposal: { variant: 'info' as const, label: 'Proposal' },
    decided: { variant: 'success' as const, label: 'Decided' },
    booked: { variant: 'success' as const, label: 'Booked' },
  }[item.stage]

  return (
    <>
      <Modal isOpen={isOpen} onClose={onClose} size="md" title={item.title}>
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={stageBadge.variant} size="sm">
              {stageBadge.label}
            </Badge>
            {item.date && (
              <Badge variant="neutral" size="sm">
                {new Date(`${item.date}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
                {timeRange ? ` · ${timeRange}` : ''}
              </Badge>
            )}
            {category && (
              <span className={`rounded-[var(--radius-sm)] px-1.5 py-0.5 text-xs font-medium ${category.badgeClassName}`}>
                {category.emoji} {category.label}
              </span>
            )}
            {item.sectionTitle && <Badge variant="neutral" size="sm">{item.sectionTitle}</Badge>}
            {costImpactLabel && <Badge variant="info" size="sm">{costImpactLabel}</Badge>}
          </div>

          {item.description && <p className="text-sm text-[var(--text-secondary)] whitespace-pre-wrap">{item.description}</p>}

          {/* Who's committed to this option (planItems.ts rule 7): covers
              both pre-v3 legacy picks and any decided/personal-order option
              carrying `selections`. */}
          {item.selections.length > 0 && (
            <div className="flex items-center gap-2">
              <SelectionAvatars
                selections={item.selections.map((s) => ({
                  id: s.id,
                  selected_at: s.selected_at ?? undefined,
                  user: s.user
                    ? {
                        full_name: s.user.full_name ?? undefined,
                        email: s.user.email ?? undefined,
                        avatar_url: s.user.avatar_url ?? undefined,
                        avatar_data: (s.user.avatar_data as { emoji: string; bgColor: string } | null) ?? undefined,
                      }
                    : undefined,
                }))}
                maxAvatars={6}
                size="sm"
              />
              <span className="text-xs text-[var(--text-muted)]">
                {item.selections.length} {item.selections.length === 1 ? 'person has' : 'people have'} picked this
              </span>
            </div>
          )}

          {place && (
            <div className="space-y-2">
              <PlaceChip place={place} />
              {place.lat != null && place.lng != null && <PlaceMapThumb lat={place.lat} lng={place.lng} height={140} />}
            </div>
          )}

          {/* Voting (option-backed items only) */}
          {item.vote && option && (
            <div className="space-y-2 border-t border-[var(--border-subtle)] pt-3">
              {/* Pick-one vs pick-multiple, spelled out (voting-clarity ask). */}
              <p className="text-xs font-medium text-[var(--text-secondary)]">
                {item.vote.votingMethod === 'approval' ? '☑️' : '🔘'} {votingInstruction(item.vote.votingMethod)}
              </p>
              <div className="flex items-center gap-3 flex-wrap">
                <Button
                  variant={myVote ? 'primary' : 'secondary'}
                  size="sm"
                  onClick={handleVote}
                  disabled={option.locked}
                  isLoading={toggleVote.isPending}
                >
                  {myVote
                    ? item.vote.votingMethod === 'ranked'
                      ? `Ranked #${myVote.rank ?? 1}`
                      : item.vote.votingMethod === 'approval'
                        ? '✓ Approved'
                        : '✓ Your choice'
                    : item.vote.votingMethod === 'approval'
                      ? 'Approve'
                      : item.vote.votingMethod === 'ranked'
                        ? 'Tap to rank next'
                        : 'Choose'}
                </Button>
                {votesVisible ? (
                  <span className="text-sm text-[var(--text-secondary)]">
                    {item.vote.totalVotes} vote{item.vote.totalVotes === 1 ? '' : 's'}
                  </span>
                ) : (
                  <span className="text-xs text-[var(--text-muted)]">Votes hidden until close</span>
                )}
              </div>

              <div className="flex items-center gap-1.5 flex-wrap">
                {QUICK_REACTIONS.map((emoji) => {
                  const count = reactionCounts.get(emoji) || 0
                  const mine = myReactions.has(emoji)
                  return (
                    <Chip key={emoji} size="sm" selected={mine} onClick={() => handleReaction(emoji)}>
                      {emoji} {count > 0 ? count : ''}
                    </Chip>
                  )
                })}
                <button
                  type="button"
                  onClick={() => setShowComments((s) => !s)}
                  className="text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] ml-1"
                >
                  💬 {optionComments.length > 0 ? optionComments.length : 'Comment'}
                </button>
              </div>

              {showComments && (
                <div className="space-y-2 pt-2 border-t border-[var(--border-subtle)]">
                  {optionComments.map((c) => {
                    const author = byUserId.get(c.user_id)
                    return (
                      <div key={c.id} className="flex items-start gap-2">
                        <UserAvatar avatarData={author?.user} size="xs" />
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium text-[var(--text-secondary)]">
                            {author?.user?.full_name || author?.user?.email || 'Someone'}
                          </p>
                          <p className="text-sm text-[var(--text-primary)]">{c.content}</p>
                        </div>
                      </div>
                    )
                  })}
                  <div className="flex gap-2">
                    <TextArea value={commentDraft} onChange={(e) => setCommentDraft(e.target.value)} placeholder="Add a comment..." rows={1} fullWidth />
                    <Button size="sm" onClick={handleAddComment} disabled={!commentDraft.trim()} isLoading={createComment.isPending}>
                      Send
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Booking fields */}
          {item.booking && (
            <div className="space-y-1.5 rounded-[var(--radius-md)] bg-[var(--surface-sunken)] p-3 text-sm">
              <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Booking</p>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[var(--text-secondary)]">
                {item.booking.vendor && <span>Vendor: {item.booking.vendor}</span>}
                {item.booking.confirmationRef && <span>Ref: {item.booking.confirmationRef}</span>}
                {item.booking.cancellationDeadline && (
                  <span>Free cancellation until {new Date(item.booking.cancellationDeadline).toLocaleString()}</span>
                )}
                {item.booking.amount != null && (
                  <span>
                    {item.booking.currency} {item.booking.amount.toFixed(2)}
                  </span>
                )}
              </div>
              {isOrganizer && (
                <Button variant="ghost" size="sm" onClick={() => setEditBookingOpen(true)}>
                  Edit booking
                </Button>
              )}
            </div>
          )}

          {/* Linked expense */}
          {item.expenseId && onNavigateToExpense && (
            <button
              type="button"
              onClick={() => onNavigateToExpense(item.expenseId!)}
              className="w-full flex items-center justify-between rounded-[var(--radius-md)] border border-[var(--border-default)] px-3 py-2 text-sm hover:border-accent-400 transition-colors"
            >
              <span className="text-[var(--text-primary)]">💵 View linked expense</span>
              <span className="text-accent-600 dark:text-accent-400">→</span>
            </button>
          )}

          {/* Schedule it — decided-but-undated items (also booked-but-undated: a
              legacy option can be status='booked' directly, with no dated
              timeline event yet, per planItems.ts rule 6). Organizer-gated to
              match RLS: trip_timeline_events INSERT is organizer-only
              server-side, so showing this to everyone just produced an error
              toast for non-organizers. */}
          {isOrganizer && !item.date && (item.stage === 'decided' || item.stage === 'booked' || item.isUnscheduledWinner) && onScheduleIt && (
            <Button variant="secondary" fullWidth onClick={() => onScheduleIt(item)}>
              📅 Schedule it
            </Button>
          )}

          {/* Edit/delete */}
          <div className="flex items-center justify-between gap-3 border-t border-[var(--border-subtle)] pt-3">
            <div>
              {isOrganizer && (
                <Button variant="danger" size="sm" onClick={() => setConfirmingDelete(true)}>
                  Delete
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              {editTarget === 'event' && (
                <Button variant="secondary" size="sm" onClick={() => setEditEventOpen(true)}>
                  Edit
                </Button>
              )}
              {/* Vote-shape options were previously uneditable anywhere in the
                  live app (OptionEditorSheet existed but was only mounted by
                  the unreachable DecisionsTab) — this is the wiring that
                  fixes it, gated the same organizer-only way delete already
                  is above (see planItemEditTarget). */}
              {editTarget === 'option' && option && (
                <Button variant="secondary" size="sm" onClick={() => setEditOptionOpen(true)}>
                  Edit
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={onClose}>
                Close
              </Button>
            </div>
          </div>
        </div>
      </Modal>

      {item.idKind === 'event' && event && (
        <EventEditorSheet isOpen={editEventOpen} onClose={() => setEditEventOpen(false)} trip={trip} event={event} />
      )}

      {item.idKind === 'option' && section && option && (
        <OptionEditorSheet
          isOpen={editOptionOpen}
          onClose={() => setEditOptionOpen(false)}
          tripId={tripId}
          sectionId={section.id}
          option={option}
          decisionShape={getDecisionShape(section.metadata)}
        />
      )}

      {booking && <BookingEditorSheet isOpen={editBookingOpen} onClose={() => setEditBookingOpen(false)} trip={trip} booking={booking} />}

      {confirmingDelete && (
        <Modal isOpen onClose={() => setConfirmingDelete(false)} size="sm" title={`Delete "${item.title}"?`}>
          <div className="space-y-4">
            <p className="text-sm text-[var(--text-secondary)]">This can't be undone.</p>
            <div className="flex justify-end gap-3">
              <Button variant="ghost" onClick={() => setConfirmingDelete(false)}>
                Cancel
              </Button>
              <Button variant="danger" onClick={handleDelete} isLoading={deleteEvent.isPending || deleteOption.isPending}>
                Delete
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  )
}
