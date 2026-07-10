import { useState } from 'react'
import { Button, Tabs } from '../../../components/ui'
import { toMinorUnits, fromMinorUnits } from '../../../lib/money'
import { useFormDraft } from '../../../lib/forms'
import { distributeAdjustmentsAcrossLines } from '../lib/adjustmentDistribution'
import { ReceiptLightbox } from '../components/ReceiptLightbox'
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
  }) => Promise<boolean>
  isSaving?: boolean
  /** True when a receipt WAS parsed but came back with zero line items -- the UI must say so rather than silently showing one blank row as if nothing had been attempted (Form & Flow Standard: no dead-empty states). */
  noItemsParsedNotice?: boolean
  /**
   * Bridges edits made in here up to the parent wizard's own `isDirty`
   * (audit finding #3a) -- without this, itemizing a receipt and then
   * backing out or closing the modal never triggered the unsaved-changes
   * guard because the wizard had no idea this screen's local draft state
   * had changed.
   */
  onDirty?: () => void
  /**
   * sessionStorage draft-persistence key + enable flag, mirroring the outer
   * wizard's useFormDraft usage (audit finding #3c) -- disabled in edit mode
   * so re-editing an already-itemized expense always seeds from the saved
   * line items, never a stale autosave (Form & Flow Standard point 2).
   */
  draftKey: string
  draftEnabled?: boolean
  /** Storage path of the source receipt, if any -- lets the user double-check ambiguous fields against the original image without leaving this screen (audit finding #3d). */
  receiptPath?: string | null
}

/**
 * Combines the line-item editor + adjustments review panel (plan §10 #3)
 * into one screen with tabs, and computes the final per-line totals
 * (subtotal + this line's proportional share of tax/service, matching
 * the money module's exact-sum guarantee) on save.
 */
export function ItemizedEditorScreen({
  initialDraft,
  onBack,
  onSave,
  isSaving,
  noItemsParsedNotice,
  onDirty,
  draftKey,
  draftEnabled = true,
  receiptPath,
}: ItemizedEditorScreenProps) {
  const { values: draft, setValues: setDraft, clearDraft } = useFormDraft<ItemizedDraft>(draftKey, initialDraft, { enabled: draftEnabled })
  const [tab, setTab] = useState<'items' | 'adjustments'>('items')
  const [showReceiptLightbox, setShowReceiptLightbox] = useState(false)

  const handleDraftChange = (next: ItemizedDraft) => {
    setDraft(next)
    onDirty?.()
  }

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
    // onSave reports success/failure explicitly (rather than throwing) so
    // the draft is only cleared once the save actually lands -- a failed
    // save must leave the in-progress itemization intact (audit #3c).
    const ok = await onSave({ lineItems, totalMajor: fromMinorUnits(totalMinor, draft.currency) })
    if (ok) clearDraft()
  }

  return (
    <div className="space-y-4">
      {noItemsParsedNotice && (
        <div className="rounded-[var(--radius-md)] border border-warn-200 bg-warn-50 dark:bg-warn-900 dark:border-warn-800 px-3 py-2.5 text-sm text-warn-700 dark:text-warn-300">
          ⚠️ No line items were read from this receipt — add them manually below, or go back and re-scan.
        </div>
      )}

      {receiptPath && (
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={() => setShowReceiptLightbox(true)}>
            📄 View receipt
          </Button>
        </div>
      )}

      <Tabs value={tab} onChange={(v) => setTab(v as 'items' | 'adjustments')}>
        <Tabs.List>
          <Tabs.Tab value="items">Line items</Tabs.Tab>
          <Tabs.Tab value="adjustments">Tax & service</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="items" className="pt-4">
          <LineItemEditor draft={draft} onChange={handleDraftChange} />
        </Tabs.Panel>
        <Tabs.Panel value="adjustments" className="pt-4">
          <AdjustmentsPanel draft={draft} onChange={handleDraftChange} />
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

      {showReceiptLightbox && receiptPath && (
        <ReceiptLightbox path={receiptPath} title="Receipt" onClose={() => setShowReceiptLightbox(false)} />
      )}
    </div>
  )
}
