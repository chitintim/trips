/**
 * `?open=` deep-link targets for TripDetail.
 *
 * Every link the to-dos engine emits (`DEEP_LINKS` in lib/todos/copy.ts, plus
 * the older `travel-details` / `actions` links) is parsed here into an
 * `OpenTarget`, and `planDeepLink` turns a target plus a small read-only view
 * of the trip's data into a `DeepLinkPlan`: which space to show, which sheet
 * to open, or (for stale / unknown ids) a soft landing on Today with a toast.
 *
 * Both functions are pure so the whole routing table is unit-testable without
 * mounting TripDetail (which needs a router + query-client tree). TripDetail
 * only has to apply the plan to its own state.
 */

export type SpaceId = 'today' | 'plan' | 'money' | 'people'

export type OpenTarget =
  | { kind: 'todos' }
  | { kind: 'rsvp' }
  | { kind: 'question'; id: string }
  | { kind: 'answer-all' }
  | { kind: 'todo'; id: string }
  | { kind: 'bring'; id: string }
  | { kind: 'settle' }
  | { kind: 'payment'; id: string }
  | { kind: 'travel-details' }
  | { kind: 'item'; id: string }
  | { kind: 'claim'; id: string }
  | { kind: 'setup' }
  | { kind: 'actions'; segment: 'actions' | 'bring' }

/** Values that carry an id after a colon: `question:<id>` etc. */
const ID_KINDS = ['question', 'todo', 'bring', 'payment', 'item', 'claim'] as const
type IdKind = (typeof ID_KINDS)[number]

const BARE_KINDS: Record<string, OpenTarget> = {
  todos: { kind: 'todos' },
  rsvp: { kind: 'rsvp' },
  'answer-all': { kind: 'answer-all' },
  settle: { kind: 'settle' },
  'travel-details': { kind: 'travel-details' },
  setup: { kind: 'setup' },
  // Older links (action notes, emails sent before the to-dos engine).
  actions: { kind: 'actions', segment: 'actions' },
  'actions-bring': { kind: 'actions', segment: 'bring' },
}

/** Resolves a raw `?open=` value to its target, or `null` for an absent/unrecognised/malformed value. */
export function resolveOpenParam(value: string | null | undefined): OpenTarget | null {
  if (!value) return null
  const bare = BARE_KINDS[value]
  if (bare) return { ...bare } as OpenTarget

  const colon = value.indexOf(':')
  if (colon <= 0) return null
  const kind = value.slice(0, colon)
  const id = value.slice(colon + 1).trim()
  if (!id || !(ID_KINDS as readonly string[]).includes(kind)) return null
  return { kind: kind as IdKind, id } as OpenTarget
}

/** Inverse of `resolveOpenParam`: the `?open=` value for a target (no leading `?open=`). */
export function formatOpenParam(target: OpenTarget): string {
  switch (target.kind) {
    case 'actions':
      return target.segment === 'bring' ? 'actions-bring' : 'actions'
    case 'question':
    case 'todo':
    case 'bring':
    case 'payment':
    case 'item':
    case 'claim':
      return `${target.kind}:${target.id}`
    default:
      return target.kind
  }
}

/**
 * `search` with the one-shot deep-link params (`open`, `tab`) removed, as a
 * query string with no leading `?` (empty when nothing is left). Other params
 * are preserved.
 */
