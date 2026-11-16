import { useState } from 'react'
import { Modal, Badge, Button, SelectionAvatars, useToast } from '../../../components/ui'
import { usePlaces } from '../../../lib/queries/usePlaces'
import { useSections, useVotes, useDeleteOption } from '../../../lib/queries/usePlanning'
import { useTimeline, useDeleteTimelineEvent } from '../../../lib/queries/useTimeline'
import { PlaceChip } from '../../places/components/PlaceChip'
import { PlaceMapThumb } from '../../places/components/PlaceMapThumb'
import { EventEditorSheet } from '../../timeline/components/EventEditorSheet'
import { BookingEditorSheet } from '../../organizer/components/BookingEditorSheet'
import { useBookings } from '../../../lib/queries/useBookings'
import type { InScopeHeadcount } from '../../people/lib/inScopePeople'
import { formatCostImpact } from '../../decisions/lib/costImpact'
import { OptionEditorSheet } from '../../decisions/components/OptionEditorSheet'
import { QuestionCard, QuestionManageSheet } from '../../decisions'
import { isDecidedOption } from '../../decisions/lib/resolveDecision'
import { getDecisionShape } from '../../decisions/lib/decisionShapes'
import { formatTimeRange, CATEGORY_CONFIG } from '../../timeline/lib/categoryConfig'
import { planItemEditTarget } from '../lib/planItems'
import type { PlanItem } from '../lib/planItems'
import { planItemStatus, bookingSummaryText, liveBookedOptionIds, itemMenuActions, sheetBody, type ItemMenuAction } from '../lib/itemSheet'
import type { Trip } from '../../../types'

const MENU_LABEL: Record<ItemMenuAction, string> = {
  edit_event: 'Edit',
  edit_option: 'Edit option',
  edit_booking: 'Edit booking',
  schedule: '📅 Schedule it',
  delete: 'Delete',
}

export interface PlanItemSheetProps {
  isOpen: boolean
  onClose: () => void
  trip: Trip
  item: PlanItem | null
  isOrganizer: boolean
  /** In-scope headcount (people/lib/inScopePeople) the cost is split across. */
  headcount: InScopeHeadcount
  /** Navigate to the Money space for this item's linked expense. */
  onNavigateToExpense?: (expenseId: string) => void
  /** "Schedule it" — opens a day/time picker to place a decided-but-undated item onto the timeline. */
  onScheduleIt?: (item: PlanItem) => void
  /** "Put it on the plan" from the question's Manage sheet (decided option). Omitted = not offered. */
  onScheduleOption?: (sectionId: string, optionId: string) => void
}

/**
 * One detail sheet for any PlanItem. For an option that belongs to a question
 * it shows that question's card (open: the shared AnswerControl; decided: the
 * outcome; booked: the booking state), so there is no separate Vote button.
 * Organiser actions for the QUESTION sit behind the card's "⋯ Manage"; the
 * item-level ones (edit, booking, schedule, delete) sit behind one "⋯" menu.
 * Reactions and comments are hidden (both tables are empty; the redesign
 * retires them).
 */
