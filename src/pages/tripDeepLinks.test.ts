import { describe, it, expect } from 'vitest'
import { DEEP_LINKS } from '../lib/todos/copy'
import {
  DEEP_LINK_TOASTS,
  fallbackDeepLinkPlan,
  DEEP_LINK_GONE_TOAST,
  formatOpenParam,
  planDeepLink,
  resolveOpenParam,
  stripDeepLinkParams,
  type DeepLinkContext,
  type OpenTarget,
} from './tripDeepLinks'

const ME = 'user-me'
const OTHER = 'user-other'

function ctx(over: Partial<DeepLinkContext> = {}): DeepLinkContext {
  return {
    userId: ME,
    isOrganizer: false,
    isParticipant: true,
    tripFinished: false,
    participantCount: 4,
    sections: [
      { id: 'sec-open', status: 'in_progress', hasLiveOptions: true },
      { id: 'sec-open-2', status: 'in_progress', hasLiveOptions: true },
      { id: 'sec-done', status: 'completed', hasLiveOptions: true },
      { id: 'sec-empty', status: 'in_progress', hasLiveOptions: false },
    ],
    answerSectionIds: ['sec-open', 'sec-open-2'],
    actionIds: new Set(['act-1']),
    checklistIds: new Set(['chk-1']),
    settlements: [
      { id: 'st-pay', from_user_id: ME, to_user_id: OTHER, status: 'suggested' },
      { id: 'st-confirm', from_user_id: OTHER, to_user_id: ME, status: 'marked_paid' },
    ],
    expenses: [
      { id: 'exp-code', claimCode: 'ABC123' },
      { id: 'exp-nocode', claimCode: null },
      { id: 'exp-mine', claimCode: 'MINE12', paidBy: ME },
      { id: 'exp-theirs', claimCode: 'THEIRS', paidBy: OTHER },
    ],
    itemIds: new Set(['evt-1', 'opt-1']),
    options: [
      { id: 'opt-open', sectionId: 'sec-open', booked: false },
      { id: 'opt-win', sectionId: 'sec-done', booked: false },
      { id: 'opt-booked', sectionId: 'sec-done', booked: true },
    ],
    ownChoiceSectionIds: new Set<string>(),
    ...over,
  }
}

/** The `?open=` value of a link built by the engine's DEEP_LINKS. */
const valueOf = (link: string) => new URLSearchParams(link).get('open')

describe('resolveOpenParam', () => {
  it('parses every link the engine emits', () => {
    const cases: Array<[string, OpenTarget]> = [
      [DEEP_LINKS.todos(), { kind: 'todos' }],
      [DEEP_LINKS.rsvp(), { kind: 'rsvp' }],
      [DEEP_LINKS.question('s1'), { kind: 'question', id: 's1' }],
      [DEEP_LINKS.answerAll(), { kind: 'answer-all' }],
      [DEEP_LINKS.todo('a1'), { kind: 'todo', id: 'a1' }],
      [DEEP_LINKS.bring('c1'), { kind: 'bring', id: 'c1' }],
      [DEEP_LINKS.settle(), { kind: 'settle' }],
      [DEEP_LINKS.payment('p1'), { kind: 'payment', id: 'p1' }],
      [DEEP_LINKS.travelDetails(), { kind: 'travel-details' }],
      [DEEP_LINKS.item('e1'), { kind: 'item', id: 'e1' }],
      [DEEP_LINKS.claim('x1'), { kind: 'claim', id: 'x1' }],
      [DEEP_LINKS.setup(), { kind: 'setup' }],
      [DEEP_LINKS.decide('s1'), { kind: 'decide', id: 's1' }],
      [DEEP_LINKS.book('o1'), { kind: 'book', id: 'o1' }],
    ]
    for (const [link, expected] of cases) {
      expect(resolveOpenParam(valueOf(link)), link).toEqual(expected)
    }
  })

  it('keeps the older links working', () => {
    expect(resolveOpenParam('actions')).toEqual({ kind: 'actions', segment: 'actions' })
    expect(resolveOpenParam('actions-bring')).toEqual({ kind: 'actions', segment: 'bring' })
  })

  it('todos-all is a link to the whole grouped To-dos sheet (todos only scrolls Today)', () => {
    expect(resolveOpenParam('todos-all')).toEqual({ kind: 'actions', segment: 'actions' })
    expect(resolveOpenParam('todos')).toEqual({ kind: 'todos' })
  })

  it('keeps uuid ids intact, including extra colons', () => {
    expect(resolveOpenParam('question:3f2a9b1e-1111-4222-8333-944455556666')).toEqual({
      kind: 'question',
      id: '3f2a9b1e-1111-4222-8333-944455556666',
    })
    expect(resolveOpenParam('item:a:b')).toEqual({ kind: 'item', id: 'a:b' })
  })

  it('returns null for absent, empty, unknown or malformed values', () => {
    for (const v of [null, undefined, '', 'something-else', 'question:', 'question', ':abc', 'todos:1', 'nope:abc', 'question: ']) {
      expect(resolveOpenParam(v), String(v)).toBeNull()
    }
  })

  it('does not hand out a shared object that callers could mutate', () => {
    const a = resolveOpenParam('todos')
    const b = resolveOpenParam('todos')
    expect(a).not.toBe(b)
  })
})

