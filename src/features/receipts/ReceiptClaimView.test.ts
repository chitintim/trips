import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { ReceiptClaimView, type ReceiptActions } from './ReceiptClaimPage'
import { parseReceipt, type PageState, type ReceiptView } from './receiptClaimState'
import { payload } from './receiptFixtures'

const api = (): ReceiptActions => ({ reload: vi.fn(), changeHint: vi.fn(), done: vi.fn(), notThere: vi.fn(), undo: vi.fn(), toggle: vi.fn() })
const ready = (over: Record<string, unknown> = {}, hint: 'done' | 'not_there' | null = null): PageState => ({
  kind: 'ready',
  receipt: parseReceipt(payload(over)) as ReceiptView,
  hint,
  posting: null,
  notice: null,
})
const html = (state: PageState, a = api()) => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ReceiptClaimView, { state, api: a })))
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ')

describe('public receipt page', () => {
  it('shows the trip, receipt, payer, the items with ÷3, amounts, total and the deadline', () => {
    const t = text(html(ready()))
    expect(t).toContain('For Marj')
    expect(t).toContain('Alps')
    expect(t).toContain('Tim paid for Le Bistrot')
    expect(t).toContain('Tim put you down for:')
    expect(t).toContain('Pizza')
    expect(t).toContain('÷3')
    expect(t).toContain('£10.00')
    expect(t).toContain('Red wine')
    expect(t).toContain('£42.00')
    expect(t).toMatch(/Reply by .*18:00 UTC/) // the reader's clock first, UTC in brackets (or plain UTC on a UTC device)
    expect(t).toContain('Bread') // an unassigned item they may tick
    expect(t).toContain("That's everything")
    expect(t).toContain("I wasn't there")
    expect(t).toContain('Open in the app')
  })
  it('opening the page (even with a hint) sends nothing: no callback runs while rendering', () => {
    const a = api()
    html(ready({}, 'done'), a)
    html(ready({}, 'not_there'), a)
    for (const fn of Object.values(a)) expect(fn).not.toHaveBeenCalled()
  })
  it('a hint pre-selects one big button and offers to change the answer', () => {
    const t = text(html(ready({}, 'not_there')))
    expect(t).toContain("I wasn't there")
    const count = (h: string) => h.split("That's everything").length - 1
    expect(count(t)).toBe(1) // only the rule sentence, no button
    expect(t).toContain('Change my answer')
    const both = text(html(ready({}, 'done')))
    expect(count(both)).toBe(2)
    expect(both).toContain("I wasn't there")
  })
  it('the payer is not offered "I wasn\'t there"', () => {
    const t = text(html(ready({ me: { user_id: 'p', first_name: 'Tim', is_payer: true } })))
    expect(t).toContain("That's everything")
    expect(t).not.toContain("I wasn't there")
  })
  it('after done: thanks with the share and Undo', () => {
    const t = text(html(ready({ response: 'done' })))
    expect(t).toContain("Thanks — you're done. Your share: £42.00")
    expect(t).toContain('Undo')
    expect(t).not.toContain('Not this?')
  })
  it('after "I wasn\'t there": says so with Undo', () => {
    const t = text(html(ready({ response: 'not_there', on_receipt: false })))
    expect(t).toContain("You told Tim you weren't there.")
    expect(t).toContain('Undo')
  })
  it('closed: final share incl. the leftover share, and the date; no buttons', () => {
    const t = text(html(ready({ closed_at: '2026-11-21T00:00:00Z', editable: false, closed_reason: 'closed', my_total: 46.5, my_leftover_total: 4.5 })))
    expect(t).toContain('This receipt is closed. Your final share: £46.50')
    expect(t).toContain('Closed on Sat 21 Nov')
    expect(t).toContain('That includes £4.50 from the leftovers')
    expect(t).not.toContain("That's everything")
    expect(t).not.toContain('Undo')
  })
  it('frozen: read-only with the share', () => {
    const t = text(html(ready({ frozen: true, editable: false, closed_reason: 'frozen' })))
    expect(t).toContain("balances are frozen")
    expect(t).toContain('£42.00')
    expect(t).not.toContain("That's everything")
  })
  it('dead, feature-off, rate-limited and error states are friendly and link to the app', () => {
    expect(text(html({ kind: 'dead', reason: 'expired' }))).toContain('This link has expired')
    expect(text(html({ kind: 'dead', reason: 'revoked' }))).toContain('This link no longer works')
    expect(text(html({ kind: 'dead', reason: 'invalid' }))).toContain("isn't valid")
    expect(text(html({ kind: 'dead', reason: 'no_token' }))).toContain('missing its code')
    expect(text(html({ kind: 'unavailable' }))).toContain("isn't available yet")
    expect(html({ kind: 'unavailable' })).toContain('href="/"')
    expect(text(html({ kind: 'rate_limited' }))).toContain('Too many attempts')
    expect(text(html({ kind: 'error', retry: 'load' }))).toContain('Try again')
  })
  it('the app link uses the existing claim deep link', () => {
    expect(html(ready())).toContain('href="/t1?open=claim:e1"')
  })
})
