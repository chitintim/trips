/**
 * propose_add_expense: "I paid £40 for taxis, split between us four". Exact minor units, explicit
 * shares (same largest-remainder rule as the app), review tier. Executor: createExpenseWithSplits with
 * these rows; FX is resolved by the CLIENT executor (this tool never calls an FX service).
 */
import { z } from 'npm:zod@3'
import { getCurrencyExponent } from '../../../_shared/money/currencyExponent.ts'
import { inScopePeople } from '../../../_shared/todos/deps/inScopePeople.ts'
import { refuse, type ToolCtx, type ToolModule, type ToolResult } from '../types.ts'
import type { AddExpenseBasis, AddExpenseParams, AddExpensePreview } from './cards.ts'
import { baseBasis, dayLabel, FROZEN_MESSAGE, gate, isRealDate, line, onRoster, originsFor, parseInput, personRef, storeProposal, tripState, uuid } from './common.ts'
import { daysBetween, messageStatesDate } from './statedDate.ts'
import { equalShares, formatMinor, isKnownCurrency, parseDecimalToMinor } from './money.ts'

export const EXPENSE_DESCRIPTION_MAX = 120
export const EXPENSE_CATEGORIES = ['accommodation', 'transport', 'food', 'activities', 'equipment', 'other'] as const
const MAX_PEOPLE = 40
/** Older than this needs the person to have written the date themselves. */
export const MAX_PAST_DAYS = 60

const Input = z
  .object({
    description: line(EXPENSE_DESCRIPTION_MAX),
    amount: z.string().max(20),
    currency: z.string().transform((s) => s.trim().toUpperCase()).pipe(z.string().regex(/^[A-Z]{3}$/, 'must be a 3-letter currency code')),
    paid_by: uuid.nullable(),
    split_between: z.union([z.array(uuid).min(1).max(MAX_PEOPLE), z.literal('everyone_in_scope')]),
    custom_split: z.array(z.object({ person_id: uuid, amount: z.string().max(20) }).strict()).max(MAX_PEOPLE).nullable(),
    date: z.string().nullable(),
    category: z.enum(EXPENSE_CATEGORIES),
  })
  .strict()

export const addExpenseSchema = {
  type: 'object',
  properties: {
    description: { type: 'string', description: 'What it was for, in a few words (up to 120 characters).' },
    amount: { type: 'string', description: 'The total as a decimal string in the currency, e.g. "40.00" or "5000" for yen. No symbol, no commas.' },
    currency: { type: 'string', description: '3-letter code, e.g. GBP. Use the trip currency unless the person says otherwise.' },
    paid_by: { type: ['string', 'null'], format: 'uuid', description: 'Who paid (user id from the roster). null = the person asking.' },
    split_between: {
      anyOf: [
        { type: 'array', items: { type: 'string', format: 'uuid' } },
        { type: 'string', enum: ['everyone_in_scope'] },
      ],
      description: 'User ids to split between, or "everyone_in_scope" for everyone who is in. Split evenly unless custom_split is given.',
    },
    custom_split: {
      type: ['array', 'null'],
      items: {
        type: 'object',
        properties: { person_id: { type: 'string', format: 'uuid' }, amount: { type: 'string' } },
        required: ['person_id', 'amount'],
        additionalProperties: false,
      },
      description: 'Only when the person gave exact amounts per person. They must add up to the total exactly and cover exactly the people in split_between. Otherwise null (even split).',
    },
    date: { type: ['string', 'null'], format: 'date', description: 'YYYY-MM-DD of the payment. null = today.' },
    category: { type: 'string', enum: [...EXPENSE_CATEGORIES] },
  },
  required: ['description', 'amount', 'currency', 'paid_by', 'split_between', 'custom_split', 'date', 'category'],
  additionalProperties: false,
}

