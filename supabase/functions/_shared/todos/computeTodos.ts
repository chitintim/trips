/**
 * MANUAL MIRROR of src/lib/todos/computeTodos.ts (Deno edge functions cannot import from src/).
 * Keep the code identical; only import specifiers and comments may differ.
 * Enforced by scripts/check-contract-drift.mjs.
 */
/**
 * Your to-dos: ONE definition of "what does this person owe on this trip".
 *
 * `computeTodos(snapshot, userId, now)` is the only place that decides it.
 * The header pill, Today's "Your to-dos" card, the dashboard badge, the plan
 * chips, the organiser's "Waiting on" board and the reminder emails all read
 * this, so the count is the same wherever it is computed.
 *
 * Global rules:
 *  - Scope. A person who is out (declined / cancelled) or inactive only gets
 *    money to-dos (pay, confirm_payment, claim). Money follows you out.
 *  - Finished trips. On a Finished trip (effective stage) the only to-dos are
 *    money ones. Open questions there are "Closed — no decision".
 *  - Deadlines never gate. A deadline only sets `due`, the `overdue` flag and
 *    the ordering.
 *
 * Pure: no React, no Supabase. See src/lib/todos/copy.ts for every string and
 * deep link, and src/lib/answers/answers.ts for "has this person answered".
 */
import { isIdeasBucket } from '../ideasBucket.ts'
import { effectiveTripStage, tripStageRank } from './deps/tripStage.ts'
import {
  buildAnsweredSectionVoters,
  answerCounts,
  indexAnswers,
  isAnswerer,
  isOwnChoice,
  isQuestionOpen,
  questionAnswerState,
  isAnswerTodoCandidate,
  type AnswerIndex,
  type AnswerInputs,
} from '../answers/answers.ts'
import type { SectionVoterIds } from '../actionCompletion/sectionVoters.ts'
import { inScopePeople } from './deps/inScopePeople.ts'
import { withClosedSections } from './deps/actionStatus.ts'
import { isTravelDetailsEvent, travelEventDirection } from './deps/travelDetails.ts'
import { resolveWinner } from './deps/resolveDecision.ts'
import {
  DEEP_LINKS,
  TODO_ACTION_LABEL,
  TRAVEL_TITLE,
  ORG_SETUP_INVITE_TITLE,
  ORG_SETUP_QUESTION_TITLE,
  answerActionLabel,
  answerSubtitle,
  bringTitle,
  claimTitle,
  distinguishedTitle,
  closesLabel,
  anyOrganizerLabel,
  confirmPaymentTitle,
  DISPUTE_AGE_NUDGE_DAYS,
  respondPaymentTitle,
  formatMoney,
  formatDayMonth,
  orgBookTitle,
  orgDecideTitle,
  orgDecideShortTitle,
  orgCloseAnswersTitle,
  orgTieSubtitle,
  orgTieTitle,
  payTitle,
  rsvpTitle,
  settleUpTitle,
  settleUpInfoText,
  confirmPaymentGroupTitle,
  confirmPaymentGroupDetail,
  unblocksLabel,
  freezeBalancesTitle,
  FREEZE_BALANCES_SUBTITLE,
  taskSubtitle,
  waitlistOfferTitle,
} from './copy.ts'
import type {
  ComputeWaitingOnOptions,
  SnapshotAction,
  SnapshotExpense,
  SnapshotParticipant,
  SnapshotSection,
  SnapshotSettlement,
  Todo,
  TodoInfo,
  TodoKind,
  TripSnapshot,
  WaitingOn,
  WaitingOnItem,
  WaitingOnPerson,
} from './types.ts'

export { DEEP_LINKS, todoHref } from './copy.ts'

/** Order of personal kinds within the same due date. */
export const TODO_KIND_ORDER: TodoKind[] = [
  'pay',
  'respond_payment',
  'rsvp',
  'answer',
  'task',
  'claim',
  'confirm_payment',
  'travel',
  'waitlist_offer',
  'org_decide',
  'org_tie',
  'org_book',
  'org_setup',
]

const DAY_MS = 86_400_000
const BALANCE_EPSILON = 0.01

// ---------------------------------------------------------------------------
// Date helpers (local calendar days; trip dates are destination-local)
// ---------------------------------------------------------------------------

function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function utcDay(dateStr: string): number {
  const [y, m, d] = dateStr.slice(0, 10).split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}

/** Whole calendar days from `from` to `to` (negative when `to` is earlier). */
function dayDiff(from: string, to: string): number {
  return Math.round((utcDay(to) - utcDay(from)) / DAY_MS)
}

const isDateOnly = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s)

/** Milliseconds used to order by deadline (date-only deadlines count to the end of that day). */
function dueMs(due: string): number {
  return isDateOnly(due) ? new Date(`${due}T23:59:59`).getTime() : new Date(due).getTime()
}

