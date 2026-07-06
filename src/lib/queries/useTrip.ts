import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../supabase'
import { Trip, TripInsert, TripUpdate, TripParticipant, User } from '../../types'
import { queryKeys } from './queryKeys'

export interface ParticipantWithUser extends TripParticipant {
  user: User
}

export interface TripWithCount extends Trip {
  confirmed_count: number
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

      if (error) throw error
      if (!tripsData) return []

      const tripsWithCounts = await Promise.all(
        tripsData.map(async (trip) => {
          const { count } = await supabase
            .from('trip_participants')
            .select('*', { count: 'exact', head: true })
            .eq('trip_id', trip.id)
            .eq('confirmation_status', 'confirmed')

          return { ...trip, confirmed_count: count || 0 }
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

      if (error) throw error
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

      if (error) throw error
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

      if (error) throw error
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
      if (error) throw error
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
      const { error } = await supabase.from('trips').update(update).eq('id', tripId)
      if (error) throw error
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tripDetail(tripId) })
      queryClient.invalidateQueries({ queryKey: queryKeys.trips() })
    },
  })
}

export type { TripInsert }
