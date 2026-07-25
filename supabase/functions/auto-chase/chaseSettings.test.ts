/**
 * Unit tests for chase_settings parsing + the action-deadline reminder
 * gate. Headline case: the incident this module fixes -- a trip with
 * chase_settings NULL (or any settings blob that simply hasn't mentioned
 * action_reminders yet) must still get the staged action-deadline ladder,
 * because that ladder is opt-OUT, not opt-IN like the bundled chase kinds.
 *
 * Run with: deno test supabase/functions/auto-chase/chaseSettings.test.ts
 */
import { assert, assertEquals, assertFalse } from 'jsr:@std/assert@1'
import { actionRemindersGateOpen, DEFAULT_SETTINGS, parseChaseSettings } from './chaseSettings.ts'

Deno.test('parseChaseSettings: null settings (chase_settings column NULL) default action_reminders to true', () => {
  const settings = parseChaseSettings(null)
  assertEquals(settings.action_reminders, true)
  assertEquals(settings.enabled, false)
})

Deno.test('parseChaseSettings: settings blob with no action_reminders key defaults it to true, independent of enabled', () => {
  const settings = parseChaseSettings({ enabled: true, delay_hours: 24 })
  assertEquals(settings.action_reminders, true)
})

Deno.test('parseChaseSettings: action_reminders explicitly false is honored', () => {
  const settings = parseChaseSettings({ action_reminders: false })
  assertEquals(settings.action_reminders, false)
})

Deno.test('parseChaseSettings: action_reminders explicitly true is honored (and not disturbed by other keys)', () => {
  const settings = parseChaseSettings({ action_reminders: true, enabled: false })
  assertEquals(settings.action_reminders, true)
})

Deno.test('parseChaseSettings: non-boolean action_reminders value falls back to the true default', () => {
  const settings = parseChaseSettings({ action_reminders: 'nope' })
  assertEquals(settings.action_reminders, true)
})

Deno.test('DEFAULT_SETTINGS: action_reminders defaults to true (opt-out), enabled defaults to false (opt-in)', () => {
  assertEquals(DEFAULT_SETTINGS.action_reminders, true)
  assertEquals(DEFAULT_SETTINGS.enabled, false)
})

Deno.test('actionRemindersGateOpen: absent setting (default true), no quiet hours -> gate open, reminders still sent', () => {
  const settings = parseChaseSettings(null)
  const now = new Date('2026-07-25T12:00:00Z')
  assert(actionRemindersGateOpen(settings, now))
})

Deno.test('actionRemindersGateOpen: explicitly false -> gate closed regardless of quiet hours', () => {
  const settings = parseChaseSettings({ action_reminders: false })
  const now = new Date('2026-07-25T12:00:00Z')
  assertFalse(actionRemindersGateOpen(settings, now))
})

Deno.test('actionRemindersGateOpen: explicitly true, outside quiet hours -> gate open, reminders sent', () => {
  const settings = parseChaseSettings({ action_reminders: true, quiet_hours: { start: 22, end: 8 } })
  const now = new Date('2026-07-25T12:00:00Z') // 12:00 UTC, outside 22-8 window
  assert(actionRemindersGateOpen(settings, now))
})

Deno.test('actionRemindersGateOpen: explicitly true, but inside quiet hours -> gate closed (quiet hours still respected)', () => {
  const settings = parseChaseSettings({ action_reminders: true, quiet_hours: { start: 22, end: 8 } })
  const now = new Date('2026-07-25T23:00:00Z') // 23:00 UTC, inside 22-8 window
  assertFalse(actionRemindersGateOpen(settings, now))
})

Deno.test('actionRemindersGateOpen: default (absent) action_reminders, but inside quiet hours -> gate closed', () => {
  const settings = parseChaseSettings({ quiet_hours: { start: 22, end: 8 } })
  const now = new Date('2026-07-25T23:00:00Z')
  assertFalse(actionRemindersGateOpen(settings, now))
})

Deno.test('actionRemindersGateOpen: action_reminders false AND inside quiet hours -> still closed (not double-negated)', () => {
  const settings = parseChaseSettings({ action_reminders: false, quiet_hours: { start: 22, end: 8 } })
  const now = new Date('2026-07-25T23:00:00Z')
  assertFalse(actionRemindersGateOpen(settings, now))
})
