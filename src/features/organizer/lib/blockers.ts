import type { ParticipantWithUser } from '../../../lib/queries/useTrip'
import type { SectionWithOptions, OptionVote } from '../../../lib/queries/usePlanning'
import type { ExpenseWithDetails } from '../../../lib/queries/useExpenses'
import type { Settlement } from '../../../lib/queries/useSettlements'
import type { Booking } from '../../../lib/queries/useBookings'
import type { Notification } from '../../../lib/queries/useNotifications'
import type { BlockerType } from '../../../shared/contracts/nudgeDraft'
import { computeWaitingOn } from '../../../lib/todos/computeTodos'
import type { SnapshotAction, SnapshotChecklistItem, SnapshotTravelEvent, Todo, TripSnapshot } from '../../../lib/todos/types'

/**
 * Thin adapter between the to-dos engine and the organiser console.
 *
 * There is no longer any "blocker" rule of its own: who owes what is decided
 * by `computeWaitingOn` (src/lib/todos), the same engine that fills each
 * person's own to-dos, so the console and a participant's list cannot
 * disagree. This file only
 *   - maps a `Todo` to the `Blocker` shape the nudge composer and older
 *     consumers expect (`todoToBlocker`),
 *   - adds the console-only extras the engine does not model: last-reminded
 *     time, "needs a personal nudge" (auto-chase gave up) and upcoming
 *     booking cancellation deadlines,
 *   - keeps `computeBlockers(input)` working for callers that still hand in
 *     raw query data (Today's BlockersStrip).
 *
 * No React, no fetching.
 */

export type BlockerKind =
  | 'pending_rsvp'
  | 'due_conditional'
  | 'unvoted_poll'
  | 'unfilled_order'
  | 'unclaimed_items'
  | 'unconfirmed_settlement'
  | 'expiring_waitlist_offer'
  | 'booking_cancellation_deadline'
  | 'escalation'
  | 'task'
  | 'travel_details'
  | 'organiser'

export interface Blocker {
  kind: BlockerKind
  /** User who owes the action. */
  userId: string
  /** Short chip label (the to-do's own title, verbatim). */
  label: string
  /** Longer description for detail rows/sheets. */
  detail?: string
  /** Entity backing the blocker (expense/section/settlement/booking id). */
  entityId?: string
  /** Deadline driving urgency, if any (ISO string). */
  deadline?: string | null
  /**
   * nudge-draft blocker_type for the AI composer; null when the blocker has
   * no sensible nudge (e.g. a booking deadline is trip-level info).
   */
  nudgeType: BlockerType | null
}

export interface PersonBlockers {
  userId: string
  name: string
  avatarUrl: unknown
  avatarData: unknown
  blockers: Blocker[]
  /** Auto-chase has sent `maxReminders`+ reminders for one thing with no result. */
  escalated?: boolean
  /** ISO time of the latest reminder logged for this person, or null. */
  lastRemindedAt?: string | null
}

export interface BlockersBoardData {
  people: PersonBlockers[]
  /** Trip-level (not person-actionable) warnings: upcoming cancellation deadlines. */
  bookingDeadlines: Blocker[]
  /** To-dos owed + booking deadlines (deadlines are not to-dos; see `todoCount`). */
  totalCount: number
  /** Sum of every person's to-do count: equals what each person sees. */
  todoCount: number
}

