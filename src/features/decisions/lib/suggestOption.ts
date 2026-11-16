/**
 * Pure rules behind "Suggest an option" (Phase 5A). Mirrors the SQL in
 * supabase/migrations/20261119090000_suggest_option.sql so the app never shows
 * a person a form the server will reject. No React, no Supabase.
 */
import { isIdeasBucket } from '../../../lib/ideasBucket'
import { isOwnChoice } from '../../../lib/answers/answers'
import type { Json } from '../../../types/database.types'

export const SUGGEST_TITLE_MAX = 120
export const SUGGEST_NOTE_MAX = 500
/** Max suggestions per person per question (server: rate_limit_question). */
export const SUGGEST_MAX_PER_QUESTION = 5

export const SUGGEST_ENTRY_LABEL = 'Suggest an option'
export const SUGGEST_IDEA_NOTE = 'Your idea goes in the “Ideas” question, where everyone can say which they like.'

export interface SuggestionValues {
  title: string
  link: string
}

/** The link as the server will store it: http(s) only, a bare "www." address gets https://. Null when empty or not a single link. */
export function normalizeSuggestionLink(raw: string): string | null {
  const t = raw.trim()
  if (!t || /\s/.test(t)) return null
  if (/^https?:\/\/\S+$/i.test(t)) return t.length <= 2000 ? t : null
  if (/^www\.[^\s.]+\.\S+$/i.test(t)) return `https://${t}`.length <= 2000 ? `https://${t}` : null
  return null
}

/** First problem with the form, in plain words, or null. Same limits as the RPC. */
export function validateSuggestion(v: SuggestionValues): string | null {
  const title = v.title.trim()
  if (!title) return 'Give it a short title.'
  if (title.length > SUGGEST_TITLE_MAX) return `Keep the title under ${SUGGEST_TITLE_MAX} characters.`
  if (v.link.trim() && !normalizeSuggestionLink(v.link)) return 'That link doesn’t look right. Paste the full address, or leave it empty.'
  return null
}

interface SuggestableSection {
  status: string
  title: string
  metadata?: unknown
  options: ReadonlyArray<{ title: string; status: string; metadata?: unknown }>
}

function isDatePoll(section: SuggestableSection): boolean {
  if (section.title.trim().toLowerCase() === 'trip dates') return true
  return section.options.some((o) => {
    const m = o.metadata
    return !!m && typeof m === 'object' && !Array.isArray(m) && 'date_range' in (m as Record<string, unknown>)
  })
}

export function suggestedById(option: { metadata?: unknown }): string | null {
  const m = option.metadata
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null
  const v = (m as Record<string, unknown>).suggested_by
  return typeof v === 'string' && v ? v : null
}

/** The suggester's optional link (metadata.source_url), or null. Validated again at render time. */
export function suggestedSourceUrl(option: { metadata?: unknown }): string | null {
  const m = option.metadata
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null
  const v = (m as Record<string, unknown>).source_url
  return typeof v === 'string' && v ? v : null
}

export interface SuggestEntryInput {
  /** The RPC exists (probe). */
  rpcAvailable: boolean
  userId: string | null
  /** Declined / cancelled / inactive (answers engine's `viewer.out`). */
  viewerOut: boolean
  tripFinished: boolean
  /** Organizers add options through Manage; the entry is theirs-free. */
  canManageTrip: boolean
  section: SuggestableSection
}

/**
 * Who sees "＋ Suggest an option" on a question card: a signed-in person who is coming, not an organizer,
 * on an open, not-finished Group-choice question that is not a date poll, who is under the per-question cap.
 */
export function canSuggestOption(i: SuggestEntryInput): boolean {
  if (!i.rpcAvailable || !i.userId || i.viewerOut || i.tripFinished || i.canManageTrip) return false
  const s = i.section
  if (s.status === 'completed') return false
  if (isOwnChoice({ metadata: (s.metadata ?? null) as Json | null })) return false
  if (isDatePoll(s)) return false
  if (s.options.length >= 60) return false
  const mine = s.options.filter((o) => suggestedById(o) === i.userId).length
  return mine < SUGGEST_MAX_PER_QUESTION
}

/** Who may add an idea from the Add flow: same people, no question needed (the bucket is created on first use). */
export function canSuggestIdea(i: Pick<SuggestEntryInput, 'rpcAvailable' | 'userId' | 'viewerOut' | 'tripFinished' | 'canManageTrip'>): boolean {
  return i.rpcAvailable && !!i.userId && !i.viewerOut && !i.tripFinished && !i.canManageTrip
}

interface NameSource {
  user_id: string
  user?: { first_name?: string | null; full_name?: string | null; email?: string | null } | null
}

/** First name for a person ("Alex"), falling back to the email's local part, then "someone". */
export function firstNameOf(p: NameSource | undefined): string {
  const u = p?.user
  const name = u?.first_name?.trim() || u?.full_name?.trim().split(/\s+/)[0] || u?.email?.split('@')[0]
  return name || 'someone'
}

/** "Suggested by Alex" (or "Suggested by you" for the viewer), or null when this option was not suggested. */
export function suggestedByLabel(option: { metadata?: unknown }, participants: ReadonlyArray<NameSource> | undefined, viewerId: string | null): string | null {
  const by = suggestedById(option)
  if (!by) return null
  if (by === viewerId) return 'Suggested by you'
  return `Suggested by ${firstNameOf(participants?.find((p) => p.user_id === by))}`
}

/** The suggester may withdraw while the question is open, the option is untouched and nobody has answered with it. */
export function canWithdrawSuggestion(i: {
  option: { metadata?: unknown; status: string; locked?: boolean | null }
  userId: string | null
  questionOpen: boolean
  tripFinished: boolean
  /** Someone (anyone) answered with this option. */
  answered: boolean
}): boolean {
  if (!i.userId || suggestedById(i.option) !== i.userId) return false
  if (!i.questionOpen || i.tripFinished || i.answered) return false
  return i.option.status === 'available' && !i.option.locked
}

export { isIdeasBucket }
