import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useAuth } from '../../hooks/useAuth'

interface Selection {
  id: string
  user_id: string
  selected_at?: string
  user?: {
    id: string
    full_name?: string
    email?: string
    avatar_data?: {
      emoji: string
      bgColor: string
      accessory?: string
    }
  }
}

interface Option {
  id: string
  title: string
  description?: string
  price?: number
  currency?: string
  status?: string
  locked?: boolean
  metadata?: {
    grid_row?: string
    grid_column?: string
    [key: string]: any
  }
  selections?: Selection[]
}

interface MatrixSelectorProps {
  options: Option[]
  rows: string[]
  columns: string[]
  currentUserId?: string
  onSelect: (optionId: string) => void
  disabled?: boolean
  showPrices?: boolean
  currency?: string
}

interface CellPopoverProps {
  option: Option
  position: { top: number; left: number }
  onClose: () => void
  onSelect: () => void
  isSelected: boolean
  disabled: boolean
}

function CellPopover({ option, position, onClose, onSelect, isSelected, disabled }: CellPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [onClose])

  // Adjust position to stay within viewport
  const adjustedPosition = { ...position }
  if (typeof window !== 'undefined') {
    const popoverWidth = 280
    const popoverHeight = 200
    if (position.left + popoverWidth > window.innerWidth - 16) {
      adjustedPosition.left = window.innerWidth - popoverWidth - 16
    }
    if (position.top + popoverHeight > window.innerHeight - 16) {
      adjustedPosition.top = position.top - popoverHeight - 8
    }
  }

  return createPortal(
    <div
      ref={popoverRef}
      className="fixed z-popover bg-white rounded-lg shadow-xl border border-gray-200 p-4 w-72"
      style={{ top: adjustedPosition.top, left: adjustedPosition.left }}
    >
      <div className="flex justify-between items-start mb-3">
        <h4 className="font-semibold text-gray-900 text-sm">{option.title}</h4>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-gray-600 p-1"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {option.description && (
        <p className="text-sm text-gray-600 mb-3">{option.description}</p>
      )}

      {option.price && (
        <p className="text-lg font-bold text-gray-900 mb-3">
          {option.currency || 'EUR'} {option.price.toFixed(2)}
        </p>
      )}

      {/* Who selected this */}
      {option.selections && option.selections.length > 0 && (
        <div className="mb-3">
          <p className="text-xs text-gray-500 mb-2">Selected by:</p>
          <div className="flex flex-wrap gap-1">
            {option.selections.map((sel) => (
              <span
                key={sel.id}
                className="inline-flex items-center gap-1 text-xs bg-gray-100 rounded-full px-2 py-1"
              >
                <span
                  className="w-4 h-4 rounded-full flex items-center justify-center text-[10px] overflow-hidden"
                  style={{ backgroundColor: sel.user?.avatar_data?.bgColor || '#0ea5e9' }}
                >
                  {sel.user?.avatar_data?.emoji || '😊'}
                </span>
                {sel.user?.full_name?.split(' ')[0] || 'Unknown'}
              </span>
            ))}
          </div>
        </div>
      )}

      <button
        onClick={onSelect}
        disabled={disabled || option.locked}
        className={`w-full py-2 px-4 rounded-lg text-sm font-medium transition-colors ${
          isSelected
            ? 'bg-sky-100 text-sky-700 border border-sky-300'
            : 'bg-sky-500 text-white hover:bg-sky-600'
        } ${(disabled || option.locked) ? 'opacity-50 cursor-not-allowed' : ''}`}
      >
        {option.locked ? '🔒 Locked' : isSelected ? '✓ Selected' : 'Select This'}
      </button>
    </div>,
    document.body
  )
}

