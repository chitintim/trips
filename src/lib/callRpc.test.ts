import { describe, it, expect, vi, beforeEach } from 'vitest'

// Simulates the real SupabaseClient.rpc() shape closely enough to catch a
// regression of the 2026-07-10 incident: SupabaseClient.rpc() is
// `return this.rest.rpc(...)` internally, so calling it detached from its
// receiver (e.g. `const rpc = supabase.rpc; rpc(...)`) throws
// "Cannot read properties of undefined (reading 'rest')" before any
// network call. If callRpc ever regresses to a detached call, this mock
// throws exactly like the real client did in production.
//
// Defined via vi.hoisted() because vi.mock() factories are hoisted above
// all other top-level statements -- a plain `const fakeSupabase = ...`
// declared below vi.mock() would be a ReferenceError (TDZ) when the
// factory runs.
const { fakeSupabase, reportErrorMock } = vi.hoisted(() => {
  const fakeSupabase = {
    rest: { marker: 'bound-correctly' },
    rpc: vi.fn(function (
      this: { rest: unknown } | undefined,
      fn: string,
      args: unknown
    ): Promise<{ data: unknown; error: { message: string } | null }> {
      if (!this || !this.rest) {
        throw new TypeError("Cannot read properties of undefined (reading 'rest')")
      }
      return Promise.resolve({ data: { fn, args, rest: this.rest }, error: null })
    }),
  }
  const reportErrorMock = vi.fn()
  return { fakeSupabase, reportErrorMock }
})

vi.mock('./supabase', () => ({ supabase: fakeSupabase }))
vi.mock('./reportError', () => ({ reportError: (...args: unknown[]) => reportErrorMock(...args) }))

import { callRpc } from './callRpc'

describe('callRpc', () => {
  beforeEach(() => {
    fakeSupabase.rpc.mockClear()
    reportErrorMock.mockReset()
  })

  it('calls supabase.rpc as a bound method call, never detached (regression test for the 2026-07-10 incident)', async () => {
    const { data, error } = await callRpc<{ fn: string; rest: unknown }>('some_fn', { p_x: 1 })
    expect(error).toBeNull()
    expect(data?.fn).toBe('some_fn')
    // Proves `this` was preserved: the mock's `this.rest` access only
    // succeeds (and echoes back) when supabase.rpc was called as
    // supabase.rpc(...), not as a detached reference.
    expect(data?.rest).toEqual({ marker: 'bound-correctly' })
  })

  it('returns the data and null error on success, without reporting', async () => {
    const { data, error } = await callRpc('get_thing', { p_id: 'abc' })
    expect(error).toBeNull()
    expect(data).toMatchObject({ fn: 'get_thing', args: { p_id: 'abc' } })
    expect(reportErrorMock).not.toHaveBeenCalled()
  })

  it('normalizes a returned {error} into {data: null, error} and reports it', async () => {
    fakeSupabase.rpc.mockResolvedValueOnce({ data: null, error: { message: 'permission denied' } })
    const { data, error } = await callRpc('protected_fn', {})
    expect(data).toBeNull()
    expect(error).toEqual({ message: 'permission denied' })
    expect(reportErrorMock).toHaveBeenCalledWith({ message: 'permission denied' }, 'rpc:protected_fn')
  })

  it('converts a thrown exception into a returned {error} instead of throwing', async () => {
    fakeSupabase.rpc.mockImplementationOnce(() => {
      throw new Error('Cannot read properties of undefined (reading \'rest\')')
    })
    const result = await callRpc('broken_fn', {})
    expect(result.data).toBeNull()
    expect(result.error).toEqual({ message: "Cannot read properties of undefined (reading 'rest')" })
    expect(reportErrorMock).toHaveBeenCalledWith(expect.any(Error), 'rpc:broken_fn')
  })

  it('converts a rejected promise into a returned {error}', async () => {
    fakeSupabase.rpc.mockImplementationOnce(() => Promise.reject(new Error('network down')))
    const result = await callRpc('flaky_fn', {})
    expect(result.error).toEqual({ message: 'network down' })
  })

  it('stringifies a non-Error thrown value into the error message', async () => {
    fakeSupabase.rpc.mockImplementationOnce(() => {
      throw 'a plain string throw'
    })
    const result = await callRpc('weird_fn', {})
    expect(result.error).toEqual({ message: 'a plain string throw' })
  })
})
