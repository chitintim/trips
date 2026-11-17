import { describe, it, expect, vi } from 'vitest'
import { APP_BUILD, CLIENT_INFO, createVersionWatcher, fetchDeployedBuild, isNewerBuild, parseVersionJson } from './appVersion'

describe('build tag', () => {
  it('is the injected build id, sent as trips-web/<id> in the existing X-Client-Info header value', () => {
    expect(CLIENT_INFO).toBe(`trips-web/${APP_BUILD}`)
    expect(APP_BUILD).toBeTruthy()
  })
})

describe('parseVersionJson / isNewerBuild', () => {
  it('reads the build id and rejects anything else', () => {
    expect(parseVersionJson('{"build":"abc123","builtAt":"2026-11-17T00:00:00Z"}')).toBe('abc123')
    expect(parseVersionJson('<html>404</html>')).toBeNull()
    expect(parseVersionJson('{"build":""}')).toBeNull()
    expect(parseVersionJson('{"build":5}')).toBeNull()
    expect(parseVersionJson('null')).toBeNull()
  })
  it('a different known build is newer; same, unknown or a dev server is not', () => {
    expect(isNewerBuild('aaa', 'bbb')).toBe(true)
    expect(isNewerBuild('aaa', 'aaa')).toBe(false)
    expect(isNewerBuild('aaa', null)).toBe(false)
    expect(isNewerBuild('dev', 'bbb')).toBe(false)
  })
})

describe('fetchDeployedBuild', () => {
  it('asks for version.json without any cache and with a throwaway query string', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, text: async () => '{"build":"zzz"}' }))
    expect(await fetchDeployedBuild({ baseUrl: '/trips/', fetchFn, now: () => 12345 })).toBe('zzz')
    expect(fetchFn).toHaveBeenCalledWith('/trips/version.json?t=12345', expect.objectContaining({ cache: 'no-store' }))
  })
  it('never throws: offline, a 404 or garbage all read as unknown', async () => {
    expect(await fetchDeployedBuild({ baseUrl: '/', fetchFn: async () => { throw new Error('offline') } })).toBeNull()
    expect(await fetchDeployedBuild({ baseUrl: '/', fetchFn: async () => ({ ok: false, text: async () => '{"build":"x"}' }) })).toBeNull()
    expect(await fetchDeployedBuild({ baseUrl: '/', fetchFn: async () => ({ ok: true, text: async () => 'oops' }) })).toBeNull()
  })
})

describe('version watcher', () => {
  function setup(extra: Partial<Parameters<typeof createVersionWatcher>[0]> = {}) {
    let t = 0
    const onNewer = vi.fn()
    const check = vi.fn(async (): Promise<string | null> => 'new')
    const timers: Array<{ fn: () => void; ms: number }> = []
    const watcher = createVersionWatcher({
      running: 'old',
      check,
      onNewer,
      now: () => t,
      setTimer: (fn, ms) => (timers.push({ fn, ms }), timers.length),
      clearTimer: vi.fn(),
      ...extra,
    })
    return { watcher, onNewer, check, timers, advance: (ms: number) => (t += ms) }
  }

  it('reports a newer deployed build, and again on every later detection (a dismissed banner returns)', async () => {
    const { watcher, onNewer, advance } = setup()
    await watcher.checkNow(true)
    expect(onNewer).toHaveBeenCalledTimes(1)
    expect(onNewer).toHaveBeenCalledWith('new')
    advance(31 * 60 * 1000)
    await watcher.checkNow(true)
    expect(onNewer).toHaveBeenCalledTimes(2)
  })

  it('says nothing when the build is the same, unreadable, or this is a dev server', async () => {
    const same = setup({ running: 'new' })
    await same.watcher.checkNow(true)
    const unknown = setup()
    unknown.check.mockResolvedValue(null)
    await unknown.watcher.checkNow(true)
    const dev = setup({ running: 'dev' })
    await dev.watcher.checkNow(true)
    expect(same.onNewer).not.toHaveBeenCalled()
    expect(unknown.onNewer).not.toHaveBeenCalled()
    expect(dev.onNewer).not.toHaveBeenCalled()
    expect(dev.check).not.toHaveBeenCalled()
  })

  it('returning to the tab re-checks, but not more often than the minimum gap', async () => {
    const { watcher, check, advance } = setup({ minGapMs: 5 * 60 * 1000 })
    watcher.onFocus()
    await Promise.resolve()
    await Promise.resolve()
    expect(check).toHaveBeenCalledTimes(1)
    advance(60 * 1000)
    watcher.onFocus()
    await Promise.resolve()
    expect(check).toHaveBeenCalledTimes(1)
    advance(5 * 60 * 1000)
    watcher.onFocus()
    await Promise.resolve()
    await Promise.resolve()
    expect(check).toHaveBeenCalledTimes(2)
  })

  it('does not run two checks at once', async () => {
    let release: (v: string | null) => void = () => {}
    const slow = vi.fn(() => new Promise<string | null>((r) => (release = r)))
    const { watcher } = setup({ check: slow })
    const first = watcher.checkNow(true)
    await watcher.checkNow(true)
    expect(slow).toHaveBeenCalledTimes(1)
    release('new')
    await first
  })

  it('polls on a 30 minute timer and stops cleanly', async () => {
    const clearTimer = vi.fn()
    const { watcher, timers, check } = setup({ clearTimer })
    watcher.start()
    watcher.start()
    expect(timers).toHaveLength(1)
    expect(timers[0].ms).toBe(30 * 60 * 1000)
    timers[0].fn()
    await Promise.resolve()
    expect(check).toHaveBeenCalledTimes(1)
    watcher.stop()
    expect(clearTimer).toHaveBeenCalledTimes(1)
  })
})
