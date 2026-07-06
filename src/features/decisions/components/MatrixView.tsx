import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useRef, useEffect } from 'react'
import { useAuth } from '../../../hooks/useAuth'
import { SelectionAvatars } from '../../../components/ui'
import { useToggleSelection } from '../../../lib/queries/usePlanning'
import type { OptionWithSelections } from '../../../lib/queries/usePlanning'
import { readOptionMetadata, getMatrixAxes } from '../lib/optionMetadata'

interface MatrixViewProps {
  tripId: string
  options: OptionWithSelections[]
  currency?: string
}

/**
 * Matrix/grid view for tiered options (the ski-rental-matrix pattern from
 * PLANNING_IMPROVEMENTS.md), rebuilt onto the new ui kit. Cells use
 * `selections` (the committed choice, one per person) rather than votes —
 * matrix options represent "what you're actually renting/taking", not a
 * poll.
 */
export function MatrixView({ tripId, options, currency = 'GBP' }: MatrixViewProps) {
  const { user } = useAuth()
  const toggleSelection = useToggleSelection(tripId)
  const [activeCell, setActiveCell] = useState<{ option: OptionWithSelections; anchor: DOMRect } | null>(null)

  const { rows, columns } = getMatrixAxes(options)
  const cellMap = new Map<string, OptionWithSelections>()
  options.forEach((opt) => {
    const meta = readOptionMetadata(opt.metadata)
    if (meta.grid_row && meta.grid_column) cellMap.set(`${meta.grid_row}|${meta.grid_column}`, opt)
  })

  const mySelectedOptionId = options.find((opt) => opt.selections.some((s) => s.user_id === user?.id))?.id
  const notRentingOption = options.find(
    (opt) => opt.title.toLowerCase().includes('not renting') || opt.title.toLowerCase().includes('own equipment')
  )

  const handleSelect = (option: OptionWithSelections) => {
    if (!user) return
    const existing = option.selections.find((s) => s.user_id === user.id)
    if (existing) {
      toggleSelection.mutate({ optionId: option.id, userId: user.id, action: 'remove', selectionId: existing.id })
    } else {
      toggleSelection.mutate({ optionId: option.id, userId: user.id, action: 'add', user: undefined })
    }
    setActiveCell(null)
  }

  return (
    <div className="overflow-x-auto -mx-4 px-4">
      <table className="w-full min-w-[400px] border-collapse">
        <thead>
          <tr>
            <th className="text-left text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide p-2 bg-[var(--surface-sunken)] rounded-tl-[var(--radius-md)]">
              Level
            </th>
            {columns.map((col, i) => (
              <th
                key={col}
                className={`text-center text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide p-2 bg-[var(--surface-sunken)] ${
                  i === columns.length - 1 ? 'rounded-tr-[var(--radius-md)]' : ''
                }`}
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row}>
              <td className="text-sm font-medium text-[var(--text-primary)] p-2 bg-[var(--surface-sunken)] border-t border-[var(--border-subtle)]">
                {row}
              </td>
              {columns.map((col) => {
                const option = cellMap.get(`${row}|${col}`)
                if (!option) {
                  return (
                    <td key={col} className="p-1 border-t border-[var(--border-subtle)]">
                      <div className="text-center text-[var(--text-muted)] text-xs p-2">—</div>
                    </td>
                  )
                }
                const isSelected = option.id === mySelectedOptionId
                return (
                  <td key={col} className="p-1 border-t border-[var(--border-subtle)]">
                    <button
                      type="button"
                      onClick={(e) => setActiveCell({ option, anchor: (e.target as HTMLElement).getBoundingClientRect() })}
                      className={`w-full p-2 rounded-[var(--radius-md)] text-center transition-all ${
                        isSelected
                          ? 'bg-accent-50 border-2 border-accent-500 shadow-sm'
                          : 'bg-[var(--surface-raised)] border border-[var(--border-default)] hover:border-accent-300'
                      }`}
                    >
                      {option.price != null && (
                        <div className={`text-sm font-semibold ${isSelected ? 'text-accent-700' : 'text-[var(--text-primary)]'}`}>
                          {currency} {option.price.toFixed(0)}
                        </div>
                      )}
                      {option.selections.length > 0 && (
                        <div className="flex justify-center mt-1">
                          <SelectionAvatars
                            selections={option.selections.map((s) => ({
                              id: s.id,
                              user: s.user
                                ? {
                                    full_name: s.user.full_name ?? undefined,
                                    email: s.user.email ?? undefined,
                                    avatar_data: (s.user.avatar_data as { emoji: string; bgColor: string } | null) ?? undefined,
                                  }
                                : undefined,
                            }))}
                            maxAvatars={3}
                            size="sm"
                          />
                        </div>
                      )}
                      {isSelected && <div className="text-[10px] text-accent-600 font-medium mt-1">✓ You</div>}
                    </button>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>

      {notRentingOption && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => handleSelect(notRentingOption)}
            className={`w-full p-3 rounded-[var(--radius-md)] text-left flex items-center justify-between transition-all ${
              notRentingOption.id === mySelectedOptionId
                ? 'bg-[var(--surface-sunken)] border-2 border-[var(--border-default)]'
                : 'bg-[var(--surface-raised)] border border-[var(--border-default)] hover:border-[var(--border-subtle)]'
            }`}
          >
            <span className="text-sm font-medium text-[var(--text-primary)]">{notRentingOption.title}</span>
            {notRentingOption.id === mySelectedOptionId && (
              <span className="text-xs text-[var(--text-secondary)] font-medium">✓ Selected</span>
            )}
          </button>
        </div>
      )}

      {activeCell && (
        <CellPopover
          option={activeCell.option}
          anchor={activeCell.anchor}
          onClose={() => setActiveCell(null)}
          onSelect={() => handleSelect(activeCell.option)}
          isSelected={activeCell.option.id === mySelectedOptionId}
          currency={currency}
        />
      )}
    </div>
  )
}

function CellPopover({
  option,
  anchor,
  onClose,
  onSelect,
  isSelected,
  currency,
}: {
  option: OptionWithSelections
  anchor: DOMRect
  onClose: () => void
  onSelect: () => void
  isSelected: boolean
  currency: string
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [onClose])

  const top = Math.min(anchor.bottom + 8, window.innerHeight - 220)
  const left = Math.min(anchor.left, window.innerWidth - 296)

  return createPortal(
    <div
      ref={ref}
      className="fixed z-popover bg-[var(--surface-raised)] rounded-[var(--radius-md)] shadow-xl border border-[var(--border-default)] p-4 w-72"
      style={{ top, left }}
    >
      <h4 className="font-semibold text-[var(--text-primary)] text-sm mb-2">{option.title}</h4>
      {option.description && <p className="text-sm text-[var(--text-secondary)] mb-2">{option.description}</p>}
      {option.price != null && (
        <p className="text-lg font-bold text-[var(--text-primary)] mb-3">
          {option.currency || currency} {option.price.toFixed(2)}
        </p>
      )}
      <button
        type="button"
        onClick={onSelect}
        disabled={option.locked}
        className={`w-full py-2 px-4 rounded-[var(--radius-md)] text-sm font-medium transition-colors ${
          isSelected ? 'bg-accent-100 text-accent-700 border border-accent-300' : 'bg-accent-600 text-white hover:bg-accent-700'
        } ${option.locked ? 'opacity-50 cursor-not-allowed' : ''}`}
      >
        {option.locked ? '🔒 Locked' : isSelected ? '✓ Selected' : 'Select this'}
      </button>
    </div>,
    document.body
  )
}
