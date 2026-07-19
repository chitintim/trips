/**
 * Unit tests for the trip_actions due-date helpers (Task D + staged
 * deadline reminders). Run with:
 *   deno test supabase/functions/auto-chase/actionDueDate.test.ts
 */
import { assert, assertEquals } from 'jsr:@std/assert@1'
import { actionDueChipLabel, actionReminderStage, effectiveActionDueDate, isActionOverdue } from './actionDueDate.ts'

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

Deno.test('actionReminderStage: more than 7 days out is null (no reminder yet)', () => {
  const now = new Date('2026-07-19T09:00:00Z')
  assertEquals(actionReminderStage('2026-07-29', now), null)
})

Deno.test('actionReminderStage: within the 7-day window enters d7', () => {
  const now = new Date('2026-07-22T09:00:00Z')
  assertEquals(actionReminderStage('2026-07-29', now), 'd7')
})

Deno.test('actionReminderStage: two days out is still d7', () => {
  const now = new Date('2026-07-27T09:00:00Z')
  assertEquals(actionReminderStage('2026-07-29', now), 'd7')
})

Deno.test('actionReminderStage: day before due is d1', () => {
  const now = new Date('2026-07-28T09:00:00Z')
  assertEquals(actionReminderStage('2026-07-29', now), 'd1')
})

Deno.test('actionReminderStage: due today is d1 (not yet overdue)', () => {
  const now = new Date('2026-07-29T09:00:00Z')
  assertEquals(actionReminderStage('2026-07-29', now), 'd1')
})

Deno.test('actionReminderStage: day after due is overdue', () => {
  const now = new Date('2026-07-30T09:00:00Z')
  assertEquals(actionReminderStage('2026-07-29', now), 'overdue')
})

Deno.test('actionDueChipLabel: labels for each horizon', () => {
  const now = new Date('2026-07-22T09:00:00Z')
  assertEquals(actionDueChipLabel('2026-07-22', now), 'Due today')
  assertEquals(actionDueChipLabel('2026-07-23', now), 'Due tomorrow')
  assertEquals(actionDueChipLabel('2026-07-29', now), 'Due in 7 days')
  assertEquals(actionDueChipLabel('2026-07-21', now), 'Overdue')
})
