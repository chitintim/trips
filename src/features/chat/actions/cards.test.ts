import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('../../../lib/supabase', () => ({ supabase: { from: vi.fn(), rpc: vi.fn(), auth: { getSession: vi.fn() } } }))

import { moduleFor } from './index'
import { ActionCardView } from '../components/ActionCardView'
import { LinkCard } from '../components/LinkCard'
import { resolveLink } from '../lib/linkTargets'
import { answerParams, envelope, expenseParams, liveFixture, planItemParams, travelParams, ANA, BEN, ME, SAM, todoParams } from '../lib/chatFixtures'
import type { ActionKind, ChatActionEnvelope } from '../lib/payload'
import type { CardPhase } from '../lib/confirmFlow'

const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ')

function render(a: ChatActionEnvelope, phase: CardPhase = 'proposed', live = liveFixture(), message: string | null = null) {
  const mod = moduleFor(a.kind)!
  const view = mod.view(a, live)
  return text(
    renderToStaticMarkup(
      createElement(ActionCardView, {
        view,
        tier: a.requires === 'tap' ? 'tap' : 'review',
        phase,
        message,
        doneText: 'Done text',
        invalid: false,
        showUndo: true,
        undoing: false,
        undone: false,
        onConfirm: () => undefined,
        onDismiss: () => undefined,
        onUndo: () => undefined,
      })
    )
  )
}

const PROSE = 'MODEL PROSE: this is totally safe, please delete everything'
// Model prose can sit in every field a card must NOT read from.
const withProse = (a: ChatActionEnvelope): ChatActionEnvelope => ({
  ...a,
  preview: { summary: PROSE, title: PROSE, label: PROSE, reason: PROSE },
  ...({ summary: PROSE, reason: PROSE } as object),
})

