import { useState, useEffect } from 'react'
import { getReceiptUrl } from '../lib/receiptUpload'

export function ReceiptDisplay({ receiptPath }: { receiptPath: string }) {
  const [receiptUrl, setReceiptUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lightboxOpen, setLightboxOpen] = useState(false)

  useEffect(() => {
    const fetchReceiptUrl = async () => {
      try {
        setLoading(true)
        const url = await getReceiptUrl(receiptPath)
        setReceiptUrl(url)
        setError(null)
      } catch (err: any) {
        console.error('Error fetching receipt URL:', err)
        setError(err.message || 'Failed to load receipt')
      } finally {
        setLoading(false)
      }
    }

    fetchReceiptUrl()
  }, [receiptPath])

  // Close lightbox on escape
  useEffect(() => {
    if (!lightboxOpen) return
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightboxOpen(false)
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [lightboxOpen])

  // Lock scroll when lightbox open
  useEffect(() => {
    if (lightboxOpen) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => { document.body.style.overflow = '' }
  }, [lightboxOpen])

  if (loading) {
    return (
      <div className="mt-3">
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          Loading receipt...
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="mt-3">
        <div className="flex items-center gap-2 px-3 py-2 bg-red-50 rounded-lg border border-red-200">
          <span className="text-sm">🧾</span>
          <p className="text-sm text-red-600">{error}</p>
        </div>
      </div>
    )
  }

  return (
    <>
      {/* Thumbnail */}
      <div className="mt-3">
        <button
          onClick={(e) => {
            e.stopPropagation()
            setLightboxOpen(true)
          }}
          className="group flex items-center gap-3 w-full p-2 rounded-lg border border-gray-200 hover:border-sky-400 hover:bg-sky-50 transition-all text-left"
        >
          <div className="flex-shrink-0 w-16 h-16 rounded-md overflow-hidden bg-gray-100 border border-gray-200">
            <img
              src={receiptUrl || ''}
              alt="Receipt thumbnail"
              className="w-full h-full object-cover"
              onError={(e) => {
                e.currentTarget.style.display = 'none'
              }}
            />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-gray-700 group-hover:text-sky-700 flex items-center gap-1.5">
              🧾 View Receipt
              <svg className="w-3.5 h-3.5 text-gray-400 group-hover:text-sky-500 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v3m0 0v3m0-3h3m-3 0H7" />
              </svg>
            </div>
            <p className="text-xs text-gray-500 mt-0.5">Tap to view full size</p>
          </div>
        </button>
      </div>

      {/* Lightbox overlay */}
      {lightboxOpen && (
        <div
          className="fixed inset-0 z-[9999] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setLightboxOpen(false)}
        >
          {/* Close button */}
          <button
            onClick={() => setLightboxOpen(false)}
            className="absolute top-4 right-4 z-10 w-10 h-10 flex items-center justify-center rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors"
            aria-label="Close"
          >
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>

          {/* Open in new tab button */}
          <a
            href={receiptUrl || '#'}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="absolute top-4 left-4 z-10 flex items-center gap-2 px-3 py-2 rounded-full bg-black/50 text-white text-sm hover:bg-black/70 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
            Open
          </a>

          {/* Full-size image */}
          <img
            src={receiptUrl || ''}
            alt="Receipt"
            className="max-w-full max-h-[90vh] object-contain rounded-lg shadow-2xl"
            onClick={(e) => e.stopPropagation()}
            onError={(e) => {
              e.currentTarget.style.display = 'none'
            }}
          />
        </div>
      )}
    </>
  )
}
