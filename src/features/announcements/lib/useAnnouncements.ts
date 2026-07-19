import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../../../lib/supabase'
import { SiteAnnouncement, SiteAnnouncementInsert } from '../../../types'
import { addSessionDismissedId, getSessionDismissedIds } from './sessionDismissals'

/**
 * Site announcements are cross-trip, so they get their own top-level query
 * key branch (kept local to the feature rather than in
 * lib/queries/queryKeys.ts — nothing trip-scoped ever needs to invalidate
 * them).
 */
export const announcementKeys = {
  all: ['siteAnnouncements'] as const,
  visible: (userId: string | undefined) => ['siteAnnouncements', 'visible', userId] as const,
  admin: () => ['siteAnnouncements', 'admin'] as const,
}

export interface VisibleAnnouncementsData {
  /** Announcements currently inside their [starts_at, ends_at] window (RLS + query filter). */
  announcements: SiteAnnouncement[]
  /** Announcement ids this user has dismissed (DB rows ∪ session-only fallbacks). */
  dismissedIds: string[]
}

/**
 * Active announcements + this user's dismissals, fetched once per app load
 * (staleTime) — the popup is a landing moment, not a live feed.
 */
export function useVisibleAnnouncements(userId: string | undefined) {
  return useQuery({
    queryKey: announcementKeys.visible(userId),
    queryFn: async (): Promise<VisibleAnnouncementsData> => {
      const nowIso = new Date().toISOString()
      const [announcementsRes, dismissalsRes] = await Promise.all([
        supabase
          .from('site_announcements')
          .select('*')
          .lte('starts_at', nowIso)
          .gte('ends_at', nowIso)
          .order('starts_at', { ascending: true }),
        supabase.from('announcement_dismissals').select('announcement_id').eq('user_id', userId as string),
      ])
      if (announcementsRes.error) throw announcementsRes.error
      if (dismissalsRes.error) throw dismissalsRes.error
      return {
        announcements: announcementsRes.data ?? [],
        dismissedIds: [
          ...new Set([...(dismissalsRes.data ?? []).map((d) => d.announcement_id), ...getSessionDismissedIds()]),
        ],
      }
    },
    enabled: !!userId,
    staleTime: 5 * 60 * 1000,
  })
}

/**
 * Record that this user has seen an announcement. Deliberately optimistic
 * with NO rollback: closing the popup must hide it for the session even if
 * the insert fails (sessionStorage keeps refetches honest); the DB row is
 * what makes the dismissal stick across devices. A duplicate-key error
 * (already dismissed on another device/tab) counts as success.
 */
export function useDismissAnnouncement(userId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (announcementId: string) => {
      const { error } = await supabase
        .from('announcement_dismissals')
        .insert({ announcement_id: announcementId, user_id: userId as string })
      if (error && error.code !== '23505') throw error
    },
    onMutate: async (announcementId: string) => {
      addSessionDismissedId(announcementId)
      await queryClient.cancelQueries({ queryKey: announcementKeys.visible(userId) })
      queryClient.setQueryData<VisibleAnnouncementsData>(announcementKeys.visible(userId), (prev) =>
        prev ? { ...prev, dismissedIds: [...new Set([...prev.dismissedIds, announcementId])] } : prev
      )
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: announcementKeys.admin() }),
  })
}

// ---------------------------------------------------------------------------
// Admin panel (Dashboard → Announcements tab)
// ---------------------------------------------------------------------------

export interface AdminAnnouncement extends SiteAnnouncement {
  dismissal_count: number
}

/** Every announcement (RLS lets admins read outside the active window) + per-announcement dismissal counts. */
export function useAdminAnnouncements(enabled: boolean) {
  return useQuery({
    queryKey: announcementKeys.admin(),
    queryFn: async (): Promise<AdminAnnouncement[]> => {
      const [announcementsRes, dismissalsRes] = await Promise.all([
        supabase.from('site_announcements').select('*').order('created_at', { ascending: false }),
        supabase.from('announcement_dismissals').select('announcement_id'),
      ])
      if (announcementsRes.error) throw announcementsRes.error
      if (dismissalsRes.error) throw dismissalsRes.error
      const counts = new Map<string, number>()
      for (const d of dismissalsRes.data ?? []) {
        counts.set(d.announcement_id, (counts.get(d.announcement_id) ?? 0) + 1)
      }
      return (announcementsRes.data ?? []).map((a) => ({ ...a, dismissal_count: counts.get(a.id) ?? 0 }))
    },
    enabled,
  })
}

export function useCreateAnnouncement() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: SiteAnnouncementInsert) => {
      const { error } = await supabase.from('site_announcements').insert(input)
      if (error) throw error
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: announcementKeys.all }),
  })
}

export function useUpdateAnnouncement() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: { id: string; patch: Partial<Pick<SiteAnnouncement, 'title' | 'body_md' | 'ends_at'>> }) => {
      const { error } = await supabase.from('site_announcements').update(input.patch).eq('id', input.id)
      if (error) throw error
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: announcementKeys.all }),
  })
}

export function useDeleteAnnouncement() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('site_announcements').delete().eq('id', id)
      if (error) throw error
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: announcementKeys.all }),
  })
}
