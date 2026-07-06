/**
 * Waitlist lifecycle helpers (plan §14). The actual email send for a
 * freed-spot offer is the `auto-chase` edge function's job; this module is
 * the client-side surface: queue position, who should be offered next when
 * a spot frees, and offer-expiry state — all pure functions over already
 * -fetched participant data so the UI can render live without extra
 * queries.
 */
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'

export interface WaitlistEntry {
  participant: ParticipantWithUser
  /** 1-based position in the waitlist queue (ordered by when they joined the waitlist). */
  position: number
  /** True if this person currently has a live (unexpired) freed-spot offer. */
  hasActiveOffer: boolean
  /** True if they had an offer that has since expired without being claimed. */
  offerExpired: boolean
}

/**
 * Order the waitlist by `updated_at` ascending (earliest to join the
 * waitlist goes first) — `updated_at` is bumped by the
 * enforce_capacity_limit trigger / any status change, which is the closest
 * proxy we have to "waitlisted since" without a dedicated column.
 */
export function getWaitlistQueue(participants: ParticipantWithUser[], now: number = Date.now()): WaitlistEntry[] {
  const waitlisted = participants
    .filter((p) => p.confirmation_status === 'waitlist')
    .slice()
    .sort((a, b) => new Date(a.updated_at || a.created_at).getTime() - new Date(b.updated_at || b.created_at).getTime())

  return waitlisted.map((participant, i) => {
    const expiresAt = participant.waitlist_offer_expires_at
    const hasActiveOffer = !!expiresAt && new Date(expiresAt).getTime() > now
    const offerExpired = !!expiresAt && new Date(expiresAt).getTime() <= now
    return { participant, position: i + 1, hasActiveOffer, offerExpired }
  })
}

/**
 * Given the current waitlist queue, who should receive the next
 * freed-spot offer? The first person without an active offer and without
 * an already-expired-and-not-yet-cascaded offer (i.e. position 1 unless
 * they already have a live offer pending, in which case nobody new is
 * offered yet — one live offer at a time).
 */
export function getNextWaitlistOffer(queue: WaitlistEntry[]): WaitlistEntry | null {
  const alreadyOffered = queue.find((e) => e.hasActiveOffer)
  if (alreadyOffered) return null // someone already has a live offer outstanding
  return queue.find((e) => !e.offerExpired) ?? queue[0] ?? null
}

/** Default offer window used when the organizer/auto-chase creates a new offer. */
export const DEFAULT_WAITLIST_OFFER_HOURS = 48

export function computeOfferExpiry(now: number = Date.now(), hours: number = DEFAULT_WAITLIST_OFFER_HOURS): string {
  return new Date(now + hours * 60 * 60 * 1000).toISOString()
}
