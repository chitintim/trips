import type { QueryClient } from '@tanstack/react-query'
import { reportError } from '../../../lib/reportError'
import { describeWriteError, refreshAfterRefusal } from '../../../lib/writeRefusals'
import { moduleFor } from '../actions'
import type { ExecCtx, LiveData } from '../actions/types'
import { ChatRpcError, type ChatRpc } from './chatApi'
import type { ChatActionEnvelope } from './payload'

/** How long after finishing a self-only action the Undo stays offered. */
export const UNDO_WINDOW_MS = 10 * 60 * 1000

export type ConfirmOutcome =
  | { kind: 'done'; result: Record<string, unknown>; doneText: string; action: ChatActionEnvelope | null }
  /** A second tap (or this device already running it): nothing was started. */
  | { kind: 'busy' }
  | { kind: 'already_started'; action: ChatActionEnvelope | null }
  | { kind: 'not_proposed'; action: ChatActionEnvelope | null }
  | { kind: 'expired'; action: ChatActionEnvelope | null }
  | { kind: 'stale'; reason: string }
  | { kind: 'invalid' }
  | { kind: 'failed'; message: string; action: ChatActionEnvelope | null }
  /** The bookkeeping call failed before anything ran (cap reached, signed out, not deployed): nothing was changed. */
  | { kind: 'blocked'; message: string }

export const INVALID_MESSAGE = "I can't show this suggestion properly, so it can't be run from here."
export const GENERIC_FAILURE = "That didn't go through. Please check the screen and try again."

/** Taps in flight on this device, by action id: a double tap never starts the work twice, even before the server answers. */
const inFlight = new Set<string>()
export function __resetInFlightForTests(): void {
  inFlight.clear()
}

/** Plain wording for whatever a shared write function threw. */
export function failureMessage(err: unknown): string {
  const text = describeWriteError(err)
  if (!text) return GENERIC_FAILURE
  // Raw database wording is never shown: a thrown supabase error without a hint keeps only our own plain sentences.
  if (/^(new row violates|permission denied|duplicate key|null value|violates|JWT|FetchError|TypeError)/i.test(text)) return GENERIC_FAILURE
  const code = (err as { code?: unknown } | null)?.code
  if (code === '42501' && !/permission|allowed|organi[sz]er/i.test(text)) return "You don't have permission to do that."
  return text
}

export interface ConfirmDeps {
  rpc: ChatRpc
  ctx: ExecCtx
}

/**
 * Confirm one proposed action. Nothing runs without this being called from a tap.
 *   re-check against fresh live data -> begin_chat_action (atomic proposed->executing) -> the shared write
 *   function (the SAME one the screen uses) -> finish_chat_action -> refresh the same query keys the screen would.
 */
export async function confirmAction(action: ChatActionEnvelope, { rpc, ctx }: ConfirmDeps): Promise<ConfirmOutcome> {
  const mod = moduleFor(action.kind)
  if (!mod || action.requires === 'link') return { kind: 'invalid' }
  if (inFlight.has(action.id)) return { kind: 'busy' }
  inFlight.add(action.id)
  try {
    if (!mod.validate(action.params)) return { kind: 'invalid' }

    // Look at the true state first: a suggestion is only valid for the data it was made against.
    await ctx.refresh().catch(() => undefined)
    const stale = mod.recheck(action, ctx.live())
    if (stale) return { kind: 'stale', reason: stale }

    let started
    try {
      started = await rpc.begin(action.id)
    } catch (err) {
      return { kind: 'blocked', message: err instanceof ChatRpcError ? err.message : GENERIC_FAILURE }
    }
    if (!started.started) {
      if (started.reason === 'expired') return { kind: 'expired', action: started.action }
      if (started.reason === 'not_proposed') return { kind: 'not_proposed', action: started.action }
      return { kind: 'already_started', action: started.action }
    }

    let outcome
    try {
      outcome = await mod.execute(action, ctx)
    } catch (err) {
      const message = failureMessage(err)
      reportError(err, action.kind === 'add_expense' ? 'createExpense' : `chat:${action.kind}`) // these writes no longer go through a mutation, so the global error reporter would never see them
      refreshAfterRefusal(ctx.queryClient as QueryClient, ctx.tripId, err)
      mod.invalidate(ctx) // a half-done write must not leave the screen stale
      let finished = null
      try {
        finished = (await rpc.finish(action.id, false, null, message.slice(0, 500))).action
      } catch {
        /* the card still shows the failure; the row stays "executing" and offers Check */
      }
      return { kind: 'failed', message, action: finished }
    }

    mod.invalidate(ctx)
    let finishedAction: ChatActionEnvelope | null = null
    try {
      finishedAction = (await rpc.finish(action.id, true, outcome.result)).action
    } catch {
      /* the write happened; only the bookkeeping failed. Report success. */
    }
    return { kind: 'done', result: outcome.result, doneText: outcome.doneText, action: finishedAction }
  } finally {
    inFlight.delete(action.id)
  }
}

export interface DismissOutcome {
  ok: boolean
  action: ChatActionEnvelope | null
  message?: string
}

export async function dismissAction(action: ChatActionEnvelope, rpc: ChatRpc): Promise<DismissOutcome> {
  try {
    const r = await rpc.dismiss(action.id)
    return { ok: r.dismissed, action: r.action }
  } catch (err) {
    return { ok: false, action: null, message: err instanceof ChatRpcError ? err.message : GENERIC_FAILURE }
  }
}

