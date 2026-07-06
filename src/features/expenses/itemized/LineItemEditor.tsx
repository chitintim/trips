import { Input, Button, Badge } from '../../../components/ui'
import { toMinorUnits } from '../../../lib/money'
import { formatMoneyMinor } from '../lib/formatMoney'
import { addLineItem, removeLineItem, type ItemizedDraft } from './itemizedState'

export interface LineItemEditorProps {
  draft: ItemizedDraft
  onChange: (next: ItemizedDraft) => void
}

/**
 * Line-item editor (plan §10 #3): qty/unit/total with printed_field
 * awareness -- a small badge flags which field was actually printed on the
 * receipt (or "ambiguous", prompting the user to double check) so quantity
 * vs unit-price vs line-total disagreements are visible, not silently
 * papered over.
 */
export function LineItemEditor({ draft, onChange }: LineItemEditorProps) {
  const updateLine = (lineNumber: number, patch: Partial<ItemizedDraft['lineItems'][number]>) => {
    onChange({
      ...draft,
      lineItems: draft.lineItems.map((l) => (l.lineNumber === lineNumber ? { ...l, ...patch } : l)),
    })
  }

  const itemsTotalMinor = draft.lineItems.reduce((sum, l) => {
    const parsed = parseFloat(l.lineTotal) || 0
    return sum + toMinorUnits(parsed, draft.currency)
  }, 0)

  return (
    <div className="space-y-3">
      {draft.lineItems.map((line) => (
        <div key={line.lineNumber} className="border border-[var(--border-subtle)] rounded-[var(--radius-md)] p-3 space-y-2">
          <div className="flex items-start gap-2">
            <Input
              value={line.nameOriginal}
              onChange={(e) => updateLine(line.lineNumber, { nameOriginal: e.target.value })}
              placeholder="Item name"
              size="sm"
              className="flex-1"
            />
            <button
              type="button"
              onClick={() => onChange(removeLineItem(draft, line.lineNumber))}
              className="p-2 text-[var(--text-muted)] hover:text-danger-600 shrink-0"
              aria-label="Remove line item"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {line.nameEnglish !== undefined && line.nameOriginal !== line.nameEnglish && (
            <Input
              value={line.nameEnglish}
              onChange={(e) => updateLine(line.lineNumber, { nameEnglish: e.target.value })}
              placeholder="English translation (optional)"
              size="sm"
            />
          )}

          <div className="grid grid-cols-3 gap-2 items-end">
            <Input
              label="Qty"
              size="sm"
              inputMode="decimal"
              value={line.quantity}
              onChange={(e) => updateLine(line.lineNumber, { quantity: e.target.value })}
            />
            <Input
              label="Unit price"
              size="sm"
              inputMode="decimal"
              value={line.unitPrice}
              onChange={(e) => updateLine(line.lineNumber, { unitPrice: e.target.value })}
              success={line.printedField === 'unit_price' || line.printedField === 'both'}
            />
            <Input
              label="Line total"
              size="sm"
              inputMode="decimal"
              value={line.lineTotal}
              onChange={(e) => updateLine(line.lineNumber, { lineTotal: e.target.value })}
              success={line.printedField === 'line_total' || line.printedField === 'both'}
            />
          </div>

          {line.printedField === 'ambiguous' && (
            <Badge variant="warning" size="sm">⚠️ Unclear which field was printed — please check</Badge>
          )}
        </div>
      ))}

      <Button variant="secondary" size="sm" onClick={() => onChange(addLineItem(draft))} leftIcon={<span>+</span>}>
        Add item
      </Button>

      <p className="text-sm text-[var(--text-muted)] text-right">
        Items subtotal: <span className="font-medium text-[var(--text-primary)]">{formatMoneyMinor(itemsTotalMinor, draft.currency)}</span>
      </p>
    </div>
  )
}