export function MatrixSelector({
  options,
  rows,
  columns,
  currentUserId,
  onSelect,
  disabled = false,
  showPrices = true,
  currency = 'EUR',
}: MatrixSelectorProps) {
  const { user } = useAuth()
  const userId = currentUserId || user?.id
  const [activeCell, setActiveCell] = useState<{ option: Option; position: { top: number; left: number } } | null>(null)

  // Build a map of row+column -> option
  const optionMap = new Map<string, Option>()
  options.forEach((opt) => {
    const row = opt.metadata?.grid_row
    const col = opt.metadata?.grid_column
    if (row && col) {
      optionMap.set(`${row}|${col}`, opt)
    }
  })

  // Find which option the current user has selected
  const userSelectedOptionId = options.find((opt) =>
    opt.selections?.some((sel) => sel.user_id === userId)
  )?.id

  const handleCellClick = (option: Option, event: React.MouseEvent) => {
    const rect = (event.target as HTMLElement).getBoundingClientRect()
    setActiveCell({
      option,
      position: { top: rect.bottom + 8, left: rect.left },
    })
  }

  const handleSelect = (optionId: string) => {
    onSelect(optionId)
    setActiveCell(null)
  }

  // Mini avatar component
  const MiniAvatars = ({ selections }: { selections?: Selection[] }) => {
    if (!selections || selections.length === 0) return null

    const maxShow = 3
    const visible = selections.slice(0, maxShow)
    const overflow = selections.length - maxShow

    return (
      <div className="flex -space-x-1.5 mt-1">
        {visible.map((sel) => (
          <div
            key={sel.id}
            className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] ring-2 ring-white overflow-hidden"
            style={{ backgroundColor: sel.user?.avatar_data?.bgColor || '#0ea5e9' }}
            title={sel.user?.full_name || sel.user?.email || 'Unknown'}
          >
            {sel.user?.avatar_data?.emoji || '😊'}
          </div>
        ))}
        {overflow > 0 && (
          <div className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] bg-gray-200 text-gray-600 ring-2 ring-white font-medium">
            +{overflow}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="overflow-x-auto -mx-4 px-4">
      <table className="w-full min-w-[400px] border-collapse">
        <thead>
          <tr>
            <th className="text-left text-xs font-medium text-gray-500 uppercase tracking-wider p-2 bg-gray-50 rounded-tl-lg">
              Level
            </th>
            {columns.map((col, i) => (
              <th
                key={col}
                className={`text-center text-xs font-medium text-gray-500 uppercase tracking-wider p-2 bg-gray-50 ${
                  i === columns.length - 1 ? 'rounded-tr-lg' : ''
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
              <td className="text-sm font-medium text-gray-700 p-2 bg-gray-50 border-t border-gray-100">
                {row}
              </td>
              {columns.map((col) => {
                const option = optionMap.get(`${row}|${col}`)
                if (!option) {
                  return (
                    <td key={col} className="p-1 border-t border-gray-100">
                      <div className="text-center text-gray-400 text-xs p-2">-</div>
                    </td>
                  )
                }

                const isSelected = option.id === userSelectedOptionId
                const selectionCount = option.selections?.length || 0

                return (
                  <td key={col} className="p-1 border-t border-gray-100">
                    <button
                      onClick={(e) => handleCellClick(option, e)}
                      disabled={disabled}
                      className={`w-full p-2 rounded-lg text-center transition-all ${
                        isSelected
                          ? 'bg-sky-100 border-2 border-sky-500 shadow-sm'
                          : 'bg-white border border-gray-200 hover:border-sky-300 hover:bg-sky-50'
                      } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                    >
                      {showPrices && option.price && (
                        <div className={`text-sm font-semibold ${isSelected ? 'text-sky-700' : 'text-gray-900'}`}>
                          {currency} {option.price.toFixed(0)}
                        </div>
                      )}
                      {selectionCount > 0 && (
                        <div className="flex justify-center">
                          <MiniAvatars selections={option.selections} />
                        </div>
                      )}
                      {isSelected && (
                        <div className="text-[10px] text-sky-600 font-medium mt-1">✓ You</div>
                      )}
                    </button>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>

      {/* "Not Renting" option */}
      {options.find((opt) => opt.title.toLowerCase().includes('not renting') || opt.title.toLowerCase().includes('own equipment')) && (
        <div className="mt-3">
          {(() => {
            const notRentingOption = options.find(
              (opt) => opt.title.toLowerCase().includes('not renting') || opt.title.toLowerCase().includes('own equipment')
            )!
            const isSelected = notRentingOption.id === userSelectedOptionId
            return (
              <button
                onClick={(e) => handleCellClick(notRentingOption, e)}
                disabled={disabled}
                className={`w-full p-3 rounded-lg text-left transition-all flex items-center justify-between ${
                  isSelected
                    ? 'bg-gray-100 border-2 border-gray-400'
                    : 'bg-white border border-gray-200 hover:border-gray-300'
                } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
              >
                <span className="text-sm font-medium text-gray-700">
                  {notRentingOption.title}
                </span>
                <div className="flex items-center gap-2">
                  <MiniAvatars selections={notRentingOption.selections} />
                  {isSelected && (
                    <span className="text-xs text-gray-600 font-medium">✓ Selected</span>
                  )}
                </div>
              </button>
            )
          })()}
        </div>
      )}

      {/* Cell Popover */}
      {activeCell && (
        <CellPopover
          option={activeCell.option}
          position={activeCell.position}
          onClose={() => setActiveCell(null)}
          onSelect={() => handleSelect(activeCell.option.id)}
          isSelected={activeCell.option.id === userSelectedOptionId}
          disabled={disabled}
        />
      )}
    </div>
  )
}