describe('formatOpenParam', () => {
  it('round-trips every target', () => {
    const values = [
      'todos', 'rsvp', 'question:s1', 'answer-all', 'todo:a1', 'bring:c1', 'settle',
      'payment:p1', 'travel-details', 'item:e1', 'claim:x1', 'setup', 'decide:s1', 'book:o1', 'actions', 'actions-bring',
    ]
    for (const v of values) {
      const target = resolveOpenParam(v)
      expect(target, v).not.toBeNull()
      expect(formatOpenParam(target as OpenTarget)).toBe(v)
    }
  })
})

describe('stripDeepLinkParams', () => {
  it('removes open and tab and keeps everything else', () => {
    expect(stripDeepLinkParams('open=todos')).toBe('')
    expect(stripDeepLinkParams('?tab=money&open=settle&ref=email')).toBe('ref=email')
    expect(stripDeepLinkParams('')).toBe('')
  })
})

describe('planDeepLink: decide / book', () => {
  const org = (over: Partial<DeepLinkContext> = {}) => ctx({ isOrganizer: true, ...over })

  it('decide:<id> on an open question -> Manage sheet in decide mode', () => {
    expect(planDeepLink({ kind: 'decide', id: 'sec-open' }, org())).toEqual({ space: 'plan', open: { sheet: 'manage-question', id: 'sec-open', mode: 'decide' } })
  })

  it('decide fails soft (no longer available) when decided, unknown, finished or the viewer cannot manage', () => {
    const gone = { space: 'today', toast: DEEP_LINK_GONE_TOAST }
    expect(planDeepLink({ kind: 'decide', id: 'sec-done' }, org())).toEqual(gone)
    expect(planDeepLink({ kind: 'decide', id: 'nope' }, org())).toEqual(gone)
    expect(planDeepLink({ kind: 'decide', id: 'sec-open' }, org({ tripFinished: true }))).toEqual(gone)
    expect(planDeepLink({ kind: 'decide', id: 'sec-open' }, ctx())).toEqual(gone)
  })

  it('book:<optionId> on a decided, unbooked option -> Manage sheet in book mode', () => {
    expect(planDeepLink({ kind: 'book', id: 'opt-win' }, org())).toEqual({ space: 'plan', open: { sheet: 'manage-question', id: 'sec-done', mode: 'book', optionId: 'opt-win' } })
  })

  it('book fails soft when already booked, the question is not decided, unknown, own choice, or not an organiser', () => {
    const gone = { space: 'today', toast: DEEP_LINK_GONE_TOAST }
    expect(planDeepLink({ kind: 'book', id: 'opt-booked' }, org())).toEqual(gone)
    expect(planDeepLink({ kind: 'book', id: 'opt-open' }, org())).toEqual(gone)
    expect(planDeepLink({ kind: 'book', id: 'nope' }, org())).toEqual(gone)
    expect(planDeepLink({ kind: 'book', id: 'opt-win' }, org({ ownChoiceSectionIds: new Set(['sec-done']) }))).toEqual(gone)
    expect(planDeepLink({ kind: 'book', id: 'opt-win' }, ctx())).toEqual(gone)
    expect(planDeepLink({ kind: 'book', id: 'opt-win' }, org({ tripFinished: true }))).toEqual(gone)
  })
})

