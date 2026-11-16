import { useAuth } from './useAuth'
import { useCurrentUserRow, useParticipants } from '../lib/queries/useTrip'

export interface TripPermissionInput {
  userId: string | undefined
  /** trips.created_by */
  tripCreatedBy: string | undefined | null
  /** The viewer's ACTIVE trip_participants role, if they are on the roster. */
  participantRole: 'organizer' | 'participant' | null | undefined
  /** users.role === 'admin' */
  isSiteAdmin: boolean
}

export interface TripPermissions {
  isSiteAdmin: boolean
  /** Active participant with role 'organizer'. */
  isTripOrganizer: boolean
  isTripCreator: boolean
  /**
   * THE definition of "can run this trip": active organiser, trip creator or
   * site admin. Use this for every organiser-gated control instead of
   * re-deriving it from participant.role (which excludes admins/creators).
   */
  canManageTrip: boolean
}

/** Pure rule behind useTripPermissions (kept separate so it is unit-tested). */
export function computeTripPermissions(input: TripPermissionInput): TripPermissions {
  const isSiteAdmin = input.isSiteAdmin
  const isTripOrganizer = input.participantRole === 'organizer'
  const isTripCreator = !!input.userId && !!input.tripCreatedBy && input.userId === input.tripCreatedBy
  return { isSiteAdmin, isTripOrganizer, isTripCreator, canManageTrip: isSiteAdmin || isTripOrganizer || isTripCreator }
}

/**
 * Permissions of the signed-in user on a trip. Reads the already-cached
 * participants and user row (react-query), so calling it from several
 * components costs nothing extra.
 *
 * Server note: this mirrors what the UI offers; individual writes are still
 * enforced by RLS/RPCs. reset_trip_confirmations and the settlements DELETE
 * policy accept all three roles; policies that call is_trip_organizer()
 * (settlements UPDATE, settlement_carryovers INSERT, participant role changes
 * unless also OR-ing is_admin) may reject a site admin who is not on the
 * roster -- the live function body is not in the repo.
 */
export function useTripPermissions(
  trip: { id: string; created_by?: string | null } | null | undefined
): TripPermissions & { isLoading: boolean } {
  const { user } = useAuth()
  const { data: participants, isLoading: participantsLoading } = useParticipants(trip?.id)
  const { data: currentUserRow, isLoading: userRowLoading } = useCurrentUserRow(user?.id)
  const mine = participants?.find((p) => p.user_id === user?.id)
  return {
    ...computeTripPermissions({
      userId: user?.id,
      tripCreatedBy: trip?.created_by,
      participantRole: mine?.role,
      isSiteAdmin: currentUserRow?.role === 'admin',
    }),
    /** True until the data an admin/organiser check depends on has loaded -- avoid flashing "not allowed". */
    isLoading: participantsLoading || userRowLoading,
  }
}
