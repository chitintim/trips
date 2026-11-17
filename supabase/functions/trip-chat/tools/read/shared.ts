/**
 * Helpers shared by the read tools: strict-schema builders, plain-word
 * vocabulary, cached loaders and the "is this person allowed" guard.
 *
 * Words come from the app (src/lib/tripStatus.ts getTripStatusLabel,
 * questionCardModel / answerCopy, rsvpLabels). Raw enum values must never reach
 * the model or the user; every status goes through a map here.
 */
import { z } from 'npm:zod@3'
import { memoize, refuse, type ChatTrip, type ToolCtx, type ToolModule, type ToolResult } from '../types.ts'
import { effectiveTripStage } from '../../../_shared/todos/deps/tripStage.ts'
import type { TripStatus } from '../../../_shared/todos/deps/tripStatus.ts'
import { assembleTripSnapshot, fetchSnapshotData, type SnapshotData } from '../../../_shared/todos/snapshot.ts'
import type { TripSnapshot } from '../../../_shared/todos/types.ts'
import { formatMoney as formatMoneyWords } from '../../../_shared/todos/copy.ts'
import { getCurrencyExponent } from '../../../_shared/money/currencyExponent.ts'
import { fromMinorUnits, toMinorUnits } from '../../../_shared/money/minorUnits.ts'

export { z }

// ---------------------------------------------------------------------------
// Strict JSON Schema builders (hand-written shapes, tiny helpers to avoid typos)
// ---------------------------------------------------------------------------

type JsonSchema = Record<string, unknown>

export const S = {
  string: (description?: string): JsonSchema => ({ type: 'string', ...(description ? { description } : {}) }),
  uuid: (description?: string): JsonSchema => ({ type: 'string', format: 'uuid', ...(description ? { description } : {}) }),
  date: (description?: string): JsonSchema => ({ type: 'string', format: 'date', ...(description ? { description } : {}) }),
  /** Optional value: the key is still required, the model passes null. */
  nullable: (schema: JsonSchema): JsonSchema => {
    const t = schema.type
    // A nullable enum must list null itself, or the model's null would fail the schema.
    return { ...schema, type: [t as string, 'null'], ...(Array.isArray(schema.enum) ? { enum: [...(schema.enum as unknown[]), null] } : {}) }
  },
  enum: (values: readonly string[], description?: string): JsonSchema => ({ type: 'string', enum: [...values], ...(description ? { description } : {}) }),
  /** A strict object schema: every property required, nothing else allowed. */
  object: (properties: Record<string, JsonSchema>): JsonSchema => ({
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  }),
}

/** Zod parse with a message the model can act on (goes back as an is_error result). */
export function parseArgs<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw ?? {})
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new Error(`Bad tool input: ${issue.path.join('.') || 'input'} ${issue.message}`)
  }
  return parsed.data
}

export const uuidArg = z.string().uuid()
export const dateArg = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date like 2026-12-31')

// ---------------------------------------------------------------------------
// Plain words
// ---------------------------------------------------------------------------

/** Same labels as getTripStatusLabel (src/lib/tripStatus.ts). */
const STAGE_WORDS: Record<TripStatus, string> = {
  gathering_interest: "Who's coming",
  confirming_participants: "Who's coming",
  booking_details: 'Planning',
  booked_awaiting_departure: 'Ready to go',
  trip_ongoing: 'On the trip',
  trip_completed: 'Finished',
}

/** The trip's stage in the app's words, from the EFFECTIVE stage (stored status upgraded by the dates). */
export function stageWords(trip: Pick<ChatTrip, 'status' | 'start_date' | 'end_date'>, today: Date | string = new Date()): string {
  const stage = effectiveTripStage({ status: trip.status as TripStatus, start_date: trip.start_date, end_date: trip.end_date }, today)
  return STAGE_WORDS[stage] ?? 'Planning'
}

export type QuestionStage = 'open' | 'decided' | 'booked' | 'closed'

/** Same words as the question card strip (questionCardModel). */
export const QUESTION_STATUS_WORDS: Record<QuestionStage, string> = {
  open: 'Open',
  decided: 'Decided',
  booked: 'Booked',
  closed: 'Closed - no decision',
}

export const SHAPE_WORDS = { group: 'Group choice (everyone answers the same question)', own: 'Own choice (each person picks for themselves)' } as const

