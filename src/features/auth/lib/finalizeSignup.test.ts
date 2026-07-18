import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  finalizeSignup,
  reconcilePendingSignup,
  storePendingSignup,
  readPendingSignup,
  clearPendingSignup,
  profileUpdateFromPending,
  FinalizeClient,
  PendingSignupPayload,
} from './finalizeSignup'

// reportError touches supabase + import.meta.env -- stub both modules out
// so these tests exercise finalizeSignup's decision logic only (every test
// injects its own FinalizeClient; the real supabase default is never used).
vi.mock('../../../lib/supabase', () => ({ supabase: {} }))
vi.mock('../../../lib/reportError', () => ({ reportError: vi.fn() }))

// vitest runs in the node environment (see vitest.config.ts) which has no
// localStorage -- back the pending-signup helpers with an in-memory stub.
const storage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
  clear: () => storage.clear(),
})

interface FakeClientOptions {
  updateError?: { message: string } | null
  existingFullName?: string | null
  selectError?: { message: string } | null
  markResult?: { data: unknown; error: { message: string } | null }
  assignResult?: { data: unknown; error: { message: string } | null }
}

function makeClient(options: FakeClientOptions = {}) {
  const calls: { updates: Record<string, unknown>[]; rpcs: { fn: string; args: Record<string, unknown> }[] } = {
    updates: [],
    rpcs: [],
  }
  const client: FinalizeClient = {
    from: () => ({
      update: (values: Record<string, unknown>) => ({
        eq: () => {
          calls.updates.push(values)
          return Promise.resolve({ error: options.updateError ?? null })
        },
      }),
      select: () => ({
        eq: () => ({
          maybeSingle: () =>
            Promise.resolve({
              data: { full_name: options.existingFullName ?? null },
              error: options.selectError ?? null,
            }),
        }),
      }),
    }),
    rpc: (fn, args) => {
      calls.rpcs.push({ fn, args })
      if (fn === 'mark_invitation_used') {
        return Promise.resolve(options.markResult ?? { data: true, error: null })
      }
      return Promise.resolve(options.assignResult ?? { data: null, error: null })
    },
  }
  return { client, calls }
}

const INPUT = {
  userId: 'user-1',
  invitationId: 'inv-1',
  tripId: 'trip-1',
  profileUpdate: { first_name: 'Ada', last_name: 'Lovelace', full_name: 'Ada Lovelace' },
}

describe('finalizeSignup', () => {
  it('runs all three steps and succeeds', async () => {
    const { client, calls } = makeClient()
    const result = await finalizeSignup(INPUT, client)
    expect(result).toEqual({ ok: true, errors: [] })
    expect(calls.updates).toEqual([INPUT.profileUpdate])
    expect(calls.rpcs.map((c) => c.fn)).toEqual(['mark_invitation_used', 'assign_user_to_trip'])
  })

  it('skips trip assignment when the invitation has no trip', async () => {
    const { client, calls } = makeClient()
    const result = await finalizeSignup({ ...INPUT, tripId: null }, client)
    expect(result.ok).toBe(true)
    expect(calls.rpcs.map((c) => c.fn)).toEqual(['mark_invitation_used'])
  })

  it('fails when the profile update errors and no profile exists yet', async () => {
    const { client } = makeClient({ updateError: { message: 'boom' }, existingFullName: null })
    const result = await finalizeSignup(INPUT, client)
    expect(result.ok).toBe(false)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatch(/profile/i)
  })

  it('tolerates a profile update error when the trigger already populated the row', async () => {
    const { client } = makeClient({ updateError: { message: 'boom' }, existingFullName: 'Ada Lovelace' })
    const result = await finalizeSignup(INPUT, client)
    expect(result.ok).toBe(true)
  })

  it('fails when mark_invitation_used errors', async () => {
    const { client } = makeClient({ markResult: { data: null, error: { message: 'rpc down' } } })
    const result = await finalizeSignup(INPUT, client)
    expect(result.ok).toBe(false)
    expect(result.errors[0]).toMatch(/invitation/i)
  })

  it('treats mark_invitation_used returning false (already used) as non-fatal', async () => {
    const { client, calls } = makeClient({ markResult: { data: false, error: null } })
    const result = await finalizeSignup(INPUT, client)
    expect(result.ok).toBe(true)
    // Still proceeds to trip assignment.
    expect(calls.rpcs.map((c) => c.fn)).toEqual(['mark_invitation_used', 'assign_user_to_trip'])
  })

  it('treats a trip assignment error as non-fatal', async () => {
    const { client } = makeClient({ assignResult: { data: null, error: { message: 'nope' } } })
    const result = await finalizeSignup(INPUT, client)
    expect(result.ok).toBe(true)
  })
})

