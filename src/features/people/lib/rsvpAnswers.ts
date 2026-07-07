/**
 * RSVP: three human answers over seven statuses (UX_REDESIGN.md Part 4
 * "RSVP: three human answers over seven statuses"). Pure presentation-layer
 * mapping — same `confirmation_status` enum, same `trip_participants` table,
 * nothing added/removed server-side. This module is the single source of
 * truth for how the three participant-facing answers translate to the
 * underlying 7-status write, so StatusModal (and any future entry point)
 * stays in sync and the logic is unit-testable without mounting React.
 *
 * The three answers:
 *  - "I'm in"          -> confirmed (terms/capacity handling unchanged)
 *  - "Can't say yet"   -> a follow-up ("What are you waiting on?"):
 *       a date            -> conditional, conditional_type='date'
 *       someone else      -> conditional, conditional_type='users'
 *       both              -> conditional, conditional_type='both'
 *       just thinking     -> interested
 *  - "I'm out"         -> declined, UNLESS the participant was previously
 *                         confirmed, in which case it's cancelled (with the
 *                         existing cancellation warning) — self-service
 *                         replaces the old "contact the organizer" dead-end.
 *
 * Waitlist and pending are system states, never offered as choices here —
 * waitlist is server-assigned (capacity trigger) and pending is simply "no
 * answer given yet" (the modal's own empty/first-open state).
 */
import type { ConfirmationStatus, ConditionalType } from '../../../lib/queries/useConfirmations'

export type RsvpAnswer = 'in' | 'cant-say-yet' | 'out'

export type WaitingOnAnswer = 'date' | 'someone' | 'both' | 'just-thinking'

export interface RsvpResolution {
  status: ConfirmationStatus
  conditionalType: ConditionalType
}

/**
 * Resolves the final status to write for "Can't say yet" given which
 * follow-up option the user picked.
 */
export function resolveCantSayYet(waitingOn: WaitingOnAnswer): RsvpResolution {
  if (waitingOn === 'just-thinking') return { status: 'interested', conditionalType: 'none' }
  return { status: 'conditional', conditionalType: waitingOn === 'someone' ? 'users' : waitingOn }
}

/**
 * Resolves the final status to write for "I'm out", given whether the
 * participant was previously confirmed (self-service cancellation) or not
 * (a plain decline, the common pre-commit case).
 */
export function resolveImOut(wasConfirmed: boolean): RsvpResolution {
  return { status: wasConfirmed ? 'cancelled' : 'declined', conditionalType: 'none' }
}

/** "I'm in" always resolves to the same thing — kept for symmetry/discoverability alongside the other two resolvers. */
export function resolveImIn(): RsvpResolution {
  return { status: 'confirmed', conditionalType: 'none' }
}

/**
 * Reverse mapping, for re-opening the modal against an existing record: which
 * of the three big answers does a stored 7-status value correspond to? Used
 * to pre-select the right top-level choice when a participant with an
 * existing conditional/interested/declined status reopens the sheet.
 * Waitlist and pending have no natural "answer" (they're system states) —
 * both fall through to `null`, meaning "no answer selected yet", matching
 * this module's contract that only in/cant-say-yet/out are real choices.
 */
export function answerFromStatus(status: ConfirmationStatus): RsvpAnswer | null {
  switch (status) {
    case 'confirmed':
      return 'in'
    case 'interested':
    case 'conditional':
      return 'cant-say-yet'
    case 'declined':
    case 'cancelled':
      return 'out'
    case 'waitlist':
    case 'pending':
    default:
      return null
  }
}

/** Reverse mapping for the "Can't say yet" follow-up, so reopening the sheet pre-selects the right waiting-on option. */
export function waitingOnFromStatus(status: ConfirmationStatus, conditionalType: ConditionalType): WaitingOnAnswer | null {
  if (status === 'interested') return 'just-thinking'
  if (status !== 'conditional') return null
  if (conditionalType === 'date') return 'date'
  if (conditionalType === 'users') return 'someone'
  if (conditionalType === 'both') return 'both'
  return null
}