/** Question status words for the model: Open / Decided / Booked / Closed - no decision. */
export function statusWords(stage: QuestionStage): string {
  return QUESTION_STATUS_WORDS[stage]
}

export function shapeWords(own: boolean): string {
  return own ? SHAPE_WORDS.own : SHAPE_WORDS.group
}

/** The five RSVP chips (src/features/people/lib/rsvpLabels.ts). */
const RSVP_WORDS: Record<string, string> = {
  confirmed: 'Going',
  interested: 'Not sure',
  conditional: 'Not sure',
  declined: 'Not going',
  cancelled: 'Not going',
  pending: 'No reply yet',
  waitlist: 'On the waitlist',
}
export function rsvpWords(status: string | null | undefined): string {
  return RSVP_WORDS[status ?? 'pending'] ?? 'No reply yet'
}

const CATEGORY_WORDS: Record<string, string> = {
  accommodation: 'Accommodation',
  transport: 'Transport',
  food: 'Food and drink',
  activities: 'Activities',
  equipment: 'Equipment',
  other: 'Other',
}
export function categoryWords(category: string | null | undefined): string {
  return CATEGORY_WORDS[category ?? 'other'] ?? 'Other'
}
export const EXPENSE_CATEGORIES = ['accommodation', 'transport', 'food', 'activities', 'equipment', 'other'] as const

const OPTION_STATUS_WORDS: Record<string, string> = {
  draft: 'Draft',
  available: 'Available',
  booking: 'Being booked',
  booked: 'Booked',
  cancelled: 'Cancelled',
}
export function optionStatusWords(status: string | null | undefined): string {
  return OPTION_STATUS_WORDS[status ?? 'available'] ?? 'Available'
}

const EVENT_CATEGORY_WORDS: Record<string, string> = {
  flight: 'Flight',
  accommodation: 'Accommodation',
  transport: 'Transport',
  activity: 'Activity',
  dining: 'Food and drink',
  transfer: 'Transfer',
  meeting_point: 'Meeting point',
  free_time: 'Free time',
  other: 'Other',
}
export function eventCategoryWords(category: string | null | undefined): string {
  return EVENT_CATEGORY_WORDS[category ?? 'other'] ?? 'Other'
}

const BOOKING_STATUS_WORDS: Record<string, string> = {
  confirmed: 'Confirmed',
  pending: 'Waiting for confirmation',
  booked: 'Booked',
  cancelled: 'Cancelled',
  draft: 'Draft',
}
export function bookingStatusWords(status: string | null | undefined): string {
  return BOOKING_STATUS_WORDS[status ?? ''] ?? 'Booked'
}

const SETTLEMENT_STATUS_WORDS: Record<string, string> = {
  suggested: 'Suggested, not paid yet',
  marked_paid: 'Sent, waiting for the receiver to confirm',
  confirmed: 'Paid and confirmed',
}
export function settlementStatusWords(status: string | null | undefined): string {
  return SETTLEMENT_STATUS_WORDS[status ?? 'confirmed'] ?? 'Paid and confirmed'
}

const SPLIT_WORDS: Record<string, string> = {
  equal: 'split equally',
  custom: 'split by exact amounts',
  percentage: 'split by percentages',
  shares: 'split by shares',
}
export function splitWords(type: string | null | undefined): string {
  return SPLIT_WORDS[type ?? 'equal'] ?? 'split between people'
}

/** "price basis" in words (src/lib/cost/priceBasis.ts). */
export function priceWords(option: { price?: number | null; currency?: string | null; price_type?: string | null; metadata?: unknown }, fallbackCurrency: string): string | null {
  if (option.price == null) return null
  const meta = option.metadata && typeof option.metadata === 'object' && !Array.isArray(option.metadata) ? (option.metadata as Record<string, unknown>) : {}
  const explicit = meta.price_basis
  const amount = formatMoneyWords(option.price, option.currency || fallbackCurrency)
  if (explicit === 'per_night') return `${amount} per night`
  if (explicit === 'total_split' || explicit === 'stay' || option.price_type === 'total_split') return `${amount} in total, shared between the people going`
  return `${amount} each`
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  GBP: '£', EUR: '€', USD: '$', CHF: 'CHF ', JPY: '¥', AUD: 'A$', CAD: 'C$', KRW: '₩', CNY: 'CN¥', HKD: 'HK$', SGD: 'S$', NZD: 'NZ$', INR: '₹', THB: '฿',
}

