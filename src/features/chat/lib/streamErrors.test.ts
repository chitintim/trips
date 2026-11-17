import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../lib/supabase', () => ({ supabase: { auth: { getSession: vi.fn(async () => ({ data: { session: { access_token: 't' } } })) } } }))

import { CHAT_CUT_OFF, CHAT_FALLBACK_ERROR, serverErrorText, streamChatMessage } from './streamChat'

const sse = (...events: unknown[]) => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { status: 200 })
const cbs = () => ({ onText: vi.fn(), onProposal: vi.fn(), onDone: vi.fn(), onError: vi.fn() })

beforeEach(() => vi.stubGlobal('fetch', vi.fn()))

describe("the server's error text is shown, not 'cut off'", () => {
  it('an error event without done surfaces the server wording only', async () => {
    const c = cbs()
    vi.mocked(fetch).mockResolvedValue(sse({ type: 'error', error: 'The assistant is busy right now. Try again in a minute.' }))
    await streamChatMessage('t1', 'hi', c)
    expect(c.onError).toHaveBeenCalledTimes(1)
    expect(c.onError).toHaveBeenCalledWith('The assistant is busy right now. Try again in a minute.')
  })
  it('a stream that just ends is "cut off"; a finished one is not', async () => {
    const a = cbs()
    vi.mocked(fetch).mockResolvedValue(sse({ type: 'text', text: 'Hi' }))
    await streamChatMessage('t1', 'hi', a)
    expect(a.onError).toHaveBeenCalledWith(CHAT_CUT_OFF)
    const b = cbs()
    vi.mocked(fetch).mockResolvedValue(sse({ type: 'done', message: 'Hi' }))
    await streamChatMessage('t1', 'hi', b)
    expect(b.onError).not.toHaveBeenCalled()
  })
  it('safe fallback for junk, stack traces and markup', () => {
    expect(serverErrorText(undefined)).toBe(CHAT_FALLBACK_ERROR)
    expect(serverErrorText('  ')).toBe(CHAT_FALLBACK_ERROR)
    expect(serverErrorText('{"error":"x"}')).toBe(CHAT_FALLBACK_ERROR)
    expect(serverErrorText('Error at handler (index.ts:42:7)')).toBe(CHAT_FALLBACK_ERROR)
    expect(serverErrorText('x'.repeat(500)).length).toBeLessThanOrEqual(300)
  })
  it('a non-OK response keeps the server message', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ error: 'You are not on this trip.' }), { status: 403 }))
    await expect(streamChatMessage('t1', 'hi', cbs())).rejects.toThrow('You are not on this trip.')
  })
})

describe('429 codes and timezone', () => {
  it('maps spend_limit and daily_limit to plain messages', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ success: false, error: 'x', code: 'spend_limit' }), { status: 429 }))
    await expect(streamChatMessage('t1', 'hi', cbs())).rejects.toMatchObject({ code: 'spend_limit', message: "You've used today's assistant allowance — it resets within a day." })
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ code: 'daily_limit' }), { status: 429 }))
    await expect(streamChatMessage('t1', 'hi', cbs())).rejects.toMatchObject({ code: 'daily_limit', message: "You've reached today's message limit — try again tomorrow." })
  })
  it('sends tz with the request', async () => {
    vi.mocked(fetch).mockResolvedValue(sse({ type: 'done', message: 'Hi' }))
    await streamChatMessage('t1', 'hi', cbs())
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string)
    expect(body.tz).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
  })
})
