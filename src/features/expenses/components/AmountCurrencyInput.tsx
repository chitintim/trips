import { useState, useRef, useEffect } from 'react'
import { Input } from '../../../components/ui'
import { FREQUENT_CURRENCIES, currencySymbol } from '../lib/formatMoney'
import { searchCurrencies } from '../lib/currencyList'

export interface AmountCurrencyInputProps {
  amount: string
  onAmountChange: (value: string) => void
  currency: string
  onCurrencyChange: (value: string) => void
  label?: string
  disabled?: boolean
  error?: string
  /** Fires on the amount field losing focus -- callers use this to flip a local "touched" flag so validation errors only appear after the user has actually interacted with the field, not on first render (audit finding #10). */
  onBlur?: () => void
}

/**
 * Amount + currency entry for the details step (plan §10): frequent
 * currencies pinned as quick-select chips, any ISO 4217 code searchable via
 * a small popover. Amount uses a plain text input (not `type=number`) so
 * partial/decimal typing isn't fought by the browser, validated numerically
 * at the point the wizard advances.
 */
export function AmountCurrencyInput({
  amount,
  onAmountChange,
  currency,
  onCurrencyChange,
  label = 'Amount',
  disabled,
  error,
  onBlur,
}: AmountCurrencyInputProps) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [query, setQuery] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!pickerOpen) return
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setPickerOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [pickerOpen])

  const results = searchCurrencies(query)

  return (
    <div ref={containerRef} className="relative">
      <Input
        label={label}
        inputMode="decimal"
        value={amount}
        onChange={(e) => onAmountChange(e.target.value)}
        onBlur={onBlur}
        placeholder="0.00"
        disabled={disabled}
        error={error}
        leftAddon={<span className="font-medium">{currencySymbol(currency)}</span>}
        rightAddon={
          <button
            type="button"
            onClick={() => setPickerOpen((o) => !o)}
            disabled={disabled}
            className="pointer-events-auto font-semibold text-accent-700 dark:text-accent-400 hover:text-accent-900 text-sm px-1.5 py-0.5 rounded-[var(--radius-sm)] hover:bg-accent-50 dark:hover:bg-accent-950"
          >
            {currency} ▾
          </button>
        }
      />

      {pickerOpen && (
        <div className="absolute z-dropdown mt-1 w-full max-w-xs bg-[var(--surface-raised)] border border-[var(--border-default)] rounded-[var(--radius-lg)] shadow-lg p-2">
          <input
            autoFocus
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search currency..."
            className="w-full h-9 px-3 mb-2 rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--surface-page)] text-sm focus:outline-none focus:ring-2 focus:ring-accent-500"
          />

          {!query && (
            <div className="flex flex-wrap gap-1.5 mb-2 pb-2 border-b border-[var(--border-subtle)]">
              {FREQUENT_CURRENCIES.map((code) => (
                <button
                  key={code}
                  type="button"
                  onClick={() => {
                    onCurrencyChange(code)
                    setPickerOpen(false)
                    setQuery('')
                  }}
                  className={`px-2.5 py-1 rounded-[var(--radius-full)] text-xs font-medium border transition-colors ${
                    code === currency
                      ? 'bg-accent-600 border-accent-600 text-white'
                      : 'bg-[var(--surface-sunken)] border-transparent text-[var(--text-secondary)] hover:bg-[var(--border-subtle)]'
                  }`}
                >
                  {code}
                </button>
              ))}
            </div>
          )}

          <div className="max-h-56 overflow-y-auto space-y-0.5">
            {results.map((c) => (
              <button
                key={c.code}
                type="button"
                onClick={() => {
                  onCurrencyChange(c.code)
                  setPickerOpen(false)
                  setQuery('')
                }}
                className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-[var(--radius-sm)] text-sm text-left transition-colors ${
                  c.code === currency ? 'bg-accent-50 text-accent-700 dark:bg-accent-950 dark:text-accent-300' : 'hover:bg-[var(--surface-sunken)]'
                }`}
              >
                <span className="font-medium">{c.code}</span>
                <span className="text-[var(--text-muted)] text-xs truncate ml-2">{c.name}</span>
              </button>
            ))}
            {results.length === 0 && (
              <p className="text-xs text-[var(--text-muted)] px-2.5 py-2">No matching currency</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
