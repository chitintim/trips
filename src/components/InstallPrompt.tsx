import { useEffect, useState } from 'react'
import { Modal } from './ui/Modal'
import { Button } from './ui/Button'

// ============================================================================
// TYPES
// ============================================================================

/**
 * Minimal typing for the non-standard `beforeinstallprompt` event
 * (not yet in lib.dom.d.ts).
 */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

function isIos(): boolean {
  if (typeof navigator === 'undefined') return false
  return /iphone|ipad|ipod/i.test(navigator.userAgent)
}

function isInStandaloneMode(): boolean {
  if (typeof window === 'undefined') return false
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  )
}

const DISMISSED_KEY = 'trips:install-prompt-dismissed'

// ============================================================================
// COMPONENT
// ============================================================================

/**
 * Install prompt: shows a small floating banner. On Android/Chrome it
 * triggers the native `beforeinstallprompt` flow; on iOS Safari (which has
 * no such API) it opens a sheet with manual "Add to Home Screen"
 * instructions. Renders nothing if already installed or previously
 * dismissed this session.
 */
export function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [showIosSheet, setShowIosSheet] = useState(false)
  const [dismissed, setDismissed] = useState(() => {
    if (typeof window === 'undefined') return false
    return sessionStorage.getItem(DISMISSED_KEY) === '1'
  })

  useEffect(() => {
    if (isInStandaloneMode()) return

    const handler = (e: Event) => {
      e.preventDefault()
      setDeferredPrompt(e as BeforeInstallPromptEvent)
    }

    window.addEventListener('beforeinstallprompt', handler)
    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [])

  if (isInStandaloneMode() || dismissed) return null

  const showIosBanner = isIos() && !deferredPrompt
  if (!deferredPrompt && !showIosBanner) return null

  const dismiss = () => {
    setDismissed(true)
    sessionStorage.setItem(DISMISSED_KEY, '1')
  }

  const handleInstallClick = async () => {
    if (deferredPrompt) {
      await deferredPrompt.prompt()
      await deferredPrompt.userChoice
      setDeferredPrompt(null)
      dismiss()
      return
    }
    if (showIosBanner) {
      setShowIosSheet(true)
    }
  }

  return (
    <>
      <div className="fixed bottom-20 md:bottom-4 left-4 right-4 md:left-auto md:right-4 md:w-80 z-toast">
        <div className="flex items-center gap-3 rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--surface-raised)] shadow-lg p-3.5">
          <div className="w-10 h-10 rounded-[var(--radius-md)] bg-accent-600 text-white flex items-center justify-center shrink-0 font-semibold">
            T
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-[var(--text-primary)]">Install Trips</p>
            <p className="text-xs text-[var(--text-secondary)]">Add to your home screen for quick access</p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <Button size="sm" variant="ghost" onClick={dismiss} aria-label="Dismiss">
              Later
            </Button>
            <Button size="sm" variant="primary" onClick={handleInstallClick}>
              Install
            </Button>
          </div>
        </div>
      </div>

      <Modal
        isOpen={showIosSheet}
        onClose={() => setShowIosSheet(false)}
        title="Add Trips to your Home Screen"
        size="sm"
      >
        <ol className="space-y-4 text-sm text-[var(--text-secondary)]">
          <li className="flex gap-3">
            <span className="shrink-0 w-6 h-6 rounded-full bg-accent-100 text-accent-700 dark:bg-accent-900 dark:text-accent-300 flex items-center justify-center text-xs font-semibold">1</span>
            <span>
              Tap the <strong className="text-[var(--text-primary)]">Share</strong> button in Safari's toolbar
              (the square with an arrow pointing up).
            </span>
          </li>
          <li className="flex gap-3">
            <span className="shrink-0 w-6 h-6 rounded-full bg-accent-100 text-accent-700 dark:bg-accent-900 dark:text-accent-300 flex items-center justify-center text-xs font-semibold">2</span>
            <span>
              Scroll down and tap <strong className="text-[var(--text-primary)]">Add to Home Screen</strong>.
            </span>
          </li>
          <li className="flex gap-3">
            <span className="shrink-0 w-6 h-6 rounded-full bg-accent-100 text-accent-700 dark:bg-accent-900 dark:text-accent-300 flex items-center justify-center text-xs font-semibold">3</span>
            <span>
              Tap <strong className="text-[var(--text-primary)]">Add</strong> in the top-right corner. Trips will
              appear on your home screen like a native app.
            </span>
          </li>
        </ol>
        <div className="mt-6 flex justify-end">
          <Button variant="primary" onClick={() => { setShowIosSheet(false); dismiss() }}>
            Got it
          </Button>
        </div>
      </Modal>
    </>
  )
}

InstallPrompt.displayName = 'InstallPrompt'
