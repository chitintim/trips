/**
 * Avatar system v2 (UX_REDESIGN.md "Avatar system v2"): single resolver used
 * by both `Avatar` and `UserAvatar` so there is exactly one place that
 * decides what to render for a given user. Resolution order:
 *
 *   1. `avatarUrl` (users.avatar_url)              -> photo
 *   2. `avatarData` shaped {type:'icon', icon, ...} -> curated SVG icon
 *   3. `avatarData` shaped {emoji, ...} (legacy)     -> emoji + accessory
 *   4. neither present                               -> initials fallback
 *
 * Backward compatible by construction: old rows only ever have the legacy
 * emoji shape (or nothing), so they fall through to case 3/4 exactly as
 * they did pre-v2. Nothing here mutates or migrates existing data.
 */
import { isAvatarIconData, type AnyAvatarData } from '../../../types'
import { isAvatarIconName, type AvatarIconName } from './icons/travelIcons'

export type ResolvedAvatar =
  | { kind: 'photo'; url: string }
  | { kind: 'icon'; icon: AvatarIconName; bgColor: string }
  | { kind: 'emoji'; emoji: string; accessory?: string | null; bgColor: string }
  | { kind: 'initials' }

/**
 * Loosely-typed input mirroring what callers actually have on hand: either
 * the raw Supabase row shape (`avatar_url` + `avatar_data` straight off
 * `users`/a joined `user:users(*)` select) or just a bare `avatar_data`
 * blob (the pre-v2 calling convention many components still use).
 */
export interface ResolvableAvatarSource {
  avatar_url?: string | null
  avatar_data?: unknown
}

function isRawUserShape(value: unknown): value is ResolvableAvatarSource {
  return !!value && typeof value === 'object' && ('avatar_url' in value || 'avatar_data' in value)
}

/**
 * Resolves an avatar from either:
 *  - an explicit `{ avatarUrl, avatarData }` pair (new call sites), or
 *  - a single loosely-typed value that is either the raw user row shape
 *    (`{avatar_url, avatar_data}`) or a bare legacy `avatar_data` blob
 *    (`{emoji, accessory, bgColor}` / `{type:'icon', icon, bgColor}`) --
 *    the shape every existing `<UserAvatar avatarData={...}>` call site
 *    already passes.
 */
export function resolveAvatar(input: {
  avatarUrl?: string | null
  avatarData?: unknown
}): ResolvedAvatar {
  let avatarUrl = input.avatarUrl
  let avatarData = input.avatarData

  // Someone passed the whole raw user object (or a `user:users(*)` join
  // result) as `avatarData` -- unwrap it so avatar_url still takes priority.
  if (!avatarUrl && isRawUserShape(avatarData)) {
    avatarUrl = avatarData.avatar_url ?? undefined
    avatarData = avatarData.avatar_data
  }

  if (avatarUrl) {
    return { kind: 'photo', url: avatarUrl }
  }

  const data = avatarData as AnyAvatarData | null | undefined

  if (isAvatarIconData(data) && isAvatarIconName(data.icon)) {
    return { kind: 'icon', icon: data.icon, bgColor: data.bgColor || '#1f9d90' }
  }

  if (data && typeof data === 'object' && 'emoji' in data && typeof (data as { emoji?: unknown }).emoji === 'string') {
    return {
      kind: 'emoji',
      emoji: (data as { emoji: string }).emoji || '🙂',
      accessory: (data as { accessory?: string | null }).accessory ?? null,
      bgColor: (data as { bgColor?: string }).bgColor || '#1f9d90',
    }
  }

  return { kind: 'initials' }
}
