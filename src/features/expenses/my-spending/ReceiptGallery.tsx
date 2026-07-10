import { useEffect, useState } from 'react'
import { EmptyState } from '../../../components/ui'
import { getReceiptUrl } from '../../../lib/receiptUpload'
import { ReceiptLightbox } from '../components/ReceiptLightbox'
import type { ExpenseWithDetails } from '../../../lib/queries/useExpenses'

export interface ReceiptGalleryProps {
  expenses: ExpenseWithDetails[]
}

/** Receipt gallery with lightbox (plan §7/§10 #7), signed URLs via getReceiptUrl. */
export function ReceiptGallery({ expenses }: ReceiptGalleryProps) {
  const withReceipts = expenses.filter((e) => !!e.receipt_url)
  const [lightboxExpense, setLightboxExpense] = useState<ExpenseWithDetails | null>(null)

  if (withReceipts.length === 0) {
    return <EmptyState compact icon="🧾" title="No receipts uploaded yet" description="Receipts you attach to expenses show up here." />
  }

  return (
    <>
      <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
        {withReceipts.map((expense) => (
          <ReceiptThumbnail key={expense.id} expense={expense} onClick={() => setLightboxExpense(expense)} />
        ))}
      </div>

      {lightboxExpense && (
        <ReceiptLightbox
          path={lightboxExpense.receipt_url!}
          title={lightboxExpense.description}
          onClose={() => setLightboxExpense(null)}
        />
      )}
    </>
  )
}

function ReceiptThumbnail({ expense, onClick }: { expense: ExpenseWithDetails; onClick: () => void }) {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!expense.receipt_url) return
    let cancelled = false
    getReceiptUrl(expense.receipt_url)
      .then((u) => !cancelled && setUrl(u))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [expense.receipt_url])

  return (
    <button
      type="button"
      onClick={onClick}
      className="aspect-square rounded-[var(--radius-md)] overflow-hidden border border-[var(--border-subtle)] bg-[var(--surface-sunken)]"
    >
      {url ? (
        <img src={url} alt={expense.description} className="w-full h-full object-cover" />
      ) : (
        <div className="w-full h-full animate-pulse bg-[var(--surface-sunken)]" />
      )}
    </button>
  )
}

