import type { ConfirmationStatus } from '../../../lib/queries/useConfirmations'

/**
 * Statuses a "Reset confirmations" wipes back to pending. Must mirror the
 * reset_trip_confirmations RPC (20261116090000_reset_trip_confirmations.sql):
 * 'cancelled' (they left) and 'pending' (nothing to wipe) are never touched,
 * 'declined' only when explicitly included.
 */
const ALWAYS_RESET: readonly ConfirmationStatus[] = ['confirmed', 'interested', 'conditional', 'waitlist']

interface ResettableParticipant {
  active: boolean
  confirmation_status: ConfirmationStatus | null
}

/** How many participants a reset would change (drives the confirm dialog copy). */
export function countResettableConfirmations(
  participants: readonly ResettableParticipant[],
  includeDeclined = false
): number {
  return participants.filter((p) => {
    if (!p.active || !p.confirmation_status) return false
    if (ALWAYS_RESET.includes(p.confirmation_status)) return true
    return includeDeclined && p.confirmation_status === 'declined'
  }).length
}

export function countDeclined(participants: readonly ResettableParticipant[]): number {
  return participants.filter((p) => p.active && p.confirmation_status === 'declined').length
}

export function describeResetCount(count: number): string {
  return `${count} ${count === 1 ? 'confirmation' : 'confirmations'}`
}
