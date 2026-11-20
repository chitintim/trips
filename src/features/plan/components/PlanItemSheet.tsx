import { isIdeasBucket } from '../../../lib/ideasBucket'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Modal, Badge, Button, PriceTag, SelectionAvatars, useToast } from '../../../components/ui'
import { usePlaces } from '../../../lib/queries/usePlaces'
import { useSections, useVotes, useDeleteOption } from '../../../lib/queries/usePlanning'
import { useTimeline, useDeleteTimelineEvent } from '../../../lib/queries/useTimeline'
import { PlaceChip } from '../../places/components/PlaceChip'
import { PlaceMapThumb } from '../../places/components/PlaceMapThumb'
import { EventEditorSheet } from '../../timeline/components/EventEditorSheet'
import { BookingEditorSheet } from '../../organizer/components/BookingEditorSheet'
import { useBookings } from '../../../lib/queries/useBookings'
import { useExpenses } from '../../../lib/queries/useExpenses'
import { useParticipants } from '../../../lib/queries/useTrip'
import { useAuth } from '../../../hooks/useAuth'
import { queryKeys } from '../../../lib/queries/queryKeys'
import { dateNote } from '../../../lib/tripWindow'
import { isTravelDetailsEvent } from '../../people/lib/travelDetails'
import { isMyPlanItem, saveMyPlanItem, myPlanItemErrorMessage } from '../lib/myPlanItems'
import { actualFromExpenses, matchOptionExpenses } from '../../../lib/cost/yourCost'
import { isConfirmationEnabled } from '../../../lib/tripStatus'
import type { InScopeHeadcount } from '../../people/lib/inScopePeople'
import { computeOptionPrice } from '../../../lib/cost/optionPrice'
import { formatMoney } from '../../../lib/money'
import { OptionEditorSheet } from '../../decisions/components/OptionEditorSheet'
import { QuestionCard, QuestionManageSheet, DecideSheet, PutOnPlanSheet, MarkBookedSheet } from '../../decisions'
import { isTripFinished } from '../../../lib/answers/answers'
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
  schedule: '📅 Put it on the plan',
  mark_booked: '🧾 Mark booked',
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
}: PlanItemSheetProps) {
  const tripId = trip.id
  const { showToast } = useToast()
  const { data: places } = usePlaces(tripId)
  const { data: sections } = useSections(tripId)
  const { data: votes } = useVotes(tripId)
  const { data: events } = useTimeline(tripId)
  const { data: bookings } = useBookings(tripId)
  const { data: money } = useExpenses(tripId)
  const { data: ledgerPeople = [] } = useParticipants(tripId)
  const { user: viewer } = useAuth()

  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [deletingOwn, setDeletingOwn] = useState(false)
  const deleteOption = useDeleteOption(tripId)
  const deleteEvent = useDeleteTimelineEvent(tripId)

  const [menuOpen, setMenuOpen] = useState(false)
  const [manageOpen, setManageOpen] = useState(false)
  const [editEventOpen, setEditEventOpen] = useState(false)
  const [editOptionOpen, setEditOptionOpen] = useState(false)
  const [editBookingOpen, setEditBookingOpen] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const [markBookedOpen, setMarkBookedOpen] = useState(false)

  if (!item) return null

  const place = item.placeId ? (places || []).find((p) => p.id === item.placeId) : undefined
  const section = item.sectionId ? (sections || []).find((s) => s.id === item.sectionId) : undefined
  const option = section?.options.find((o) => o.id === item.optionId)
  const event = item.eventId ? (events || []).find((e) => e.id === item.eventId) : undefined
  const booking = item.bookingId ? (bookings || []).find((b) => b.id === item.bookingId) : undefined
  const editTarget = planItemEditTarget(item, isOrganizer)

  const bookingForPrice = booking && booking.status !== 'cancelled' ? { amount: booking.amount, currency: booking.currency, status: booking.status } : null
  const optionPrice = option
    ? computeOptionPrice(option, trip, headcount, {
        decided: !!section && isDecidedOption(section, votes ?? [], option.id),
        booking: bookingForPrice,
        booked: option.status === 'booked',
        confirmationEnabled: isConfirmationEnabled(trip),
        actual: actualFromExpenses(
          matchOptionExpenses(option.id, bookings ?? [], money?.expenses ?? []),
          ledgerPeople.map((p) => p.user_id),
          trip.base_currency || 'GBP',
          viewer?.id
        ),
      })
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
  // "Put it on the plan" on a still-open vote is the Decide sheet (one step: record the winner and give it a day).
  // An idea on the Ideas list is never decided: "Put it on the plan" just schedules THAT idea.
  const isIdea = !!decisionSection && isIdeasBucket(decisionSection)
  const scheduleClosesVote = !!section && !isIdea && section.status !== 'completed' && !decisionIsPersonal
  const tripFinished = isTripFinished(trip)
  const canSchedule = !tripFinished && !item.date && (isIdea ? !item.eventId && !!item.optionId : item.stage === 'decided' || item.stage === 'booked' || item.isUnscheduledWinner)
  const canMarkBooked = !tripFinished && item.stage === 'decided' && !!item.optionId && !!decisionSection && decisionSection.status === 'completed' && !decisionIsPersonal && !isIdea
  // Organiser actions (RLS: timeline INSERT/UPDATE/DELETE, booking edits and deletes are organiser-only
  // server-side). The one exception is a member's own "just me" item, which they edit and delete through
  // save_my_plan_item (EventEditorSheet and handleDelete below), never by writing the table.
  const viewerId = viewer?.id ?? ''
  const ownJustMe = !isOrganizer && !!event && !!viewerId && isMyPlanItem(event, viewerId)
  // A travel row belongs to its traveller's travel sheet; the generic editor cannot edit its journey fields.
  const ownTravel =
    !!event && !!viewerId && isTravelDetailsEvent(event) && !event.source_option_id && event.participant_ids?.length === 1 && event.participant_ids[0] === viewerId
  const menuActions: ItemMenuAction[] = ownJustMe
    ? ['edit_event', 'delete']
    : itemMenuActions({ isOrganizer, editTarget, hasBooking: !!booking, canSchedule, canMarkBooked }).filter((a) => !(ownTravel && a === 'edit_event'))
  const canEditDate = ownJustMe || (!ownTravel && menuActions.some((a) => a === 'edit_event' || a === 'edit_option'))
  const note = item.date ? dateNote(item.date, trip.start_date, trip.end_date) : null
  const runMenuAction = (action: ItemMenuAction) => {
    setMenuOpen(false)
    if (action === 'edit_event') setEditEventOpen(true)
    else if (action === 'edit_option') setEditOptionOpen(true)
    else if (action === 'edit_booking') setEditBookingOpen(true)
    else if (action === 'schedule') setScheduleOpen(true)
    else if (action === 'mark_booked') setMarkBookedOpen(true)
    else if (action === 'delete') setConfirmingDelete(true)
  }

  // Deleting the option a closed question decided would silently promote the
  // runner-up (the tally fallback), so it is blocked until the decision is reopened.
  const deletingDecidedOption =
    item.idKind === 'option' && !!item.optionId && !!section && isDecidedOption(section, votes || [], item.optionId)

  const handleDelete = async () => {
    try {
      if (ownJustMe && item.eventId) {
        setDeletingOwn(true)
        try {
          await saveMyPlanItem(tripId, item.eventId, null)
          await queryClient.invalidateQueries({ queryKey: queryKeys.timeline(tripId) })
        } finally {
          setDeletingOwn(false)
        }
      } else if (item.idKind === 'event' && item.eventId) {
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
      showToast({ type: 'error', message: 'Could not delete', description: ownJustMe ? myPlanItemErrorMessage(err) : (err as Error).message })
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

          {note && (
            <div className="flex flex-wrap items-center gap-2">
              <p className={`text-sm ${note.tone === 'check' ? 'text-warning-700 dark:text-warning-400' : 'text-[var(--text-muted)]'}`}>{note.text}</p>
              {note.tone === 'check' && canEditDate && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => (item.idKind === 'event' ? setEditEventOpen(true) : setEditOptionOpen(true))}
                >
                  Change date
                </Button>
              )}
            </div>
          )}

          {ownTravel && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                onClose()
                navigate(`/${tripId}?open=travel-details`)
              }}
            >
              ✈️ Edit your travel
            </Button>
          )}

          {menuOpen && menuActions.length > 0 && (
            <div role="group" aria-label="Item actions" className="flex flex-wrap gap-2 rounded-[var(--radius-md)] bg-[var(--surface-sunken)] p-2">
              {menuActions.map((action) => (
                <Button key={action} variant={action === 'delete' ? 'danger' : 'secondary'} size="sm" onClick={() => runMenuAction(action)}>
                  {action === 'schedule' && scheduleClosesVote ? '📅 Decide & put it on the plan' : MENU_LABEL[action]}
                </Button>
              ))}
            </div>
          )}

          {item.description && <p className="text-sm text-[var(--text-secondary)] whitespace-pre-wrap">{item.description}</p>}

          {/* The question card prices its own options; every other body states the option's price once, here. */}
          {optionPrice && body !== 'question' && <PriceTag price={optionPrice} size="detail" />}

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
                    {formatMoney(item.booking.amount, item.booking.currency || trip.base_currency || 'GBP', { mode: 'exact' })}
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
        <QuestionManageSheet isOpen={manageOpen} onClose={() => setManageOpen(false)} tripId={tripId} sectionId={decisionSection.id} />
      )}

      {isOrganizer && scheduleClosesVote && section && (
        <DecideSheet isOpen={scheduleOpen} onClose={() => setScheduleOpen(false)} trip={trip} section={section} initialOptionId={item.optionId} />
      )}
      {isOrganizer && !scheduleClosesVote && item.optionId && (
        <PutOnPlanSheet
          isOpen={scheduleOpen}
          onClose={() => setScheduleOpen(false)}
          trip={trip}
          target={{ optionId: item.optionId, title: item.title, description: item.description, placeId: item.placeId, category: item.category }}
        />
      )}
      {isOrganizer && item.optionId && (
        <MarkBookedSheet isOpen={markBookedOpen} onClose={() => setMarkBookedOpen(false)} trip={trip} option={{ id: item.optionId, title: item.title }} mode="mark" />
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
              <Button variant="danger" onClick={handleDelete} disabled={deletingDecidedOption} isLoading={deleteEvent.isPending || deleteOption.isPending || deletingOwn}>
                Delete
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  )
}
