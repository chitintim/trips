import { fromMinorUnits, toMinorUnits } from '../../../lib/money'
import { invalidateAfterCreateExpense, type CreateExpenseFormValues } from '../../../lib/queries/useExpenses'
import { computeSplits } from '../../expenses/editor/computeSplits'
import { emptyWizardDraft, type ExpenseWizardDraft } from '../../expenses/editor/wizardState'
import type { AddExpenseParams } from '../lib/payload'
import type { ActionModule, LiveData } from './types'
import { FROZEN_CARD_MESSAGE, dayWarning, formatDay, isDay, isInt, isNonEmptyStr, isObj, money, personActive, personName } from './common'

const p = (a: { params: Record<string, unknown> }) => a.params as unknown as AddExpenseParams

const CATEGORY_LABEL: Record<AddExpenseParams['category'], string> = {
  accommodation: 'Accommodation',
  transport: 'Transport',
  food: 'Food',
  activities: 'Activities',
  equipment: 'Equipment',
  other: 'Other',
}

/** The shares exactly as the card shows them and the function will write them: from the explicit amounts in the action. */
export function sharesOf(params: AddExpenseParams, live: LiveData): Array<{ userId: string; name: string; minor: number; text: string }> {
  return params.splits.map((s) => ({ userId: s.user_id, name: personName(live, s.user_id), minor: s.amount_minor, text: money(s.amount_minor, params.currency) }))
}

/**
 * The draft the expense form would hold for this action, built so `createExpenseWithSplits` writes exactly the shares on the card.
 * An even split stays in the form's own "equal" mode (so the rows say `equal`, like the screen's) when the form's maths gives the
 * very same pennies; otherwise the explicit amounts go in as a custom split. Throws when the amounts do not add up.
 */
export function buildExpenseDraft(params: AddExpenseParams, userId: string): { draft: ExpenseWizardDraft; amountMajor: number } {
  const { currency, amount_minor: total } = params
  const ids = params.splits.map((s) => s.user_id)
  const amountMajor = fromMinorUnits(total, currency)
  if (params.splits.reduce((a, s) => a + s.amount_minor, 0) !== total || params.splits.some((s) => s.amount_minor < 0)) {
    throw new Error("The split doesn't add up to the total, so nothing was added.")
  }
  const blank = emptyWizardDraft({ today: params.payment_date, baseCurrency: params.base_currency, currentUserId: userId, allParticipantIds: ids })
  const base: ExpenseWizardDraft = {
    ...blank,
    description: params.description.trim(),
    amount: String(amountMajor),
    currency,
    paymentDate: params.payment_date,
    category: params.category,
    participantIds: ids,
    paidBy: params.paid_by,
  }
  const matches = (d: ExpenseWizardDraft) => {
    const rows = computeSplits({ mode: d.splitMode, amountMajor, currency, participantIds: d.participantIds, entries: d.splitEntries })
    return rows.length === params.splits.length && rows.every((r, i) => r.userId === params.splits[i].user_id && toMinorUnits(r.amountMajor, currency) === params.splits[i].amount_minor)
  }
  if (params.split_mode === 'equal') {
    const equal = { ...base, splitMode: 'equal' as const }
    if (matches(equal)) return { draft: equal, amountMajor }
  }
  const custom: ExpenseWizardDraft = {
    ...base,
    splitMode: 'custom',
    splitEntries: params.splits.map((s) => ({ userId: s.user_id, value: fromMinorUnits(s.amount_minor, currency).toFixed(params.exponent) })),
  }
  if (!matches(custom)) throw new Error("The split doesn't add up to the total, so nothing was added.")
  return { draft: custom, amountMajor }
}

