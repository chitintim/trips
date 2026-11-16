import { Tables, TablesInsert, TablesUpdate, Enums } from './database.types'

// Table row types
export type User = Tables<'users'>
export type Trip = Tables<'trips'>
export type TripParticipant = Tables<'trip_participants'>
export type PlanningSection = Tables<'planning_sections'>
export type Option = Tables<'options'>
export type Selection = Tables<'selections'>
export type Comment = Tables<'comments'>
export type Expense = Tables<'expenses'>
export type ExpenseSplit = Tables<'expense_splits'>
export type Invitation = Tables<'invitations'>
export type TripNote = Tables<'trip_notes'>
export type TimelineEvent = Tables<'trip_timeline_events'>
export type ChatMessage = Tables<'trip_chat_messages'>
export type SiteAnnouncement = Tables<'site_announcements'>
export type TripInsert = TablesInsert<'trips'>
export type PlanningSectionInsert = TablesInsert<'planning_sections'>
export type OptionInsert = TablesInsert<'options'>
export type ExpenseInsert = TablesInsert<'expenses'>
export type TripNoteInsert = TablesInsert<'trip_notes'>
export type TimelineEventInsert = TablesInsert<'trip_timeline_events'>
export type TimelineEventUpdate = TablesUpdate<'trip_timeline_events'>
export type SiteAnnouncementInsert = TablesInsert<'site_announcements'>

// Update types (for updating records)
export type UserUpdate = TablesUpdate<'users'>
export type TripUpdate = TablesUpdate<'trips'>
export type PlanningSectionUpdate = TablesUpdate<'planning_sections'>
export type OptionUpdate = TablesUpdate<'options'>
export type ExpenseUpdate = TablesUpdate<'expenses'>
export type TripStatus = Enums<'trip_status'>
export type PriceType = Enums<'price_type'>
export type NoteType = Enums<'note_type'>
export type TimelineEventCategory = Enums<'timeline_event_category'>

export interface OptionWithSelections extends Option {
  selections?: Array<Selection & { user?: User }>
}

export interface TripNoteWithUser extends TripNote {
  user?: User
}

// Avatar types
//
// Avatar system v2 (UX_REDESIGN.md "Avatar system v2"): three avatar types,
// stored backward-compatibly in the existing `users.avatar_url` /
// `users.avatar_data` columns -- nothing is migrated destructively, old
// data keeps rendering exactly as before.
//   1. `upload`  -> users.avatar_url (a public URL into the `avatars`
//                   storage bucket); avatar_data may still hold a fallback.
//   2. `icon`    -> avatar_data: {type:'icon', icon, bgColor}
//   3. (legacy, untyped) `{emoji, accessory, bgColor}` -- pre-v2 shape,
//      kept rendering forever, never written by new code.
export interface AvatarData {
  emoji: string
  accessory?: string | null
  bgColor: string
}

export interface AvatarIconData {
  type: 'icon'
  icon: string
  bgColor: string
}

/** Whatever may legitimately live in `users.avatar_data` across all eras. */
export type AnyAvatarData = AvatarIconData | AvatarData

export function isAvatarIconData(data: unknown): data is AvatarIconData {
  return (
    !!data &&
    typeof data === 'object' &&
    (data as { type?: unknown }).type === 'icon' &&
    typeof (data as { icon?: unknown }).icon === 'string'
  )
}

// Avatar builder options
export const AVATAR_EMOJIS = [
  '😊', '😎', '🎿', '⛷️', '🏂', '🥳',
  '🤩', '🥰', '🤗', '😄', '🌟', '⭐'
] as const

export const AVATAR_ACCESSORIES = [
  { value: null, label: 'None', emoji: '' },
  { value: '🎩', label: 'Top Hat', emoji: '🎩' },
  { value: '🧢', label: 'Cap', emoji: '🧢' },
  { value: '👓', label: 'Glasses', emoji: '👓' },
  { value: '🕶️', label: 'Sunglasses', emoji: '🕶️' },
  { value: '🎓', label: 'Graduation Cap', emoji: '🎓' },
  { value: '👑', label: 'Crown', emoji: '👑' },
  { value: '🎀', label: 'Bow', emoji: '🎀' },
] as const

export const AVATAR_BG_COLORS = [
  { value: '#0ea5e9', label: 'Sky Blue', preview: '#0ea5e9' },
  { value: '#f97316', label: 'Orange', preview: '#f97316' },
  { value: '#10b981', label: 'Green', preview: '#10b981' },
  { value: '#8b5cf6', label: 'Purple', preview: '#8b5cf6' },
  { value: '#ec4899', label: 'Pink', preview: '#ec4899' },
  { value: '#6b7280', label: 'Gray', preview: '#6b7280' },
  { value: '#ef4444', label: 'Red', preview: '#ef4444' },
  { value: '#eab308', label: 'Yellow', preview: '#eab308' },
] as const
