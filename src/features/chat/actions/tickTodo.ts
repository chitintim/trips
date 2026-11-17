import { invalidateAfterTodoChange } from '../../../lib/queries/useActions'
import { invalidateAfterChecklistChange } from '../../../lib/queries/useChecklists'
import type { TickTodoParams } from '../lib/payload'
import type { ActionModule, ExecCtx, LiveData } from './types'
import { isBool, isNonEmptyStr, isObj } from './common'

const p = (a: { params: Record<string, unknown> }) => a.params as unknown as TickTodoParams

interface Found {
  title: string
  done: boolean
  assignedTo: string | null
}

function find(params: TickTodoParams, live: LiveData): Found | null {
  if (params.source === 'checklist') {
    const c = live.checklists.find((x) => x.id === params.id)
    return c ? { title: c.title, done: !!c.done, assignedTo: c.assigned_to ?? null } : null
  }
  const a = live.actions.find((x) => x.id === params.id)
  if (!a) return null
  const done = params.is_group_action ? (a.trip_action_completions ?? []).some((c) => c.user_id === live.userId) : !!a.completed_at
  return { title: a.title, done, assignedTo: a.assigned_to ?? null }
}

const OP_LABEL: Record<TickTodoParams['op'], string> = { tick: 'Tick off', untick: 'Mark as not done', claim: "I'll do it", give_back: 'Give back' }
const CONFIRM: Record<TickTodoParams['op'], string> = { tick: 'Tick it off', untick: 'Untick', claim: "I'll do it", give_back: 'Give it back' }

/** Names of the shared functions an undo descriptor may call (the descriptor is stored data; only these run). */
const UNDO_FNS = ['toggleTodo', 'claimTodo', 'toggleChecklistItem', 'claimChecklistItem'] as const
type UndoFn = (typeof UNDO_FNS)[number]

export const tickTodoModule: ActionModule = {
  validate(x) {
    return (
      (x.source === 'action' || x.source === 'checklist') &&
      isNonEmptyStr(x.id) &&
      (x.op === 'tick' || x.op === 'untick' || x.op === 'claim' || x.op === 'give_back') &&
      isNonEmptyStr(x.user_id) &&
      isBool(x.is_group_action) &&
      isBool(x.anyone) &&
      (x.op === 'tick' || x.op === 'untick' || x.op === 'claim' || x.op === 'give_back')
    )
  },

  view(action, live) {
    const params = p(action)
    const found = find(params, live)
    const title = found?.title ?? 'a to-do'
    return {
      icon: params.op === 'claim' || params.op === 'give_back' ? '🙋' : '☑️',
      title: OP_LABEL[params.op],
      rows: [{ label: 'To-do', value: title, quoted: true, field: 'title' }],
      line: `${OP_LABEL[params.op]}: "${title}"`,
      confirmLabel: CONFIRM[params.op],
      notes: [],
    }
  },

  recheck(action, live) {
    const params = p(action)
    // Only ever for the signed-in person: a card for someone else's account never runs.
    if (params.user_id !== live.userId) return 'This suggestion was made for a different account.'
    const found = find(params, live)
    if (!found) return 'That to-do is no longer on the list.'
    if (params.op === 'tick' && found.done) return 'That is already ticked off.'
    if (params.op === 'untick' && !found.done) return 'That is already not done.'
    if (params.op === 'claim' && found.assignedTo) return found.assignedTo === live.userId ? 'You already have that one.' : 'Someone else has taken that one.'
    if (params.op === 'give_back' && found.assignedTo !== live.userId) return "That one isn't yours any more."
    return null
  },

  async execute(action, ctx) {
    const params = p(action)
    const { deps, tripId, userId } = ctx
    let undo: { fn: string; args: unknown[]; label: string }
    if (params.source === 'action') {
      if (params.op === 'tick' || params.op === 'untick') {
        undo = (await deps.toggleTodo(tripId, { actionId: params.id, isGroupAction: params.is_group_action, userId, done: params.op === 'tick', anyone: params.anyone })).undo
      } else {
        undo = (await deps.claimTodo({ id: params.id, userId, claim: params.op === 'claim' })).undo
      }
    } else if (params.op === 'tick' || params.op === 'untick') {
      undo = (await deps.toggleChecklistItem({ id: params.id, done: params.op === 'tick', doneBy: userId })).undo
    } else {
      undo = (await deps.claimChecklistItem({ id: params.id, userId, claim: params.op === 'claim' })).undo
    }
    const text = { tick: 'Ticked off.', untick: 'Marked as not done.', claim: "It's yours.", give_back: 'Given back.' }[params.op]
    return { result: { undo }, doneText: text }
  },

  undoBlocked(action, live) {
    const params = p(action)
    const found = find(params, live)
    if (!found) return 'That to-do is no longer on the list.'
    // Still the way my action left it?
    const left = params.op === 'tick' ? found.done : params.op === 'untick' ? !found.done : params.op === 'claim' ? found.assignedTo === live.userId : found.assignedTo === null
    return left ? null : 'That to-do has changed since, so it is left as it is.'
  },

  async undo(action, ctx) {
    const d = action.result?.undo
    if (!isObj(d) || !(UNDO_FNS as readonly unknown[]).includes(d.fn) || !Array.isArray(d.args)) throw new Error('Nothing to undo.')
    await runUndo(d.fn as UndoFn, d.args, ctx)
  },

  invalidate(ctx) {
    void invalidateAfterTodoChange(ctx.queryClient, ctx.tripId)
    void invalidateAfterChecklistChange(ctx.queryClient, ctx.tripId)
  },
}

async function runUndo(fn: UndoFn, args: unknown[], ctx: ExecCtx): Promise<void> {
  const d = ctx.deps
  switch (fn) {
    case 'toggleTodo':
      await d.toggleTodo(...(args as Parameters<typeof d.toggleTodo>))
      return
    case 'claimTodo':
      await d.claimTodo(...(args as Parameters<typeof d.claimTodo>))
      return
    case 'toggleChecklistItem':
      await d.toggleChecklistItem(...(args as Parameters<typeof d.toggleChecklistItem>))
      return
    case 'claimChecklistItem':
      await d.claimChecklistItem(...(args as Parameters<typeof d.claimChecklistItem>))
      return
  }
}
