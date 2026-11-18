import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '../../../lib/queries/queryKeys'
import {
  chatIsOn,
  fetchAdminChatSettings,
  fetchChatAvailability,
  setAdminChatSettings,
  setTripChatSettings,
  type ActionsScope,
  type SiteMode,
  type TripActionsSetting,
  type TripChatSetting,
} from './chatSettings'

/**
 * Is the assistant on for this trip? `chatOn` is true while loading and whenever the function is missing or fails
 * (fail open for visibility; the server still refuses when chat is off). One quiet call per trip, no retries.
 */
export function useChatAvailability(tripId: string | undefined) {
  const q = useQuery({
    queryKey: queryKeys.chatAvailability(tripId ?? ''),
    queryFn: () => fetchChatAvailability(tripId as string),
    enabled: !!tripId,
    staleTime: 60_000,
    retry: false,
  })
  const availability = q.data ?? null
  return { availability, chatOn: chatIsOn(availability), isLoading: q.isLoading }
}

/** Organisers (and site admins) change the switches for one trip. The button and the admin table update without a reload. */
export function useSetTripChatSettings(tripId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { chat?: TripChatSetting; actions?: TripActionsSetting }) => setTripChatSettings(tripId, v),
    onSuccess: (availability) => {
      qc.setQueryData(queryKeys.chatAvailability(tripId), availability)
      void qc.invalidateQueries({ queryKey: queryKeys.adminChatSettings() })
    },
  })
}

/** Site admins only: callers pass `enabled` from the same check the dashboard uses for its admin tabs. */
export function useAdminChatSettings(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.adminChatSettings(),
    queryFn: () => fetchAdminChatSettings(),
    enabled,
    staleTime: 30_000,
    retry: false,
  })
}

export function useSetAdminChatSettings() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { mode?: SiteMode; actionsScope?: ActionsScope }) => setAdminChatSettings(v),
    onSuccess: (settings) => {
      qc.setQueryData(queryKeys.adminChatSettings(), settings)
      void qc.invalidateQueries({ queryKey: ['chatAvailability'] })
    },
  })
}
