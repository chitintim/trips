import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// reportError.ts imports the shared supabase client purely to call
// supabase.rpc('log_client_error', ...) -- mock it so tests never touch a
// real network/Supabase project, per the module's own contract that this
// call is fire-and-forget and must never throw into the caller.
const rpcMock = vi.fn()
vi.mock('./supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
  },
}))

import { reportError, __resetReportErrorStateForTests } from './reportError'

describe('reportError', () => {
  beforeEach(() => {
    __resetReportErrorStateForTests()
    rpcMock.mockReset()
    rpcMock.mockResolvedValue({ data: null, error: null })
    // vitest defaults import.meta.env.DEV to true (mode 'test'); reportError
    // treats DEV as a kill switch (console.error only, never the network),
    // so the non-dev code paths under test need it stubbed off.
    vi.stubEnv('DEV', false)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'debug').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('reports an Error with its message, stack, and context', () => {
    const err = new Error('boom')
    reportError(err, 'test-context')

    expect(rpcMock).toHaveBeenCalledTimes(1)
    const [fn, args] = rpcMock.mock.calls[0]
    expect(fn).toBe('log_client_error')
    expect(args).toMatchObject({
      p_message: 'boom',
      p_context: 'test-context',
    })
    expect(args.p_stack).toBe(err.stack)
  })

  it('never throws even when the rpc call itself throws synchronously', () => {
    rpcMock.mockImplementation(() => {
      throw new Error('network is on fire')
    })
    expect(() => reportError(new Error('boom'), 'ctx')).not.toThrow()
  })

  it('dedupes the same message+context reported again within the window', () => {
    vi.useFakeTimers()
    reportError(new Error('same'), 'ctx')
    reportError(new Error('same'), 'ctx')
    reportError(new Error('same'), 'ctx')
    expect(rpcMock).toHaveBeenCalledTimes(1)
  })

  it('reports again once the dedupe window has elapsed', () => {
    vi.useFakeTimers()
    reportError(new Error('same'), 'ctx')
    vi.advanceTimersByTime(30_001)
    reportError(new Error('same'), 'ctx')
    expect(rpcMock).toHaveBeenCalledTimes(2)
  })

  it('does not dedupe distinct message/context pairs', () => {
    reportError(new Error('one'), 'ctx-a')
    reportError(new Error('two'), 'ctx-a')
    reportError(new Error('one'), 'ctx-b')
    expect(rpcMock).toHaveBeenCalledTimes(3)
  })

  it('caps total reports per session even across distinct messages', () => {
    for (let i = 0; i < 25; i++) {
      reportError(new Error(`error-${i}`), 'ctx')
    }
    expect(rpcMock).toHaveBeenCalledTimes(20)
  })

  it('skips the network entirely in dev mode', () => {
    vi.stubEnv('DEV', true)
    reportError(new Error('dev error'), 'ctx')
    expect(rpcMock).not.toHaveBeenCalled()
    expect(console.error).toHaveBeenCalled()
  })

  it('normalizes non-Error thrown values', () => {
    reportError('a plain string error', 'ctx')
    expect(rpcMock).toHaveBeenCalledTimes(1)
    const [, args] = rpcMock.mock.calls[0]
    expect(args.p_message).toBe('a plain string error')
  })
})
