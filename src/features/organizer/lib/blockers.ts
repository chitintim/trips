import type { ParticipantWithUser } from '../../../lib/queries/useTrip'
import type { SectionWithOptions, OptionVote } from '../../../lib/queries/usePlanning'
import type { ExpenseWithDetails } from '../../../lib/queries/useExpenses'
import type { Settlement } from '../../../lib/queries/useSettlements'
import type { Booking } from '../../../lib/queries/useBookings'
import type { Notification } from '../../../lib/queries/useNotifications'
import type { BlockerType } from '../../../shared/contracts/nudgeDraft'

/**
 * Pure computation behind the organizer BLOCKERS BOARD (plan §14): every
 * open loop on the trip, grouped by the person who owes the action.
 * No React, no fetching — callers feed it already-fetched query data so it
 * stays trivially unit-testable.
 */

export type BlockerKind =
  | 'pending_rsvp'
  | 'due_conditional'
  | 'unvoted_poll'
  | 'unclaimed_items'
  | 'unconfirmed_settlement'
  | 'expiring_waitlist_offer'
  | 'booking_cancellation_deadline'
  | 'escalation'

export interface Blocker {
  kind: BlockerKind
  /** User who owes the action. */
  userId: string
  /** Short chip label, e.g. `Vote: "Saturday dinner"`. */
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
}

export interface BlockersBoardData {
  people: PersonBlockers[]
  /** Trip-level (not person-actionable) warnings: upcoming cancellation deadlines. */
  bookingDeadlines: Blocker[]
  totalCount: number
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
}

const DAY_MS = 24 * 60 * 60 * 1000

function displayName(p: ParticipantWithUser): string {
  return p.user?.full_name || p.user?.email || 'Unknown'
}

