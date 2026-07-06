import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import type { FaqEntry } from '../lib/autoFaq'

interface FaqAccordionProps {
  entries: FaqEntry[]
}

export function FaqAccordion({ entries }: FaqAccordionProps) {
  const [openId, setOpenId] = useState<string | null>(entries[0]?.id ?? null)

  return (
    <div className="divide-y divide-[var(--border-subtle)]">
      {entries.map((entry) => {
        const isOpen = openId === entry.id
        return (
          <div key={entry.id}>
            <button
              type="button"
              onClick={() => setOpenId(isOpen ? null : entry.id)}
              className="w-full flex items-center justify-between gap-3 py-3 text-left"
              aria-expanded={isOpen}
            >
              <span className="font-medium text-[var(--text-primary)]">{entry.question}</span>
              <span className={`text-[var(--text-muted)] transition-transform ${isOpen ? 'rotate-180' : ''}`} aria-hidden="true">
                ▾
              </span>
            </button>
            {isOpen && (
              <div className="pb-3 text-sm text-[var(--text-secondary)] prose prose-sm max-w-none">
                <ReactMarkdown remarkPlugins={[remarkBreaks]}>{entry.answer}</ReactMarkdown>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
