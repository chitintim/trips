import { describe, it, expect, vi } from 'vitest'
import { applyUpdateAndReload, checkForServiceWorkerUpdate, RELOAD_ATTEMPT_KEY, SHARE_CACHE_NAME } from './appUpdate'

function fakeSw(opts: { waiting?: { postMessage: ReturnType<typeof vi.fn> } | null; regs?: { unregister: ReturnType<typeof vi.fn> }[] } = {}) {
  const listeners = new Set<() => void>()
  const update = vi.fn(async () => undefined)
  const sw = {
    getRegistration: vi.fn(async () => ({ waiting: opts.waiting ?? null, update })),
    getRegistrations: vi.fn(async () => opts.regs ?? []),
    addEventListener: vi.fn((_t: string, fn: () => void) => { listeners.add(fn) }),
    removeEventListener: vi.fn((_t: string, fn: () => void) => { listeners.delete(fn) }),
  }
  return { sw: sw as never, update, fire: () => [...listeners].forEach((f) => f()), raw: sw }
}
function memStorage(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial))
  return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => void m.set(k, v) }
}
const base = { pageUrl: '/trips/abc', baseUrl: '/', now: () => 1_000_000 }

describe('checkForServiceWorkerUpdate', () => {
  it('asks the registration to update, and never throws', async () => {
    const f = fakeSw()
    await checkForServiceWorkerUpdate(f.sw)
    expect(f.update).toHaveBeenCalledTimes(1)
    await expect(checkForServiceWorkerUpdate({ getRegistration: async () => { throw new Error('x') } } as never)).resolves.toBeUndefined()
    await expect(checkForServiceWorkerUpdate(null)).resolves.toBeUndefined()
  })
})

describe('applyUpdateAndReload', () => {
  it('with nothing waiting: refreshes the page document past the HTTP cache, then reloads once', async () => {
    const f = fakeSw()
    const fetchFn = vi.fn(async () => ({}))
    const reload = vi.fn()
    await applyUpdateAndReload({ ...base, serviceWorker: f.sw, cachesApi: null, fetchFn, reload, storage: memStorage() })
    expect(fetchFn).toHaveBeenCalledWith('/trips/abc', expect.objectContaining({ cache: 'reload' }))
    expect(fetchFn).toHaveBeenCalledWith('/', expect.objectContaining({ cache: 'reload' }))
    expect(reload).toHaveBeenCalledTimes(1)
    expect(f.raw.getRegistrations).not.toHaveBeenCalled()
  })

  it('a waiting worker gets SKIP_WAITING and the reload waits for controllerchange', async () => {
    const waiting = { postMessage: vi.fn() }
    const f = fakeSw({ waiting })
    const reload = vi.fn()
    const p = applyUpdateAndReload({ ...base, serviceWorker: f.sw, cachesApi: null, fetchFn: async () => ({}), reload, storage: memStorage() })
    await vi.waitFor(() => expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' }))
    expect(reload).not.toHaveBeenCalled()
    f.fire()
    await p
    expect(reload).toHaveBeenCalledTimes(1)
    expect(f.raw.removeEventListener).toHaveBeenCalled()
  })

  it('if the worker never takes over, unregisters workers, clears caches except the share payload, and still reloads once', async () => {
    const reg = { unregister: vi.fn(async () => true) }
    const f = fakeSw({ waiting: { postMessage: vi.fn() }, regs: [reg] })
    const cachesApi = { keys: vi.fn(async () => ['old-precache', SHARE_CACHE_NAME]), delete: vi.fn(async () => true) }
    const reload = vi.fn()
    await applyUpdateAndReload({ ...base, serviceWorker: f.sw, cachesApi, fetchFn: async () => ({}), reload, storage: memStorage(), timeoutMs: 5 })
    expect(reg.unregister).toHaveBeenCalled()
    expect(cachesApi.delete).toHaveBeenCalledWith('old-precache')
    expect(cachesApi.delete).not.toHaveBeenCalledWith(SHARE_CACHE_NAME)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('a second Reload shortly after the first takes the hard path', async () => {
    const reg = { unregister: vi.fn(async () => true) }
    const f = fakeSw({ regs: [reg] })
    const reload = vi.fn()
    const storage = memStorage({ [RELOAD_ATTEMPT_KEY]: String(1_000_000 - 30_000) })
    await applyUpdateAndReload({ ...base, serviceWorker: f.sw, cachesApi: { keys: async () => [], delete: async () => true }, fetchFn: async () => ({}), reload, storage })
    expect(reg.unregister).toHaveBeenCalled()
    expect(reload).toHaveBeenCalledTimes(1)
    expect(storage.get(RELOAD_ATTEMPT_KEY)).toBe('1000000')
  })

  it('works without service worker support and when the refresh fetch fails', async () => {
    const reload = vi.fn()
    await applyUpdateAndReload({ ...base, serviceWorker: null, cachesApi: null, fetchFn: async () => { throw new Error('offline') }, reload, storage: memStorage() })
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
