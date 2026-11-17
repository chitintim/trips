import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('../../../lib/supabase', () => ({ supabase: { from: vi.fn(), rpc: vi.fn(), auth: { getSession: vi.fn() } } }))

import { moduleFor } from './index'
import { dayWarning, formatDay, personName } from './common'
import { ActionCardView } from '../components/ActionCardView'
import { ownPendingProposals } from '../lib/ownProposals'
import { answerParams, envelope, expenseParams, liveFixture, ANA, BEN, ME, SAM, todoParams } from '../lib/chatFixtures'
import type { LiveData } from './types'

const NOW = new Date('2026-11-17T12:00:00Z')
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ')
const roster = (...p: Array<[string, string]>): LiveData['roster'] => p.map(([user_id, name]) => ({ user_id, name, active: true, confirmation_status: 'confirmed' }))

function card(a: ReturnType<typeof envelope>, live: LiveData, phase: 'proposed' | 'stale' | 'stuck' = 'proposed', message: string | null = null) {
  return text(
    renderToStaticMarkup(
      createElement(ActionCardView, {
        view: moduleFor(a.kind)!.view(a, live),
        tier: 'review',
        phase,
        message,
        doneText: null,
        invalid: false,
        showUndo: false,
        undoing: false,
        undone: false,
        onConfirm: () => undefined,
        onDismiss: () => undefined,
        onUndo: () => undefined,
        onAskAgain: () => undefined,
      })
    )
  )
}

