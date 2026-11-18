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
import { formatOpenParam, isIdTarget, OPEN_TARGETS, TARGET_LABELS, type IdTarget, type OpenTargetName } from './deepLinks.ts'
import { baseBasis, parseInput, tripState, uuid } from './common.ts'

export const MAX_LINKS_PER_TURN = 5

/** Said to the model inside every open_screen result: the button is an extra, the words are the answer. */
export const OPEN_SCREEN_RESULT_NOTE =
  'The button is shown to the person. It is NOT your answer: your reply must still say, in words, what they asked (names, amounts, dates from the read tools), or briefly why you cannot do it.'

/** The exact content of a successful open_screen result (the eval builds the same one). */
export function openScreenResultContent(target: OpenTargetName, id: string | null): { ok: true; link: { label: string; target: string; open_param: string }; note: string } {
  return { ok: true, link: { label: TARGET_LABELS[target], target, open_param: formatOpenParam(target, id) }, note: OPEN_SCREEN_RESULT_NOTE }
}

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
  const label = TARGET_LABELS[target]
  // One button per destination per message: the same screen asked for twice (also under another target name that
  // reads the same on the button, e.g. todos / actions, or the same label and subject) shows once.
  const memoKey = `open_screen:${openParam}`
  const buttonKey = `open_screen:button:${label}|${subject ?? ''}`
  if (ctx.memo.has(memoKey)) return (await ctx.memo.get(memoKey)) as ToolResult
  if (ctx.memo.has(buttonKey)) return (await ctx.memo.get(buttonKey)) as ToolResult
  const n = [...ctx.memo.keys()].filter((k) => k.startsWith('open_screen:') && !k.startsWith('open_screen:button:')).length + 1
  if (n > MAX_LINKS_PER_TURN) return refuse(`At most ${MAX_LINKS_PER_TURN} links per message.`)

  const result: ToolResult = { content: openScreenResultContent(target, id) }
  ctx.memo.set(memoKey, Promise.resolve(result))
  ctx.memo.set(buttonKey, Promise.resolve(result))

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
    'Show the person a button that opens the right screen in the app. Use it for anything you must not do yourself: deciding a question, marking something booked, freezing/unfreezing balances (also "freeze/lock/close the trip"), deleting, resetting, settling payments, changing reminder settings, or voting/ticking for someone else. Also handy to point at a question, to-do or expense. Writes nothing. The button NEVER replaces your answer: for a question about money, receipts, to-dos or anything else you can look up, first call the read tools and answer in words with the real figures, and only then (optionally) add the button. For something you cannot do, say so in a sentence and add the button. Call it once per screen.',
  statusLabel: 'Finding the right screen…',
  inputSchema: openScreenSchema,
  run,
}
