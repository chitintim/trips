import { useState, type ReactNode } from 'react'

/** Progressive disclosure: everything past the minimum fields sits behind "More options". */
export function MoreOptions({ children, defaultOpen = false }: { children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="border-t border-[var(--border-subtle)] pt-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex min-h-[44px] w-full items-center justify-between text-sm font-medium text-[var(--text-secondary)]"
      >
        <span>More options</span>
        <span aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>
      {open && <div className="space-y-4 pt-2">{children}</div>}
    </div>
  )
}
