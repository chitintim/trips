/**
 * Unit tests for the trip_actions due-date helpers (Task D). Run with:
 *   deno test supabase/functions/auto-chase/actionDueDate.test.ts
 */
import { assert, assertEquals } from 'jsr:@std/assert@1'
import { effectiveActionDueDate, isActionDueOrOverdue, isActionOverdue } from './actionDueDate.ts'

Deno.test('effectiveActionDueDate: fixed deadline uses due_date', () => {
  const result = effectiveActionDueDate({ deadline_kind: 'fixed', due_date: '2026-08-01', tripStartDate: '2026-09-01' })
  assertEquals(result, '2026-08-01')
})

Deno.test('effectiveActionDueDate: before_trip uses trip start_date', () => {
  const result = effectiveActionDueDate({ deadline_kind: 'before_trip', due_date: null, tripStartDate: '2026-09-01' })
  assertEquals(result, '2026-09-01')
})

Deno.test('effectiveActionDueDate: before_trip with no start_date is null (skip)', () => {
  const result = effectiveActionDueDate({ deadline_kind: 'before_trip', due_date: null, tripStartDate: null })
  assertEquals(result, null)
})

Deno.test('isActionDueOrOverdue: overdue date is due', () => {
  const now = new Date('2026-07-19T12:00:00Z')
  assert(isActionDueOrOverdue('2026-07-10', now))
})

Deno.test('isActionDueOrOverdue: within 48h lookahead is due', () => {
  const now = new Date('2026-07-19T12:00:00Z')
  assert(isActionDueOrOverdue('2026-07-21', now))
})

Deno.test('isActionDueOrOverdue: beyond 48h lookahead is not due', () => {
  const now = new Date('2026-07-19T12:00:00Z')
  assert(!isActionDueOrOverdue('2026-07-25', now))
})

Deno.test('isActionOverdue: past date is overdue', () => {
  const now = new Date('2026-07-19T12:00:00Z')
  assert(isActionOverdue('2026-07-10', now))
})

Deno.test('isActionOverdue: future date is not overdue', () => {
  const now = new Date('2026-07-19T12:00:00Z')
  assert(!isActionOverdue('2026-07-21', now))
})

Deno.test('isActionOverdue: due today is not overdue', () => {
  const now = new Date('2026-07-19T12:00:00Z')
  assert(!isActionOverdue('2026-07-19', now))
})

Deno.test('isActionOverdue: due today becomes overdue once the day fully elapses', () => {
  const now = new Date('2026-07-20T00:00:00Z')
  assert(isActionOverdue('2026-07-19', now))
})

Deno.test('isActionOverdue: due today just before day end is not yet overdue', () => {
  const now = new Date('2026-07-19T23:59:59Z')
  assert(!isActionOverdue('2026-07-19', now))
})
