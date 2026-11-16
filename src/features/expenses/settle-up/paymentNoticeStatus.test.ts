import { describe, it, expect } from 'vitest'
import type { ActivityFeedEntry } from '../../../lib/queries/useActivityFeed'
import { paymentNoticeBySettlement, paymentNoticeLines } from './paymentNoticeStatus'

const entry = (verb: string, id: string, at: string, actor: string | null = verb.endsWith('disputed') ? 'recv' : 'payer'): ActivityFeedEntry =>
  ({ id: verb + at, trip_id: 't', actor, verb, entity: { type: 'settlement', id }, metadata: null, created_at: at }) as ActivityFeedEntry
const row = { status: 'marked_paid', from_user_id: 'payer', to_user_id: 'recv' }
const rows = [{ id: 's1', from_user_id: 'payer', to_user_id: 'recv' }]
const orgs = new Set(['org'])
const fmt = (iso: string) => iso.slice(0, 10)

describe('paymentNoticeBySettlement', () => {
  it('keeps the latest of each verb per settlement and ignores other verbs', () => {
    const m = paymentNoticeBySettlement([
      entry('settlement_receipt_requested', 's1', '2026-11-01T10:00:00Z'),
      entry('settlement_receipt_requested', 's1', '2026-11-02T10:00:00Z'),
      entry('settlement_receipt_disputed', 's1', '2026-11-03T10:00:00Z'),
      entry('expense_added', 's1', '2026-11-04T10:00:00Z'),
    ], rows, orgs)
    expect(m.get('s1')).toEqual({ requestedAt: '2026-11-02T10:00:00Z', disputedAt: '2026-11-03T10:00:00Z' })
  })
})

describe('paymentNoticeBySettlement: only rows whose actor fits (M1)', () => {
  const at = '2026-11-02T10:00:00Z'
  const by = (verb: string, actor: string | null) => paymentNoticeBySettlement([entry(verb, 's1', at, actor)], rows, orgs).get('s1')
  it('a dispute counts only from the receiver', () => {
    expect(by('settlement_receipt_disputed', 'recv')?.disputedAt).toBe(at)
    for (const a of ['payer', 'org', 'other', null]) expect(by('settlement_receipt_disputed', a)).toBeUndefined()
  })
  it('a receipt request counts from the payer or a manager, never a null or other actor', () => {
    expect(by('settlement_receipt_requested', 'payer')?.requestedAt).toBe(at)
    expect(by('settlement_receipt_requested', 'org')?.requestedAt).toBe(at)
    for (const a of ['recv', 'other', null]) expect(by('settlement_receipt_requested', a)).toBeUndefined()
  })
  it('a row for an unknown payment is ignored', () => {
    expect(paymentNoticeBySettlement([entry('settlement_receipt_disputed', 'zzz', at)], rows, orgs).size).toBe(0)
  })
})

describe('paymentNoticeLines', () => {
  const info = { requestedAt: '2026-11-02T10:00:00Z', disputedAt: null }
  it('shows the request line to the payer and organizers, not the receiver or others', () => {
    expect(paymentNoticeLines(row, info, { viewerId: 'payer', canManageTrip: false }, 'Sam', fmt)).toEqual(['Receipt request emailed to Sam on 2026-11-02'])
    expect(paymentNoticeLines(row, info, { viewerId: 'org', canManageTrip: true }, 'Sam', fmt)).toHaveLength(1)
    expect(paymentNoticeLines(row, info, { viewerId: 'recv', canManageTrip: false }, 'Sam', fmt)).toEqual([])
    expect(paymentNoticeLines(row, info, { viewerId: 'other', canManageTrip: false }, 'Sam', fmt)).toEqual([])
  })
  it('shows the dispute to payer, receiver and organizers', () => {
    const d = { requestedAt: null, disputedAt: '2026-11-03T10:00:00Z' }
    for (const v of [{ viewerId: 'payer', canManageTrip: false }, { viewerId: 'recv', canManageTrip: false }, { viewerId: 'o', canManageTrip: true }]) {
      expect(paymentNoticeLines(row, d, v, 'Sam', fmt)).toEqual(["Sam says they haven't received this"])
    }
    expect(paymentNoticeLines(row, d, { viewerId: 'other', canManageTrip: false }, 'Sam', fmt)).toEqual([])
  })
  it('shows nothing once the row is no longer marked paid', () => {
    expect(paymentNoticeLines({ ...row, status: 'confirmed' }, info, { viewerId: 'payer', canManageTrip: true }, 'Sam', fmt)).toEqual([])
  })
})
