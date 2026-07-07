import { Button, Input, Select, Badge, SelectionAvatars } from '../../../components/ui'
import { readOptionPricing, resolveVariantPricing, computeOrderItemTotal } from '../../decisions/lib/decisionShapes'
import { formatMoney } from '../../decisions/lib/costImpact'
import type { SectionWithOptions } from '../../../lib/queries/usePlanning'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'
import type { UseOrderFormResult } from '../lib/useOrderForm'

export interface OrderFormFieldsProps {
  section: SectionWithOptions
  participants: ParticipantWithUser[]
  form: UseOrderFormResult
}

/**
 * The catalog item rows + live total for a personal order (UX_REDESIGN.md
 * Part 5, shape 2) — pure presentation over `useOrderForm`'s state, shared
 * between the standalone OrderFormSheet (Modal-wrapped, opened from the
 * Plan tray) and the AnswerFlow stepper's inline personal-order step (no
 * Modal — it's already inside the stepper's own full-screen sheet).
 */
export function OrderFormFields({ section, participants, form }: OrderFormFieldsProps) {
  const { values, updateRow, totalsByCurrency, respondedUsers, fallbackCurrency } = form

  const respondedWithNames = respondedUsers.map((r) => ({
    id: r.id,
    user: participants.find((p) => p.user_id === r.id)?.user ?? undefined,
  }))

  return (
    <div className="space-y-4">
      {respondedWithNames.length > 0 && (
        <div className="flex items-center gap-2">
          <SelectionAvatars
            selections={respondedWithNames.map((r) => ({
              id: r.id,
              user: r.user
                ? {
                    full_name: r.user.full_name ?? undefined,
                    email: r.user.email ?? undefined,
                    avatar_url: r.user.avatar_url ?? undefined,
                    avatar_data: (r.user.avatar_data as { emoji: string; bgColor: string } | null) ?? undefined,
                  }
                : undefined,
            }))}
            maxAvatars={5}
            size="sm"
          />
          <span className="text-xs text-[var(--text-muted)]">
            {respondedWithNames.length} of {participants.length || respondedWithNames.length} ordered
          </span>
        </div>
      )}

      <div className="space-y-3">
        {section.options.map((option) => {
          const row = values[option.id]
          if (!row) return null
          const pricing = readOptionPricing(option.metadata)
          const currency = option.currency || fallbackCurrency
          const rate = pricing ? resolveVariantPricing(pricing, row.variant || undefined) : {}
          const rowTotal = pricing
            ? computeOrderItemTotal(pricing, { start_date: row.startDate, end_date: row.endDate, variant: row.variant || undefined, quantity: row.quantity }, currency)
            : 0

          return (
            <div key={option.id} className="rounded-[var(--radius-lg)] border border-[var(--border-default)] p-3 space-y-3">
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={row.checked}
                  onChange={(e) => updateRow(option.id, { checked: e.target.checked })}
                  className="mt-0.5 w-5 h-5 accent-accent-600"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-[var(--text-primary)]">{option.title}</span>
                    {rate.per_day != null && (
                      <Badge variant="neutral" size="sm">
                        {formatMoney(rate.per_day, currency)}/day
                      </Badge>
                    )}
                    {rate.flat != null && (
                      <Badge variant="neutral" size="sm">
                        {formatMoney(rate.flat, currency)} flat
                      </Badge>
                    )}
                  </div>
                  {option.description && <p className="text-xs text-[var(--text-secondary)] mt-0.5">{option.description}</p>}
                </div>
              </label>

              {row.checked && (
                <div className="pl-8 space-y-3">
                  {(pricing?.variants?.length ?? 0) > 0 && (
                    <Select
                      label="Variant"
                      value={row.variant}
                      onChange={(e) => updateRow(option.id, { variant: e.target.value })}
                      options={[{ value: '', label: 'Standard' }, ...pricing!.variants!.map((v) => ({ value: v.label, label: v.label }))]}
                    />
                  )}

                  {rate.per_day != null && rate.flat == null && (
                    <div className="grid grid-cols-2 gap-3">
                      <Input label="From" type="date" value={row.startDate} onChange={(e) => updateRow(option.id, { startDate: e.target.value })} />
                      <Input label="To" type="date" value={row.endDate} onChange={(e) => updateRow(option.id, { endDate: e.target.value })} />
                    </div>
                  )}

                  <div className="flex items-center gap-3">
                    <span className="text-sm text-[var(--text-secondary)]">Quantity</span>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => updateRow(option.id, { quantity: Math.max(1, row.quantity - 1) })}
                        disabled={row.quantity <= 1}
                      >
                        −
                      </Button>
                      <span className="w-6 text-center text-sm font-medium text-[var(--text-primary)]">{row.quantity}</span>
                      <Button variant="outline" size="sm" onClick={() => updateRow(option.id, { quantity: row.quantity + 1 })}>
                        +
                      </Button>
                    </div>
                    <span className="ml-auto text-sm font-semibold text-[var(--text-primary)]">{formatMoney(rowTotal, currency)}</span>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="rounded-[var(--radius-lg)] bg-[var(--surface-sunken)] p-3 flex items-center justify-between">
        <span className="text-sm font-medium text-[var(--text-primary)]">Your total</span>
        <span className="text-lg font-semibold text-[var(--text-primary)]">
          {Object.keys(totalsByCurrency).length === 0
            ? formatMoney(0, fallbackCurrency)
            : Object.entries(totalsByCurrency)
                .map(([currency, amount]) => formatMoney(amount, currency))
                .join(' + ')}
        </span>
      </div>
    </div>
  )
}
