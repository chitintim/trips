import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { searchPlace } from './geocode'

const SAMPLE_RESPONSE = [
  {
    display_name: 'Tsukiji Outer Market, Chuo, Tokyo, Japan',
    lat: '35.6654',
    lon: '139.7707',
    place_id: 12345,
    osm_type: 'way',
    osm_id: 999,
  },
]

describe('searchPlace', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('returns an empty array for blank input without making a request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const result = await searchPlace('   ')
    expect(result).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('parses a successful Nominatim response into GeocodeResult[]', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => SAMPLE_RESPONSE,
    } as Response)

    const promise = searchPlace('Tsukiji Outer Market')
    await vi.runAllTimersAsync()
    const result = await promise

    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('Tsukiji Outer Market')
    expect(result[0].lat).toBeCloseTo(35.6654)
    expect(result[0].lng).toBeCloseTo(139.7707)
  })

  it('sends a User-Agent header per Nominatim usage policy', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => [],
    } as Response)

    const promise = searchPlace('some query')
    await vi.runAllTimersAsync()
    await promise

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(String(url)).toContain('nominatim.openstreetmap.org/search')
    expect(String(url)).toContain('format=json')
    const headers = init?.headers as Record<string, string>
    expect(headers['User-Agent']).toBeTruthy()
  })

  it('returns an empty array gracefully on network failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'))
    const promise = searchPlace('anything')
    await vi.runAllTimersAsync()
    const result = await promise
    expect(result).toEqual([])
  })

  it('returns an empty array gracefully on a non-ok HTTP response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, json: async () => [] } as Response)
    const promise = searchPlace('anything')
    await vi.runAllTimersAsync()
    const result = await promise
    expect(result).toEqual([])
  })

  it('throttles concurrent calls to at least 1 second apart', async () => {
    const callTimes: number[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      callTimes.push(Date.now())
      return { ok: true, json: async () => [] } as Response
    })

    const p1 = searchPlace('first')
    const p2 = searchPlace('second')
    const p3 = searchPlace('third')

    await vi.runAllTimersAsync()
    await Promise.all([p1, p2, p3])

    expect(callTimes).toHaveLength(3)
    expect(callTimes[1] - callTimes[0]).toBeGreaterThanOrEqual(1000)
    expect(callTimes[2] - callTimes[1]).toBeGreaterThanOrEqual(1000)
  })

  it('keeps the throttle queue moving after a failed request', async () => {
    let callCount = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      callCount += 1
      if (callCount === 1) throw new Error('boom')
      return { ok: true, json: async () => SAMPLE_RESPONSE } as Response
    })

    const p1 = searchPlace('fails')
    const p2 = searchPlace('succeeds')

    await vi.runAllTimersAsync()
    const [r1, r2] = await Promise.all([p1, p2])

    expect(r1).toEqual([])
    expect(r2).toHaveLength(1)
  })
})