/** Undo is offered for 10 minutes after a self-only action finished, on kinds that can be reversed. */
export function canUndo(action: ChatActionEnvelope, nowMs: number, live?: LiveData | null): boolean {
  const mod = moduleFor(action.kind)
  if (!mod?.undo || action.status !== 'done' || action.requires !== 'tap' || !action.finished_at) return false
  if (wasUndone(action)) return false
  const t = Date.parse(action.finished_at)
  if (!Number.isFinite(t) || nowMs - t > UNDO_WINDOW_MS) return false
  // Only while what the action wrote is still as it left it.
  if (live && mod.undoBlocked && mod.undoBlocked(action, live)) return false
  return true
}

/** The server row says it was undone (any device). */
export function wasUndone(action: ChatActionEnvelope): boolean {
  return typeof action.result?.undone_at === 'string'
}

export async function undoAction(action: ChatActionEnvelope, ctx: ExecCtx, rpc?: ChatRpc): Promise<{ ok: true } | { ok: false; message: string }> {
  const mod = moduleFor(action.kind)
  if (!mod?.undo) return { ok: false, message: 'This one can only be changed from its own screen.' }
  try {
    // Look again first: if anyone changed what this wrote, leave it alone.
    await ctx.refresh().catch(() => undefined)
    const blocked = mod.undoBlocked?.(action, ctx.live())
    if (blocked) return { ok: false, message: blocked }
    await mod.undo(action, ctx)
    mod.invalidate(ctx)
    void rpc?.markUndone?.(action.id)
    return { ok: true }
  } catch (err) {
    mod.invalidate(ctx)
    return { ok: false, message: failureMessage(err) }
  }
}

/** Stuck in "executing" (the tab closed mid-write): offered "Did this go through?". */
export const STUCK_AFTER_MS = 2 * 60 * 1000
export function isStuck(action: ChatActionEnvelope, nowMs: number): boolean {
  if (action.status !== 'executing') return false
  const t = Date.parse(action.started_at ?? action.created_at ?? '')
  return Number.isFinite(t) && nowMs - t > STUCK_AFTER_MS
}

const STUCK_WHERE: Record<string, string> = {
  add_expense: 'the Money tab',
  add_todo: 'your to-dos',
  tick_todo: 'your to-dos',
  answer: 'the question',
  suggest_option: 'the Plan tab',
  create_question: 'the Plan tab',
  add_option: 'the Plan tab',
}
/** The wording for a card stuck at "executing". Never offers a retry: a money action must be looked for first. */
export function stuckMessage(kind: string): string {
  return `This didn't finish — check ${STUCK_WHERE[kind] ?? 'the app'} before trying again.`
}

const TICK_DONE: Record<string, string> = { tick: 'Ticked off.', untick: 'Marked as not done.', claim: "It's yours.", give_back: 'Given back.' }
/**
 * The outcome line of a finished card ("Added to your to-dos."), derived from the stored row so a reloaded card
 * reads the same as it did live. Must match the `doneText` each executor returns (see confirmFlow.test).
 */
export function outcomeLine(action: ChatActionEnvelope): string | null {
  if (action.status !== 'done') return null
  switch (action.kind) {
    case 'add_todo':
      return 'Added to your to-dos.'
    case 'tick_todo':
      return TICK_DONE[String(action.params.op)] ?? null
    case 'answer':
      return 'Your answer is recorded.'
    case 'add_expense':
      return 'Expense added.'
    case 'suggest_option':
      return action.params.idea ? 'Added to Ideas.' : 'Suggestion added.'
    case 'create_question':
      return 'Question added to the plan.'
    case 'add_option':
      return 'Option added.'
    default:
      return null
  }
}

const TERMINAL = new Set(['done', 'failed', 'dismissed', 'expired', 'edited_elsewhere'])
/** Combine a known envelope with a newer-looking one: an older snapshot (proposed / executing) never overwrites a finished card. */
export function mergeAction(prev: ChatActionEnvelope | undefined, incoming: ChatActionEnvelope): ChatActionEnvelope {
  if (!prev) return incoming
  if (TERMINAL.has(prev.status) && (incoming.status === 'proposed' || incoming.status === 'executing')) return prev
  if (prev.status === 'executing' && incoming.status === 'proposed') return prev
  return incoming
}

export type CardPhase = 'proposed' | 'running' | 'done' | 'failed' | 'dismissed' | 'expired' | 'edited' | 'stuck' | 'working_elsewhere' | 'stale' | 'blocked'

/** What the card shows, from the stored status plus this device's transient state. Pure. */
export function cardPhase(action: ChatActionEnvelope, local: { running: boolean; stale: string | null; blocked?: string | null }, nowMs: number): CardPhase {
  if (local.running) return 'running'
  switch (action.status) {
    case 'done':
      return 'done'
    case 'failed':
      return 'failed'
    case 'dismissed':
      return 'dismissed'
    case 'edited_elsewhere':
      return 'edited'
    case 'expired':
      return 'expired'
    case 'executing':
      return isStuck(action, nowMs) ? 'stuck' : 'working_elsewhere'
    case 'proposed': {
      if (action.expires_at && Date.parse(action.expires_at) <= nowMs) return 'expired'
      if (local.stale) return 'stale'
      return local.blocked ? 'blocked' : 'proposed'
    }
  }
}

export type { LiveData }
