/**
 * open_screen: a link card to the right screen in the app. Used for everything the assistant must never
 * do itself (decide, book, freeze, delete, reset, settle for someone, reminder settings, vote for someone
 * else). NOT gated by the actions flag and writes nothing, not even chat_actions: it emits an envelope
 * (kind 'open_screen', requires 'link', id 'link-<turnId>-<n>') that is never persisted.
 * The `?open=` value is built only from deepLinks.ts with every id verified to exist on THIS trip.
 */
import { z } from 'npm:zod@3'
import { refuse, type Json, type ToolCtx, type ToolModule, type ToolResult } from '../types.ts'
import type { OpenScreenParams, OpenScreenPreview } from './cards.ts'
import { formatOpenParam, isIdTarget, OPEN_TARGETS, TARGET_LABELS, type IdTarget } from './deepLinks.ts'
import { baseBasis, parseInput, tripState, uuid } from './common.ts'

export const MAX_LINKS_PER_TURN = 5

const Input = z
  .object({
    target: z.enum(OPEN_TARGETS as unknown as [string, ...string[]]),
    id: uuid.nullable(),
  })
  .strict()

export const openScreenSchema = {
  type: 'object',
  properties: {
    target: {
      type: 'string',
      enum: [...OPEN_TARGETS],
      description:
        'Which screen. With an id: question, todo, bring, payment, item, claim (an expense), decide (a question; organisers), book (an option; organisers). Without an id: todos, rsvp, answer-all, settle, travel-details, setup (organisers), actions, actions-bring.',
    },
    id: { type: ['string', 'null'], format: 'uuid', description: 'The id for targets that need one (from the trip context or a tool result); null otherwise.' },
  },
  required: ['target', 'id'],
  additionalProperties: false,
}

interface Found {
  subject: string | null
}

async function one(ctx: ToolCtx, table: string, cols: string, id: string, tripScoped = true): Promise<Record<string, unknown> | null> {
  let q = ctx.client.from(table).select(cols).eq('id', id)
  if (tripScoped) q = q.eq('trip_id', ctx.tripId)
  const { data, error } = await q.maybeSingle()
  return error || !data ? null : (data as unknown as Record<string, unknown>)
}

/** Verify an id exists on THIS trip for the target. Returns the subject title, or a refusal. */
async function verify(ctx: ToolCtx, target: IdTarget, id: string): Promise<Found | ToolResult> {
  const gone = (what: string) => refuse(`That ${what} was not found on this trip. Use an id from the trip context or a tool result.`)
  const organiserOnly = (what: string) => refuse(`Only organisers can ${what}. Tell the person to ask an organiser.`)
  switch (target) {
    case 'question': {
      const r = await one(ctx, 'planning_sections', 'id,title', id)
      return r ? { subject: String(r.title) } : gone('question')
    }
    case 'decide': {
      if (!ctx.me.canManageTrip) return organiserOnly('decide a question')
      const r = await one(ctx, 'planning_sections', 'id,title', id)
      return r ? { subject: String(r.title) } : gone('question')
    }
    case 'book': {
      if (!ctx.me.canManageTrip) return organiserOnly('mark something booked')
      const o = await one(ctx, 'options', 'id,title,section_id', id, false)
      if (!o) return gone('option')
      const s = await one(ctx, 'planning_sections', 'id,title', String(o.section_id))
      return s ? { subject: String(o.title) } : gone('option')
    }
    case 'todo': {
      const r = await one(ctx, 'trip_actions', 'id,title', id)
      return r ? { subject: String(r.title) } : gone('to-do')
    }
    case 'bring': {
      const r = await one(ctx, 'trip_checklists', 'id,title', id)
      return r ? { subject: String(r.title) } : gone('bring item')
    }
    case 'payment': {
      const r = await one(ctx, 'settlements', 'id', id)
      return r ? { subject: null } : gone('payment')
    }
    case 'claim': {
      const r = await one(ctx, 'expenses', 'id,description', id)
      return r ? { subject: String(r.description) } : gone('expense')
    }
    case 'item': {
      const ev = await one(ctx, 'trip_timeline_events', 'id,title', id)
      if (ev) return { subject: String(ev.title) }
      const o = await one(ctx, 'options', 'id,title,section_id', id, false)
      if (o) {
        const s = await one(ctx, 'planning_sections', 'id', String(o.section_id))
        if (s) return { subject: String(o.title) }
      }
      return gone('plan item')
    }
  }
}

async function run(raw: unknown, ctx: ToolCtx): Promise<ToolResult> {
  const parsed = parseInput(Input, raw)
  if (!parsed.ok) return parsed.result
  const target = parsed.data.target as (typeof OPEN_TARGETS)[number]
  const id = parsed.data.id

  let subject: string | null = null
  if (isIdTarget(target)) {
    if (!id) return refuse(`The "${target}" screen needs an id.`)
    const found = await verify(ctx, target, id)
    if ('content' in found) return found
    subject = found.subject
  } else {
    if (id) return refuse(`The "${target}" screen takes no id. Send id null.`)
    if (target === 'setup' && !ctx.me.canManageTrip) return refuse('Only organisers can open trip setup.')
    if ((target === 'rsvp' || target === 'travel-details') && !ctx.me.isOnRoster) return refuse("You're not on this trip's roster.")
  }

  const openParam = formatOpenParam(target, id)
  const memoKey = `open_screen:${openParam}`
  if (ctx.memo.has(memoKey)) return (await ctx.memo.get(memoKey)) as ToolResult
  const n = [...ctx.memo.keys()].filter((k) => k.startsWith('open_screen:')).length + 1
  if (n > MAX_LINKS_PER_TURN) return refuse(`At most ${MAX_LINKS_PER_TURN} links per message.`)

  const label = TARGET_LABELS[target]
  const result: ToolResult = { content: { ok: true, link: { label, target, open_param: openParam } } }
  ctx.memo.set(memoKey, Promise.resolve(result))

  const params: OpenScreenParams = { target, id, open_param: openParam }
  const preview: OpenScreenPreview = { label, subject }
  const state = await tripState(ctx)
  ctx.emitAction({
    id: `link-${ctx.turnId}-${n}`,
    kind: 'open_screen',
    params: params as unknown as Json,
    preview: preview as unknown as Json,
    basis: baseBasis(ctx, state) as unknown as Json,
    requires: 'link',
    status: 'proposed',
    expires_at: null,
    turn_id: ctx.turnId,
  })
  return result
}

export const openScreen: ToolModule = {
  name: 'open_screen',
  description:
    'Show the person a button that opens the right screen in the app. Use it for anything you must not do yourself: deciding a question, marking something booked, freezing/unfreezing balances, deleting, resetting, settling payments, changing reminder settings, or voting/ticking for someone else. Also handy to point at a question, to-do or expense. Writes nothing.',
  statusLabel: 'Finding the right screen…',
  inputSchema: openScreenSchema,
  run,
}
