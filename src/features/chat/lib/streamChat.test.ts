import { describe, it, expect } from 'vitest'
import { createSseParser, parseStreamEvent } from './streamChat'

const line = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`

describe('SSE parser', () => {
  it('reads the new events: status, text, action, done with message_id and action ids', () => {
    const p = createSseParser()
    const evs = p.push(
      line({ type: 'status', label: 'Checking your to-dos…' }) +
        line({ type: 'text', text: 'You have ' }) +
        line({ type: 'action', action: { id: 'a1', kind: 'add_todo', params: { title: 'x' }, requires: 'tap', status: 'proposed', turn_id: 't1' } }) +
        line({ type: 'done', message_id: 'm1', actions: ['a1'] })
    )
    expect(evs.map((e) => e.type)).toEqual(['status', 'text', 'action', 'done'])
    expect(evs[0]).toEqual({ type: 'status', label: 'Checking your to-dos…' })
    const action = evs[2] as Extract<(typeof evs)[number], { type: 'action' }>
    expect(action.action.kind).toBe('add_todo')
    expect(action.action.requires).toBe('tap')
    expect(evs[3]).toEqual({ type: 'done', message: '', messageId: 'm1', actionIds: ['a1'], actionsEnabled: null })
  })
  it('reads actions_enabled from done (hides the "ask me to do things" chips when false)', () => {
    expect(parseStreamEvent(JSON.stringify({ type: 'done', message: 'x', message_id: 'm', turn_id: 't', actions: [], actions_enabled: false, replayed: true }))).toEqual({ type: 'done', message: 'x', messageId: 'm', actionIds: [], actionsEnabled: false })
  })
  it('handles chunks split mid-line and CRLF, and ignores ": ping" comments', () => {
    const p = createSseParser()
    const whole = `: ping\r\n` + line({ type: 'text', text: 'hello' })
    const out = [...p.push(whole.slice(0, 20)), ...p.push(whole.slice(20, 40)), ...p.push(whole.slice(40))]
    expect(out).toEqual([{ type: 'text', text: 'hello' }])
  })
  it('stays compatible with the old server (text, proposal, done with message, error only)', () => {
    const p = createSseParser()
    const evs = p.push(line({ type: 'text', text: 'Hi' }) + line({ type: 'proposal', proposal_id: 'p1' }) + line({ type: 'done', message: 'Hi', actions_summary: [], proposal_id: 'p1' }) + line({ type: 'error', error: 'Nope' }))
    expect(evs).toEqual([
      { type: 'text', text: 'Hi' },
      { type: 'proposal', proposalId: 'p1' },
      { type: 'done', message: 'Hi', messageId: null, actionIds: [], actionsEnabled: null },
      { type: 'error', error: 'Nope' },
    ])
  })
  it('skips junk: bad json, unknown types, unknown action kinds, actions without params', () => {
    expect(parseStreamEvent('{nope')).toBeNull()
    expect(parseStreamEvent(JSON.stringify({ type: 'surprise' }))).toBeNull()
    expect(parseStreamEvent(JSON.stringify({ type: 'action', action: { id: 'a', kind: 'delete_everything', params: {} } }))).toBeNull()
    expect(parseStreamEvent(JSON.stringify({ type: 'action', action: { id: 'a', kind: 'add_todo' } }))).toBeNull()
    expect(parseStreamEvent(JSON.stringify({ type: 'status', label: '' }))).toBeNull()
  })
  it('an unknown tier becomes the fuller review card; open_screen is always a link', () => {
    const a = parseStreamEvent(JSON.stringify({ type: 'action', action: { id: 'a', kind: 'add_expense', params: {}, requires: 'whatever' } })) as { action: { requires: string } }
    expect(a.action.requires).toBe('review')
    const b = parseStreamEvent(JSON.stringify({ type: 'action', action: { id: 'b', kind: 'open_screen', params: { open_param: 'settle' }, requires: 'tap' } })) as { action: { requires: string } }
    expect(b.action.requires).toBe('link')
  })
})

describe('the travel and plan kinds are known', () => {
  it('parses an action stream event of each new kind, and still drops an unknown one', () => {
    for (const kind of ['set_travel', 'add_plan_item']) {
      const ev = parseStreamEvent(JSON.stringify({ type: 'action', action: { id: 'a1', kind, params: { date: '2026-12-03' }, requires: 'tap', status: 'proposed' } }))
      expect(ev).toMatchObject({ type: 'action', action: { kind, requires: 'tap' } })
    }
    expect(parseStreamEvent(JSON.stringify({ type: 'action', action: { id: 'a1', kind: 'set_travel_for_sam', params: {}, requires: 'tap' } }))).toBeNull()
  })
})