const PENDING: PendingSignupPayload = {
  invitationId: 'inv-1',
  tripId: 'trip-1',
  firstName: 'Ada',
  lastName: 'Lovelace',
  avatarData: { type: 'icon', icon: 'mountain', bgColor: '#0ea5e9' },
}

describe('pending signup storage', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('round-trips a payload through localStorage', () => {
    storePendingSignup(PENDING)
    expect(readPendingSignup()).toEqual(PENDING)
    clearPendingSignup()
    expect(readPendingSignup()).toBeNull()
  })

  it('returns null for corrupt or missing payloads', () => {
    expect(readPendingSignup()).toBeNull()
    localStorage.setItem('trips:pending-signup', 'not-json')
    expect(readPendingSignup()).toBeNull()
    localStorage.setItem('trips:pending-signup', JSON.stringify({ firstName: 'Ada' }))
    expect(readPendingSignup()).toBeNull()
  })
})

describe('profileUpdateFromPending', () => {
  it('builds the users-row update including avatar data', () => {
    expect(profileUpdateFromPending(PENDING)).toEqual({
      first_name: 'Ada',
      last_name: 'Lovelace',
      full_name: 'Ada Lovelace',
      avatar_data: PENDING.avatarData,
      avatar_url: null,
    })
  })

  it('omits avatar fields when no avatar was chosen', () => {
    expect(profileUpdateFromPending({ ...PENDING, avatarData: null })).toEqual({
      first_name: 'Ada',
      last_name: 'Lovelace',
      full_name: 'Ada Lovelace',
    })
  })
})

describe('reconcilePendingSignup', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('does nothing without a stored payload', async () => {
    const { client, calls } = makeClient()
    expect(await reconcilePendingSignup('user-1', client)).toBe(false)
    expect(calls.updates).toHaveLength(0)
    expect(calls.rpcs).toHaveLength(0)
  })

  it('clears the payload without finalizing when the profile is already complete', async () => {
    storePendingSignup(PENDING)
    const { client, calls } = makeClient({ existingFullName: 'Ada Lovelace' })
    expect(await reconcilePendingSignup('user-1', client)).toBe(false)
    expect(readPendingSignup()).toBeNull()
    expect(calls.rpcs).toHaveLength(0)
  })

  it('finalizes an unfinalized user and clears the payload on success', async () => {
    storePendingSignup(PENDING)
    const { client, calls } = makeClient({ existingFullName: null })
    expect(await reconcilePendingSignup('user-1', client)).toBe(true)
    expect(calls.updates).toEqual([profileUpdateFromPending(PENDING)])
    expect(calls.rpcs.map((c) => c.fn)).toEqual(['mark_invitation_used', 'assign_user_to_trip'])
    expect(readPendingSignup()).toBeNull()
  })

  it('keeps the payload when finalization fails so a later mount can retry', async () => {
    storePendingSignup(PENDING)
    const { client } = makeClient({
      existingFullName: null,
      updateError: { message: 'boom' },
      markResult: { data: null, error: { message: 'rpc down' } },
    })
    expect(await reconcilePendingSignup('user-1', client)).toBe(false)
    expect(readPendingSignup()).toEqual(PENDING)
  })
})
