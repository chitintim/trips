/**
 * MANUAL MIRROR of src/lib/todos/types.ts (Deno edge functions cannot import from src/).
 * Keep the code identical; only import specifiers and comments may differ.
 * Enforced by scripts/check-contract-drift.mjs.
 */
/**
 * Types for the to-dos engine (src/lib/todos/computeTodos.ts).
 *
 * Everything here is structural and dependency-light so generated DB rows and
 * TanStack Query results fit without conversion, and so the module can be
 * mirrored into the auto-chase edge function.
 */
import type { Json } from './deps/json.ts'
import type { TripStatus } from './deps/tripStatus.ts'
import type { AnswerPass } from '../answers/answers.ts'

// ---------------------------------------------------------------------------
// Snapshot: exactly what the existing queries already fetch
// ---------------------------------------------------------------------------

export interface SnapshotTrip {
  id: string
  name: string
  status: TripStatus
  start_date: string
  end_date: string
  confirmation_enabled: boolean | null
  confirmation_deadline: string | null
  base_currency: string
  created_by?: string | null
  /**
   * `trips.settlement_snapshot`. Non-null = balances are frozen (suggested
   * payments exist and expenses are locked). Omitted/null = not frozen.
   */
  settlement_snapshot?: Json | null
}

export interface SnapshotUser {
  full_name?: string | null
  first_name?: string | null
  email?: string | null
}

export interface SnapshotParticipant {
  user_id: string
  role?: string | null
  /** `false` = removed from the trip (money to-dos only). */
  active?: boolean | null
  confirmation_status?: string | null
  conditional_date?: string | null
  waitlist_offer_expires_at?: string | null
  user?: SnapshotUser | null
}

export interface SnapshotOption {
  id: string
  title?: string | null
  status: string
  order_index?: number | null
  created_at?: string | null
  metadata?: Json | null
  selections?: ReadonlyArray<{ user_id: string }> | null
}

export interface SnapshotSection {
  id: string
  title: string
  status: string
  vote_deadline: string | null
  voting_method: string | null
  metadata: Json | null
  /** `planning_sections.section_type`; only types you actually book produce a "Book:" to-do. */
  section_type?: string | null
  options: ReadonlyArray<SnapshotOption>
}

export interface SnapshotVote {
  option_id: string
  user_id: string
  rank?: number | null
}

export interface SnapshotAction {
  id: string
  title: string
  assigned_to: string | null
  deadline_kind: string
  due_date: string | null
  completed_at: string | null
  section_id: string | null
  trip_action_completions?: ReadonlyArray<{ user_id: string }> | null
}

export interface SnapshotChecklistItem {
  id: string
  title: string
  assigned_to: string | null
  done: boolean
}

export interface SnapshotExpense {
  id: string
  description: string
  amount: number
  currency: string
  paid_by: string
  ai_parsed: boolean | null
  status: string | null
  participant_ids: ReadonlyArray<string> | null
  claims: ReadonlyArray<{ user_id: string }>
  /** The claim link (`expense_allocation_links` row). No link = nobody can claim, so there is no claim to-do. */
  allocation_link?: { code: string; expires_at?: string | null } | null
}

export interface SnapshotSettlement {
  id: string
  from_user_id: string
  to_user_id: string
  amount: number
  currency: string | null
  status: string
}

export interface SnapshotTravelEvent {
  title: string
  participant_ids: ReadonlyArray<string> | null
  metadata: Json | null
}

export interface SnapshotBooking {
  option_id: string | null
  status: string
}

