import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../lib/supabase', () => ({ supabase: { auth: { getSession: vi.fn(async () => ({ data: { session: { access_token: 't' } } })) } } }))

import {
  actionsChoices,
  chatIsOn,
  effectiveLabel,
  fetchAdminChatSettings,
  fetchChatAvailability,
  parseAvailability,
  setAdminChatSettings,
  setTripChatSettings,
  tripControlState,
  type ChatAvailability,
  type RpcFn,
} from './chatSettings'
import { ChatOffError, streamChatMessage } from './streamChat'

const avail = (over: Record<string, unknown> = {}) => ({
  chat: true,
  actions: true,
  can_manage: true,
  can_force_on: false,
  trip: { chat: 'inherit', actions: 'inherit' },
  site: { mode: 'actions', actions_scope: 'upcoming' },
  ...over,
})
const rpcOk = (data: unknown): RpcFn => vi.fn(async () => ({ data, error: null }))

describe('availability fails open', () => {
  it('shows chat while loading and when nothing is known', () => {
    expect(chatIsOn(null)).toBe(true)
    expect(chatIsOn(undefined)).toBe(true)
  })
  it('a missing function, an error, a throw or junk all read as "unknown", never as off', async () => {
    const missing: RpcFn = vi.fn(async () => ({ data: null, error: { code: 'PGRST202', message: 'not found' } }))
    expect(await fetchChatAvailability('t1', missing)).toBeNull()
    expect(await fetchChatAvailability('t1', vi.fn(async () => { throw new Error('offline') }))).toBeNull()
    expect(await fetchChatAvailability('t1', rpcOk({ nope: 1 }))).toBeNull()
    expect(chatIsOn(await fetchChatAvailability('t1', missing))).toBe(true)
  })
  it('calls only the real function, with the trip id and nothing else', async () => {
    const rpc = rpcOk(avail())
    await fetchChatAvailability('t1', rpc)
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('get_chat_availability', { p_trip_id: 't1' })
  })
  it('chat false hides chat', async () => {
    const a = await fetchChatAvailability('t1', rpcOk(avail({ chat: false, actions: false })))
    expect(chatIsOn(a)).toBe(false)
  })
  it('parses the contract shape', () => {
    expect(parseAvailability(avail({ can_force_on: true, trip: { chat: 'off', actions: 'on' }, site: { mode: 'answers', actions_scope: 'all' } }))).toEqual({
      chat: true,
      actions: true,
      canManage: true,
      canForceOn: true,
      trip: { chat: 'off', actions: 'on' },
      site: { mode: 'answers', actionsScope: 'all' },
    })
  })
})