export interface ComputeBlockersInput {
  participants: ParticipantWithUser[]
  sections: SectionWithOptions[]
  votes: OptionVote[]
  expenses: ExpenseWithDetails[]
  settlements: Settlement[]
  bookings: Booking[]
  notifications: Notification[]
  /** Reminder count at which auto-chase stops and escalates (chase_settings.max_reminders, default 3). */
  maxReminders?: number
  now?: number
  /** How far ahead a booking cancellation deadline counts as "upcoming". Default 7 days. */
  bookingDeadlineWindowMs?: number
  /**
   * Whether the trip tracks RSVP confirmation status (trips.confirmation_enabled).
   * Only used when `trip` is not supplied. Defaults to true.
   */
  confirmationEnabled?: boolean
  /**
   * Optional engine inputs the legacy callers do not have. Pass them (or
   * better, use `useWaitingOn`) to get task / packing / travel to-dos too.
   */
  trip?: TripSnapshot['trip']
  actions?: ReadonlyArray<SnapshotAction>
  checklists?: ReadonlyArray<SnapshotChecklistItem>
  travelEvents?: ReadonlyArray<SnapshotTravelEvent>
  balances?: Readonly<Record<string, number>>
}

const DAY_MS = 24 * 60 * 60 * 1000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Nudge-draft blocker_type for a to-do (null = no AI draft, hand-written fallback). */
function nudgeTypeFor(todo: Todo): BlockerType | null {
  switch (todo.kind) {
    case 'rsvp':
    case 'waitlist_offer':
      return 'pending_rsvp'
    case 'answer':
      return 'unvoted_poll'
    case 'claim':
      return 'unclaimed_items'
    case 'pay':
    case 'respond_payment':
    case 'confirm_payment':
      return 'unpaid_settlement'
    default:
      return null
  }
}

function blockerKindFor(todo: Todo): BlockerKind {
  switch (todo.kind) {
    case 'rsvp':
      return 'pending_rsvp'
    case 'waitlist_offer':
      return 'expiring_waitlist_offer'
    case 'answer':
      return todo.shape === 'own' ? 'unfilled_order' : 'unvoted_poll'
    case 'claim':
      return 'unclaimed_items'
    case 'pay':
    case 'respond_payment':
    case 'confirm_payment':
      return 'unconfirmed_settlement'
    case 'task':
      return 'task'
    case 'travel':
      return 'travel_details'
    default:
      return 'organiser'
  }
}

/** True for to-dos the organiser owes themselves (decide / book / set up): never nudged. */
export function isOrganiserOwn(todo: Pick<Todo, 'group'>): boolean {
  return todo.group === 'organiser'
}

/**
 * Map one engine to-do to the `Blocker` the nudge composer takes. The label
 * is the to-do's own title, so the console reads exactly as the person's list.
 */
export function todoToBlocker(todo: Todo): Blocker {
  return {
    kind: blockerKindFor(todo),
    userId: todo.userId,
    label: todo.title,
    detail: todo.subtitle ? `${todo.title}. ${todo.subtitle}` : todo.title,
    // blocker_entity_id must be a UUID; synthetic ids ('pay:settle', trip id for rsvp) are left out.
    entityId: todo.kind !== 'rsvp' && todo.kind !== 'waitlist_offer' && UUID_RE.test(todo.entityId) ? todo.entityId : undefined,
    deadline: todo.due,
    nudgeType: nudgeTypeFor(todo),
  }
}

const LAST_REMINDED_RECENT_DAYS = 14

/** A reminder from months ago on a finished trip is noise: show it when recent, or while the trip is still live. */
export function showLastReminded(remindedAt: string | Date, tripFinished: boolean, now: Date = new Date()): boolean {
  if (!tripFinished) return true
  return now.getTime() - new Date(remindedAt).getTime() <= LAST_REMINDED_RECENT_DAYS * 86_400_000
}

/** Latest reminder time per recipient, from the notifications log. */
export function lastRemindedByUser(notifications: ReadonlyArray<Pick<Notification, 'user_id' | 'sent_at'>>): Map<string, string> {
  const out = new Map<string, string>()
  for (const n of notifications) {
    if (!n.sent_at) continue
    const prev = out.get(n.user_id)
    if (!prev || new Date(n.sent_at).getTime() > new Date(prev).getTime()) out.set(n.user_id, n.sent_at)
  }
  return out
}

/**
 * People for whom auto-chase has sent `maxReminders`+ reminders about the
 * same thing (kind + entity) with no result: time for a personal nudge.
 */
