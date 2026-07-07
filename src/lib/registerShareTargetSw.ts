/**
 * Registers the hand-rolled share-target service worker (see
 * public/sw.js) — best-effort, non-blocking, and silently a no-op on
 * browsers/contexts without SW support (iOS Safari when not installed,
 * older browsers, etc). This is the ONLY thing the SW is for; see
 * public/sw.js's header comment for why POST share_target requires one on
 * static GitHub Pages hosting.
 */
export function registerShareTargetSw(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  // Registered at build time via Vite's static `public/` passthrough, so
  // the path is always `${base}sw.js` — base is configurable via the
  // VITE_BASE env var (see vite.config.ts), defaulting to `/trips/`.
  const base = import.meta.env.BASE_URL
  navigator.serviceWorker.register(`${base}sw.js`, { scope: base }).catch(() => {
    // Share-target is a progressive enhancement; a failed registration
    // (unsupported browser, blocked by privacy settings, etc.) shouldn't
    // surface as an error anywhere in the app.
  })
}
