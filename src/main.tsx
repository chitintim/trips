import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from './lib/queries/queryClient'
import { registerShareTargetSw } from './lib/registerShareTargetSw'
import './index.css'
import App from './App.tsx'

registerShareTargetSw()

// GitHub Pages deploys atomically replace dist/, so a tab left open across
// a redeploy can request a lazy chunk whose hashed filename no longer
// exists -- the SPA 404 fallback answers with HTML, which Vite surfaces as
// `vite:preloadError` on the dynamic import. A reload picks up the current
// index.html and its (now-matching) chunk hashes. Guard with a sessionStorage
// flag so a deploy that's still broken after the reload (mid-rollout, CDN
// lag) can't bounce the tab in a loop -- the flag re-arms 60s later so a
// tab kept open across a LATER, unrelated redeploy still self-heals once.
const CHUNK_RELOAD_KEY = 'chunk-reload-attempted'
window.addEventListener('vite:preloadError', () => {
  if (sessionStorage.getItem(CHUNK_RELOAD_KEY)) return
  sessionStorage.setItem(CHUNK_RELOAD_KEY, '1')
  window.location.reload()
})
setTimeout(() => sessionStorage.removeItem(CHUNK_RELOAD_KEY), 60_000)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
