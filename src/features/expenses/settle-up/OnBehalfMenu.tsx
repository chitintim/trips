import { useEffect, useRef, useState } from 'react'
import type { OnBehalfAction } from './settleOnBehalf'

interface OnBehalfMenuProps {
  /** "Alex → Sam", for the button's accessible name. */
  paymentLabel: string
  actions: OnBehalfAction[]
  disabled?: boolean
  onSelect: (action: OnBehalfAction) => void
}

/** A quiet "⋯" menu on a payment row: the organiser's "settle on their behalf" actions. */
export function OnBehalfMenu({ paymentLabel, actions, disabled, onSelect }: OnBehalfMenuProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (actions.length === 0) return null

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={`More actions for ${paymentLabel}`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className="h-9 w-9 inline-flex items-center justify-center rounded-[var(--radius-full)] text-[var(--text-muted)] hover:bg-[var(--surface-sunken)] disabled:opacity-50"
      >
        <span aria-hidden="true">⋯</span>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1 z-20 min-w-[14rem] rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-raised)] shadow-lg py-1"
        >
          {actions.map((a) => (
            <button
              key={a.kind}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                onSelect(a)
              }}
              className="block w-full text-left px-3 py-2.5 text-sm text-[var(--text-primary)] hover:bg-[var(--surface-sunken)]"
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
