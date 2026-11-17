import { useEffect, useState } from 'react'
import { APP_BUILD, createVersionWatcher, fetchDeployedBuild } from '../lib/appVersion'

/**
 * "A new version is available — Reload". Shown when the deployed build (version.json) differs from the one running.
 * Dismissible, but it comes back the next time a check (every 30 minutes, or on returning to the tab) still finds a newer build.
 * It never reloads by itself, so nothing typed into a form is lost; the Reload button is the person's choice, and a form with unsaved
 * changes still gets the browser's own "Leave site?" question.
 */
export function NewVersionBanner() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const watcher = createVersionWatcher({
      running: APP_BUILD,
      check: () => fetchDeployedBuild({ baseUrl: import.meta.env.BASE_URL }),
      onNewer: () => setVisible(true),
    })
    const onVisibility = () => {
      if (document.visibilityState === 'visible') watcher.onFocus()
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', watcher.onFocus)
    window.addEventListener('online', watcher.onFocus)
    watcher.start()
    void watcher.checkNow(true)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', watcher.onFocus)
      window.removeEventListener('online', watcher.onFocus)
      watcher.stop()
    }
  }, [])

  if (!visible) return null
  return (
    <div
      role="status"
      className="fixed top-2 left-4 right-4 md:left-auto md:right-4 md:w-96 z-toast flex items-center justify-between gap-2 rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--surface-raised)] pl-4 pr-1 text-sm text-[var(--text-primary)] shadow-lg"
    >
      <span>A new version is available.</span>
      <button type="button" onClick={() => window.location.reload()} className="min-h-11 rounded-[var(--radius-md)] px-3 font-semibold text-accent-700 dark:text-accent-400">
        Reload
      </button>
      <button type="button" onClick={() => setVisible(false)} aria-label="Dismiss" className="min-h-11 min-w-11 text-[var(--text-muted)]">
        ✕
      </button>
    </div>
  )
}