export function escalatedUserIds(notifications: ReadonlyArray<Pick<Notification, 'user_id' | 'kind' | 'entity_id'>>, maxReminders = 3): Set<string> {
  const counts = new Map<string, { n: number; userId: string }>()
  for (const n of notifications) {
    const key = `${n.kind}:${n.entity_id ?? ''}:${n.user_id}`
    const e = counts.get(key)
    if (e) e.n += 1
    else counts.set(key, { n: 1, userId: n.user_id })
  }
  const out = new Set<string>()
  for (const c of counts.values()) if (c.n >= maxReminders) out.add(c.userId)
  return out
}

/** Upcoming (within the window) cancellation deadlines of live bookings. Trip-level info, not a to-do. */
export function upcomingCancellationDeadlines(
  bookings: ReadonlyArray<Booking>,
  now: number = Date.now(),
  windowMs: number = 7 * DAY_MS
): Blocker[] {
  const out: Blocker[] = []
  for (const b of bookings) {
    if (b.status === 'cancelled' || !b.cancellation_deadline) continue
    const deadline = new Date(b.cancellation_deadline).getTime()
    if (deadline <= now || deadline - now > windowMs) continue
    out.push({
      kind: 'booking_cancellation_deadline',
      userId: b.booked_by,
      label: `Free cancellation on "${b.title}" ends soon`,
      detail: `Cancellation deadline ${new Date(b.cancellation_deadline).toLocaleString()}.`,
      entityId: b.id,
      deadline: b.cancellation_deadline,
      nudgeType: 'expiring_cancellation_window',
    })
  }
  return out
}

/** Legacy entry point: raw query data in, engine-backed board out (personal to-dos only). */
export function computeBlockers(input: ComputeBlockersInput): BlockersBoardData {
  const {
    participants,
    notifications,
    maxReminders = 3,
    now = Date.now(),
    bookingDeadlineWindowMs = 7 * DAY_MS,
    confirmationEnabled = true,
  } = input

  const trip: TripSnapshot['trip'] = input.trip ?? {
    id: '',
    name: '',
    status: 'confirming_participants',
    start_date: '2099-01-01',
    end_date: '2099-01-02',
    confirmation_enabled: confirmationEnabled,
    confirmation_deadline: null,
    base_currency: 'GBP',
  }
  const snapshot: TripSnapshot = {
    trip,
    participants,
    sections: input.sections,
    votes: input.votes,
    actions: input.actions ?? [],
    checklists: input.checklists ?? [],
    expenses: input.expenses,
    settlements: input.settlements,
    balances: input.balances,
    travelEvents: input.travelEvents ?? [],
    bookings: input.bookings,
  }
  // Personal to-dos only: this adapter feeds "who is holding things up", and
  // the organiser's own decide/book/setup to-dos are not anyone else's blocker.
  const waitingOn = computeWaitingOn(snapshot, new Date(now), { includeOrganiser: false })

  const lastReminded = lastRemindedByUser(notifications)
  const escalated = escalatedUserIds(notifications, maxReminders)
  const byId = new Map(participants.map((p) => [p.user_id, p]))

  const people: PersonBlockers[] = waitingOn.byPerson.map((wp) => {
    const p = byId.get(wp.userId)
    return {
      userId: wp.userId,
      name: p?.user?.full_name || p?.user?.email || wp.name,
      avatarUrl: p?.user?.avatar_url ?? null,
      avatarData: p?.user?.avatar_data ?? null,
      blockers: wp.todos.map(todoToBlocker),
      escalated: escalated.has(wp.userId),
      lastRemindedAt: lastReminded.get(wp.userId) ?? null,
    }
  })

  const bookingDeadlines = upcomingCancellationDeadlines(input.bookings, now, bookingDeadlineWindowMs)
  const todoCount = waitingOn.totalTodos
  return { people, bookingDeadlines, todoCount, totalCount: todoCount + bookingDeadlines.length }
}