describe('trip controls', () => {
  const a = (over: Partial<ChatAvailability> = {}): ChatAvailability => ({ ...(parseAvailability(avail()) as ChatAvailability), ...over })
  it('an organiser cannot see force-on; a site admin can', () => {
    expect(actionsChoices({ canForceOn: false })).toEqual(['inherit', 'off'])
    expect(actionsChoices({ canForceOn: true })).toEqual(['inherit', 'off', 'on'])
  })
  it('explains a control the site level makes moot', () => {
    expect(tripControlState(a({ site: { mode: 'off', actionsScope: 'upcoming' } }))).toEqual({ chatDisabledReason: 'Switched off for the whole site.', actionsDisabledReason: 'Switched off for the whole site.' })
    expect(tripControlState(a({ site: { mode: 'answers', actionsScope: 'upcoming' } })).actionsDisabledReason).toMatch(/only allows answers/)
    expect(tripControlState(a({ trip: { chat: 'off', actions: 'inherit' } })).actionsDisabledReason).toMatch(/first/)
    expect(tripControlState(a())).toEqual({ chatDisabledReason: null, actionsDisabledReason: null })
  })
  it('says the result in words', () => {
    expect(effectiveLabel(false, false)).toBe('Off')
    expect(effectiveLabel(true, false)).toBe('Answers only')
    expect(effectiveLabel(true, true)).toBe('Answers and actions')
  })
  it('saving calls set_trip_chat_settings with the right arguments and returns the new state', async () => {
    const rpc = rpcOk(avail({ chat: false, trip: { chat: 'off', actions: 'inherit' } }))
    const r = await setTripChatSettings('t1', { chat: 'off' }, rpc)
    expect(rpc).toHaveBeenCalledWith('set_trip_chat_settings', { p_trip_id: 't1', p_chat: 'off', p_actions: null })
    expect(r.trip.chat).toBe('off')
  })
  it('only the changed field is sent: the other is NULL (unchanged), never a stale value or inherit', async () => {
    const rpc = rpcOk(avail())
    await setTripChatSettings('t1', { actions: 'off' }, rpc)
    expect(rpc).toHaveBeenLastCalledWith('set_trip_chat_settings', { p_trip_id: 't1', p_chat: null, p_actions: 'off' })
    const rpc2 = rpcOk({ mode: 'actions', actions_scope: 'all', trips: [] })
    await setAdminChatSettings({ actionsScope: 'all' }, rpc2)
    expect(rpc2).toHaveBeenCalledWith('admin_set_chat_settings', { p_mode: null, p_actions_scope: 'all' })
  })
  it('a refused save throws the server message', async () => {
    const rpc: RpcFn = vi.fn(async () => ({ data: null, error: { message: 'Only a site admin can do that' } }))
    await expect(setTripChatSettings('t1', { actions: 'on' }, rpc)).rejects.toThrow('Only a site admin can do that')
  })
})

describe('admin controls', () => {
  const admin = {
    mode: 'actions',
    actions_scope: 'upcoming',
    updated_at: '2026-11-18T10:00:00Z',
    trips: [{ trip_id: 't1', name: 'Alps', start_date: '2027-01-01', end_date: '2027-01-07', chat: 'inherit', actions: 'on', effective_chat: true, effective_actions: true }],
  }
  it('reads with admin_get_chat_settings', async () => {
    const rpc = rpcOk(admin)
    const r = await fetchAdminChatSettings(rpc)
    expect(rpc).toHaveBeenCalledWith('admin_get_chat_settings', {})
    expect(r.trips[0]).toMatchObject({ tripId: 't1', name: 'Alps', actions: 'on', effectiveActions: true })
  })
  it('writes with admin_set_chat_settings and the chosen mode and scope', async () => {
    const rpc = rpcOk({ ...admin, mode: 'off' })
    const r = await setAdminChatSettings({ mode: 'off', actionsScope: 'all' }, rpc)
    expect(rpc).toHaveBeenCalledWith('admin_set_chat_settings', { p_mode: 'off', p_actions_scope: 'all' })
    expect(r.mode).toBe('off')
  })
  it('a malformed answer is an error, not a silent success', async () => {
    await expect(fetchAdminChatSettings(rpcOk({}))).rejects.toThrow()
  })
})

describe('chat_off from the function', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()))
  it('a 403 with code chat_off becomes the plain notice and cannot be retried', async () => {
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ error: 'x', code: 'chat_off' }), { status: 403 }))
    const cbs = { onText: vi.fn(), onProposal: vi.fn(), onDone: vi.fn(), onError: vi.fn() }
    await expect(streamChatMessage('t1', 'hi', cbs)).rejects.toBeInstanceOf(ChatOffError)
    await expect(streamChatMessage('t1', 'hi', cbs)).rejects.toMatchObject({ code: 'chat_off', message: 'The assistant is switched off for this trip.' })
  })
  it('any other 403 keeps its own message', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ error: 'You are not on this trip.' }), { status: 403 }))
    await expect(streamChatMessage('t1', 'hi', { onText: vi.fn(), onProposal: vi.fn(), onDone: vi.fn(), onError: vi.fn() })).rejects.toThrow('You are not on this trip.')
  })
})
