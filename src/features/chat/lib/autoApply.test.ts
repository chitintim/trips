import { describe, it, expect } from 'vitest'
import { isEligibleForAutoApply, type AutoApplyContext } from './autoApply'
import type { Json } from '../../../types/database.types'

function eventAction(overrides: Record<string, unknown> = {}): Json {
  return {
    type: 'create_event',
    idempotency_key: 'k1',
    trip_id: '11111111-1111-4111-8111-111111111111',
    title: 'Dinner at Kumo',
    event_date: '2026-08-03',
    ...overrides,
  } as unknown as Json
}

function bookingAction(overrides: Record<string, unknown> = {}): Json {
  return {
    type: 'create_booking_draft',
    idempotency_key: 'k1',
    trip_id: '11111111-1111-4111-8111-111111111111',
    title: 'Chalet Rosalp',
    ...overrides,
  } as unknown as Json
}

function expenseAction(overrides: Record<string, unknown> = {}): Json {
  return {
    type: 'create_expense_draft',
    idempotency_key: 'k1',
    trip_id: '11111111-1111-4111-8111-111111111111',
    description: 'Receipt',
    amount: 42,
    currency: 'GBP',
    ...overrides,
  } as unknown as Json
}

function baseCtx(overrides: Partial<AutoApplyContext> = {}): AutoApplyContext {
  return {
    aiAutonomy: 'auto_own_uploads',
    isOwnUpload: true,
    classification: 'event',
    reconciliation: null,
    ...overrides,
  }
}

describe('isEligibleForAutoApply', () => {
  it('is never eligible under the default "suggest" autonomy setting', () => {
    expect(isEligibleForAutoApply(baseCtx({ aiAutonomy: 'suggest' }), [eventAction()])).toBe(false)
  })

  it('is never eligible for someone else\'s upload, even under auto_own_uploads', () => {
    expect(isEligibleForAutoApply(baseCtx({ isOwnUpload: false }), [eventAction()])).toBe(false)
  })

  it('is eligible for a clean event with title + date, own upload, auto_own_uploads', () => {
    expect(isEligibleForAutoApply(baseCtx(), [eventAction()])).toBe(true)
  })

  it('is not eligible when the event is missing a title', () => {
    expect(isEligibleForAutoApply(baseCtx(), [eventAction({ title: '' })])).toBe(false)
  })

  it('is eligible for a booking with a title', () => {
    expect(isEligibleForAutoApply(baseCtx({ classification: 'booking' }), [bookingAction()])).toBe(true)
  })

  it('is not eligible for a booking missing a title', () => {
    expect(isEligibleForAutoApply(baseCtx({ classification: 'booking' }), [bookingAction({ title: '' })])).toBe(false)
  })

  it('gates receipts on reconciliation.reconciled, not field presence', () => {
    const ctx = baseCtx({ classification: 'receipt', reconciliation: { reconciled: true } })
    expect(isEligibleForAutoApply(ctx, [expenseAction()])).toBe(true)

    const unreconciled = baseCtx({ classification: 'receipt', reconciliation: { reconciled: false } })
    expect(isEligibleForAutoApply(unreconciled, [expenseAction()])).toBe(false)

    const missing = baseCtx({ classification: 'receipt', reconciliation: null })
    expect(isEligibleForAutoApply(missing, [expenseAction()])).toBe(false)
  })

  it('is never eligible for option classification (no ai_proposals row is ever created for options)', () => {
    expect(isEligibleForAutoApply(baseCtx({ classification: 'option' }), [eventAction()])).toBe(false)
  })

  it('rejects a batch of more than one action (ingest always produces exactly one; multi-action batches are chat-originated and never auto-applied)', () => {
    expect(isEligibleForAutoApply(baseCtx(), [eventAction(), eventAction({ idempotency_key: 'k2' })])).toBe(false)
  })

  it('rejects malformed actions that fail schema validation', () => {
    expect(isEligibleForAutoApply(baseCtx(), [{ type: 'create_event' }] as unknown as Json)).toBe(false)
  })

  it('defensively rejects update_event/delete_request even if somehow present', () => {
    const updateAction = { type: 'update_event', idempotency_key: 'k1', event_id: '11111111-1111-4111-8111-111111111111' } as unknown as Json
    expect(isEligibleForAutoApply(baseCtx(), [updateAction])).toBe(false)

    const deleteAction = {
      type: 'delete_request',
      idempotency_key: 'k1',
      entity_type: 'event',
      entity_id: '11111111-1111-4111-8111-111111111111',
    } as unknown as Json
    expect(isEligibleForAutoApply(baseCtx(), [deleteAction])).toBe(false)
  })
})
