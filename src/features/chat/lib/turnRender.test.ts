import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('../../../lib/supabase', () => ({ supabase: { from: vi.fn(), rpc: vi.fn(), auth: { getSession: vi.fn() } } }))

import { collapseRepeatedBlocks, ChatMarkdown } from './markdown'
import { dedupeLinkCards } from './linkTargets'
import { outcomeLine } from './confirmFlow'
import { envelope, liveFixture, ME, todoParams } from './chatFixtures'
import { moduleFor } from '../actions'
import { addTodoModule } from '../actions/addTodo'
import { tickTodoModule } from '../actions/tickTodo'
import { ActionCardView } from '../components/ActionCardView'
import type { ExecCtx } from '../actions/types'
import type { ChatDeps } from '../actions/deps'

const tick = (over = {}) => envelope('tick_todo', { source: 'action', id: 'gone', op: 'tick', user_id: ME, is_group_action: false, anyone: false, done: true, claim: null }, { requires: 'tap', preview: { title: 'Book the ferry' }, ...over })

describe('one reply renders once', () => {
  it('collapses a paragraph repeated word for word, keeps short and distinct ones', () => {
    const a = 'You owe Sam 12.50 pounds in total across the trip.'
    expect(collapseRepeatedBlocks(`${a}\n\nSettle up when you can.\n\n${a}`)).toBe(`${a}\n\nSettle up when you can.`)
    expect(collapseRepeatedBlocks('Yes\n\nYes')).toBe('Yes\n\nYes')
    expect(renderToStaticMarkup(createElement(ChatMarkdown, null, `${a}\n\n${a}`)).split('Sam 12.50').length).toBe(2)
  })

  it('shows an identical link button once, even with different card ids', () => {
    const link = (id: string, open_param: string) => envelope('open_screen', { target: 'settle', id: null, open_param }, { id, requires: 'link' })
    const out = dedupeLinkCards([link('link-t-0', 'settle'), link('link-t-1', 'settle'), link('link-t-2', 'todos'), envelope('add_todo', todoParams())])
    expect(out.map((a) => a.id)).toEqual(['link-t-0', 'link-t-2', 'act-add_todo'])
  })
})

describe('a card keeps what it was about', () => {
  it('tick card names the to-do from the stored copy once the live row is gone', () => {
    const view = tickTodoModule.view(tick(), liveFixture({ actions: [] }))
    expect(view.rows[0].value).toBe('Book the ferry')
    expect(view.line).toContain('Book the ferry')
  })
  it('add_todo card still names the to-do after it is deleted (Undo)', () => {
    const a = envelope('add_todo', todoParams({ title: 'Buy tickets' }), { status: 'done', result: { created_id: 'x', undone_at: '2026-11-18T10:00:00Z' } })
    expect(addTodoModule.view(a, liveFixture({ actions: [] })).title + addTodoModule.view(a, liveFixture({ actions: [] })).line).toContain('Buy tickets')
  })
})

describe('a reloaded finished card keeps its outcome line', () => {
  const done = (kind: Parameters<typeof envelope>[0], params: Record<string, unknown>) => envelope(kind, params, { status: 'done', finished_at: '2026-11-18T10:00:00Z' })
  it('is derived from the stored row, per kind, and only when done', () => {
    expect(outcomeLine(done('add_todo', todoParams()))).toBe('Added to your to-dos.')
    expect(outcomeLine(done('tick_todo', tick().params))).toBe('Ticked off.')
    expect(outcomeLine(done('suggest_option', { idea: true }))).toBe('Added to Ideas.')
    expect(outcomeLine(done('set_travel', {}))).toBe('Travel saved.')
    expect(outcomeLine(done('add_plan_item', {}))).toBe('Added to the plan.')
    expect(outcomeLine(envelope('add_todo', todoParams(), { status: 'dismissed' }))).toBeNull()
    expect(outcomeLine(envelope('add_todo', todoParams()))).toBeNull()
  })
  it('matches the text each executor returns live', async () => {
    const deps = { createTodo: vi.fn(async () => ({ id: 'n1' })), toggleTodo: vi.fn(async () => ({ undo: { fn: 'toggleTodo', args: [], label: '' } })) } as unknown as ChatDeps
    const ctx = { tripId: 't1', userId: ME, queryClient: {} as never, live: () => liveFixture(), refresh: async () => undefined, logActivity: vi.fn(), deps, now: () => new Date() } as ExecCtx
    for (const a of [envelope('add_todo', todoParams()), tick({ id: 'x1' })]) {
      const out = await moduleFor(a.kind)!.execute(a, ctx)
      expect(outcomeLine({ ...a, status: 'done' })).toBe(out.doneText)
    }
  })
  it('the done card renders "Done ✓ · line" and, after Undo, still the title', () => {
    const a = done('add_todo', todoParams({ title: 'Buy tickets' }))
    const html = renderToStaticMarkup(
      createElement(ActionCardView, { view: addTodoModule.view(a, liveFixture()), tier: 'tap', phase: 'done', message: null, doneText: outcomeLine(a), invalid: false, showUndo: false, undoing: false, undone: false, onConfirm: () => undefined, onDismiss: () => undefined, onUndo: () => undefined })
    )
    expect(html).toContain('Added to your to-dos.')
    expect(html).toContain('Buy tickets')
  })
})
