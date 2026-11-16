/**
 * Run with: deno test supabase/functions/auto-chase/chaseScope.test.ts
 */
import { assertEquals } from 'jsr:@std/assert@1'
import { chaseScopes, isChaseableParticipant, isSectionClosed, isTripOpenForReminders, joinedAfterDueDate } from './chaseScope.ts'

Deno.test('isChaseableParticipant: declined, cancelled and inactive are out; everyone else is in', () => {
  assertEquals(isChaseableParticipant({ active: true, confirmation_status: 'declined' }), false)
  assertEquals(isChaseableParticipant({ active: true, confirmation_status: 'cancelled' }), false)
  assertEquals(isChaseableParticipant({ active: false, confirmation_status: 'confirmed' }), false)
  for (const s of ['pending', 'confirmed', 'interested', 'conditional', 'waitlist', null]) {
    assertEquals(isChaseableParticipant({ active: true, confirmation_status: s }), true)
  }
})

Deno.test('isTripOpenForReminders: completed and past-end trips are skipped', () => {
  const now = new Date('2026-11-16T10:00:00Z')
  assertEquals(isTripOpenForReminders({ status: 'trip_completed', end_date: '2027-01-01' }, now), false)
  assertEquals(isTripOpenForReminders({ status: 'trip_ongoing', end_date: '2026-11-15' }, now), false)
  assertEquals(isTripOpenForReminders({ status: 'trip_ongoing', end_date: '2026-11-16' }, now), true)
  assertEquals(isTripOpenForReminders({ status: 'booking_details', end_date: '2027-03-01' }, now), true)
  assertEquals(isTripOpenForReminders({ status: 'booking_details', end_date: null }, now), true)
})

Deno.test('isSectionClosed', () => {
  assertEquals(isSectionClosed({ status: 'completed' }), true)
  assertEquals(isSectionClosed({ status: 'in_progress' }), false)
})

Deno.test('joinedAfterDueDate: only people who joined after the due day ended', () => {
  assertEquals(joinedAfterDueDate('2026-11-10T12:00:00Z', '2026-11-10'), false) // joined on the due day
  assertEquals(joinedAfterDueDate('2026-11-11T00:00:00Z', '2026-11-10'), true)
  assertEquals(joinedAfterDueDate('2026-10-01T00:00:00Z', '2026-11-10'), false)
  assertEquals(joinedAfterDueDate(null, '2026-11-10'), false)
})

Deno.test('chaseScopes: money reminders stay on for finished trips; planning chases stop', () => {
  const now = new Date('2026-11-16T10:00:00Z')
  assertEquals(chaseScopes({ status: 'trip_completed', end_date: '2026-11-01' }, now), { planning: false, money: true })
  assertEquals(chaseScopes({ status: 'trip_ongoing', end_date: '2026-11-15' }, now), { planning: false, money: true })
  assertEquals(chaseScopes({ status: 'booking_details', end_date: '2027-03-01' }, now), { planning: true, money: true })
})
