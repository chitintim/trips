import { describe, it, expect } from 'vitest'
import type { Settlement } from '../../../lib/queries/useSettlements'
import type { ActivityFeedEntry } from '../../../lib/queries/useActivityFeed'
import {
  onBehalfActions,
  buildSettleAllList,
  canOfferSettleAll,
  settleAllConfirmLabel,
  isEverythingSettled,
  onBehalfRecordsBySettlement,
  onBehalfLabel,
  summariseBatch,
} from './settleOnBehalf'

const row = (o: Partial<Settlement>): Settlement => ({
  id: 's1',
  trip_id: 't',
  from_user_id: 'a',
  to_user_id: 'b',
  amount: 10,
  currency: 'GBP',
  status: 'suggested',
  created_at: '2026-11-01T10:00:00Z',
  created_by: 'o',
  settled_at: '2026-11-01T10:00:00Z',
  payment_method: null,
  notes: null,
  ...o,
})
const ctx = (o: Partial<{ canManageTrip: boolean; viewerId: string }> = {}) => ({ canManageTrip: true, viewerId: 'o', receiverName: 'Sam', ...o })

describe('onBehalfActions', () => {
  it('offers nothing to people who cannot manage the trip', () => {
    expect(onBehalfActions(row({}), ctx({ canManageTrip: false }))).toEqual([])
  })
  it('suggested row: record as paid, and as paid and received', () => {
    expect(onBehalfActions(row({}), ctx()).map((a) => [a.label, a.to])).toEqual([
      ['Record as paid', 'marked_paid'],
      ['Record as paid and received', 'confirmed'],
    ])
  })
  it('skips "Record as paid" when the viewer is the payer (they have Mark paid)', () => {
    expect(onBehalfActions(row({}), ctx({ viewerId: 'a' })).map((a) => a.kind)).toEqual(['record_paid_and_received'])
  })
  it('marked_paid row: confirm on the receiver\'s behalf', () => {
    const a = onBehalfActions(row({ status: 'marked_paid' }), ctx())
    expect(a).toHaveLength(1)
    expect(a[0]).toMatchObject({ label: "Confirm received on Sam's behalf", to: 'confirmed' })
  })
  it('no on-behalf confirm for the receiver (own button) and none on confirmed rows', () => {
    expect(onBehalfActions(row({ status: 'marked_paid' }), ctx({ viewerId: 'b' }))).toEqual([])
    expect(onBehalfActions(row({ status: 'confirmed' }), ctx())).toEqual([])
  })
})

describe('buildSettleAllList', () => {
  const name = (id: string) => id.toUpperCase()
  it('lists unfinished rows only, oldest first, with count and total', () => {
    const list = buildSettleAllList(
      [
        row({ id: 'x', status: 'confirmed' }),
        row({ id: 'm', status: 'marked_paid', amount: 5.5, created_at: '2026-11-02T00:00:00Z' }),
        row({ id: 's', amount: 4.5 }),
      ],
      name,
      'GBP'
    )
    expect(list.rows.map((r) => r.id)).toEqual(['s', 'm'])
    expect(list.count).toBe(2)
    expect(list.totals).toEqual([{ currency: 'GBP', amount: 10 }])
    expect(list.rows[0]).toMatchObject({ fromName: 'A', toName: 'B', status: 'suggested' })
  })
  it('uses the base currency for rows without one and totals per currency', () => {
    const list = buildSettleAllList([row({ id: '1', currency: null }), row({ id: '2', currency: 'EUR', amount: 3 })], name, 'GBP')
    expect(list.totals).toEqual([
      { currency: 'GBP', amount: 10 },
      { currency: 'EUR', amount: 3 },
    ])
  })
  it('sums without float drift', () => {
    const list = buildSettleAllList([row({ id: '1', amount: 0.1 }), row({ id: '2', amount: 0.2 })], name, 'GBP')
    expect(list.totals[0].amount).toBe(0.3)
  })
})