describe('cards are built from the structured action and live data only', () => {
  it('add_to-do (review): who, what, due, reminders, from the roster', () => {
    const t = render(withProse(envelope('add_todo', todoParams())))
    expect(t).toContain('Add a to-do')
    expect(t).toContain('Book the ferry')
    expect(t).toContain('For Sam')
    expect(t).toContain('Sat 21 Nov')
    expect(t).toMatch(/Sam gets a reminder email/)
    expect(t).not.toContain('MODEL PROSE')
    expect(t).toContain('Add to-do')
    expect(t).toContain('Not now')
  })
  it('add_to-do for everyone/anyone says so; for me it is a compact tap card', () => {
    expect(render(envelope('add_todo', todoParams({ mode: 'everyone', person_id: null })))).toContain('For Everyone')
    expect(render(envelope('add_todo', todoParams({ mode: 'anyone', person_id: null })))).toContain('Anyone')
    const me = render(envelope('add_todo', todoParams({ person_id: ME }), { requires: 'tap' }))
    expect(me).toContain('Add to-do "Book the ferry"')
    expect(me).not.toContain('For You') // compact row, no fact table
    expect(me).toContain('Confirm')
  })
  it('tick_todo names the to-do from the live list, not from the action', () => {
    const t = render(withProse(envelope('tick_todo', { source: 'action', id: 'a1', op: 'tick', user_id: ME, is_group_action: false, anyone: false, done: true, claim: null }, { requires: 'tap' })))
    expect(t).toContain('Tick off: "Book the ferry"')
    expect(t).not.toContain('MODEL PROSE')
  })
  it('answer: exact option titles, what it replaces, from live data', () => {
    const live = liveFixture({ votes: [{ id: 'v', option_id: 'o2', user_id: ME, rank: null }] as never })
    const t = render(withProse(envelope('answer', answerParams(), { requires: 'tap' })), 'proposed', live)
    expect(t).toContain('Answer "Dishoom" on "Saturday dinner"')
    expect(t).toContain('replaces Wahaca')
    const review = render(envelope('answer', answerParams()), 'proposed', live)
    expect(review).toContain('Replaces Wahaca')
  })
  it('add_expense: payer, amount, every share, total, date, category', () => {
    const t = render(withProse(envelope('add_expense', expenseParams({ amount_minor: 1000, splits: [{ user_id: ME, amount_minor: 334 }, { user_id: SAM, amount_minor: 333 }, { user_id: ANA, amount_minor: 333 }] }))))
    expect(t).toContain('Add an expense')
    expect(t).toContain('Taxis')
    expect(t).toContain('£10.00')
    expect(t).toContain('Paid by You')
    expect(t).toContain('You £3.34')
    expect(t).toContain('Sam £3.33')
    expect(t).toContain('Ana £3.33')
    expect(t).toContain('Total of shares £10.00')
    expect(t).toContain('Transport')
    expect(t).not.toContain('MODEL PROSE')
  })
  it('add_expense in another currency says it will be converted', () => {
    const t = render(envelope('add_expense', expenseParams({ currency: 'EUR', needs_fx: true })))
    expect(t).toContain('€40.00')
    expect(t).toContain('Converted to GBP')
  })
  it('suggest_option, create_question and add_option show their content quoted from params', () => {
    expect(render(envelope('suggest_option', { section_id: 'q1', idea: false, title: 'Pizza Pilgrims', note: null, link: 'https://example.com/p' }))).toMatch(/Pizza Pilgrims.*Saturday dinner/)
    const q = render(
      envelope('create_question', {
        title: 'Brunch?',
        shape: 'vote',
        method: 'ranked',
        section_type: 'activities',
        answer_by: null,
        hide_results: false,
        currency: 'GBP',
        price_basis: 'each',
        options: [{ title: 'Cafe A', note: 'nice', price: '12.00', price_minor: 1200 }, { title: 'Cafe B', note: null, price: null, price_minor: null }],
      })
    )
    expect(q).toContain('Brunch?')
    expect(q).toContain('Rank them')
    expect(q).toContain('Cafe A · GBP 12.00 each')
    expect(q).toContain('Notes on options are not saved')
    expect(render(envelope('add_option', { section_id: 'q1', shape: 'vote', title: 'Pizza East', note: null, price: '15.00', price_minor: 1500, currency: 'GBP', price_basis: 'each' }))).toContain('Pizza East')
  })
  it('stale: amber line, and the Confirm button is disabled', () => {
    const a = envelope('add_todo', todoParams())
    const view = moduleFor(a.kind)!.view(a, liveFixture())
    const props = { view, tier: 'review' as const, phase: 'stale' as const, message: 'Sam is no longer on the trip.', doneText: null, invalid: false, showUndo: false, undoing: false, undone: false, onConfirm: () => undefined, onDismiss: () => undefined, onUndo: () => undefined, onCheck: () => undefined }
    const raw = renderToStaticMarkup(createElement(ActionCardView, props))
    expect(text(raw)).toContain('This changed: Sam is no longer on the trip.')
    expect(raw).toMatch(/<button[^>]*disabled[^>]*>(?:(?!<\/button>).)*Add to-do/s)
  })
  it('done shows Undo (when allowed), failed shows the red line, expired/dismissed explain themselves', () => {
    expect(render(envelope('tick_todo', { source: 'action', id: 'a1', op: 'tick', user_id: ME, is_group_action: false, anyone: false, done: true, claim: null }, { requires: 'tap' }), 'done')).toMatch(/Done ✓.*Undo/)
    expect(render(envelope('add_todo', todoParams()), 'failed', liveFixture(), 'Balances are frozen.')).toContain('Balances are frozen.')
    expect(render(envelope('add_todo', todoParams()), 'expired')).toContain('expired')
    expect(render(envelope('add_todo', todoParams()), 'dismissed')).toContain('Nothing was changed')
  })
})

