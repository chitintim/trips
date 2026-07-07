// Hand-rolled service worker — NOT workbox, NOT a general offline cache.
// Its ONLY job is handling the PWA `share_target` POST (UX_REDESIGN.md
// Part 3 "Ambient AI" #1, "Share target"). GitHub Pages serves this app as
// a static site with no server-side handler, and the manifest's
// `share_target.method` MUST be "POST" for Android to let installed apps
// (Gmail, Booking.com, Airbnb, Photos, ...) share files/text/url directly
// into this app — the GET-only share_target variant cannot carry files at
// all, which would defeat "snap a screenshot -> share into Trips" for the
// most common real-world case. A GET target also can't intercept the
// navigation itself (the browser just does a normal top-level GET, no
// service worker needed) — but POST *requires* a fetch event handler
// because there is no static endpoint on GitHub Pages that could receive
// the multipart form body. Hence: the smallest possible SW, scoped to
// /trips/, that does exactly one thing.
//
// Flow: browser POSTs multipart/form-data to /trips/share-target (the
// manifest's share_target.action) -> this fetch handler reads the form,
// stashes {title, text, url, images: [...base64]} into a dedicated Cache
// Storage entry (IndexedDB would also work; Cache Storage needs no schema
// and this is a single JSON blob) -> redirects to /trips/share, which reads
// and clears that cache entry on mount (see src/pages/SharePage.tsx).
//
// Everything else (every non-share-target request) is left completely
// alone -- `fetch` is not even listened to for other paths, so this SW
// provides no offline behavior and cannot get in the way of normal
// same-origin requests, cache versioning, or deploys.

const SHARE_CACHE = 'trips-share-target-v1'
const SHARE_TARGET_PATH = '/trips/share-target'
const SHARE_PAYLOAD_URL = '/trips/__share-payload__'

self.addEventListener('install', (event) => {
  // Activate immediately -- this SW has no versioned asset cache to worry
  // about clobbering, so there's no reason to wait for old tabs to close.
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (event.request.method !== 'POST' || url.pathname !== SHARE_TARGET_PATH) return

  event.respondWith(
    (async () => {
      try {
        const formData = await event.request.formData()
        const title = formData.get('title')
        const text = formData.get('text')
        const sharedUrl = formData.get('url')
        const images = []
        for (const value of formData.getAll('images')) {
          if (value instanceof File && value.size > 0) {
            const base64 = await fileToBase64(value)
            images.push({ base64, media_type: value.type || 'image/jpeg', name: value.name })
          }
        }

        const payload = {
          title: typeof title === 'string' ? title : null,
          text: typeof text === 'string' ? text : null,
          url: typeof sharedUrl === 'string' ? sharedUrl : null,
          images,
          received_at: new Date().toISOString(),
        }

        const cache = await caches.open(SHARE_CACHE)
        await cache.put(SHARE_PAYLOAD_URL, new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } }))
      } catch (err) {
        // Never let a malformed share payload break the redirect -- /share
        // just finds no cached payload and shows its own "nothing shared"
        // empty state instead of the user's OS-level share sheet erroring.
        console.error('[sw] share_target handling failed', err)
      }

      return Response.redirect('/trips/share', 303)
    })()
  )
})

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = /** @type {string} */ (reader.result)
      // Strip the "data:<mime>;base64," prefix -- callers only want the payload.
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}