export function stripDeepLinkParams(search: string): string {
  const params = new URLSearchParams(search)
  params.delete('open')
  params.delete('tab')
  return params.toString()
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/** Read-only facts about the trip that routing needs. Build it from the to-dos snapshot. */
export interface DeepLinkContext {
  userId: string | null
  isOrganizer: boolean
  /** The viewer has a participant row (RSVP sheet needs one). */
  isParticipant: boolean
  tripFinished: boolean
  participantCount: number
  sections: ReadonlyArray<{ id: string; status: string | null; hasLiveOptions: boolean }>
  /** Section ids of the viewer's current "answer" to-dos, in to-do order. */
  answerSectionIds: ReadonlyArray<string>
  actionIds: ReadonlySet<string>
  checklistIds: ReadonlySet<string>
  settlements: ReadonlyArray<{ id: string; from_user_id: string; to_user_id: string; status: string | null }>
  expenses: ReadonlyArray<{ id: string; claimCode: string | null }>
  /** Timeline event ids and option ids (what `item:` can point at). */
  itemIds: ReadonlySet<string>
}

export type DeepLinkSheet =
  | { sheet: 'rsvp' }
  | { sheet: 'answer'; sectionIds: string[] }
  | { sheet: 'actions'; segment: 'actions' | 'bring'; highlightId?: string }
  | { sheet: 'travel-details' }
  | { sheet: 'mark-paid'; settlementId: string }
  | { sheet: 'confirm-payment'; settlementId: string }
  | { sheet: 'plan-item'; id: string }
  | { sheet: 'plan-question'; id: string }
  | { sheet: 'settle-up' }
  | { sheet: 'claim'; code: string }
  | { sheet: 'add-participant' }
  | { sheet: 'add-to-plan' }
  | { sheet: 'scroll-todos' }

export interface DeepLinkPlan {
  space: SpaceId
  open?: DeepLinkSheet
  /** Soft-failure message: shown as a brief toast. */
  toast?: string
}

export const DEEP_LINK_TOASTS = {
  question: "That question isn't open any more.",
  noAnswers: "You're all set ✓ Nothing needs your answer.",
  todo: "That to-do isn't on the list any more.",
  bring: "That packing item isn't on the list any more.",
  payment: "That payment isn't there any more.",
  claim: "That receipt isn't there any more.",
  claimClosed: "Claiming isn't open for that receipt.",
  item: "That item isn't on the plan any more.",
  rsvp: "You're not on this trip's guest list.",
} as const

const soft = (toast: string): DeepLinkPlan => ({ space: 'today', toast })

/** Where a parsed `?open=` target lands, given the current data. Pure; unknown/stale ids fail soft to Today + toast. */
export function planDeepLink(target: OpenTarget, ctx: DeepLinkContext): DeepLinkPlan {
  switch (target.kind) {
    case 'todos':
      return { space: 'today', open: { sheet: 'scroll-todos' } }

    case 'rsvp':
      return ctx.isParticipant ? { space: 'today', open: { sheet: 'rsvp' } } : soft(DEEP_LINK_TOASTS.rsvp)

    case 'question': {
      const section = ctx.sections.find((s) => s.id === target.id)
      if (!section) return soft(DEEP_LINK_TOASTS.question)
      // A decided / closed / option-less question has nothing left to answer:
      // show it on the Plan, where its card lives.
      if (section.status === 'completed' || ctx.tripFinished || !section.hasLiveOptions) return { space: 'plan', open: { sheet: 'plan-question', id: section.id } }
      return { space: 'plan', open: { sheet: 'answer', sectionIds: [section.id] } }
    }

    case 'answer-all': {
      const open = ctx.answerSectionIds.filter((id) => ctx.sections.some((s) => s.id === id))
      if (open.length === 0) return soft(DEEP_LINK_TOASTS.noAnswers)
      return { space: 'plan', open: { sheet: 'answer', sectionIds: [...open] } }
    }

    case 'todo':
      return ctx.actionIds.has(target.id)
        ? { space: 'today', open: { sheet: 'actions', segment: 'actions', highlightId: target.id } }
        : soft(DEEP_LINK_TOASTS.todo)

    case 'bring':
      return ctx.checklistIds.has(target.id)
        ? { space: 'today', open: { sheet: 'actions', segment: 'bring', highlightId: target.id } }
        : soft(DEEP_LINK_TOASTS.bring)

    case 'actions':
      return { space: 'today', open: { sheet: 'actions', segment: target.segment } }

    case 'settle':
      return { space: 'money', open: { sheet: 'settle-up' } }

    case 'payment': {
      const st = ctx.settlements.find((s) => s.id === target.id)
      if (!st) return { space: 'money', open: { sheet: 'settle-up' }, toast: DEEP_LINK_TOASTS.payment }
      // The payer marks a suggested payment as paid in the MarkPaid sheet.
      if (st.from_user_id === ctx.userId && st.status === 'suggested') {
        return { space: 'money', open: { sheet: 'mark-paid', settlementId: st.id } }
      }
      // The receiver's "confirm" opens its confirm step directly.
      if (st.to_user_id === ctx.userId && st.status === 'marked_paid') {
        return { space: 'money', open: { sheet: 'confirm-payment', settlementId: st.id } }
      }
      // Anything else (already settled, or not the viewer's payment) lives on Settle up.
      return { space: 'money', open: { sheet: 'settle-up' } }
    }

    case 'claim': {
      const expense = ctx.expenses.find((e) => e.id === target.id)
      if (!expense) return soft(DEEP_LINK_TOASTS.claim)
      if (!expense.claimCode) return { space: 'money', toast: DEEP_LINK_TOASTS.claimClosed }
      return { space: 'money', open: { sheet: 'claim', code: expense.claimCode } }
    }

    case 'travel-details':
      return { space: 'people', open: { sheet: 'travel-details' } }

    case 'item':
      // The Plan owns PlanItemSheet; the shell hands it the id to open.
      return ctx.itemIds.has(target.id) ? { space: 'plan', open: { sheet: 'plan-item', id: target.id } } : soft(DEEP_LINK_TOASTS.item)

    case 'setup': {
      if (!ctx.isOrganizer) return { space: 'today' }
      if (ctx.participantCount < 2) return { space: 'today', open: { sheet: 'add-participant' } }
      if (ctx.sections.length === 0) return { space: 'plan', open: { sheet: 'add-to-plan' } }
      return { space: 'today' }
    }
  }
}
