import { describe, it, expect } from 'vitest'
import { fetchChatActions, fetchThreadInfo, isMissingObject, makeChatRpc, markChatSeen, startNewChat, ChatRpcError, type LooseClient } from './chatApi'
import { parseEnvelope } from './payload'
import { chipsFor, spaceFor } from './chips'
import { nextRevealLength } from './useRevealedText'

const missing = { message: 'Could not find the table', code: 'PGRST205' }
function client(over: Partial<{ select: unknown; rpc: unknown }> = {}): LooseClient {
  const chain = (result: unknown): never => {
    const c: Record<string, unknown> = {}
    for (const m of ['eq', 'order', 'limit']) c[m] = () => c
    c.then = (res: (v: unknown) => unknown) => Promise.resolve(result).then(res)
    return c as never
  }
  return {
    from: () => ({ select: () => chain(over.select ?? { data: [], error: null }) }),
    rpc: () => Promise.resolve((over.rpc as { data: unknown; error: unknown }) ?? { data: {}, error: null }) as never,
  } as LooseClient
}

describe('before the migrations / function are live the chat behaves as it does today', () => {
  it('no chat_actions table: no actions, no throw', async () => {
    expect(await fetchChatActions('t', client({ select: { data: null, error: missing } }))).toEqual([])
    const throwing = { from: () => { throw new Error('offline') }, rpc: () => Promise.reject(new Error('x')) } as unknown as LooseClient
    expect(await fetchChatActions('t', throwing)).toEqual([])
  })
  it('no private-thread table: threads are not "available", so no private header or New chat', async () => {
    expect(await fetchThreadInfo('t', 'u', client({ select: { data: null, error: missing } }))).toEqual({ available: false, clearedAt: null })
    expect(await fetchThreadInfo('t', 'u', client({ select: { data: [{ cleared_at: '2026-11-17T00:00:00Z' }], error: null } }))).toEqual({ available: true, clearedAt: '2026-11-17T00:00:00Z' })
    expect(await fetchThreadInfo('t', 'u', client({ select: { data: [], error: null } }))).toEqual({ available: true, clearedAt: null })
  })
  it('new_chat not deployed: returns null instead of failing; mark_chat_seen never throws', async () => {
    expect(await startNewChat('t', client({ rpc: { data: null, error: { message: 'Could not find the function', code: 'PGRST202' } } }))).toBeNull()
    await expect(markChatSeen('t', { from: () => ({}), rpc: () => Promise.reject(new Error('x')) } as unknown as LooseClient)).resolves.toBeUndefined()
  })
  it('confirming without the RPCs says so plainly and flags it as missing', async () => {
    const rpc = makeChatRpc(client({ rpc: { data: null, error: { message: 'Could not find the function public.begin_chat_action', code: 'PGRST202' } } }))
    const err = await rpc.begin('a').catch((e) => e)
    expect(err).toBeInstanceOf(ChatRpcError)
    expect(err.missing).toBe(true)
    expect(err.message).toBe('Confirming from chat is not switched on yet.')
    expect(isMissingObject({ message: 'x', code: '42P01' })).toBe(true)
    expect(isMissingObject({ message: 'x', code: 'P0001' })).toBe(false)
  })
  it('an old-server stream has no actions, so nothing but text is rendered (envelopes parse to null)', () => {
    expect(parseEnvelope(undefined)).toBeNull()
    expect(parseEnvelope({ id: 'x', kind: 'propose_actions', params: {} })).toBeNull()
  })
})

describe('chips and reveal', () => {
  it('map the shell context to a space, with two questions and two actions each', () => {
    expect(spaceFor('settle-up')).toBe('money')
    expect(spaceFor('decisions')).toBe('plan')
    expect(spaceFor(undefined)).toBe('today')
    for (const s of ['today', 'plan', 'money', 'people'] as const) expect(chipsFor(s, false).length).toBeGreaterThanOrEqual(2)
    expect(chipsFor('plan', true).some((c) => c.label === 'Make a poll')).toBe(true)
    expect(chipsFor('plan', false).some((c) => c.label === 'Make a poll')).toBe(false)
    // action chips fill the box instead of sending
    expect(chipsFor('money', false).find((c) => c.label === 'Add an expense')?.insert).toBeTruthy()
  })
  it('a burst of text is spread over several steps and always finishes', () => {
    let shown = 0
    let steps = 0
    while (shown < 400) {
      shown = nextRevealLength(shown, 400)
      steps++
    }
    expect(steps).toBeGreaterThan(5)
    expect(nextRevealLength(400, 400)).toBe(400)
  })
})
