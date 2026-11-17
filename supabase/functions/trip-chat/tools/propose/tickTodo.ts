/**
 * propose_tick_todo: tick / untick / claim / give back MY OWN to-do. Never someone else's.
 * Executor: toggleTodo / claimTodo (trip_actions) or toggleChecklistItem / claimChecklistItem (bring list).
 * Rules are todoModel's canTick / canClaim / canUnclaim, self-only.
 */
import { z } from 'npm:zod@3'
import { refuse, type ToolCtx, type ToolModule, type ToolResult } from '../types.ts'
import type { TickOp, TickTodoBasis, TickTodoParams, TickTodoPreview } from './cards.ts'
import { baseBasis, FINISHED_MESSAGE, gate, originsFor, parseInput, personRef, storeProposal, tripState, uuid } from './common.ts'

const Input = z
  .object({
    todo_ref: z.object({ source: z.enum(['action', 'checklist']), id: uuid }).strict(),
    op: z.enum(['tick', 'untick', 'claim', 'give_back']),
  })
  .strict()

export const tickTodoSchema = {
  type: 'object',
  properties: {
    todo_ref: {
      type: 'object',
      properties: {
        source: { type: 'string', enum: ['action', 'checklist'], description: 'Which list the to-do id comes from (as shown in the to-do list you were given).' },
        id: { type: 'string', format: 'uuid' },
      },
      required: ['source', 'id'],
      additionalProperties: false,
    },
    op: { type: 'string', enum: ['tick', 'untick', 'claim', 'give_back'], description: 'tick/untick: mark my own to-do done or not done. claim: take an "anyone" to-do. give_back: hand one I claimed back.' },
  },
  required: ['todo_ref', 'op'],
  additionalProperties: false,
}

const OP_LABEL: Record<TickOp, string> = {
  tick: 'Tick off',
  untick: 'Mark as not done',
  claim: "I'll do it",
  give_back: 'Give it back',
}

function openLink(source: string, id: string): string {
  return `use open_screen with target "${source === 'checklist' ? 'bring' : 'todo'}" and id "${id}"`
}

async function run(raw: unknown, ctx: ToolCtx): Promise<ToolResult> {
  const blocked = gate(ctx, 'group')
  if (blocked) return blocked
  const parsed = parseInput(Input, raw)
  if (!parsed.ok) return parsed.result
  const { todo_ref: ref, op } = parsed.data
  const state = await tripState(ctx)
  if (state.finished) return refuse(FINISHED_MESSAGE)
  const me = ctx.userId

  let title: string
  let createdBy: string | null
  let current: 'open' | 'done'
  let isGroup = false
  let anyone = false
  let completedAt: string | null = null
  let myCompletion: boolean | null = null
  let assignedTo: string | null
  let done: boolean | null

  if (ref.source === 'action') {
    const { data, error } = await ctx.client
      .from('trip_actions')
      .select('id,trip_id,title,assigned_to,who_mode,completed_at,completed_by,section_id,created_by')
      .eq('id', ref.id)
      .eq('trip_id', ctx.tripId)
      .maybeSingle()
    if (error || !data) return refuse('That to-do was not found on this trip.')
    const row = data as {
      title: string; assigned_to: string | null; who_mode?: string | null; completed_at: string | null; section_id: string | null; created_by: string | null
    }
    title = row.title
    createdBy = row.created_by
    assignedTo = row.assigned_to
    completedAt = row.completed_at
    anyone = row.who_mode === 'anyone'
    isGroup = !anyone && !row.assigned_to
    if (row.section_id) {
      const { data: sec } = await ctx.client.from('planning_sections').select('status').eq('id', row.section_id).eq('trip_id', ctx.tripId).maybeSingle()
      if ((sec as { status?: string } | null)?.status === 'completed') return refuse('That to-do is no longer needed: its question is already decided.')
    }
    if (isGroup) {
      const { data: comp } = await ctx.client.from('trip_action_completions').select('user_id').eq('action_id', ref.id).eq('user_id', me)
      myCompletion = ((comp ?? []) as unknown[]).length > 0
      current = myCompletion ? 'done' : 'open'
      if (op === 'claim' || op === 'give_back') return refuse('This to-do is for everyone, so each person just ticks their own. Use tick or untick.')
    } else if (anyone && !row.assigned_to) {
      current = 'open'
      if (op !== 'claim') return refuse('Nobody has taken this "anyone" to-do yet. Claim it first (op "claim").')
    } else {
      if (row.assigned_to !== me) {
        const who = row.assigned_to ? personRef(ctx, row.assigned_to).name : 'someone else'
        return refuse(`That to-do belongs to ${who}; I can only change your own. If they need to act, ${openLink(ref.source, ref.id)} so they can do it themselves.`)
      }
      current = row.completed_at ? 'done' : 'open'
      if (op === 'claim') return refuse('You already hold this to-do.')
      if (op === 'give_back' && !anyone) return refuse('Only an "anyone" to-do you claimed can be given back.')
      if (op === 'give_back' && current === 'done') return refuse('That one is already done; untick it first if you want to give it back.')
    }
  } else {
    const { data, error } = await ctx.client
      .from('trip_checklists')
      .select('id,trip_id,title,assigned_to,done,created_by')
      .eq('id', ref.id)
      .eq('trip_id', ctx.tripId)
      .maybeSingle()
    if (error || !data) return refuse('That bring item was not found on this trip.')
    const row = data as { title: string; assigned_to: string | null; done: boolean | null; created_by: string | null }
    title = row.title
    createdBy = row.created_by
    assignedTo = row.assigned_to
    current = row.done ? 'done' : 'open'
    if (!row.assigned_to) {
      if (op !== 'claim') return refuse('Nobody is bringing this yet. Claim it first (op "claim").')
    } else if (row.assigned_to !== me) {
      return refuse(`${personRef(ctx, row.assigned_to).name} is bringing that; I can only change your own. ${openLink(ref.source, ref.id)}.`)
    } else if (op === 'claim') return refuse('You already hold this one.')
    else if (op === 'give_back' && current === 'done') return refuse('That one is already done; untick it first if you want to give it back.')
  }

  if (op === 'tick' && current === 'done') return refuse('That is already ticked off.')
  if (op === 'untick' && current === 'open') return refuse('That is not ticked off, so there is nothing to untick.')
  done = op === 'tick' ? true : op === 'untick' ? false : null

  const params: TickTodoParams = {
    source: ref.source,
    id: ref.id,
    op,
    user_id: me,
    is_group_action: isGroup,
    anyone,
    done,
    claim: op === 'claim' ? true : op === 'give_back' ? false : null,
  }
  const preview: TickTodoPreview = {
    title,
    op_label: OP_LABEL[op],
    current_state: current,
    content_origin: createdBy && createdBy !== me ? await originsFor(ctx, [{ field: 'title', text: title, sources: ['todo'] }]) : {},
  }
  const basis: TickTodoBasis = {
    ...baseBasis(ctx, state),
    completed_at: completedAt,
    my_completion: myCompletion,
    assigned_to: assignedTo,
    done: ref.source === 'checklist' ? current === 'done' : null,
  }
  return storeProposal(ctx, { kind: 'tick_todo', params, preview, basis, requires: 'tap' })
}

export const proposeTickTodo: ToolModule = {
  name: 'propose_tick_todo',
  description:
    "Suggest ticking off, unticking, claiming or giving back one of the PERSON'S OWN to-dos (including bring-list items). Never for someone else: for that, use open_screen. Nothing changes until they tap Confirm.",
  statusLabel: 'Preparing to update your to-do…',
  inputSchema: tickTodoSchema,
  run,
}