function isPast(due: string, now: Date): boolean {
  return isDateOnly(due) ? due < localDate(now) : new Date(due).getTime() < now.getTime()
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface Ctx {
  s: TripSnapshot
  now: Date
  today: string
  confirmationEnabled: boolean
  finished: boolean
  stageRank: number
  answerInputs: AnswerInputs
  index: AnswerIndex
  sectionVoters: SectionVoterIds
  byUser: Map<string, SnapshotParticipant>
  /** Active AND departed people, for naming only. */
  namesById: Map<string, SnapshotParticipant>
  frozen: boolean
  organiserIds: Set<string>
}

function buildCtx(snapshot: TripSnapshot, now: Date): Ctx {
  // The Ideas bucket is a place to collect suggestions, never a question: the engine does not see it.
  const s: TripSnapshot = snapshot.sections.some(isIdeasBucket) ? { ...snapshot, sections: snapshot.sections.filter((x) => !isIdeasBucket(x)) } : snapshot
  const stage = effectiveTripStage(s.trip, now)
  const answerInputs: AnswerInputs = { votes: s.votes, passes: s.passes }
  const sections = s.sections
  const index = indexAnswers(sections, answerInputs)
  // Auto-tick: answering a question (vote, selection or pass) completes the
  // linked to-do; a closed question completes it for everyone.
  const sectionVoters = withClosedSections(
    buildAnsweredSectionVoters(sections, answerInputs),
    sections,
    s.participants.map((p) => p.user_id)
  )
  const organiserIds = new Set(s.participants.filter((p) => p.role === 'organizer').map((p) => p.user_id))
  if (s.trip.created_by) organiserIds.add(s.trip.created_by)
  return {
    s,
    now,
    today: localDate(now),
    confirmationEnabled: s.trip.confirmation_enabled === true,
    finished: stage === 'trip_completed',
    stageRank: tripStageRank(stage),
    answerInputs,
    index,
    sectionVoters,
    byUser: new Map(s.participants.map((p) => [p.user_id, p])),
    namesById: new Map([...(s.allParticipants ?? []), ...s.participants].map((p) => [p.user_id, p])),
    frozen: s.trip.settlement_snapshot != null,
    organiserIds,
  }
}

function firstName(p: SnapshotParticipant | undefined): string {
  const u = p?.user
  if (!u) return 'someone'
  const first = u.first_name?.trim() || u.full_name?.trim().split(/\s+/)[0] || u.email?.split('@')[0]
  return first || 'someone'
}

/** Display name for a participant (first name, then email local part, then "someone"). */
export function participantName(p: SnapshotParticipant | undefined): string {
  return firstName(p)
}

/** Out of the trip (declined, cancelled, or removed): the exact complement of `isAnswerer`. */
function isOut(p: SnapshotParticipant): boolean {
  return !isAnswerer(p)
}

// ---------------------------------------------------------------------------
// Per-kind generators
// ---------------------------------------------------------------------------

type Draft = Omit<Todo, 'id' | 'userId' | 'overdue' | 'actionLabel' | 'subtitle' | 'group'> & {
  id?: string
  subtitle?: string | null
  actionLabel?: string
  group?: Todo['group']
}

function finish(ctx: Ctx, userId: string, d: Draft): Todo {
  return {
    ...d,
    id: d.id ?? `${d.kind}:${d.entityId}`,
    userId,
    group: d.group ?? 'personal',
    subtitle: d.subtitle ?? null,
    actionLabel: d.actionLabel ?? TODO_ACTION_LABEL[d.kind],
    overdue: d.due ? isPast(d.due, ctx.now) : false,
  }
}

function rsvpTodos(ctx: Ctx, userId: string, p: SnapshotParticipant): Todo[] {
  if (!ctx.confirmationEnabled) return []
  const { trip } = ctx.s
  const status = p.confirmation_status
  const dueConditional = status === 'conditional' && !!p.conditional_date && p.conditional_date.slice(0, 10) <= ctx.today
  const interestedWithDeadline = status === 'interested' && !!trip.confirmation_deadline
  if (!(status === 'pending' || dueConditional || interestedWithDeadline)) return []
  return [
    finish(ctx, userId, {
      kind: 'rsvp',
      entityId: trip.id,
      title: rsvpTitle(trip.name),
      due: trip.confirmation_deadline,
      link: DEEP_LINKS.rsvp(),
    }),
  ]
}

function answerTodos(ctx: Ctx, userId: string): Todo[] {
  const out: Todo[] = []
  for (const section of ctx.s.sections) {
    if (questionAnswerState(section, userId, { index: ctx.index, tripFinished: ctx.finished }) !== 'needs_answer') continue
    const shape = isOwnChoice(section) ? 'own' : 'group'
    // Without passes an Own-choice question with no deadline cannot be cleared
    // by someone who wants nothing, so it is not a to-do (snapshot.passesAvailable).
    if (!isAnswerTodoCandidate(section, ctx.s.passesAvailable === true)) continue
    const counts = answerCounts(section.id, ctx.index, ctx.s.participants, ctx.confirmationEnabled)
    out.push(
      finish(ctx, userId, {
        kind: 'answer',
        entityId: section.id,
        title: section.title,
        subtitle: answerSubtitle(shape, counts.answered, counts.total, section.vote_deadline ? closesLabel(section.vote_deadline, ctx.now) : null),
        actionLabel: answerActionLabel(shape),
        due: section.vote_deadline,
        link: DEEP_LINKS.question(section.id),
        shape,
        progress: { done: counts.answered, total: counts.total },
      })
    )
  }
  return out
}

/** Local mirror of actionStatus.isActionCompleteForUser over the snapshot shape. */
export function isActionDoneFor(action: SnapshotAction, userId: string, sectionVoters: SectionVoterIds): boolean {
  const answeredLinked = (who: string) => !!action.section_id && (sectionVoters.get(action.section_id)?.has(who) ?? false)
  if (action.assigned_to) return action.completed_at != null || answeredLinked(action.assigned_to)
  return (action.trip_action_completions ?? []).some((c) => c.user_id === userId) || answeredLinked(userId)
}

function actionDue(action: SnapshotAction, tripStart: string): string | null {
  return action.deadline_kind === 'before_trip' ? tripStart : action.due_date
}

function taskTodos(ctx: Ctx, userId: string): Todo[] {
  const out: Todo[] = []
  for (const a of ctx.s.actions) {
    // An unclaimed Anyone item is nobody's to-do; once claimed it counts for the claimer only.
    if (a.who_mode === 'anyone' && !a.assigned_to) continue
    const mine = a.assigned_to ? a.assigned_to === userId : true
    if (!mine || isActionDoneFor(a, userId, ctx.sectionVoters)) continue
    const due = actionDue(a, ctx.s.trip.start_date)
    const overdueDays = due && isDateOnly(due.slice(0, 10)) ? Math.max(0, dayDiff(due.slice(0, 10), ctx.today)) : null
    out.push(
      finish(ctx, userId, {
        kind: 'task',
        entityId: a.id,
        title: a.title,
        subtitle: taskSubtitle(a.assigned_to ? 'You' : 'Everyone', due, overdueDays),
        due,
        link: DEEP_LINKS.todo(a.id),
      })
    )
  }
  for (const item of ctx.s.checklists) {
    if (item.done || item.assigned_to !== userId) continue
    out.push(
      finish(ctx, userId, {
        kind: 'task',
        entityId: item.id,
        title: bringTitle(item.title),
        subtitle: 'You',
        due: null,
        link: DEEP_LINKS.bring(item.id),
      })
    )
  }
  return out
}

function moneyTodos(ctx: Ctx, userId: string): Todo[] {
  const { settlements, expenses, trip } = ctx.s
  const out: Todo[] = []

  // pay: suggested settlements I owe. Suggested rows only mean something while
  // balances are frozen (freezing creates them; unfreezing leaves them stale),
  // so an unfrozen trip never produces per-payment "Pay" rows.
  const suggestedFromMe = ctx.frozen ? settlements.filter((st) => st.from_user_id === userId && st.status === 'suggested') : []
  for (const st of suggestedFromMe) {
    out.push(
      finish(ctx, userId, {
        kind: 'pay',
        entityId: st.id,
        title: payTitle(firstName(ctx.namesById.get(st.to_user_id)), formatMoney(st.amount, st.currency ?? trip.base_currency)),
        due: null,
        link: DEEP_LINKS.payment(st.id),
      })
    )
  }

  // Finished and balances frozen, no per-payment row: "Settle up: you owe £X"
  // is a real payment to make. NOT frozen: nobody can pay until an organiser
  // freezes balances, so it is not this person's to-do (see `computeInfo`).
  if (ctx.finished && ctx.frozen && suggestedFromMe.length === 0) {
    const owed = settleOwed(ctx, userId)
    if (owed >= BALANCE_EPSILON) {
      out.push(
        finish(ctx, userId, {
          kind: 'pay',
          // One per person, so Waiting on never merges different people's payments.
          id: `pay:settle:${userId}`,
          entityId: `${trip.id}:${userId}`,
          title: settleUpTitle(formatMoney(owed, trip.base_currency)),
          actionLabel: 'Settle up',
          due: null,
          link: DEEP_LINKS.settle(),
        })
      )
    }
  }

  // respond_payment: I marked a payment as paid and the receiver says it hasn't arrived.
  // (A flag on any other status is stale and ignored.)
  for (const st of settlements) {
    if (st.from_user_id !== userId || st.status !== 'marked_paid' || !st.receipt_disputed_at) continue
    // Older than DISPUTE_AGE_NUDGE_DAYS: say how long it has been waiting (this is what organisers see in Waiting on).
    const ageMs = ctx.now.getTime() - new Date(st.receipt_disputed_at).getTime()
    const ageDays = ageMs > DISPUTE_AGE_NUDGE_DAYS * DAY_MS ? Math.floor(ageMs / DAY_MS) : null
    out.push(
      finish(ctx, userId, {
        kind: 'respond_payment',
        entityId: st.id,
        title: respondPaymentTitle(firstName(ctx.namesById.get(st.to_user_id)), formatMoney(st.amount, st.currency ?? trip.base_currency), ageDays),
        counterpartyId: st.to_user_id,
        due: null,
        link: DEEP_LINKS.payment(st.id),
      })
    )
  }

  // confirm_payment: someone says they paid me. Not once I have said it hasn't arrived: I have answered,
  // the next step is the payer's.
  for (const st of settlements) {
    if (st.to_user_id !== userId || st.status !== 'marked_paid' || st.receipt_disputed_at) continue
    out.push(
      finish(ctx, userId, {
        kind: 'confirm_payment',
        entityId: st.id,
        title: confirmPaymentTitle(firstName(ctx.namesById.get(st.from_user_id)), formatMoney(st.amount, st.currency ?? trip.base_currency)),
        counterpartyId: st.from_user_id,
        due: null,
        link: DEEP_LINKS.payment(st.id),
      })
    )
  }

  // claim: itemised receipts I am on and have not claimed anything from. Not
  // while balances are frozen (claims are locked), and not without a usable
  // claim link (there is nowhere to claim).
  if (!ctx.frozen) {
    const everyone = ctx.s.participants.map((p) => p.user_id)
    for (const e of expenses) {
      if (!e.ai_parsed || !e.status) continue
      if (e.status === 'allocated' || e.status === 'confirmed') continue
      if (receiptFullyClaimed(e)) continue
      if (!hasUsableClaimLink(e, ctx.now)) continue
      if (e.paid_by === userId) continue // the payer is not chased on their own receipt
      const involved = e.participant_ids && e.participant_ids.length > 0 ? e.participant_ids : everyone
      if (!involved.includes(userId)) continue
      if (e.claims.some((c) => isSelfMadeClaim(c, userId))) continue
      out.push(
        finish(ctx, userId, {
          kind: 'claim',
          entityId: e.id,
          title: claimTitle(e.description, formatMoney(e.amount, e.currency)),
          due: null,
          link: DEEP_LINKS.claim(e.id),
        })
      )
    }
  }
  return disambiguatePayments(out, settlements)
}

/**
 * Two payments can read identically (same people, same amount): a genuine
 * double payment, or two organisers freezing at once. They are separate rows
 * the person must act on separately, so tell them apart with the date / note
 * (or "1 of 2" when even those match) instead of printing the same line twice.
 */
function disambiguatePayments(todos: Todo[], settlements: ReadonlyArray<SnapshotSettlement>): Todo[] {
  const byTitle = new Map<string, Todo[]>()
  for (const t of todos) {
    if (t.kind !== 'pay' && t.kind !== 'confirm_payment' && t.kind !== 'respond_payment') continue
    byTitle.set(t.title, [...(byTitle.get(t.title) ?? []), t])
  }
  const rows = new Map(settlements.map((st) => [st.id, st]))
  const retitled = new Map<Todo, string>()
  for (const group of byTitle.values()) {
    if (group.length < 2) continue
    const stamps = group.map((t) => {
      const st = rows.get(t.entityId)
      const when = st?.settled_at ?? st?.created_at
      const note = st?.notes?.trim()
      return [when ? formatDayMonth(when) : '', note ? (note.length > 28 ? `${note.slice(0, 27)}…` : note) : ''].filter(Boolean).join(', ')
    })
    const distinct = stamps.every((x) => x !== '') && new Set(stamps).size === stamps.length
    group.forEach((t, i) => retitled.set(t, distinct ? stamps[i] : [stamps[i], `${i + 1} of ${group.length}`].filter(Boolean).join(', ')))
  }
  return retitled.size === 0 ? todos : todos.map((t) => (retitled.has(t) ? { ...t, title: distinguishedTitle(t.title, retitled.get(t)!) } : t))
}

/** What a person still owes on a finished trip (base currency, major units), net of payments awaiting confirmation. */
function settleOwed(ctx: Ctx, userId: string): number {
  const { settlements, trip } = ctx.s
  const balance = ctx.s.balances?.[userId] ?? 0
  // Only payments in the trip's base currency reduce a base-currency balance.
  const awaitingConfirmation = settlements
    .filter((st) => st.from_user_id === userId && st.status === 'marked_paid' && (st.currency ?? trip.base_currency) === trip.base_currency)
    .reduce((sum, st) => sum + st.amount, 0)
  return -balance - awaitingConfirmation
}

/**
 * A claim row the person made themselves. Legacy rows (no source, no created_by)
 * are 'self'. A 'shared' or 'on_behalf' row counts only when they created it.
 * A row that holds only a share of the leftovers (no quantity of the person's own) never does:
 * a claim with own (non-leftover) quantity above 0 is the test, not the source alone.
 */
function isSelfMadeClaim(
  c: { user_id: string; source?: string | null; created_by?: string | null; quantity_claimed?: number; leftover_quantity?: number | null },
  userId: string
): boolean {
  if (c.user_id !== userId) return false
  if (c.source === 'leftover') return false
  if (typeof c.quantity_claimed === 'number' && Math.round((c.quantity_claimed - (c.leftover_quantity ?? 0)) * 100) <= 0) return false
  if (c.source === 'shared' || c.source === 'on_behalf') return c.created_by === userId
  return true
}

/** The dust tolerance the whole claims feature shares (balances.ts LINE_QUANTITY_TOLERANCE, the server's 0.011). */
const CLAIM_QUANTITY_TOLERANCE = 0.011

/**
 * True when every line that has money on it is claimed within the dust tolerance (0.33 x 3 of a line counts as claimed). The database column
 * expenses.status is set by a trigger that compares quantities exactly, so it can read 'pending_allocation' on a legacy receipt that is in fact
 * fully claimed; this is the tolerant answer. False when there are no lines (then only the status is known).
 */
export function linesFullyClaimedWithinDust(
  lines: ReadonlyArray<{ id: string; quantity: number; total_amount?: number | null }> | null | undefined,
  claims: ReadonlyArray<{ line_item_id?: string | null; quantity_claimed?: number | null }>
): boolean {
  if (!lines || lines.length === 0) return false
  const claimed = new Map<string, number>()
  for (const c of claims) {
    if (c.line_item_id == null || typeof c.quantity_claimed !== 'number') return false
    claimed.set(c.line_item_id, (claimed.get(c.line_item_id) ?? 0) + c.quantity_claimed)
  }
  return lines.every((l) => !((l.total_amount ?? 1) > 0) || Math.round((l.quantity - (claimed.get(l.id) ?? 0)) * 1e6) / 1e6 <= CLAIM_QUANTITY_TOLERANCE)
}

function receiptFullyClaimed(e: SnapshotExpense): boolean {
  return linesFullyClaimedWithinDust(e.line_items, e.claims)
}

function hasUsableClaimLink(e: SnapshotExpense, now: Date): boolean {
  const link = e.allocation_link
  if (!link || !link.code) return false
  return !link.expires_at || new Date(link.expires_at).getTime() > now.getTime()
}

/** Organiser: the trip is over and someone owes money, but balances are not frozen so nobody can pay yet. */
function freezeTodos(ctx: Ctx, userId: string): Todo[] {
  if (!ctx.finished || ctx.frozen || !ctx.organiserIds.has(userId)) return []
  const unblocks = ctx.s.participants.filter((p) => p.active !== false && settleOwed(ctx, p.user_id) >= BALANCE_EPSILON).length
  if (unblocks === 0) return []
  return [
    finish(ctx, userId, {
      group: 'organiser',
      kind: 'org_setup',
      id: 'org_setup:freeze',
      entityId: `${ctx.s.trip.id}:freeze`,
      title: freezeBalancesTitle,
      subtitle: FREEZE_BALANCES_SUBTITLE,
      actionLabel: 'Freeze',
      unblocks,
      due: null,
      link: DEEP_LINKS.settle(),
    }),
  ]
}

function travelTodos(ctx: Ctx, userId: string, p: SnapshotParticipant): Todo[] {
  if (ctx.confirmationEnabled && p.confirmation_status !== 'confirmed') return []
  const { trip } = ctx.s
  // Only before the trip starts: not ongoing or finished.
  if (ctx.stageRank >= tripStageRank('trip_ongoing')) return []
  const daysToStart = dayDiff(ctx.today, trip.start_date)
  if (!(daysToStart <= 30 || ctx.stageRank >= tripStageRank('booked_awaiting_departure'))) return []

  let arrival = false
  let departure = false
  for (const ev of ctx.s.travelEvents) {
    if (!isTravelDetailsEvent(ev) || !(ev.participant_ids ?? []).includes(userId)) continue
    const dir = travelEventDirection(ev)
    if (dir === 'arrival') arrival = true
    if (dir === 'departure') departure = true
  }
  if (arrival && departure) return []

  const due = new Date(utcDay(trip.start_date) - 7 * DAY_MS).toISOString().slice(0, 10)
  return [
    finish(ctx, userId, {
      kind: 'travel',
      entityId: trip.id,
      title: TRAVEL_TITLE,
      due,
      link: DEEP_LINKS.travelDetails(),
    }),
  ]
}

function waitlistTodos(ctx: Ctx, userId: string, p: SnapshotParticipant): Todo[] {
  // An accepted offer leaves 'waitlist' but keeps its expiry timestamp, so the status must still be waitlist.
  if (!ctx.confirmationEnabled || p.confirmation_status !== 'waitlist' || !p.waitlist_offer_expires_at) return []
  if (new Date(p.waitlist_offer_expires_at).getTime() <= ctx.now.getTime()) return []
  return [
    finish(ctx, userId, {
      kind: 'waitlist_offer',
      entityId: ctx.s.trip.id,
      title: waitlistOfferTitle(ctx.s.trip.name),
      due: p.waitlist_offer_expires_at,
      link: DEEP_LINKS.rsvp(),
    }),
  ]
}

// ---- organiser kinds -------------------------------------------------------

function optionIsBooked(ctx: Ctx, optionId: string, status: string): boolean {
  if (status === 'booked') return true
  return (ctx.s.bookings ?? []).some((b) => b.option_id === optionId && b.status !== 'cancelled')
}

/** Most "Book:" to-dos shown at once. */
export const MAX_BOOK_TODOS = 3
/** Section types that are booked with a supplier; equipment, insurance and anything unknown are not. */
const BOOKABLE_SECTION_TYPES = new Set(['accommodation', 'flights', 'transport', 'activities', 'lessons'])
const TRIP_DATES_TITLE = 'Trip dates'

/** An option that carries a candidate date range (a "Trip dates" poll option). */
function hasDateRange(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false
  const range = (metadata as Record<string, unknown>).date_range
  return !!range && typeof range === 'object' && !Array.isArray(range)
}

function isBookableSection(section: SnapshotSection): boolean {
  if (section.title.trim().toLowerCase() === TRIP_DATES_TITLE.toLowerCase()) return false
  if (section.options.some((o) => hasDateRange(o.metadata))) return false
  return !!section.section_type && BOOKABLE_SECTION_TYPES.has(section.section_type)
}

/** `metadata.followup_action_id` when the Decide sheet (or the old follow-up flow) linked a real "Book:" to-do. */
function followupActionId(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const id = (metadata as Record<string, unknown>).followup_action_id
  return typeof id === 'string' && id.length > 0 ? id : null
}

function organiserTodos(ctx: Ctx, userId: string): Todo[] {
  const out: Todo[] = []
  const g = { group: 'organiser' as const }
  // "Book: X" rule (D3): only before the trip starts. Decisions on a trip that
  // is already under way (or over) are not nagged about, which also keeps
  // every question decided before this feature shipped from producing a burst
  // of to-dos on trips that are past booking. Capped so a big plan stays quiet.
  const bookingsOpen = ctx.stageRank < tripStageRank('trip_ongoing')
  let bookTodos = 0
  const actionIds = new Set(ctx.s.actions.map((a) => a.id))

  for (const section of ctx.s.sections) {
    const deadlinePassed = !!section.vote_deadline && isPast(section.vote_deadline, ctx.now)

    if (isOwnChoice(section)) {
      // Each person picks for themselves: nothing to decide and nothing to book.
      // Past its deadline the organiser only has to close answers (same sheet,
      // different words). Never "everyone answered": picks stay editable.
      if (isQuestionOpen(section) && deadlinePassed) {
        const counts = answerCounts(section.id, ctx.index, ctx.s.participants, ctx.confirmationEnabled)
        out.push(
          finish(ctx, userId, {
            ...g,
            kind: 'org_decide',
            entityId: section.id,
            title: orgCloseAnswersTitle(section.title),
            shortTitle: orgCloseAnswersTitle(section.title),
            due: section.vote_deadline,
            link: DEEP_LINKS.decide(section.id),
            shape: 'own',
            progress: { done: counts.answered, total: counts.total },
          })
        )
      }
      continue
    }

    if (isQuestionOpen(section)) {
      const counts = answerCounts(section.id, ctx.index, ctx.s.participants, ctx.confirmationEnabled)
      const allAnswered = counts.total > 0 && counts.answered >= counts.total
      if (!deadlinePassed && !allAnswered) continue
      // A tie is only called once answers are closed (deadline passed): same
      // tally and tie rule as the Decide sheet and the auto-decide job. It
      // replaces org_decide for the question, never both.
      const winner = deadlinePassed
        ? resolveWinner({ status: section.status, metadata: section.metadata, voting_method: section.voting_method, options: section.options.map((o) => ({ ...o, metadata: o.metadata ?? null })) }, [...ctx.s.votes])
        : null
      if (winner?.tied) {
        const titles = winner.tiedOptionIds.map((id) => section.options.find((o) => o.id === id)?.title).filter((t): t is string => !!t)
        out.push(
          finish(ctx, userId, {
            ...g,
            kind: 'org_tie',
            entityId: section.id,
            title: orgTieTitle(section.title),
            shortTitle: orgTieTitle(section.title),
            subtitle: titles.length > 0 ? orgTieSubtitle(titles) : null,
            due: section.vote_deadline,
            link: DEEP_LINKS.decide(section.id),
            progress: { done: counts.answered, total: counts.total },
          })
        )
        continue
      }
      out.push(
        finish(ctx, userId, {
          ...g,
          kind: 'org_decide',
          entityId: section.id,
          title: orgDecideTitle(
            section.title,
            deadlinePassed ? { kind: 'deadline_passed', answered: counts.answered, total: counts.total } : { kind: 'all_answered', total: counts.total }
          ),
          shortTitle: orgDecideShortTitle(section.title),
          due: section.vote_deadline,
          link: DEEP_LINKS.decide(section.id),
          progress: { done: counts.answered, total: counts.total },
        })
      )
    } else if (section.status === 'completed' && bookingsOpen && bookTodos < MAX_BOOK_TODOS && isBookableSection(section)) {
      // The Decide sheet makes a real "Book: X" to-do (assigned to someone, not
      // necessarily an organiser) and links it from the question. While that
      // row exists (open or done) the synthetic one would be a duplicate.
      const linked = followupActionId(section.metadata)
      if (linked && actionIds.has(linked)) continue
      const winner = resolveWinner(
        { status: section.status, metadata: section.metadata, voting_method: section.voting_method, options: section.options.map((o) => ({ ...o, metadata: o.metadata ?? null })) },
        [...ctx.s.votes]
      )
      const option = section.options.find((o) => o.id === winner.optionId)
      if (option && !hasDateRange(option.metadata) && !optionIsBooked(ctx, option.id, option.status)) {
        bookTodos++
        out.push(
          finish(ctx, userId, {
            ...g,
            kind: 'org_book',
            entityId: option.id,
            title: orgBookTitle(option.title ?? section.title),
            due: null,
            link: DEEP_LINKS.book(option.id),
          })
        )
      }
    }
  }

  // Setup steps are true-in-the-data, never dismissed locally.
  if (ctx.s.participants.length < 2) {
    out.push(finish(ctx, userId, { ...g, kind: 'org_setup', id: 'org_setup:invite', entityId: `${ctx.s.trip.id}:invite`, title: ORG_SETUP_INVITE_TITLE, due: null, link: DEEP_LINKS.setup() }))
  }
  if (ctx.s.sections.length === 0) {
    out.push(finish(ctx, userId, { ...g, kind: 'org_setup', id: 'org_setup:question', entityId: `${ctx.s.trip.id}:question`, title: ORG_SETUP_QUESTION_TITLE, due: null, link: DEEP_LINKS.setup() }))
  }
  return out
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/** Personal group before organiser group; within a group: overdue, then due date, then kind order, then title. */
export function compareTodos(a: Todo, b: Todo): number {
  if (a.group !== b.group) return a.group === 'personal' ? -1 : 1
  if (a.overdue !== b.overdue) return a.overdue ? -1 : 1
  const ad = a.due ? dueMs(a.due) : Number.POSITIVE_INFINITY
  const bd = b.due ? dueMs(b.due) : Number.POSITIVE_INFINITY
  if (ad !== bd) return ad < bd ? -1 : 1
  const ak = TODO_KIND_ORDER.indexOf(a.kind)
  const bk = TODO_KIND_ORDER.indexOf(b.kind)
  if (ak !== bk) return ak - bk
  if (a.kind === 'org_setup') return a.id.localeCompare(b.id) // invite before first question
  return a.title.localeCompare(b.title) || a.id.localeCompare(b.id)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function todosFor(ctx: Ctx, userId: string): Todo[] {
  const p = ctx.byUser.get(userId)
  if (!p) return []
  const moneyOnly = ctx.finished || isOut(p)
  const todos: Todo[] = [...moneyTodos(ctx, userId), ...(p.active === false ? [] : freezeTodos(ctx, userId))]
  if (!moneyOnly) {
    todos.push(
      ...rsvpTodos(ctx, userId, p),
      ...answerTodos(ctx, userId),
      ...taskTodos(ctx, userId),
      ...travelTodos(ctx, userId, p),
      ...waitlistTodos(ctx, userId, p)
    )
    if (ctx.organiserIds.has(userId)) todos.push(...organiserTodos(ctx, userId))
  }
  return todos.sort(compareTodos)
}

/**
 * Non-counting lines for `userId`: things blocked on someone else, so not
 * something THIS person can act on now. Never in the pill, Today's count,
 * the dashboard, Waiting on, nudges or emails.
 */
export function computeInfo(snapshot: TripSnapshot, userId: string, now: Date = new Date()): TodoInfo[] {
  const ctx = buildCtx(snapshot, now)
  if (!ctx.byUser.has(userId) || !ctx.finished || ctx.frozen) return []
  const owed = settleOwed(ctx, userId)
  if (owed < BALANCE_EPSILON) return []
  return [{ id: `info:settle_waiting:${userId}`, kind: 'settle_waiting', userId, text: settleUpInfoText(formatMoney(owed, snapshot.trip.base_currency)) }]
}

/**
 * The ordered to-dos `userId` owes on this trip, done-conditions already
 * applied. Empty means "You're all set". `now` defaults to the current time;
 * pass it in tests.
 */
export function computeTodos(snapshot: TripSnapshot, userId: string, now: Date = new Date()): Todo[] {
  return todosFor(buildCtx(snapshot, now), userId)
}

/** Personal (non-organiser) to-dos only. */
export const personalTodos = (todos: Todo[]) => todos.filter((t) => t.group === 'personal')
/** Organiser-group to-dos only ("For you as organiser"). */
export const organiserOnlyTodos = (todos: Todo[]) => todos.filter((t) => t.group === 'organiser')
/** The answer to-dos, in order: seed for AnswerFlow and the "Answer all" row. */
export const answerTodoList = (todos: Todo[]) => todos.filter((t) => t.kind === 'answer')
/** True when the list is long enough to offer "Answer all". */
export const canAnswerAll = (todos: Todo[]) => answerTodoList(todos).length >= 2
/** Count that every surface shows (header pill, dashboard badge). */
export const countTodos = (todos: Todo[]) => todos.length
export const hasOverdue = (todos: Todo[]) => todos.some((t) => t.overdue)

/**
 * The organiser's mirror: the same engine run for every participant, by
 * person and by thing. `byPerson[i].count` always equals
 * `computeTodos(snapshot, userId).length` (unless `includeOrganiser: false`).
 */
export function computeWaitingOn(snapshot: TripSnapshot, now: Date = new Date(), options: ComputeWaitingOnOptions = {}): WaitingOn {
  const includeOrganiser = options.includeOrganiser ?? true
  const ctx = buildCtx(snapshot, now)
  const byUser = new Map<string, Todo[]>()
  const byPerson: WaitingOnPerson[] = []

  for (const p of snapshot.participants) {
    let todos = todosFor(ctx, p.user_id)
    if (!includeOrganiser) todos = personalTodos(todos)
    if (todos.length === 0) continue
    byUser.set(p.user_id, todos)
    byPerson.push({ userId: p.user_id, name: firstName(p), todos, count: todos.length, overdueCount: todos.filter((t) => t.overdue).length })
  }
  byPerson.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))

  const items = new Map<string, WaitingOnItem>()
  const confirmCounts = new Map<string, number>()
  for (const person of byPerson) {
    for (const t of person.todos) {
      if (t.kind === 'confirm_payment' && t.counterpartyId) confirmCounts.set(t.counterpartyId, (confirmCounts.get(t.counterpartyId) ?? 0) + 1)
    }
  }
  for (const person of byPerson) {
    for (const t of person.todos) {
      // Several people each confirming payments from the same payer read as one
      // item ("Confirm payment from Tim"); a single one keeps its own row.
      const grouped = t.kind === 'confirm_payment' && !!t.counterpartyId && (confirmCounts.get(t.counterpartyId) ?? 0) > 1
      const entityId = grouped ? `from:${t.counterpartyId}` : t.entityId
      const key = `${t.kind}:${entityId}`
      const existing = items.get(key)
      if (existing) {
        existing.userIds.push(person.userId)
        existing.todoIds[person.userId] = t.id
      } else {
        items.set(key, {
          id: key,
          kind: t.kind,
          group: t.group,
          entityId,
          title: grouped ? confirmPaymentGroupTitle(firstName(ctx.namesById.get(t.counterpartyId!))) : t.title,
          link: grouped ? DEEP_LINKS.settle() : t.link,
          due: t.due,
          overdue: t.overdue,
          userIds: [person.userId],
          todoIds: { [person.userId]: t.id },
          ...(t.unblocks != null ? { detail: unblocksLabel(t.unblocks), unblocks: t.unblocks } : {}),
          ...(t.shortTitle ? { shortTitle: t.shortTitle } : {}),
        })
      }
    }
  }
  const sectionById = new Map<string, SnapshotSection>(snapshot.sections.map((s) => [s.id, s]))
  const actionById = new Map(snapshot.actions.map((a) => [a.id, a]))
  const roster = snapshot.participants.filter((p) => !isOut(p))
  for (const item of items.values()) {
    if (item.kind === 'confirm_payment' && item.entityId.startsWith('from:')) item.detail = confirmPaymentGroupDetail(item.userIds.length)
    // Decide / tie / book can be done by ANY organiser; none of them individually owes it.
    if (item.kind === 'org_decide' || item.kind === 'org_tie' || item.kind === 'org_book') item.detail = anyOrganizerLabel(item.userIds.length)
    if (item.kind === 'answer' && sectionById.has(item.entityId)) {
      const c = answerCounts(item.entityId, ctx.index, snapshot.participants, ctx.confirmationEnabled)
      item.title = sectionById.get(item.entityId)!.title
      item.done = c.answered
      item.total = c.total
    } else if (item.kind === 'task') {
      const a = actionById.get(item.entityId)
      if (a && !a.assigned_to && a.who_mode !== 'anyone') {
        item.done = roster.filter((p) => isActionDoneFor(a, p.user_id, ctx.sectionVoters)).length
        item.total = roster.length
      }
    }
  }
  const byItem = [...items.values()].sort((a, b) => {
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1
    const ad = a.due ? dueMs(a.due) : Number.POSITIVE_INFINITY
    const bd = b.due ? dueMs(b.due) : Number.POSITIVE_INFINITY
    if (ad !== bd) return ad < bd ? -1 : 1
    return TODO_KIND_ORDER.indexOf(a.kind) - TODO_KIND_ORDER.indexOf(b.kind)
  })

  return { byPerson, byItem, byUser, totalPeople: byPerson.length, totalTodos: byPerson.reduce((n, p) => n + p.count, 0) }
}

/** In-scope headcount, re-exported so surfaces that print "N people" use the same rule. */
export function inScopeCount(snapshot: TripSnapshot): number {
  return inScopePeople([...snapshot.participants], snapshot.trip.confirmation_enabled === true).length
}
