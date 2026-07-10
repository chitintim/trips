import { lazy, type ComponentType } from 'react'

const RETRY_DELAY_MS = 300

/**
 * Wraps `React.lazy` with a single retry on rejection. GitHub Pages
 * deploys atomically replace the whole `dist/` artifact, so a tab left
 * open across a redeploy can request a chunk URL that no longer exists --
 * that's a real failure no retry fixes. But an import can also fail from a
 * one-off network blip on an otherwise-current chunk, which a retry does
 * fix. One retry (after a short delay) covers the transient case cheaply;
 * if it still fails, the rejection propagates so `lazy()`'s internal
 * Suspense machinery throws during render and the nearest ErrorBoundary
 * (see src/components/ErrorBoundary.tsx's chunk-load-error handling)
 * catches it.
 */
export function lazyWithRetry<T extends ComponentType<any>>(
  importer: () => Promise<{ default: T }>,
) {
  return lazy(() =>
    importer().catch(
      () =>
        new Promise<{ default: T }>((resolve, reject) => {
          setTimeout(() => {
            importer().then(resolve, reject)
          }, RETRY_DELAY_MS)
        }),
    ),
  )
}
