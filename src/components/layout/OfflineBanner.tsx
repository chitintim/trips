import { useEffect, useState } from 'react'
import { Offline } from '../ui/illustrations'

/**
 * Offline state (UX_REDESIGN.md Part 4 "Illustrations"): a small persistent
 * banner using the `Offline` illustration whenever the browser reports it
 * has lost connectivity. Mounted once in AppShell so every space gets it
 * for free. Deliberately simple — `navigator.onLine` + the standard
 * online/offline events, no service-worker plumbing (out of scope here).
 */
export function OfflineBanner() {
  const [isOffline, setIsOffline] = useState(() => typeof navigator !== 'undefined' && !navigator.onLine)

  useEffect(() => {
    const goOffline = () => setIsOffline(true)
    const goOnline = () => setIsOffline(false)
    window.addEventListener('offline', goOffline)
    window.addEventListener('online', goOnline)
    return () => {
      window.removeEventListener('offline', goOffline)
      window.removeEventListener('online', goOnline)
    }
  }, [])

  if (!isOffline) return null

  return (
    <div className="flex items-center gap-2 bg-warn-50 dark:bg-warn-950 border-b border-warn-200 dark:border-warn-800 px-4 py-2 text-sm text-warn-800 dark:text-warn-300">
      <Offline className="w-8 h-6 shrink-0 text-warn-600" />
      <span>You're offline — changes will sync once you're back online.</span>
    </div>
  )
}
