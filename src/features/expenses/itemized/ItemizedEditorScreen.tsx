import { useState } from 'react'
import { Button, Tabs } from '../../../components/ui'
import { toMinorUnits, fromMinorUnits } from '../../../lib/money'
import { distributeAdjustmentsAcrossLines } from '../lib/adjustmentDistribution'
import { LineItemEditor } from './LineItemEditor'
import { AdjustmentsPanel } from './AdjustmentsPanel'
import type { ItemizedDraft } from './itemizedState'

export interface ItemizedEditorScreenProps {
  initialDraft: ItemizedDraft
  onBack: () => void
  onSave: (params: {
    lineItems: Array<{
      name_original: string
      name_english: string | null
      quantity: number
      unit_price: number
      subtotal: number
      tax_amount: number
      service_amount: number
      line_discount_amount: number | null
      total_amount: number
    }>
    totalMajor: number
  }) => void | Promise<void>
  isSaving?: boolean
  /** True when a receipt WAS parsed but came back with zero line items -- the UI must say so rather than silently showing one blank row as if nothing had been attempted (Form & Flow Standard: no dead-empty states). */
  noItemsParsedNotice?: boolean
}

/**
 * Combines the line-item editor + adjustments review panel (plan §10 #3)
 * into one screen with tabs, and computes the final per-line totals
 * (subtotal + this line's proportional share of tax/service, matching
 * the money module's exact-sum guarantee) on save.
 */
export function ItemizedEditorScreen({ initialDraft, onBack, onSave, isSaving, noItemsParsedNotice }: ItemizedEditorScreenProps) {
  const [draft, setDraft] = useState<ItemizedDraft>(initialDraft)
  const [tab, setTab] = useState<'items' | 'adjustments'>('items')

  const handleSave = async () => {
    const itemSubtotalsMinor = draft.lineItems.map((l) => toMinorUnits(parseFloat(l.lineTotal) || 0, draft.currency))
    const shares = distributeAdjustmentsAcrossLines(itemSubtotalsMinor, draft.adjustments)

    const lineItems = draft.lineItems.map((l, i) => ({
      name_original: l.nameOriginal || `Item ${i + 1}`,
      name_english: l.nameEnglish || null,
      quantity: parseFloat(l.quantity) || 1,
      unit_price: parseFloat(l.unitPrice) || 0,
      subtotal: fromMinorUnits(itemSubtotalsMinor[i], draft.currency),
      tax_amount: fromMinorUnits(shares[i].taxShareMinor, draft.currency),
      service_amount: fromMinorUnits(shares[i].serviceShareMinor, draft.currency),
      line_discount_amount: shares[i].discountShareMinor > 0 ? fromMinorUnits(shares[i].discountShareMinor, draft.currency) : null,
      total_amount: fromMinorUnits(shares[i].totalWithAdjustmentsMinor, draft.currency),
    }))

    const totalMinor = shares.reduce((sum, s) => sum + s.totalWithAdjustmentsMinor, 0)
    await onSave({ lineItems, totalMajor: fromMinorUnits(totalMinor, draft.currency) })
  }

  return (
    <div className="space-y-4">
      {noItemsParsedNotice && (
        <div className="rounded-[var(--radius-md)] border border-warn-200 bg-warn-50 dark:bg-warn-900 dark:border-warn-800 px-3 py-2.5 text-sm text-warn-700 dark:text-warn-300">
          No line items were read from this receipt — add them manually below, or go back and re-scan.
        </div>
      )}
      <Tabs value={tab} onChange={(v) => setTab(v as 'items' | 'adjustments')}>
        <Tabs.List>
          <Tabs.Tab value="items">Line items</Tabs.Tab>
          <Tabs.Tab value="adjustments">Tax & service</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="items" className="pt-4">
          <LineItemEditor draft={draft} onChange={setDraft} />
        </Tabs.Panel>
        <Tabs.Panel value="adjustments" className="pt-4">
          <AdjustmentsPanel draft={draft} onChange={setDraft} />
        </Tabs.Panel>
      </Tabs>

      <div className="flex items-center gap-3 pt-2">
        <Button variant="secondary" onClick={onBack} disabled={isSaving}>
          Back
        </Button>
        <Button variant="primary" fullWidth onClick={handleSave} isLoading={isSaving}>
          Save & create claim link
        </Button>
      </div>
    </div>
  )
}
