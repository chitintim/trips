import { useEffect } from 'react'

const APP_NAME = "Tim's Trip Planner"

/**
 * Sets document.title for the lifetime of the calling page. Pass a trip (or
 * other page-specific) name to get "<name> · Tim's Trip Planner"; omit it
 * (or pass a falsy value while data is still loading) to fall back to the
 * plain app name. Resets to the plain app name on unmount so navigating
 * away from a trip doesn't leave a stale tab title behind.
 */
export function useDocumentTitle(pageName?: string | null) {
  useEffect(() => {
    document.title = pageName ? `${pageName} · ${APP_NAME}` : APP_NAME
    return () => {
      document.title = APP_NAME
    }
  }, [pageName])
}
