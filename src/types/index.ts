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
export type InvitationAttempt = Tables<'invitation_attempts'>

// Insert types (for creating new records)
export type UserInsert = TablesInsert<'users'>
export type TripInsert = TablesInsert<'trips'>
export type TripParticipantInsert = TablesInsert<'trip_participants'>
export type PlanningSectionInsert = TablesInsert<'planning_sections'>
export type OptionInsert = TablesInsert<'options'>
export type SelectionInsert = TablesInsert<'selections'>
export type CommentInsert = TablesInsert<'comments'>
export type ExpenseInsert = TablesInsert<'expenses'>
export type ExpenseSplitInsert = TablesInsert<'expense_splits'>
export type InvitationInsert = TablesInsert<'invitations'>
export type InvitationAttemptInsert = TablesInsert<'invitation_attempts'>

// Update types (for updating records)
export type UserUpdate = TablesUpdate<'users'>
export type TripUpdate = TablesUpdate<'trips'>
export type TripParticipantUpdate = TablesUpdate<'trip_participants'>
export type PlanningSectionUpdate = TablesUpdate<'planning_sections'>
export type OptionUpdate = TablesUpdate<'options'>
export type SelectionUpdate = TablesUpdate<'selections'>
export type CommentUpdate = TablesUpdate<'comments'>
export type ExpenseUpdate = TablesUpdate<'expenses'>
export type ExpenseSplitUpdate = TablesUpdate<'expense_splits'>
export type InvitationUpdate = TablesUpdate<'invitations'>
export type InvitationAttemptUpdate = TablesUpdate<'invitation_attempts'>

// Enum types
export type UserRole = Enums<'user_role'>
export type TripStatus = Enums<'trip_status'>
export type ParticipantRole = Enums<'participant_role'>
export type SectionType = Enums<'section_type'>
export type SectionStatus = Enums<'section_status'>

// Extended types with relationships
export interface TripWithCreator extends Trip {
  creator?: User
}

export interface TripWithParticipants extends Trip {
  participants?: Array<TripParticipant & { user?: User }>
}

export interface TripFull extends Trip {
  creator?: User
  participants?: Array<TripParticipant & { user?: User }>
}

export interface UserWithTrips extends User {
  created_trips?: Trip[]
  participating_trips?: Array<TripParticipant & { trip?: Trip }>
}

export interface PlanningSectionWithOptions extends PlanningSection {
  options?: Option[]
}

export interface OptionWithSelections extends Option {
  selections?: Array<Selection & { user?: User }>
}

export interface SelectionWithDetails extends Selection {
  option?: Option
  user?: User
}

export interface CommentWithUser extends Comment {
  user?: User
}

export interface ExpenseWithSplits extends Expense {
  splits?: Array<ExpenseSplit & { user?: User }>
  paid_by_user?: User
}

export interface ExpenseSplitWithDetails extends ExpenseSplit {
  expense?: Expense
  user?: User
}

// Form types
export interface CreateTripForm {
  name: string
  location: string
  start_date: string
  end_date: string
  status?: TripStatus
}

export interface UpdateTripForm {
  name?: string
  location?: string
  start_date?: string
  end_date?: string
  status?: TripStatus
}

export interface UpdateProfileForm {
  full_name?: string
  avatar_url?: string
}

export interface CreatePlanningSectionForm {
  trip_id: string
  section_type: SectionType
  title: string
  description?: string
  order_index?: number
}

export interface CreateOptionForm {
  section_id: string
  title: string
  description?: string
  price?: number
  currency?: string
  metadata?: Record<string, any>
}

export interface CreateSelectionForm {
  option_id: string
  metadata?: Record<string, any>
}

export interface CreateCommentForm {
  section_id?: string
  option_id?: string
  content: string
}

export interface CreateExpenseForm {
  trip_id: string
  amount: number
  currency?: string
  description: string
  receipt_url?: string
}

export interface CreateExpenseSplitForm {
  expense_id: string
  user_id: string
  amount: number
}

export interface CreateInvitationForm {
  trip_id?: string // Optional - admin can assign later
  max_uses?: number
  expires_at?: string
}

// Avatar types
export interface AvatarData {
  emoji: string
  accessory?: string | null
  bgColor: string
}

export interface SignupForm {
  invitationCode: string
  email: string
  password: string
  firstName: string
  lastName: string
  avatarData: AvatarData
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

export type AvatarEmoji = typeof AVATAR_EMOJIS[number]
export type AvatarAccessory = typeof AVATAR_ACCESSORIES[number]['value']
export type AvatarBgColor = typeof AVATAR_BG_COLORS[number]['value']
