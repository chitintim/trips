import { describe, it, expect } from 'vitest'
import { ACTION_LABELS, DISPUTED_PAYMENT_PAUSE, disputedPayments, disputeSupported, disputeView, reAsksUsed, reAsksLeft, retractConfirmBody, MAX_RE_ASKS } from './paymentDispute'
import { computeTripPermissions } from '../../../hooks/useTripPermissions'
import { paymentNoticeLines } from './paymentNoticeStatus'
import type { ActivityFeedEntry } from '../../../lib/queries/useActivityFeed'

const base = { id: 's1', from_user_id: 'payer', to_user_id: 'rcv' }
const names = { payerName: 'Sam', receiverName: 'Tim' }
const row = (status: string, disputed: string | null | undefined) => ({ ...base, status, ...(disputed === undefined ? {} : { receipt_disputed_at: disputed }) })
const view = (r: ReturnType<typeof row>, viewerId: string, canManageTrip = false, used = 0, supported = true) =>
  disputeView(r, { viewerId, canManageTrip }, { supported, reAsksUsed: used, ...names })

describe('disputeSupported', () => {
  it('needs the key on some row', () => {
    expect(disputeSupported([])).toBe(false)
    expect(disputeSupported([row('marked_paid', undefined)])).toBe(false)
    expect(disputeSupported([row('marked_paid', null)])).toBe(true)
  })
})

describe('disputeView', () => {
  it('receiver gets a quiet "It hasn\'t arrived" on an undisputed marked-paid row', () => {
    expect(view(row('marked_paid', null), 'rcv')).toEqual({ statusLine: null, actions: ['not_arrived'], helpText: null })
  })
  it('organizer and bystander see nothing before a dispute', () => {
    for (const v of [view(row('marked_paid', null), 'org', true), view(row('marked_paid', null), 'x')]) {
      expect(v).toEqual({ statusLine: null, actions: [], helpText: null })
    }
  })
  it('U2: the payer can always quietly undo a marked-paid payment (flagged or not)', () => {
    expect(view(row('marked_paid', null), 'payer')).toEqual({ statusLine: null, actions: ['retract'], helpText: null })
    expect(view(row('marked_paid', null), 'payer', true)).toEqual({ statusLine: null, actions: ['retract'], helpText: null })
    expect(view(row('suggested', null), 'payer').actions).toEqual([])
    expect(view(row('confirmed', null), 'payer').actions).toEqual([])
    expect(ACTION_LABELS.retract).toBe("Undo — I haven't paid yet")
  })
  it('U2: the confirm text says so when an organizer recorded the payment', () => {
    expect(retractConfirmBody('Tim')).toBe('Tim will be told.')
    expect(retractConfirmBody('Tim', true)).toContain('An organizer recorded this payment as paid for you')
    expect(retractConfirmBody('Tim', true)).toContain('Tim will be told')
  })
  it('D7: trip creators and site admins who are not on the roster get the same actions as organizers', () => {
    const creator = computeTripPermissions({ userId: 'c', tripCreatedBy: 'c', participantRole: null, isSiteAdmin: false })
    const admin = computeTripPermissions({ userId: 'a', tripCreatedBy: 'c', participantRole: null, isSiteAdmin: true })
    const plain = computeTripPermissions({ userId: 'p', tripCreatedBy: 'c', participantRole: 'participant', isSiteAdmin: false })
    for (const [id, perms] of [['c', creator], ['a', admin]] as const) expect(view(row('marked_paid', 't'), id, perms.canManageTrip).actions).toEqual(['ask_again', 'retract'])
    expect(view(row('marked_paid', 't'), 'p', plain.canManageTrip).actions).toEqual([])
  })
  it('disputed: receiver waits but can still confirm (no extra actions)', () => {
    expect(view(row('marked_paid', 't'), 'rcv')).toEqual({ statusLine: "You said this hasn't arrived — waiting for Sam", actions: [], helpText: null })
  })
  it('disputed: payer can ask again or retract', () => {
    expect(view(row('marked_paid', 't'), 'payer')).toEqual({ statusLine: "Tim says this hasn't arrived", actions: ['ask_again', 'retract'], helpText: null })
  })
  it('disputed: re-asks used up -> payer is pointed to an organizer, can still retract', () => {
    expect(view(row('marked_paid', 't'), 'payer', false, MAX_RE_ASKS)).toEqual({ statusLine: "Tim says this hasn't arrived", actions: ['retract'], helpText: 'Ask an organizer to help' })
  })
  it('disputed: organizer with no re-asks left gets retract only, no help text', () => {
    expect(view(row('marked_paid', 't'), 'org', true, 2)).toEqual({ statusLine: "Tim says this hasn't arrived", actions: ['retract'], helpText: null })
    expect(view(row('marked_paid', 't'), 'org', true, 0).actions).toEqual(['ask_again', 'retract'])
  })
  it('disputed: a bystander only sees the line', () => {
    expect(view(row('marked_paid', 't'), 'x')).toEqual({ statusLine: "Tim says this hasn't arrived", actions: [], helpText: null })
  })
  it('nothing when unsupported, confirmed or suggested, or not signed in', () => {
    expect(view(row('marked_paid', 't'), 'payer', false, 0, false).actions).toEqual([])
    expect(view(row('confirmed', null), 'rcv').actions).toEqual([])
    expect(view(row('suggested', null), 'payer').actions).toEqual([])
    expect(disputeView(row('marked_paid', 't'), { viewerId: undefined, canManageTrip: false }, { supported: true, reAsksUsed: 0, ...names }).actions).toEqual([])
  })
})

describe('reAsksUsed', () => {
  const e = (actor: string | null, id = 's1', verb = 'settlement_re_asked') => ({ verb, actor, entity: { type: 'settlement', id } }) as unknown as ActivityFeedEntry
  it('counts payer and manager rows for this payment only', () => {
    const entries = [e('payer'), e('org'), e('stranger'), e(null), e('payer', 's2'), e('payer', 's1', 'other')]
    expect(reAsksUsed(entries, base, new Set(['org']))).toBe(2)
    expect(reAsksLeft(2)).toBe(0)
    expect(reAsksLeft(5)).toBe(0)
    expect(reAsksLeft(0)).toBe(2)
  })
})

describe('paymentNoticeLines with the dispute column', () => {
  const info = { requestedAt: '2026-11-01', disputedAt: '2026-11-02' }
  const viewer = { viewerId: 'payer', canManageTrip: false }
  it('falls back to the activity row without the column', () => {
    expect(paymentNoticeLines(row('marked_paid', undefined), info, viewer, 'Tim', (x) => x)).toContain("Tim says they haven't received this")
  })
  it('leaves the line to disputeView when the column exists', () => {
    const lines = paymentNoticeLines(row('marked_paid', null), info, viewer, 'Tim', (x) => x)
    expect(lines).toEqual(['Receipt request emailed to Tim on 2026-11-01'])
  })
})

describe('D6: disputed payments pause Freeze / Unfreeze', () => {
  it('lists only marked-paid rows with a flag', () => {
    const rows = [row('marked_paid', 't'), row('marked_paid', null), row('marked_paid', undefined), row('suggested', 't'), row('confirmed', 't')]
    expect(disputedPayments(rows)).toHaveLength(1)
    expect(disputedPayments([])).toEqual([])
  })
  it('has the agreed wording', () => expect(DISPUTED_PAYMENT_PAUSE).toBe('A payment is in question — sort that out first'))
})
