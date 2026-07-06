import { useEffect, useState } from 'react'
import { Modal } from '../../../components/ui'
import { getReceiptUrl } from '../../../lib/receiptUpload'
import type { ExpenseWithDetails } from '../../../lib/queries/useExpenses'

export interface ReceiptGalleryProps {
  expenses: ExpenseWithDetails[]
}

/** Receipt gallery with lightbox (plan §7/§10 #7), signed URLs via getReceiptUrl. */
export function ReceiptGallery({ expenses }: ReceiptGalleryProps) {
  const withReceipts = expenses.filter((e) => !!e.receipt_url)
  const [lightboxExpense, setLightboxExpense] = useState<ExpenseWithDetails | null>(null)

  if (withReceipts.length === 0) {
    return <p className="text-sm text-[var(--text-muted)] py-4 text-center">No receipts uploaded yet</p>
  }

  return (
    <>
      <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
        {withReceipts.map((expense) => (
          <ReceiptThumbnail key={expense.id} expense={expense} onClick={() => setLightboxExpense(expense)} />
        ))}
      </div>

      {lightboxExpense && <ReceiptLightbox expense={lightboxExpense} onClose={() => setLightboxExpense(null)} />}
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

function ReceiptLightbox({ expense, onClose }: { expense: ExpenseWithDetails; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!expense.receipt_url) return
    getReceiptUrl(expense.receipt_url).then(setUrl).catch(() => {})
  }, [expense.receipt_url])

  return (
    <Modal isOpen onClose={onClose} title={expense.description} size="lg">
      {url ? (
        <img src={url} alt={expense.description} className="w-full h-auto rounded-[var(--radius-md)]" />
      ) : (
        <div className="aspect-square animate-pulse bg-[var(--surface-sunken)] rounded-[var(--radius-md)]" />
      )}
    </Modal>
  )
}