/** Everything `computeTodos` reads. No React, no Supabase. */
export interface TripSnapshot {
  trip: SnapshotTrip
  /** Active participants (the shape `useParticipants` returns). */
  participants: ReadonlyArray<SnapshotParticipant>
  /**
   * Everyone ever on the trip, including people who left (`useAllParticipants`).
   * Used ONLY to name a payer/payee who is no longer active. Optional.
   */
  allParticipants?: ReadonlyArray<SnapshotParticipant>
  /** Questions with nested options and nested selections (`useSections`). */
  sections: ReadonlyArray<SnapshotSection>
  votes: ReadonlyArray<SnapshotVote>
  /** Phase 2 extension point (`question_passes`). Omit until it exists. */
  passes?: ReadonlyArray<AnswerPass>
  actions: ReadonlyArray<SnapshotAction>
  checklists: ReadonlyArray<SnapshotChecklistItem>
  expenses: ReadonlyArray<SnapshotExpense>
  settlements: ReadonlyArray<SnapshotSettlement>
  /**
   * Net balance per user in base-currency MAJOR units (negative = owes money).
   * Computed by the caller with `computeBalances`; only read on Finished trips.
   */
  balances?: Readonly<Record<string, number>>
  /** Timeline events (travel-details events are recognised by metadata). */
  travelEvents: ReadonlyArray<SnapshotTravelEvent>
  /** Live and cancelled bookings (used to decide whether a decided winner still needs booking). */
  bookings?: ReadonlyArray<SnapshotBooking>
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export type TodoKind =
  | 'rsvp'
  | 'answer'
  | 'task'
  | 'pay'
  | 'confirm_payment'
  | 'claim'
  | 'travel'
  | 'waitlist_offer'
  // organiser-only
  | 'org_decide'
  | 'org_tie'
  | 'org_book'
  | 'org_setup'

/** `personal` = something this person owes; `organiser` = "For you as organiser". */
export type TodoGroup = 'personal' | 'organiser'

/**
 * A deep link as a query string appended to the trip URL: `?open=question:<id>`.
 * Use `todoHref(tripId, todo)` for a path, or `todo.link` with
 * `navigate({ search })`. The formats are built by `DEEP_LINKS` in copy.ts.
 */
export type TodoLink = string

export interface Todo {
  /** Stable `${kind}:${entityId}` (a few kinds add a suffix). Unique within one person's list. */
  id: string
  kind: TodoKind
  group: TodoGroup
  /** Who owes it. */
  userId: string
  /** Question / action / checklist item / settlement / expense / option / trip id. */
  entityId: string
  /** Verb-first row title (copy.ts). */
  title: string
  /** Second line, or null (copy.ts). */
  subtitle: string | null
  /** Primary button text (copy.ts). */
  actionLabel: string
  /** Optional deadline (ISO date or timestamp). Affects ordering and `overdue` only. */
  due: string | null
  overdue: boolean
  link: TodoLink
  /** For `answer`: Group choice vs Own choice. */
  shape?: 'group' | 'own'
  /** For `answer`: "N of M answered", with the single in-scope denominator. */
  progress?: { done: number; total: number }
}

export interface WaitingOnPerson {
  userId: string
  name: string
  todos: Todo[]
  count: number
  overdueCount: number
}

export interface WaitingOnItem {
  /** `${kind}:${entityId}` */
  id: string
  kind: TodoKind
  group: TodoGroup
  entityId: string
  /** The shared title (taken from the first person's to-do). */
  title: string
  link: TodoLink
  due: string | null
  overdue: boolean
  /** People who still owe this item. */
  userIds: string[]
  /** Present for answers and "Everyone" to-dos: "7 of 9 answered" / "8 of 10 done". */
  done?: number
  total?: number
}

export interface WaitingOn {
  /** Most to-dos first, then name. Only people who owe something. */
  byPerson: WaitingOnPerson[]
  /** Overdue first, then by due date, then kind order. */
  byItem: WaitingOnItem[]
  /** userId -> that person's to-dos: identical to `computeTodos(snapshot, userId)`. */
  byUser: Map<string, Todo[]>
  totalPeople: number
  totalTodos: number
}

export interface ComputeWaitingOnOptions {
  /** Include organiser-group to-dos (decide / book / setup). Default true, so per-person counts equal `computeTodos`. */
  includeOrganiser?: boolean
}