describe('B1: who a card says paid', () => {
  it('"You" only for the signed-in user, by id', () => {
    const live = liveFixture({ roster: roster([ME, 'Tim Lam'], [SAM, 'Sam Jones']), now: NOW })
    expect(personName(live, ME)).toBe('You')
    expect(personName(live, SAM)).toBe('Sam Jones')
  })
  it('a member literally named "You" never reads as the viewer', () => {
    const live = liveFixture({ roster: roster([ME, 'Tim Lam'], [SAM, 'You'], [ANA, 'you (Ana)']), now: NOW })
    expect(personName(live, SAM)).toBe('You (not you)')
    expect(personName(live, ANA)).toBe('you (Ana) (not you)')
    const t = card(envelope('add_expense', expenseParams({ paid_by: SAM, splits: [{ user_id: ME, amount_minor: 2000 }, { user_id: SAM, amount_minor: 2000 }], participant_ids: [ME, SAM] }), { requires: 'review' }), live)
    expect(t).toContain('Paid by You (not you)')
    expect(t).not.toMatch(/Paid by You [^(]/)
  })
  it('two people called Sam are told apart by full name', () => {
    const live = liveFixture({ roster: roster([ME, 'Tim Lam'], [SAM, 'Sam Jones'], [ANA, 'Sam Khan']), now: NOW })
    const params = expenseParams({ paid_by: SAM, splits: [{ user_id: ME, amount_minor: 1500 }, { user_id: SAM, amount_minor: 1500 }, { user_id: ANA, amount_minor: 1000 }], participant_ids: [ME, SAM, ANA] })
    const t = card(envelope('add_expense', params), live)
    expect(t).toContain('Paid by Sam Jones')
    expect(t).toContain('Sam Khan £10.00')
  })
  it('identical names and a name equal to the viewer get a marker', () => {
    const live = liveFixture({ roster: roster([ME, 'Sam'], [SAM, 'Sam'], [ANA, 'Ben'], [BEN, 'Ben']), now: NOW })
    expect(personName(live, SAM)).toBe('Sam (not you)')
    expect(personName(live, ANA)).toBe('Ben (1)')
    expect(personName(live, BEN)).toBe('Ben (2)')
  })
  it('when someone else paid, says what you will owe them', () => {
    const live = liveFixture({ roster: roster([ME, 'Tim Lam'], [SAM, 'Sam Jones']), now: NOW })
    const t = card(envelope('add_expense', expenseParams({ paid_by: SAM, splits: [{ user_id: ME, amount_minor: 2500 }, { user_id: SAM, amount_minor: 1500 }], participant_ids: [ME, SAM] })), live)
    expect(t).toContain("Paid by Sam Jones — you'll owe them £25.00")
    const mine = card(envelope('add_expense', expenseParams()), liveFixture({ now: NOW }))
    expect(mine).not.toContain("you'll owe")
    expect(mine).toContain('Paid by You')
  })
  it('names assignees by the same helper', () => {
    const live = liveFixture({ roster: roster([ME, 'Tim'], [SAM, 'You']), now: NOW })
    expect(moduleFor('add_todo')!.view(envelope('add_todo', todoParams()), live).rows.find((r) => r.label === 'For')?.value).toBe('You (not you)')
  })
})

describe('B2: stale currency and people', () => {
  const m = moduleFor('add_expense')!
  it('goes stale when the trip base currency changed', () => {
    expect(m.recheck(envelope('add_expense', expenseParams()), liveFixture({ baseCurrency: 'EUR' }))).toMatch(/currency changed/)
    expect(m.recheck(envelope('add_expense', expenseParams()), liveFixture())).toBeNull()
  })
  it('goes stale when the payer or a split person left', () => {
    const left = (id: string) => liveFixture({ roster: liveFixture().roster.map((p) => (p.user_id === id ? { ...p, active: false } : p)) })
    expect(m.recheck(envelope('add_expense', expenseParams({ paid_by: SAM })), left(SAM))).toMatch(/no longer on the trip/)
    expect(m.recheck(envelope('add_expense', expenseParams()), left(BEN))).toMatch(/no longer on the trip/)
  })
  it('the stale card says why and offers Ask again', () => {
    const t = card(envelope('add_expense', expenseParams()), liveFixture(), 'stale', "The trip's currency changed. Ask again.")
    expect(t).toContain('This changed')
    expect(t).toContain('Ask again')
  })
})

describe('S2: dates', () => {
  it('shows the year only when it is not this year', () => {
    expect(formatDay('2026-11-20', NOW)).toBe('Fri 20 Nov')
    expect(formatDay('2025-11-17', NOW)).toBe('Mon 17 Nov 2025')
  })
  it('warns about a future date and one more than 60 days ago, not a recent one', () => {
    expect(dayWarning('2026-11-18', NOW)).toMatch(/in the future/)
    expect(dayWarning('2026-09-01', NOW)).toMatch(/77 days ago/)
    expect(dayWarning('2026-11-10', NOW)).toBeNull()
    expect(dayWarning('2026-11-17', NOW)).toBeNull()
  })
  it('the expense card shows the warning', () => {
    const t = card(envelope('add_expense', expenseParams({ payment_date: '2025-11-17' })), liveFixture({ now: NOW }))
    expect(t).toContain('Mon 17 Nov 2025')
    expect(t).toMatch(/365 days ago/)
  })
})

describe('S1: clearing "No preference" (unpass)', () => {
  it('the card validates (so Confirm is offered)', async () => {
    const params = answerParams({ op: 'clear', option_ids: [], answer_actions: [{ type: 'unpass' }] })
    expect(moduleFor('answer')!.validate(params)).toBe(true)
    expect(moduleFor('answer')!.validate(answerParams({ answer_actions: [{ type: 'nonsense' }] }))).toBe(false)
  })
})

describe('S4: undo only while the created row is unchanged', () => {
  const todo = (over: object = {}) => liveFixture({ actions: [{ id: 'n1', title: 'Book the ferry', completed_at: null, assigned_to: SAM, trip_action_completions: [], ...over }] as never })
  const a = envelope('add_todo', todoParams(), { status: 'done', requires: 'tap', result: { created_id: 'n1' } })
  const m = moduleFor('add_todo')!
  it('add_todo', () => {
    expect(m.undoBlocked!(a, todo())).toBeNull()
    expect(m.undoBlocked!(a, todo({ completed_at: 'x' }))).toMatch(/ticked/)
    expect(m.undoBlocked!(a, todo({ assigned_to: ANA }))).toMatch(/reassigned/)
    expect(m.undoBlocked!(a, todo({ title: 'Other' }))).toMatch(/changed/)
    expect(m.undoBlocked!(a, liveFixture())).toMatch(/gone/)
  })
  it('answer: only while my answer is what the action left', () => {
    const ans = (after: object | undefined) => envelope('answer', answerParams(), { status: 'done', requires: 'tap', result: { undo: { previous: { votes: [], selections: [], pass: null }, ...(after ? { after } : {}) } } })
    const voted = liveFixture({ votes: [{ id: 'v', option_id: 'o1', user_id: ME, rank: null }] as never })
    const after = { votes: [{ optionId: 'o1', rank: null }], selections: [], pass: null }
    const am = moduleFor('answer')!
    expect(am.undoBlocked!(ans(after), voted)).toBeNull()
    expect(am.undoBlocked!(ans(after), liveFixture({ votes: [{ id: 'v', option_id: 'o2', user_id: ME, rank: null }] as never }))).toMatch(/changed/)
    expect(am.undoBlocked!(ans(undefined), voted)).toBeTruthy()
  })
  it('tick_todo: undone only while it is still ticked', () => {
    const t = envelope('tick_todo', { source: 'action', id: 'a1', op: 'tick', user_id: ME, is_group_action: false, anyone: false, done: true, claim: null }, { status: 'done', requires: 'tap' })
    const tm = moduleFor('tick_todo')!
    expect(tm.undoBlocked!(t, liveFixture({ actions: [{ id: 'a1', title: 'x', completed_at: 'y', assigned_to: ME, trip_action_completions: [] }] as never }))).toBeNull()
    expect(tm.undoBlocked!(t, liveFixture())).toMatch(/changed/)
  })
})

describe('P1: only my own staged proposals', () => {
  const rows = [
    { id: '1', created_by: ME, status: 'pending', expires_at: null, source_text: 'mine' },
    { id: '2', created_by: SAM, status: 'pending', expires_at: null, source_text: 'a co-organiser typed this' },
    { id: '3', created_by: ME, status: 'applied', expires_at: null, source_text: '' },
  ]
  it('hides another organiser\'s proposals', () => {
    expect(ownPendingProposals(rows, ME, true, NOW.getTime()).map((r) => r.id)).toEqual(['1'])
    expect(ownPendingProposals(rows, ME, false, NOW.getTime())).toEqual([])
    expect(ownPendingProposals(rows, undefined, true, NOW.getTime())).toEqual([])
  })
})

describe('S3: a card stuck at executing', () => {
  it('says to check, never retries, and offers Dismiss', () => {
    const t = card(envelope('add_expense', expenseParams(), { status: 'executing' }), liveFixture(), 'stuck', "This didn't finish — check the Money tab before trying again.")
    expect(t).toContain("This didn't finish — check the Money tab before trying again.")
    expect(t).toContain('Dismiss')
    expect(t).not.toContain('Add expense')
  })
})

describe('add_expense server parity guard and wording', () => {
  const m = moduleFor('add_expense')!
  const mine = expenseParams().splits.find((s) => s.user_id === ME)?.amount_minor ?? 0
  it('matching my_share_minor is fine; one minor unit off goes stale', () => {
    expect(m.recheck(envelope('add_expense', expenseParams(), { preview: { my_share_minor: mine } }), liveFixture())).toBeNull()
    expect(m.recheck(envelope('add_expense', expenseParams(), { preview: { my_share_minor: mine + 1 } }), liveFixture())).toMatch(/don't match/)
  })
  it('uses the server wording when someone else paid', () => {
    const a = envelope('add_expense', expenseParams({ paid_by: SAM }), { preview: { payer_is_user: false, my_share_minor: mine, my_share_text: 'SERVERTEXT' } })
    expect((m.view(a, liveFixture()).warnings ?? []).join(' ')).toContain('SERVERTEXT')
  })
})