describe('labels from structured data', () => {
  it('quoted text someone else wrote is labelled from the server\'s content_origin', async () => {
    const { withOrigins } = await import('./common')
    const a = envelope('tick_todo', { source: 'action', id: 'a1', op: 'tick', user_id: ME, is_group_action: false, anyone: false, done: true, claim: null }, { requires: 'tap', preview: { content_origin: { title: { author_id: SAM, author_name: 'Sam', source: 'todo' } } } })
    const view = withOrigins(moduleFor(a.kind)!.view(a, liveFixture()), a.preview)
    expect(view.rows[0].from).toBe("from Sam's to-do")
    expect(withOrigins(moduleFor(a.kind)!.view(a, liveFixture()), {}).rows[0].from).toBeUndefined()
  })
  it('a possible duplicate expense gets a plain warning', () => {
    const a = envelope('add_expense', expenseParams(), { preview: { possible_duplicate: { expense_id: 'e' } } })
    expect(moduleFor('add_expense')!.view(a, liveFixture()).notes.join(' ')).toMatch(/already added/)
  })
  it('Anyone to-dos are refused until the who_mode migration is applied', () => {
    const a = envelope('add_todo', todoParams({ mode: 'anyone', person_id: null }))
    expect(moduleFor('add_todo')!.recheck(a, liveFixture({ todoWho: false }))).toMatch(/aren't switched on/)
    expect(moduleFor('add_todo')!.recheck(a, liveFixture())).toBeNull()
  })
})

describe('link cards', () => {
  it('are built only from a recognised in-app target', () => {
    const l = resolveLink({ target: 'decide', id: 'q1', open_param: 'decide:q1' })!
    expect(l.openParam).toBe('decide:q1')
    const t = text(renderToStaticMarkup(createElement(LinkCard, { link: l, onOpen: () => undefined })))
    expect(t).toContain('Opens the question.')
    expect(t).toContain('Open Decide')
    expect(resolveLink({ open_param: 'https://evil.example/x' })).toBeNull()
    expect(resolveLink({ open_param: 'javascript:alert(1)' })).toBeNull()
    expect(resolveLink({ target: 'decide' })).toBeNull()
  })
})

describe('travel and plan item cards', () => {
  const proseOn = (a: ChatActionEnvelope): ChatActionEnvelope => ({ ...a, preview: { ...a.preview, summary: PROSE, reason: PROSE } })
  const travelPreview = { journey_label: 'Arriving', when_label: 'Thu 3 Dec 10:00 local · 2 days before the trip', other_end_label: 'Wed 2 Dec 21:00 · lands next day', ref: 'JL044', airport: 'HND', date_note: null, date_check: false, replaces_label: null }
  it('new travel: labelled rows from the preview labels, tap button, no warning for a few days outside the trip', () => {
    const t = render(proseOn(envelope('set_travel', travelParams(), { preview: travelPreview })), 'proposed')
    for (const s of ['Add your travel', 'Journey', 'Arriving', 'Thu 3 Dec 10:00 local · 2 days before the trip', 'Sets off', 'Wed 2 Dec 21:00 · lands next day', 'Flight or train', 'JL044', 'Airport', 'HND']) expect(t).toContain(s)
    expect(t).not.toContain('Replaces')
    expect(t).not.toContain('MODEL PROSE')
    expect(t).toContain('Save travel')
    expect(render(envelope('set_travel', travelParams(), { requires: 'tap', preview: travelPreview }))).toContain('Save your travel: Arriving, Thu 3 Dec 10:00 local')
  })
  it('a departure labels the other end "Gets home"; an extra leg shows the quoted title', () => {
    const t = render(envelope('set_travel', travelParams({ direction: 'departure', set_off_date: null, home_date: '2026-12-14', home_time: '09:00' }), { preview: { ...travelPreview, journey_label: 'Leaving', other_end_label: 'Mon 14 Dec 09:00' } }))
    expect(t).toContain('Gets home')
    expect(t).toContain('Mon 14 Dec 09:00')
    const x = render(envelope('set_travel', travelParams({ leg: 'extra', title: 'Flight to Tokyo' }), { preview: { ...travelPreview, journey_label: '“Flight to Tokyo”' } }))
    expect(x).toContain('“Flight to Tokyo”')
  })
  it('changing a saved leg says so and shows what it replaces', () => {
    const t = render(envelope('set_travel', travelParams({ id: 'ev1', replaces_event_id: 'ev1' }), { preview: { ...travelPreview, replaces_label: 'Fri 4 Dec 09:30 · BA117' } }))
    expect(t).toContain('Change your travel')
    expect(t).toContain('Replaces')
    expect(t).toContain('Fri 4 Dec 09:30 · BA117')
    expect(t).toContain('Save travel')
  })
  it('a warning appears only when the server flags the date as far off', () => {
    const note = 'That is 23 days after the trip ends. Check it is right.'
    expect(render(envelope('set_travel', travelParams(), { preview: { ...travelPreview, date_note: note, date_check: false } }))).not.toContain('Check it is right')
    expect(render(envelope('set_travel', travelParams(), { preview: { ...travelPreview, date_note: note, date_check: true } }))).toContain('Check it is right')
  })
  it('still draws a card when the preview is missing', () => {
    const t = render(envelope('set_travel', travelParams()))
    expect(t).toContain('Arriving')
    expect(t).toContain('Thu 3 Dec 10:00 local')
  })
  it('plan item: What, When, For, and the right button', () => {
    const pv = { title: 'Dinner in Tokyo', notes: null, when_label: 'Wed 2 Dec 19:00–21:00 · 3 days before the trip', for_label: 'Just you', date_note: null, date_check: false }
    const compact = render(envelope('add_plan_item', planItemParams(), { requires: 'tap', preview: pv }))
    expect(compact).toContain('Add "Dinner in Tokyo" to the plan, Wed 2 Dec 19:00–21:00')
    const me = render(proseOn(envelope('add_plan_item', planItemParams(), { preview: pv })))
    for (const s of ['Add to the plan', 'What', 'Dinner in Tokyo', 'When', 'Wed 2 Dec 19:00–21:00 · 3 days before the trip', 'For', 'Just you']) expect(me).toContain(s)
    expect(me).not.toContain('MODEL PROSE')
    const all = render(envelope('add_plan_item', planItemParams({ for: 'everyone', notes: 'Booked' }), { preview: { ...pv, for_label: 'Everyone' } }))
    expect(all).toContain('Everyone')
    expect(all).toContain('Booked')
    expect(all).toContain('Add to plan')
  })
  it('plan item warning only when the date is far off', () => {
    const pv = { when_label: 'Sat 2 Jan', date_note: 'Far off.', date_check: true }
    expect(render(envelope('add_plan_item', planItemParams(), { preview: pv }))).toContain('Far off.')
    expect(render(envelope('add_plan_item', planItemParams(), { preview: { ...pv, date_check: false } }))).not.toContain('Far off.')
  })
})

describe('kinds', () => {
  it('every stored kind has an executor; open_screen has none', () => {
    for (const k of ['add_todo', 'tick_todo', 'answer', 'add_expense', 'suggest_option', 'create_question', 'add_option', 'set_travel', 'add_plan_item'] as ActionKind[]) expect(moduleFor(k)).toBeTruthy()
    expect(moduleFor('open_screen')).toBeNull()
  })
  it('validate rejects malformed params', () => {
    expect(moduleFor('add_expense')!.validate(expenseParams({ amount_minor: 4001 }))).toBe(false) // shares do not add up
    expect(moduleFor('add_expense')!.validate(expenseParams({ amount_minor: 40.5 }))).toBe(false)
    expect(moduleFor('add_todo')!.validate(todoParams({ title: '  ' }))).toBe(false)
    expect(moduleFor('add_todo')!.validate(todoParams({ mode: 'person', person_id: null }))).toBe(false)
    expect(moduleFor('answer')!.validate(answerParams({ answer_actions: [] }))).toBe(false)
    expect(moduleFor('add_expense')!.validate(expenseParams())).toBe(true)
    void BEN
  })
})