export const addExpenseModule: ActionModule = {
  validate(x) {
    return (
      isNonEmptyStr(x.description) &&
      isInt(x.amount_minor) &&
      (x.amount_minor as number) > 0 &&
      isNonEmptyStr(x.currency) &&
      isInt(x.exponent) &&
      isNonEmptyStr(x.paid_by) &&
      isDay(x.payment_date) &&
      isNonEmptyStr(x.category) &&
      (x.split_mode === 'equal' || x.split_mode === 'custom') &&
      isNonEmptyStr(x.base_currency) &&
      Array.isArray(x.splits) &&
      x.splits.length > 0 &&
      x.splits.every((s) => isObj(s) && isNonEmptyStr(s.user_id) && isInt(s.amount_minor)) &&
      (x.splits as Array<{ amount_minor: number }>).reduce((a, s) => a + s.amount_minor, 0) === x.amount_minor
    )
  },

  view(action, live) {
    const params = p(action)
    const shares = sharesOf(params, live)
    const now = live.now ?? new Date()
    const payer = personName(live, params.paid_by)
    const mine = params.splits.find((s) => s.user_id === live.userId)
    const warnings: string[] = []
    // The server's own wording for "you'll owe them" when present (recheck guards that its figure matches ours).
    const serverText = typeof action.preview.my_share_text === 'string' && action.preview.my_share_text ? action.preview.my_share_text : null
    const payerIsUser = typeof action.preview.payer_is_user === 'boolean' ? action.preview.payer_is_user : params.paid_by === live.userId
    if (!payerIsUser) {
      warnings.push(mine ? `Paid by ${payer} — you'll owe them ${serverText ?? money(mine.amount_minor, params.currency)}` : `Paid by ${payer} — you're not in this split, so you won't owe them anything.`)
    }
    const dateWarning = dayWarning(params.payment_date, now)
    if (dateWarning) warnings.push(dateWarning)
    const sum = shares.reduce((a, s) => a + s.minor, 0)
    const rows = [
      { label: 'What for', value: params.description.trim(), quoted: true, field: 'description' },
      { label: 'Amount', value: money(params.amount_minor, params.currency) },
      { label: 'Paid by', value: payer },
      { label: 'Split', value: params.split_mode === 'equal' ? 'Equally' : 'Exact amounts', lines: shares.map((s) => `${s.name} ${s.text}`) },
      { label: 'Total of shares', value: money(sum, params.currency) },
      { label: 'Date', value: formatDay(params.payment_date, now) },
      { label: 'Category', value: CATEGORY_LABEL[params.category] ?? 'Other' },
    ]
    const dup = isObj(action.preview.possible_duplicate)
    const notes = [...(dup ? ['This looks like one that is already added. Check the expenses before you confirm.'] : []), ...(params.currency !== live.baseCurrency ? [`Converted to ${live.baseCurrency} at the rate on ${formatDay(params.payment_date, now)} when you confirm.`] : [])]
    return {
      icon: '💷',
      title: 'Add an expense',
      rows,
      line: `Add expense "${params.description.trim()}" ${money(params.amount_minor, params.currency)}`,
      confirmLabel: 'Add expense',
      notes,
      warnings,
    }
  },

  recheck(action, live) {
    const params = p(action)
    if (live.frozen) return FROZEN_CARD_MESSAGE
    // Parity guard: the server's idea of my share must equal ours to the minor unit, else the card is stale.
    if ('my_share_minor' in action.preview) {
      const server = action.preview.my_share_minor
      const mine = params.splits.find((s) => s.user_id === live.userId)?.amount_minor ?? null
      if ((server ?? null) !== mine) return "These figures don't match what I worked out — ask again."
    }
    if (params.base_currency !== live.baseCurrency) return "The trip's currency changed since I suggested this, so the amounts would be converted wrongly. Ask again."
    for (const s of params.splits) {
      if (!personActive(live, s.user_id)) return `${personName(live, s.user_id)} is no longer on the trip.`
    }
    if (!personActive(live, params.paid_by)) return `${personName(live, params.paid_by)} is no longer on the trip.`
    return null
  },

  async execute(action, ctx) {
    const params = p(action)
    const { draft, amountMajor } = buildExpenseDraft(params, ctx.userId)
    const values: CreateExpenseFormValues = { draft, amountMajor, receiptUrl: null, baseCurrency: params.base_currency }
    const created = await ctx.deps.createExpenseWithSplits(ctx.tripId, values)
    ctx.logActivity({ verb: 'expense_added', entity: { type: 'expense', id: created.id, label: created.description }, metadata: { via: 'assistant', chat_action_id: action.id } })
    return { result: { expense_id: created.id }, doneText: 'Expense added.' }
  },

  invalidate(ctx) {
    void invalidateAfterCreateExpense(ctx.queryClient, ctx.tripId)
  },
}