describe('batch gating and labels', () => {
  it('offers the batch only to managers on a frozen trip with something left', () => {
    expect(canOfferSettleAll({ canManageTrip: true, isFrozen: true, unfinishedCount: 2 })).toBe(true)
    expect(canOfferSettleAll({ canManageTrip: false, isFrozen: true, unfinishedCount: 2 })).toBe(false)
    expect(canOfferSettleAll({ canManageTrip: true, isFrozen: false, unfinishedCount: 2 })).toBe(false)
    expect(canOfferSettleAll({ canManageTrip: true, isFrozen: true, unfinishedCount: 0 })).toBe(false)
  })
  it('confirm button label counts', () => {
    expect(settleAllConfirmLabel(9)).toBe('Mark 9 payments as settled')
    expect(settleAllConfirmLabel(1)).toBe('Mark 1 payment as settled')
  })
  it('everything settled needs payments and all confirmed', () => {
    expect(isEverythingSettled([])).toBe(false)
    expect(isEverythingSettled([{ status: 'confirmed' }, { status: 'marked_paid' }])).toBe(false)
    expect(isEverythingSettled([{ status: 'confirmed' }, { status: 'confirmed' }])).toBe(true)
  })
  it('summarises a batch', () => {
    expect(summariseBatch({ done: ['a', 'b'], failed: [] })).toEqual({ tone: 'success', message: '2 payments marked as settled' })
    expect(summariseBatch({ done: ['a'], failed: [{ id: 'b', message: 'x' }] })).toEqual({ tone: 'warning', message: '1 settled, 1 failed' })
    expect(summariseBatch({ done: [], failed: [{ id: 'b', message: 'x' }] }).tone).toBe('error')
  })
})

describe('on-behalf records and label', () => {
  const entry = (o: Partial<ActivityFeedEntry>): ActivityFeedEntry =>
    ({
      id: 'e',
      trip_id: 't',
      actor: 'o',
      verb: 'settlement_recorded_on_behalf',
      entity: { type: 'settlement', id: 's1' },
      metadata: { from_status: 'suggested', to_status: 'confirmed' },
      created_at: '2026-11-16T09:00:00Z',
      ...o,
    }) as ActivityFeedEntry
  const fmt = () => '16 Nov 2026'

  it('keeps the latest entry per settlement and ignores other verbs', () => {
    const m = onBehalfRecordsBySettlement([
      entry({ id: '1', created_at: '2026-11-15T09:00:00Z', metadata: { from_status: 'suggested', to_status: 'marked_paid' } }),
      entry({ id: '2' }),
      entry({ id: '3', verb: 'settlement_confirmed' }),
      entry({ id: '4', entity: null }),
    ])
    expect(m.size).toBe(1)
    expect(m.get('s1')).toMatchObject({ toStatus: 'confirmed', actorId: 'o' })
  })
  it('labels each kind and hides once the row moved past it', () => {
    const rec = onBehalfRecordsBySettlement([entry({})]).get('s1')
    expect(onBehalfLabel({ status: 'confirmed', to_user_id: 'b' }, rec, 'Tim', 'Sam', fmt)).toBe('Recorded as paid and received by Tim on 16 Nov 2026, not by the people involved.')
    const paid = onBehalfRecordsBySettlement([entry({ metadata: { from_status: 'suggested', to_status: 'marked_paid' } })]).get('s1')
    expect(onBehalfLabel({ status: 'marked_paid', to_user_id: 'b' }, paid, 'Tim', 'Sam', fmt)).toBe('Recorded as paid by Tim on 16 Nov 2026, not by the payer.')
    expect(onBehalfLabel({ status: 'confirmed', to_user_id: 'b' }, paid, 'Tim', 'Sam', fmt)).toBeNull()
    const conf = onBehalfRecordsBySettlement([entry({ metadata: { from_status: 'marked_paid', to_status: 'confirmed' } })]).get('s1')
    expect(onBehalfLabel({ status: 'confirmed', to_user_id: 'b' }, conf, 'Tim', 'Sam', fmt)).toBe("Receipt confirmed on Sam's behalf by Tim on 16 Nov 2026.")
    expect(onBehalfLabel({ status: 'suggested', to_user_id: 'b' }, undefined, 'Tim', 'Sam', fmt)).toBeNull()
  })
})