export function PlanItemSheet({
  isOpen,
  onClose,
  trip,
  item,
  isOrganizer,
  headcount,
  onNavigateToExpense,
  onScheduleIt,
  onScheduleOption,
}: PlanItemSheetProps) {
  const tripId = trip.id
  const { showToast } = useToast()
  const { data: places } = usePlaces(tripId)
  const { data: sections } = useSections(tripId)
  const { data: votes } = useVotes(tripId)
  const { data: events } = useTimeline(tripId)
  const { data: bookings } = useBookings(tripId)

  const deleteOption = useDeleteOption(tripId)
  const deleteEvent = useDeleteTimelineEvent(tripId)

  const [menuOpen, setMenuOpen] = useState(false)
  const [manageOpen, setManageOpen] = useState(false)
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

  const costImpactLabel = option
    ? formatCostImpact({ price: option.price, currency: option.currency, priceType: option.price_type, confirmedCount: headcount.count, isEstimate: headcount.isEstimate, metadata: option.metadata })
    : null

  const category = event ? CATEGORY_CONFIG[event.category] ?? CATEGORY_CONFIG.other : null
  const timeRange = event ? formatTimeRange(event.all_day, event.start_time, event.end_time) : null

  // The section that owns this item's option, even for a timeline event that
  // absorbed it (events carry source_option_id but no sectionId).
  const decisionSection = item.optionId ? (sections || []).find((s) => s.options.some((o) => o.id === item.optionId)) : undefined
  const decisionIsPersonal = decisionSection ? getDecisionShape(decisionSection.metadata) === 'personal' : false
  const body = sheetBody({ item, section: decisionSection })
  const questionOpen = !!decisionSection && decisionSection.status !== 'completed'
  const status = planItemStatus(item)
  const bookedIds = liveBookedOptionIds(bookings || [])
  const bookedSummary = bookingSummaryText(item.booking)
  // "Schedule it" on a still-open vote closes it and records this option as the decision.
  const scheduleClosesVote = !!section && section.status !== 'completed' && !decisionIsPersonal
  const canSchedule = !item.date && (item.stage === 'decided' || item.stage === 'booked' || item.isUnscheduledWinner) && !!onScheduleIt
  // Organiser-only (RLS: timeline INSERT, booking edits and deletes are organiser-only server-side).
  const menuActions = itemMenuActions({ isOrganizer, editTarget, hasBooking: !!booking, canSchedule })
  const runMenuAction = (action: ItemMenuAction) => {
    setMenuOpen(false)
    if (action === 'edit_event') setEditEventOpen(true)
    else if (action === 'edit_option') setEditOptionOpen(true)
    else if (action === 'edit_booking') setEditBookingOpen(true)
    else if (action === 'schedule') onScheduleIt?.(item)
    else if (action === 'delete') setConfirmingDelete(true)
  }

  // Deleting the option a closed question decided would silently promote the
  // runner-up (the tally fallback), so it is blocked until the decision is reopened.
  const deletingDecidedOption =
    item.idKind === 'option' && !!item.optionId && !!section && isDecidedOption(section, votes || [], item.optionId)

  const handleDelete = async () => {
    try {
      if (item.idKind === 'event' && item.eventId) {
        await deleteEvent.mutateAsync(item.eventId)
      } else if (item.idKind === 'option' && item.optionId) {
        if (deletingDecidedOption) {
          showToast({ type: 'error', message: 'This option is the answer', description: 'Reopen the question first, then delete the option.' })
          return
        }
        await deleteOption.mutateAsync(item.optionId)
      }
      setConfirmingDelete(false)
      onClose()
    } catch (err) {
      showToast({ type: 'error', message: 'Could not delete', description: (err as Error).message })
    }
  }

  return (
    <>
      <Modal isOpen={isOpen} onClose={onClose} size="md" title={item.title}>
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {status && (
              <Badge variant={status.variant} size="sm">
                {status.label}
              </Badge>
            )}
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
            {menuActions.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto"
                aria-expanded={menuOpen}
                aria-haspopup="true"
                aria-label="More actions for this item"
                onClick={() => setMenuOpen((v) => !v)}
              >
                ⋯
              </Button>
            )}
          </div>

          {menuOpen && menuActions.length > 0 && (
            <div role="group" aria-label="Item actions" className="flex flex-wrap gap-2 rounded-[var(--radius-md)] bg-[var(--surface-sunken)] p-2">
              {menuActions.map((action) => (
                <Button key={action} variant={action === 'delete' ? 'danger' : 'secondary'} size="sm" onClick={() => runMenuAction(action)}>
                  {action === 'schedule' && scheduleClosesVote ? '📅 Close question & schedule' : MENU_LABEL[action]}
                </Button>
              ))}
            </div>
          )}

          {item.description && <p className="text-sm text-[var(--text-secondary)] whitespace-pre-wrap">{item.description}</p>}

          {/* Who's committed to this option (planItems.ts rule 7): covers
              both pre-v3 legacy picks and any decided/personal-order option
              carrying `selections`. */}
          {body === 'plain' && item.selections.length > 0 && (
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
                {item.selections.length} {item.selections.length === 1 ? 'person has' : 'people have'} chosen this
              </span>
            </div>
          )}

          {place && (
            <div className="space-y-2">
              <PlaceChip place={place} />
              {place.lat != null && place.lng != null && <PlaceMapThumb lat={place.lat} lng={place.lng} height={140} />}
            </div>
          )}

          {/* The question this option belongs to: open -> the shared answer
              control; decided -> the outcome; booked -> the booking state.
              "⋯ Manage" (organisers) is the only entry to question-level actions. */}
          {body === 'question' && decisionSection && (
            <QuestionCard
              trip={trip}
              section={decisionSection}
              defaultExpanded={questionOpen ? true : undefined}
              focusOptionId={item.optionId}
              bookedOptionIds={bookedIds}
              bookedSummary={bookedSummary ? <>🧾 {bookedSummary}</> : undefined}
              onManage={isOrganizer ? () => setManageOpen(true) : undefined}
            />
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
              {item.booking.cancelled && <p className="font-medium text-[var(--text-primary)]">⚠️ Booking cancelled — needs rebooking</p>}
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

          <div className="flex justify-end border-t border-[var(--border-subtle)] pt-3">
            <Button variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
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

      {isOrganizer && decisionSection && (
        <QuestionManageSheet isOpen={manageOpen} onClose={() => setManageOpen(false)} tripId={tripId} sectionId={decisionSection.id} onSchedule={onScheduleOption} />
      )}

      {confirmingDelete && (
        <Modal isOpen onClose={() => setConfirmingDelete(false)} size="sm" title={`Delete "${item.title}"?`}>
          <div className="space-y-4">
            {deletingDecidedOption ? (
              <p className="text-sm text-[var(--text-secondary)]">
                This option is the group's recorded decision. Reopen the decision first, then delete it, otherwise the runner-up would silently become the decision.
              </p>
            ) : (
              <p className="text-sm text-[var(--text-secondary)]">This can't be undone.</p>
            )}
            <div className="flex justify-end gap-3">
              <Button variant="ghost" onClick={() => setConfirmingDelete(false)}>
                Cancel
              </Button>
              <Button variant="danger" onClick={handleDelete} disabled={deletingDecidedOption} isLoading={deleteEvent.isPending || deleteOption.isPending}>
                Delete
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  )
}
