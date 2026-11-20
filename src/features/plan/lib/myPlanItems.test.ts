import { describe, it, expect, vi, beforeEach } from 'vitest'

const rpc = vi.fn()
vi.mock('../../../lib/supabase', () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }))

import { isMyPlanItem, myPlanItemErrorMessage, saveMyPlanItem, type MyPlanItemInput } from './myPlanItems'

const ME = 'u1'
const base = { created_by: ME, participant_ids: [ME], metadata: {}, source_option_id: null }

const input: MyPlanItemInput = {
  title: ' Dinner in Tokyo ', date: '2026-12-07', startTime: '19:00', endTime: '', notes: '  ', placeId: null, location: null, category: 'dining',
}

describe('isMyPlanItem', () => {
  it('is true for my own just-me row', () => expect(isMyPlanItem(base, ME)).toBe(true))
  it('is false for someone else’s', () => expect(isMyPlanItem({ ...base, created_by: 'u2' }, ME)).toBe(false))
  it('is false when it is for everyone or several people', () => {
    expect(isMyPlanItem({ ...base, participant_ids: null }, ME)).toBe(false)
    expect(isMyPlanItem({ ...base, participant_ids: [ME, 'u2'] }, ME)).toBe(false)
    expect(isMyPlanItem({ ...base, participant_ids: ['u2'] }, ME)).toBe(false)
  })
  it('is false for travel rows and option-backed rows', () => {
    expect(isMyPlanItem({ ...base, metadata: { travel_details: true } }, ME)).toBe(false)
    expect(isMyPlanItem({ ...base, source_option_id: 'o1' }, ME)).toBe(false)
  })
  it('stays mine when travel_details is not the boolean true', () => expect(isMyPlanItem({ ...base, metadata: { travel_details: 'true' } }, ME)).toBe(true))
  it('is false with no user', () => expect(isMyPlanItem(base, '')).toBe(false))
})

describe('myPlanItemErrorMessage', () => {
  it('passes the message through for a known hint', () => {
    expect(myPlanItemErrorMessage({ hint: 'bad_date', message: 'That date looks wrong. Check the year.' })).toBe('That date looks wrong. Check the year.')
  })
  it('never passes raw database text', () => {
    expect(myPlanItemErrorMessage({ hint: 'weird', message: 'new row violates row-level security policy' })).toBe("Couldn't save that. Check your connection and try again.")
    expect(myPlanItemErrorMessage(new Error('boom'))).toBe("Couldn't save that. Check your connection and try again.")
    expect(myPlanItemErrorMessage(null)).toBe("Couldn't save that. Check your connection and try again.")
  })
})

describe('saveMyPlanItem times', () => {
  beforeEach(() => rpc.mockReset())
  it('normalises HH:MM:SS to HH:MM and garbage to null, with exact keys', async () => {
    rpc.mockResolvedValue({ data: { id: 'a' }, error: null })
    await saveMyPlanItem('t1', 'a', { ...input, startTime: '19:00:00', endTime: 'soon', location: '', placeId: '' })
    const item = rpc.mock.calls[0][1].p_item
    expect(item.start_time).toBe('19:00')
    expect(item.end_time).toBeNull()
    expect(item.place_id).toBeNull()
    expect(item.location).toBeNull()
    expect(Object.keys(item).sort()).toEqual(['category', 'date', 'end_time', 'location', 'notes', 'place_id', 'start_time', 'title'])
  })
  it('shows the too_many message', () => {
    expect(myPlanItemErrorMessage({ hint: 'too_many', message: "You've added a lot of your own plans to this trip. Remove one before adding another." })).toMatch(/Remove one/)
  })
})

describe('saveMyPlanItem', () => {
  beforeEach(() => rpc.mockReset())

  it('inserts with snake_case and trimmed values', async () => {
    rpc.mockResolvedValue({ data: { id: 'new1' }, error: null })
    const res = await saveMyPlanItem('t1', null, input)
    expect(res).toEqual({ id: 'new1' })
    expect(rpc).toHaveBeenCalledWith('save_my_plan_item', {
      p_trip_id: 't1',
      p_id: null,
      p_item: { title: 'Dinner in Tokyo', date: '2026-12-07', start_time: '19:00', end_time: null, notes: null, category: 'dining', place_id: null, location: null },
    })
  })

  it('deletes with a null item', async () => {
    rpc.mockResolvedValue({ data: { id: 'x' }, error: null })
    const res = await saveMyPlanItem('t1', 'x', null)
    expect(res).toEqual({ id: null })
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_id: 'x', p_item: null })
  })

  it('refuses a delete without an id', async () => {
    await expect(saveMyPlanItem('t1', null, null)).rejects.toThrow()
    expect(rpc).not.toHaveBeenCalled()
  })

  it('throws a safe message on error', async () => {
    rpc.mockResolvedValue({ data: null, error: { hint: 'not_yours', message: 'You can only change your own plans.', code: '42501' } })
    await expect(saveMyPlanItem('t1', 'x', input)).rejects.toThrow('You can only change your own plans.')
    rpc.mockResolvedValue({ data: null, error: { message: 'permission denied for table' } })
    await expect(saveMyPlanItem('t1', 'x', input)).rejects.toThrow("Couldn't save that. Check your connection and try again.")
  })
})
