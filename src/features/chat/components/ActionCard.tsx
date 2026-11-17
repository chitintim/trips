import { useMemo, useRef, useState } from 'react'
import { moduleFor } from '../actions'
import { withOrigins } from '../actions/common'
import type { ExecCtx, LiveData } from '../actions/types'
import type { ChatRpc } from '../lib/chatApi'
import { canUndo, cardPhase, confirmAction, dismissAction, stuckMessage, undoAction, wasUndone, INVALID_MESSAGE } from '../lib/confirmFlow'
import type { ChatActionEnvelope } from '../lib/payload'
import { ActionCardView } from './ActionCardView'

const UNDONE_KEY = 'trips-chat-undone'

function readUndone(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(UNDONE_KEY) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}
function rememberUndone(id: string): void {
  try {
    const s = readUndone()
    s.add(id)
    localStorage.setItem(UNDONE_KEY, JSON.stringify([...s].slice(-200)))
  } catch {
    /* per-device convenience only */
  }
}

export interface ActionRuntime {
  rpc: ChatRpc
  /** A fresh execution context (live data is re-read from the cache each time). */
  makeCtx: () => ExecCtx
  /** Called with the newest known envelope after any step. */
  onUpdate: (action: ChatActionEnvelope) => void
  /** Re-read my actions from the server. */
  recheckServer: () => Promise<void>
  /** Put a new request in the chat box for the person to send ("Ask again" on a card that went stale). */
  askAgain?: (text: string) => void
}

/** Connected card: re-checks itself against live data as it changes, and runs Confirm / Not now / Undo. */
export function ActionCard({ action, live, runtime }: { action: ChatActionEnvelope; live: LiveData | null; runtime: ActionRuntime }) {
  const mod = moduleFor(action.kind)
  const [running, setRunning] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [staleNow, setStaleNow] = useState<string | null>(null)
  const [doneText, setDoneText] = useState<string | null>(null)
  const [undoing, setUndoing] = useState(false)
  const [undoneHere, setUndone] = useState(() => readUndone().has(action.id))
  const [blocked, setBlocked] = useState<string | null>(null)
  const undone = undoneHere || wasUndone(action)
  const tapped = useRef(false)

  const invalid = !mod || !mod.validate(action.params)
  const view = useMemo(() => (mod && live && !invalid ? withOrigins(mod.view(action, live), action.preview) : null), [mod, live, action, invalid])
  const liveStale = useMemo(() => (mod && live && !invalid && action.status === 'proposed' ? mod.recheck(action, live) : null), [mod, live, action, invalid])
  const stale = staleNow ?? liveStale

  if (!mod || !live) return null
  const nowMs = Date.now()
  const phase = cardPhase(action, { running, stale, blocked }, nowMs)
  if (action.requires === 'link') return null

  const fallback: ChatActionEnvelope = action
  const patch = (status: ChatActionEnvelope['status'], extra: Partial<ChatActionEnvelope> = {}): ChatActionEnvelope => ({ ...fallback, status, ...extra })

  const onConfirm = async () => {
    if (tapped.current || running) return // double tap: the first one is already running
    tapped.current = true
    setRunning(true)
    setMessage(null)
    setBlocked(null)
    try {
      const out = await confirmAction(action, { rpc: runtime.rpc, ctx: runtime.makeCtx() })
      switch (out.kind) {
        case 'done':
          setDoneText(out.doneText)
          runtime.onUpdate(out.action && out.action.status === 'done' ? out.action : patch('done', { result: out.result, finished_at: new Date().toISOString() }))
          break
        case 'busy':
          break
        case 'stale':
          setStaleNow(out.reason)
          break
        case 'invalid':
          setBlocked(INVALID_MESSAGE)
          break
        case 'blocked':
          setBlocked(out.message)
          break
        case 'failed':
          setMessage(out.message)
          runtime.onUpdate(out.action ?? patch('failed', { error: out.message }))
          break
        case 'expired':
          runtime.onUpdate(out.action ?? patch('expired'))
          break
        case 'not_proposed':
        case 'already_started':
          runtime.onUpdate(out.action ?? patch('executing'))
          void runtime.recheckServer()
          break
      }
    } finally {
      tapped.current = false
      setRunning(false)
    }
  }

  const onDismiss = async () => {
    setRunning(true)
    setBlocked(null)
    if (phase === 'stuck') {
      // It started but never finished: close the row as "didn't finish" (never run again from here) so it stops counting.
      const note = stuckMessage(action.kind)
      try {
        const r = await runtime.rpc.finish(action.id, false, null, note)
        runtime.onUpdate(r.action ?? patch('failed', { error: note }))
      } catch {
        runtime.onUpdate(patch('failed', { error: note }))
      }
      setRunning(false)
      return
    }
    const out = await dismissAction(action, runtime.rpc)
    setRunning(false)
    if (out.ok) runtime.onUpdate(out.action ?? patch('dismissed'))
    else if (out.action) runtime.onUpdate(out.action)
    else setBlocked(out.message ?? "That didn't work. Please try again.")
  }

  const onUndo = async () => {
    setUndoing(true)
    const out = await undoAction(action, runtime.makeCtx(), runtime.rpc)
    setUndoing(false)
    if (out.ok) {
      rememberUndone(action.id)
      setUndone(true)
    } else {
      setMessage(out.message)
    }
  }

  if (!view) {
    return (
      <div className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-3 text-sm text-[var(--text-muted)]" data-testid="action-card" data-phase="invalid">
        {INVALID_MESSAGE}
      </div>
    )
  }

  return (
    <ActionCardView
      view={view}
      tier={action.requires === 'tap' ? 'tap' : 'review'}
      phase={phase}
      message={phase === 'stale' ? stale : phase === 'blocked' ? blocked : phase === 'stuck' ? stuckMessage(action.kind) : message ?? action.error}
      doneText={doneText}
      invalid={invalid}
      showUndo={canUndo(action, nowMs, live)}
      undoing={undoing}
      undone={undone}
      onConfirm={() => void onConfirm()}
      onDismiss={() => void onDismiss()}
      onUndo={() => void onUndo()}
      onAskAgain={runtime.askAgain ? () => runtime.askAgain?.(view.line) : undefined}
    />
  )
}