export function computeBlockers(input: ComputeBlockersInput): BlockersBoardData {
  const {
    participants,
    sections,
    votes,
    expenses,
    settlements,
    bookings,
    notifications,
    maxReminders = 3,
    now = Date.now(),
    bookingDeadlineWindowMs = 7 * DAY_MS,
  } = input

  const active = participants.filter((p) => p.active !== false)
  const byUser = new Map<string, Blocker[]>()
  const push = (b: Blocker) => {
    const list = byUser.get(b.userId) ?? []
    list.push(b)
    byUser.set(b.userId, list)
  }

  // ---- Pending RSVPs + arrived conditional_date promises -----------------
  for (const p of active) {
    if (p.confirmation_status === 'pending') {
      push({
        kind: 'pending_rsvp',
        userId: p.user_id,
        label: 'RSVP pending',
        detail: 'Has not said whether they are joining.',
        nudgeType: 'pending_rsvp',
        deadline: null,
      })
    } else if (
      p.confirmation_status === 'conditional' &&
      p.conditional_date &&
      new Date(p.conditional_date).getTime() <= now
    ) {
      push({
        kind: 'due_conditional',
        userId: p.user_id,
        label: `Promised an answer by ${p.conditional_date}`,
        detail: `Said they would know by ${p.conditional_date} — that date has arrived.`,
        nudgeType: 'pending_rsvp',
        deadline: p.conditional_date,
      })
    }
  }

  // ---- Unvoted deadline-polls --------------------------------------------
  const votedOptionsByUser = new Map<string, Set<string>>()
  for (const v of votes) {
    const set = votedOptionsByUser.get(v.user_id) ?? new Set<string>()
    set.add(v.option_id)
    votedOptionsByUser.set(v.user_id, set)
  }
  for (const section of sections) {
    if (!section.vote_deadline) continue
    if (new Date(section.vote_deadline).getTime() <= now) continue
    const optionIds = (section.options ?? []).map((o) => o.id)
    if (optionIds.length === 0) continue
    for (const p of active) {
      const voted = votedOptionsByUser.get(p.user_id)
      const hasVoted = !!voted && optionIds.some((id) => voted.has(id))
      if (!hasVoted) {
        push({
          kind: 'unvoted_poll',
          userId: p.user_id,
          label: `Vote: "${section.title}"`,
          detail: `Hasn't voted in "${section.title}" (closes ${new Date(section.vote_deadline).toLocaleDateString()}).`,
          entityId: section.id,
          deadline: section.vote_deadline,
          nudgeType: 'unvoted_poll',
        })
      }
    }
  }

  // ---- Unclaimed itemized expense items, per receipt ----------------------
  for (const expense of expenses) {
    if (!expense.ai_parsed || !expense.status) continue
    if (expense.status === 'allocated' || expense.status === 'confirmed') continue
    const involved = expense.participant_ids?.length
      ? expense.participant_ids
      : active.map((p) => p.user_id)
    const claimedBy = new Set((expense.claims ?? []).map((c) => c.user_id))
    for (const userId of involved) {
      if (claimedBy.has(userId)) continue
      if (userId === expense.paid_by) continue // the payer isn't chased on their own receipt
      if (!active.some((p) => p.user_id === userId)) continue
      push({
        kind: 'unclaimed_items',
        userId,
        label: `Claim items: "${expense.description}"`,
        detail: `Hasn't claimed anything on "${expense.description}" (${expense.currency} ${expense.amount}).`,
        entityId: expense.id,
        nudgeType: 'unclaimed_items',
      })
    }
  }

  // ---- Unconfirmed settlements --------------------------------------------
  for (const s of settlements) {
    if (s.status === 'suggested') {
      push({
        kind: 'unconfirmed_settlement',
        userId: s.from_user_id,
        label: `Pay ${s.currency ?? ''} ${s.amount}`.trim(),
        detail: `Suggested payment of ${s.currency ?? ''} ${s.amount} not yet marked paid.`,
        entityId: s.id,
        nudgeType: 'unpaid_settlement',
      })
    } else if (s.status === 'marked_paid') {
      push({
        kind: 'unconfirmed_settlement',
        userId: s.to_user_id,
        label: `Confirm receipt of ${s.currency ?? ''} ${s.amount}`.trim(),
        detail: `Payer marked ${s.currency ?? ''} ${s.amount} as paid — awaiting the recipient's confirmation.`,
        entityId: s.id,
        nudgeType: 'unpaid_settlement',
      })
    }
  }

  // ---- Expiring waitlist offers -------------------------------------------
  for (const p of active) {
    if (!p.waitlist_offer_expires_at) continue
    const expires = new Date(p.waitlist_offer_expires_at).getTime()
    if (expires <= now) continue // already lapsed; auto-chase cascades it
    push({
      kind: 'expiring_waitlist_offer',
      userId: p.user_id,
      label: 'Waitlist offer expiring',
      detail: `Their claim offer expires ${new Date(p.waitlist_offer_expires_at).toLocaleString()}.`,
      deadline: p.waitlist_offer_expires_at,
      nudgeType: 'pending_rsvp',
    })
  }

  // ---- Escalations: 3+ reminders sent for the same open loop --------------
  // notifications dedupe_key convention (auto-chase): kind:entity:user:seq —
  // we count sends per (kind,entity,user) and surface >= maxReminders.
  const reminderCounts = new Map<string, { count: number; kind: string; entityId: string | null; userId: string }>()
  for (const n of notifications) {
    const groupKey = `${n.kind}:${n.entity_id ?? ''}:${n.user_id}`
    const existing = reminderCounts.get(groupKey)
    if (existing) existing.count += 1
    else reminderCounts.set(groupKey, { count: 1, kind: n.kind, entityId: n.entity_id, userId: n.user_id })
  }
  for (const group of reminderCounts.values()) {
    if (group.count < maxReminders) continue
    if (!active.some((p) => p.user_id === group.userId)) continue
    push({
      kind: 'escalation',
      userId: group.userId,
      label: `Needs a personal nudge (${group.count} reminders sent)`,
      detail: `Auto-chase sent ${group.count} reminders about "${group.kind.replace(/_/g, ' ')}" with no result — time for a human touch.`,
      entityId: group.entityId ?? undefined,
      nudgeType: kindToNudgeType(group.kind),
    })
  }

  // ---- Upcoming booking cancellation deadlines (trip-level) ----------------
  const bookingDeadlines: Blocker[] = []
  for (const b of bookings) {
    if (b.status === 'cancelled' || !b.cancellation_deadline) continue
    const deadline = new Date(b.cancellation_deadline).getTime()
    if (deadline <= now || deadline - now > bookingDeadlineWindowMs) continue
    bookingDeadlines.push({
      kind: 'booking_cancellation_deadline',
      userId: b.booked_by,
      label: `Free cancellation on "${b.title}" ends soon`,
      detail: `Cancellation deadline ${new Date(b.cancellation_deadline).toLocaleString()}.`,
      entityId: b.id,
      deadline: b.cancellation_deadline,
      nudgeType: 'expiring_cancellation_window',
    })
  }

  // ---- Assemble, ordered: most blockers first ------------------------------
  const people: PersonBlockers[] = []
  for (const p of active) {
    const blockers = byUser.get(p.user_id)
    if (!blockers || blockers.length === 0) continue
    people.push({ userId: p.user_id, name: displayName(p), avatarUrl: p.user?.avatar_url ?? null, avatarData: p.user?.avatar_data ?? null, blockers })
  }
  people.sort((a, b) => b.blockers.length - a.blockers.length || a.name.localeCompare(b.name))

  const totalCount = people.reduce((sum, p) => sum + p.blockers.length, 0) + bookingDeadlines.length

  return { people, bookingDeadlines, totalCount }
}

/** Best-effort mapping from a notifications.kind to a nudge blocker_type. */
function kindToNudgeType(kind: string): BlockerType | null {
  if (kind.includes('rsvp') || kind.includes('conditional') || kind.includes('waitlist')) return 'pending_rsvp'
  if (kind.includes('poll') || kind.includes('vote')) return 'unvoted_poll'
  if (kind.includes('claim') || kind.includes('item')) return 'unclaimed_items'
  if (kind.includes('settle')) return 'unpaid_settlement'
  if (kind.includes('cancel')) return 'expiring_cancellation_window'
  return null
}