describe('planDeepLink', () => {
  it('todos -> Today, scrolled to Your to-dos', () => {
    expect(planDeepLink({ kind: 'todos' }, ctx())).toEqual({ space: 'today', open: { sheet: 'scroll-todos' } })
  })

  it('rsvp -> RSVP sheet; soft-fails for a non-participant', () => {
    expect(planDeepLink({ kind: 'rsvp' }, ctx())).toEqual({ space: 'today', open: { sheet: 'rsvp' } })
    expect(planDeepLink({ kind: 'rsvp' }, ctx({ isParticipant: false }))).toEqual({
      space: 'today',
      toast: DEEP_LINK_TOASTS.rsvp,
    })
  })

  describe('question', () => {
    it('open question -> answer flow on that question, over the Plan', () => {
      expect(planDeepLink({ kind: 'question', id: 'sec-open' }, ctx())).toEqual({
        space: 'plan',
        open: { sheet: 'answer', sectionIds: ['sec-open'] },
      })
    })

    it('decided question -> Plan (its card), no flow', () => {
      expect(planDeepLink({ kind: 'question', id: 'sec-done' }, ctx())).toEqual({
        space: 'plan',
        open: { sheet: 'plan-question', id: 'sec-done' },
      })
    })

    it('finished trip or option-less question -> Plan, no flow', () => {
      expect(planDeepLink({ kind: 'question', id: 'sec-open' }, ctx({ tripFinished: true }))).toEqual({
        space: 'plan',
        open: { sheet: 'plan-question', id: 'sec-open' },
      })
      expect(planDeepLink({ kind: 'question', id: 'sec-empty' }, ctx())).toEqual({
        space: 'plan',
        open: { sheet: 'plan-question', id: 'sec-empty' },
      })
    })

    it('a question the viewer has already answered (or is not asked) -> Questions list card, no flow', () => {
      expect(planDeepLink({ kind: 'question', id: 'sec-open' }, ctx({ answerSectionIds: ['sec-open-2'] }))).toEqual({
        space: 'plan',
        open: { sheet: 'plan-question', id: 'sec-open' },
      })
      expect(planDeepLink({ kind: 'question', id: 'sec-open' }, ctx({ answerSectionIds: [] })).open).toEqual({ sheet: 'plan-question', id: 'sec-open' })
    })

    it('unknown id fails soft to Today with a toast', () => {
      expect(planDeepLink({ kind: 'question', id: 'gone' }, ctx())).toEqual({ space: 'today', toast: DEEP_LINK_TOASTS.question })
    })
  })

  describe('answer-all', () => {
    it('opens the flow over the viewer\'s open answers', () => {
      expect(planDeepLink({ kind: 'answer-all' }, ctx())).toEqual({
        space: 'plan',
        open: { sheet: 'answer', sectionIds: ['sec-open', 'sec-open-2'] },
      })
    })

    it('drops answers whose question no longer exists', () => {
      const plan = planDeepLink({ kind: 'answer-all' }, ctx({ answerSectionIds: ['sec-open', 'deleted'] }))
      expect(plan.open).toEqual({ sheet: 'answer', sectionIds: ['sec-open'] })
    })

    it('nothing to answer -> Today with a toast', () => {
      expect(planDeepLink({ kind: 'answer-all' }, ctx({ answerSectionIds: [] }))).toEqual({
        space: 'today',
        toast: DEEP_LINK_TOASTS.noAnswers,
      })
    })
  })

  describe('todo / bring', () => {
    it('todo:<id> -> to-dos sheet, row highlighted', () => {
      expect(planDeepLink({ kind: 'todo', id: 'act-1' }, ctx())).toEqual({
        space: 'today',
        open: { sheet: 'actions', segment: 'actions', highlightId: 'act-1' },
      })
    })

    it('bring:<id> -> to-dos sheet on the bring segment', () => {
      expect(planDeepLink({ kind: 'bring', id: 'chk-1' }, ctx())).toEqual({
        space: 'today',
        open: { sheet: 'actions', segment: 'bring', highlightId: 'chk-1' },
      })
    })

    it('stale ids fail soft', () => {
      expect(planDeepLink({ kind: 'todo', id: 'x' }, ctx())).toEqual({ space: 'today', toast: DEEP_LINK_TOASTS.todo })
      expect(planDeepLink({ kind: 'bring', id: 'x' }, ctx())).toEqual({ space: 'today', toast: DEEP_LINK_TOASTS.bring })
    })

    it('todos-all opens the To-dos sheet', () => {
      expect(planDeepLink(resolveOpenParam('todos-all')!, ctx())).toEqual({
        space: 'today',
        open: { sheet: 'actions', segment: 'actions' },
      })
    })

    it('legacy actions links open the sheet without a highlight', () => {
      expect(planDeepLink({ kind: 'actions', segment: 'bring' }, ctx())).toEqual({
        space: 'today',
        open: { sheet: 'actions', segment: 'bring' },
      })
    })
  })

  describe('money', () => {
    it('settle -> Money > Settle up', () => {
      expect(planDeepLink({ kind: 'settle' }, ctx())).toEqual({ space: 'money', open: { sheet: 'settle-up' } })
    })

    it('payment I owe (suggested) -> MarkPaid sheet', () => {
      expect(planDeepLink({ kind: 'payment', id: 'st-pay' }, ctx())).toEqual({
        space: 'money',
        open: { sheet: 'mark-paid', settlementId: 'st-pay' },
      })
    })

    it('payment to confirm (I am the receiver) -> Settle up, that payment', () => {
      expect(planDeepLink({ kind: 'payment', id: 'st-confirm' }, ctx())).toEqual({
        space: 'money',
        open: { sheet: 'confirm-payment', settlementId: 'st-confirm' },
      })
    })

    it('unknown payment -> Settle up with a toast', () => {
      expect(planDeepLink({ kind: 'payment', id: 'gone' }, ctx())).toEqual({
        space: 'money',
        open: { sheet: 'settle-up' },
        toast: DEEP_LINK_TOASTS.payment,
      })
    })

    it('claim with a code -> claim page; without -> Money with a toast; unknown -> Today with a toast', () => {
      expect(planDeepLink({ kind: 'claim', id: 'exp-code' }, ctx())).toEqual({
        space: 'money',
        open: { sheet: 'claim', code: 'ABC123' },
      })
      expect(planDeepLink({ kind: 'claim', id: 'exp-nocode' }, ctx())).toEqual({ space: 'money', toast: DEEP_LINK_TOASTS.claimClosed })
      expect(planDeepLink({ kind: 'claim', id: 'gone' }, ctx())).toEqual({ space: 'today', toast: DEEP_LINK_TOASTS.claim })
    })

    it('claim for a receipt YOU paid lands on Who had what; someone else’s lands on the normal claim page', () => {
      expect(planDeepLink({ kind: 'claim', id: 'exp-mine' }, ctx())).toEqual({ space: 'money', open: { sheet: 'claim', code: 'MINE12', assign: true } })
      expect(planDeepLink({ kind: 'claim', id: 'exp-theirs' }, ctx())).toEqual({ space: 'money', open: { sheet: 'claim', code: 'THEIRS' } })
    })
  })

  it('travel-details -> People, travel sheet', () => {
    expect(planDeepLink({ kind: 'travel-details' }, ctx())).toEqual({ space: 'people', open: { sheet: 'travel-details' } })
  })

  it('item:<id> -> Plan; unknown fails soft', () => {
    expect(planDeepLink({ kind: 'item', id: 'evt-1' }, ctx())).toEqual({
      space: 'plan',
      open: { sheet: 'plan-item', id: 'evt-1' },
    })
    expect(planDeepLink({ kind: 'item', id: 'gone' }, ctx())).toEqual({ space: 'today', toast: DEEP_LINK_TOASTS.item })
  })

  describe('setup', () => {
    it('organiser with nobody invited -> invite sheet', () => {
      expect(planDeepLink({ kind: 'setup' }, ctx({ isOrganizer: true, participantCount: 1 }))).toEqual({
        space: 'today',
        open: { sheet: 'add-participant' },
      })
    })

    it('organiser with people but no questions -> add-to-plan sheet', () => {
      expect(planDeepLink({ kind: 'setup' }, ctx({ isOrganizer: true, sections: [] }))).toEqual({
        space: 'plan',
        open: { sheet: 'add-to-plan', asQuestion: true },
      })
    })

    it('already set up, or not an organiser -> Today', () => {
      expect(planDeepLink({ kind: 'setup' }, ctx({ isOrganizer: true }))).toEqual({ space: 'today' })
      expect(planDeepLink({ kind: 'setup' }, ctx({ participantCount: 1 }))).toEqual({ space: 'today' })
    })
  })

  describe('fallbackDeepLinkPlan (data never loaded)', () => {
    it('lands on Today with a toast for any link that needs data', () => {
      expect(fallbackDeepLinkPlan({ kind: 'question', id: 'x' })).toEqual({ space: 'today', toast: DEEP_LINK_GONE_TOAST })
      expect(fallbackDeepLinkPlan({ kind: 'payment', id: 'x' }).toast).toBe(DEEP_LINK_GONE_TOAST)
    })
    it('todos still scrolls to the card', () => {
      expect(fallbackDeepLinkPlan({ kind: 'todos' })).toEqual({ space: 'today', open: { sheet: 'scroll-todos' } })
    })
  })
})

describe('?open=ask (the trip assistant)', () => {
  it('parses, round-trips and opens the assistant without picking a sheet to land on', () => {
    expect(resolveOpenParam('ask')).toEqual({ kind: 'ask' })
    expect(formatOpenParam({ kind: 'ask' })).toBe('ask')
    expect(planDeepLink({ kind: 'ask' }, ctx()).open).toEqual({ sheet: 'ask' })
  })
})