/**
 * The app's exact money format (src/lib/money/format.ts formatMoney mode 'exact'): full minor units, fixed en-GB
 * grouping, the app's symbols ("£12.50", "¥5,000", "CHF 120.00"), "-£4.00" for negatives.
 */
export function moneyExact(amount: number, currency: string | null | undefined): string {
  const code = (currency || 'GBP').toUpperCase()
  const exponent = getCurrencyExponent(code)
  const safe = Number.isFinite(amount) ? amount : 0
  const abs = fromMinorUnits(toMinorUnits(Math.abs(safe), code), code)
  const body = abs.toLocaleString('en-GB', { minimumFractionDigits: exponent, maximumFractionDigits: exponent })
  const symbol = CURRENCY_SYMBOLS[code] ?? `${code} `
  return `${safe < 0 && abs !== 0 ? '-' : ''}${symbol}${body}`
}

/** Alias kept for readability where "headline" money was meant; the chat always prints exact amounts. */
export const money = moneyExact

// ---------------------------------------------------------------------------
// Roster / names
// ---------------------------------------------------------------------------

export function nameOf(ctx: ToolCtx, userId: string | null | undefined): string {
  if (!userId) return 'Someone'
  if (userId === ctx.userId) return 'You'
  return ctx.roster.find((p) => p.userId === userId)?.name?.trim() || 'Someone'
}

/** Name for a sentence about the viewer's own row: "you" is rendered by the caller. */
export function personName(ctx: ToolCtx, userId: string | null | undefined): string {
  if (!userId) return 'Someone'
  return ctx.roster.find((p) => p.userId === userId)?.name?.trim() || 'Someone'
}

// ---------------------------------------------------------------------------
// Cached loaders (one fetch of each table per turn, shared by every tool)
// ---------------------------------------------------------------------------

export function loadData(ctx: ToolCtx): Promise<SnapshotData | null> {
  return memoize(ctx, 'read:snapshot-data', () => fetchSnapshotData(ctx.client, ctx.tripId))
}

export async function loadSnapshot(ctx: ToolCtx): Promise<TripSnapshot | null> {
  const data = await loadData(ctx)
  return data ? assembleTripSnapshot(data, ctx.now) : null
}

export const LOAD_FAILED = "I couldn't load that from the trip just now. Please try again in a moment."

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

export const OUT_REFUSAL = "You're not going on this trip, so I can only help with money questions (what you owe, balances and expenses)."

/** 'money' tools are open to people who are out; 'trip' tools are for people who are on the trip. */
export type ToolAccess = 'trip' | 'money'

export function accessRefusal(ctx: ToolCtx, access: ToolAccess): ToolResult | null {
  if (access === 'money') return null
  return ctx.me.isOut ? refuse(OUT_REFUSAL) : null
}

export interface ReadToolSpec<A> {
  name: string
  description: string
  statusLabel: string
  inputSchema: JsonSchema
  access: ToolAccess
  schema: z.ZodType<A>
  run: (args: A, ctx: ToolCtx) => Promise<ToolResult>
}

/** Builds a ToolModule: access guard, Zod parse, a failed load becomes a plain message (never a stack). */
export function readTool<A>(spec: ReadToolSpec<A>): ToolModule {
  return {
    name: spec.name,
    description: spec.description,
    statusLabel: spec.statusLabel,
    inputSchema: spec.inputSchema,
    run: async (raw, ctx) => {
      const blocked = accessRefusal(ctx, spec.access)
      if (blocked) return blocked
      const args = parseArgs(spec.schema, raw)
      return await spec.run(args, ctx)
    },
  }
}

/** Anything that can go wrong in a read: a plain, model-relayable error. */
export function failed(): ToolResult {
  return refuse(LOAD_FAILED)
}

/** ISO date (YYYY-MM-DD) of ctx.today, ready for comparisons. */
export function todayOf(ctx: ToolCtx): string {
  return ctx.today
}

export function isDateOnly(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s)
}

/** "Fri 21 Nov" from YYYY-MM-DD (UTC-safe, no Intl locale surprises). */
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export function dateWords(value: string | null | undefined): string | null {
  if (!value) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  if (!m) return value
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return `${WD[d.getUTCDay()]} ${d.getUTCDate()} ${MO[d.getUTCMonth()]}`
}

export function timeWords(value: string | null | undefined): string | null {
  if (!value) return null
  return value.slice(0, 5)
}