async function run(raw: unknown, ctx: ToolCtx): Promise<ToolResult> {
  const blocked = gate(ctx, 'money')
  if (blocked) return blocked
  const parsed = parseInput(Input, raw)
  if (!parsed.ok) return parsed.result
  const v = parsed.data
  const state = await tripState(ctx)
  if (state.frozen) return refuse(FROZEN_MESSAGE)

  if (!isKnownCurrency(v.currency, ctx.trip.base_currency)) return refuse(`${v.currency} is not a currency the app knows. Use a 3-letter code such as ${ctx.trip.base_currency}.`)
  const total = parseDecimalToMinor(v.amount, v.currency)
  if (total == null) {
    return refuse(`"${v.amount}" is not an amount I can use in ${v.currency}: write digits with at most ${getCurrencyExponent(v.currency)} decimal places, no symbols or commas.`)
  }
  if (total <= 0) return refuse('The amount must be more than zero.')

  const date = v.date ?? ctx.today
  if (!isRealDate(date)) return refuse('date must be a real YYYY-MM-DD date.')
  // Far-off dates are only accepted when the person wrote that date themselves; the model's own arithmetic is not trusted.
  const offset = daysBetween(ctx.today, date) // + = future
  const futureSlack = ctx.tzLabel === 'your local date' ? 0 : 1 // no timezone sent: the person may already be on tomorrow's date
  if ((offset > futureSlack || offset < -MAX_PAST_DAYS) && !messageStatesDate(ctx.userMessage ?? '', date)) {
    return refuse(offset > 0
      ? `${date} is in the future and the person did not give that date. Ask them what date they paid (expenses are recorded once paid), then call this again with it.`
      : `${date} is ${-offset} days ago and the person did not give that date. Ask them what date they paid, then call this again with it.`)
  }

  // payer
  const payerId = v.paid_by ?? ctx.userId
  if (!onRoster(ctx, payerId)) return refuse('The person who paid is not on this trip. Use a user id from the roster.')

  // who shares it, in roster order (so the extra pennies fall exactly as they do in the app)
  let ids: string[]
  if (v.split_between === 'everyone_in_scope') {
    ids = inScopePeople(
      ctx.roster.map((p) => ({ user_id: p.userId, active: p.active, confirmation_status: p.confirmationStatus })),
      state.confirmationEnabled,
    ).map((p) => p.user_id)
    if (ids.length === 0) return refuse('Nobody is in scope to split between. Name the people explicitly.')
  } else {
    if (new Set(v.split_between).size !== v.split_between.length) return refuse('Each person can appear once in split_between.')
    for (const id of v.split_between) {
      const p = onRoster(ctx, id)
      if (!p) return refuse('Someone in split_between is not on this trip. Use user ids from the roster.')
      if (!p.active) return refuse(`${p.name} has been removed from the trip, so an expense cannot be split with them.`)
    }
    const set = new Set(v.split_between)
    ids = ctx.roster.filter((p) => set.has(p.userId)).map((p) => p.userId)
  }

  // shares
  let splitMode: 'equal' | 'custom' = 'equal'
  let amounts: number[]
  if (v.custom_split) {
    splitMode = 'custom'
    const byId = new Map<string, number>()
    for (const c of v.custom_split) {
      if (byId.has(c.person_id)) return refuse('Each person can appear once in custom_split.')
      const m = parseDecimalToMinor(c.amount, v.currency)
      if (m == null) return refuse(`"${c.amount}" is not an amount I can use in ${v.currency}.`)
      byId.set(c.person_id, m)
    }
    if (byId.size !== ids.length || ids.some((id) => !byId.has(id))) return refuse('custom_split must list exactly the people in split_between, once each.')
    amounts = ids.map((id) => byId.get(id)!)
    const sum = amounts.reduce((a, b) => a + b, 0)
    if (sum !== total) {
      const diff = total - sum
      return refuse(`The amounts add up to ${formatMinor(sum, v.currency)} but the total is ${formatMinor(total, v.currency)} (${diff > 0 ? 'short' : 'over'} by ${formatMinor(Math.abs(diff), v.currency)}). They must match exactly; fix the amounts or split evenly (custom_split null).`)
    }
  } else {
    amounts = equalShares(total, ids.length)
  }
  const splits = ids.map((id, i) => ({ user_id: id, amount_minor: amounts[i] }))
  if (splits.reduce((a, s) => a + s.amount_minor, 0) !== total) return refuse('Internal check failed: the shares do not add up. Nothing was suggested.')

  const needsFx = v.currency !== ctx.trip.base_currency
  const params: AddExpenseParams = {
    description: v.description,
    amount_minor: total,
    currency: v.currency,
    exponent: getCurrencyExponent(v.currency),
    paid_by: payerId,
    payment_date: date,
    category: v.category,
    split_mode: splitMode,
    participant_ids: ids,
    splits,
    base_currency: ctx.trip.base_currency,
    needs_fx: needsFx,
  }

  // A similar expense already on the trip? (warning only)
  let dup: { expense_id: string } | null = null
  try {
    const { data } = await ctx.client.from('expenses').select('id,amount,paid_by,payment_date').eq('trip_id', ctx.tripId).eq('description', v.description)
    const hit = ((data ?? []) as Array<{ id: string; amount: number; paid_by: string; payment_date: string }>).find(
      (r) => r.paid_by === payerId && String(r.payment_date).slice(0, 10) === date && parseDecimalToMinor(String(r.amount), v.currency) === total,
    )
    if (hit) dup = { expense_id: hit.id }
  } catch { /* best effort */ }

  const preview: AddExpensePreview = {
    description: v.description,
    amount_text: formatMinor(total, v.currency),
    currency: v.currency,
    paid_by: personRef(ctx, payerId),
    paid_by_is_me: payerId === ctx.userId,
    payer_is_user: payerId === ctx.userId,
    my_share_minor: splits.find((s) => s.user_id === ctx.userId)?.amount_minor ?? null,
    my_share_text: splits.some((s) => s.user_id === ctx.userId) ? formatMinor(splits.find((s) => s.user_id === ctx.userId)!.amount_minor, v.currency) : null,
    date,
    date_label: dayLabel(date, ctx.today),
    category: v.category,
    split_mode: splitMode,
    shares: splits.map((s) => ({ ...personRef(ctx, s.user_id), amount_minor: s.amount_minor, amount_text: formatMinor(s.amount_minor, v.currency) })),
    shares_total_text: formatMinor(total, v.currency),
    fx_note: needsFx ? `The app converts this to ${ctx.trip.base_currency} at the exchange rate for the payment date when you confirm.` : null,
    possible_duplicate: dup,
    content_origin: await originsFor(ctx, [{ field: 'description', text: v.description, sources: ['expense', 'todo', 'option'] }]),
  }
  const basis: AddExpenseBasis = {
    ...baseBasis(ctx, state),
    people_active: Object.fromEntries([...ids, payerId].map((id) => [id, onRoster(ctx, id)?.active === true])),
  }
  // Money and other people: always a full review, whoever paid.
  return storeProposal(ctx, { kind: 'add_expense', params, preview, basis, requires: 'review' })
}

export const proposeAddExpense: ToolModule = {
  name: 'propose_add_expense',
  description:
    'Suggest adding an expense, e.g. "I paid £40 for taxis, split between the four of us". Give the amount as a decimal string and the people by id; the app works out each share exactly. Always shown to the person for review before anything is saved. Not available while balances are frozen.',
  statusLabel: 'Preparing an expense…',
  inputSchema: addExpenseSchema,
  run,
}
