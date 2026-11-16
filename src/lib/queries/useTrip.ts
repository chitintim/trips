import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../supabase'
import { Trip, TripInsert, TripUpdate, TripParticipant, User } from '../../types'
import { queryKeys } from './queryKeys'
import { useOptimisticMutation } from './makeOptimisticMutation'
import { assertRowsAffected, throwIfError } from './assertRowsAffected'

export interface ParticipantWithUser extends TripParticipant {
  user: User
}

export interface TripWithCount extends Trip {
  confirmed_count: number
  /** Active roster size — what "confirmed" means when confirmation tracking is off. */
  participant_count: number
}

/**
 * Dashboard list: every trip visible to the current user (RLS handles
 * public/participant visibility) plus a confirmed-participant count per
 * trip. Mirrors Dashboard.tsx's fetchTrips shape so the page can be ported
 * with minimal changes.
 */
export function useTrips() {
  return useQuery({
    queryKey: queryKeys.trips(),
    queryFn: async (): Promise<TripWithCount[]> => {
      const { data: tripsData, error } = await supabase
        .from('trips')
        .select('*')
        .order('start_date', { ascending: false })

      throwIfError(error)
      if (!tripsData) return []

      const tripsWithCounts = await Promise.all(
        tripsData.map(async (trip) => {
          const [{ count: confirmedCount }, { count: participantCount }] = await Promise.all([
            supabase
              .from('trip_participants')
              .select('*', { count: 'exact', head: true })
              .eq('trip_id', trip.id)
              .eq('confirmation_status', 'confirmed'),
            supabase
              .from('trip_participants')
              .select('*', { count: 'exact', head: true })
              .eq('trip_id', trip.id)
              .eq('active', true),
          ])

          return { ...trip, confirmed_count: confirmedCount || 0, participant_count: participantCount || 0 }
        })
      )

      return tripsWithCounts
    },
  })
}

/** Single trip by id. */
export function useTrip(tripId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.tripDetail(tripId || ''),
    queryFn: async (): Promise<Trip | null> => {
      const { data, error } = await supabase
        .from('trips')
        .select('*')
        .eq('id', tripId as string)
        .single()

      throwIfError(error)
      return data
    },
    enabled: !!tripId,
  })
}

/** Active participants + joined user rows, as used across TripDetail and its tabs. */
export function useParticipants(tripId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.participants(tripId || ''),
    queryFn: async (): Promise<ParticipantWithUser[]> => {
      const { data, error } = await supabase
        .from('trip_participants')
        .select(`*, user:user_id (*)`)
        .eq('trip_id', tripId as string)
        .eq('active', true)

      throwIfError(error)
      return (data as unknown as ParticipantWithUser[]) || []
    },
    enabled: !!tripId,
  })
}

/**
 * Every participant row for the trip INCLUDING removed ones (active=false),
 * with the user joined. Needed by Settle Up so that someone who left with
 * expense history is still named and shown (marked "left the trip") rather
 * than vanishing from the ledger. Relies on the same read policy as
 * useParticipants; if RLS hides inactive rows the caller falls back to
 * "Former member" for unknown ids.
 */
export function useAllParticipants(tripId: string | undefined) {
  return useQuery({
    queryKey: [...queryKeys.participants(tripId || ''), 'all'],
    queryFn: async (): Promise<ParticipantWithUser[]> => {
      const { data, error } = await supabase
        .from('trip_participants')
        .select(`*, user:user_id (*)`)
        .eq('trip_id', tripId as string)

      throwIfError(error)
      return (data as unknown as ParticipantWithUser[]) || []
    },
    enabled: !!tripId,
  })
}

/** Current user's `public.users` row (role, avatar, payment details, etc). */
export function useCurrentUserRow(userId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.currentUser(userId),
    queryFn: async (): Promise<User | null> => {
      const { data, error } = await supabase
        .from('users')
        .select('*')
        .eq('id', userId as string)
        .single()

      throwIfError(error)
      return data
    },
    enabled: !!userId,
  })
}

/** Create a new trip (uses the RPC that also inserts the organizer participant row). */
export function useCreateTrip() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      name: string
      location: string
      start_date: string
      end_date: string
      status: Trip['status']
      is_public?: boolean
    }) => {
      const { data, error } = await supabase.rpc('create_trip_with_participant', {
        p_name: input.name,
        p_location: input.location,
        p_start_date: input.start_date,
        p_end_date: input.end_date,
        p_status: input.status,
        p_is_public: input.is_public,
      })
      throwIfError(error)
      return data as string // new trip id
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.trips() })
    },
  })
}

/** Update an existing trip (edit modal). */
export function useUpdateTrip(tripId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (update: TripUpdate) => {
      const { data, error } = await supabase.from('trips').update(update).eq('id', tripId).select('id')
      throwIfError(error)
      assertRowsAffected(data, 'Could not save: you may not have permission to edit this trip.')
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tripDetail(tripId) })
      queryClient.invalidateQueries({ queryKey: queryKeys.trips() })
    },
  })
}

/**
 * Optimistic variant of `useUpdateTrip`, for one-tap "accept" actions that
 * should feel instant (stage-advance suggestions, setting dates from a
 * closed date poll) — patches the single cached `tripDetail` object
 * immediately, rolls back on error. Deliberately does NOT patch the
 * `trips()` dashboard list optimistically (that cache holds an array of a
 * different shape); it's still invalidated on success so the dashboard
 * stays correct. Other `useUpdateTrip` consumers (edit forms, which already
 * have their own saving/pending UI) are unaffected — use this only where an
 * instant, low-risk optimistic patch is actually wanted.
 */
export function useOptimisticUpdateTrip(tripId: string) {
  const queryClient = useQueryClient()
  return useOptimisticMutation<void, TripUpdate, Trip | null>({
    mutationFn: async (update) => {
      const { data, error } = await supabase.from('trips').update(update).eq('id', tripId).select('id')
      throwIfError(error)
      assertRowsAffected(data, 'Could not save: you may not have permission to edit this trip.')
    },
    queryKey: () => queryKeys.tripDetail(tripId),
    updater: (trip, update) => (trip ? { ...trip, ...update } : null),
    options: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: queryKeys.trips() })
      },
    },
  })
}

export type { TripInsert }
