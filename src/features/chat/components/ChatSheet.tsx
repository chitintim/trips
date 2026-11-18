import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Button, Chip, Modal, Skeleton, TextArea, UserAvatar } from '../../../components/ui'
import { useAuth } from '../../../hooks/useAuth'
import { useTripPermissions } from '../../../hooks/useTripPermissions'
import { queryKeys } from '../../../lib/queries/queryKeys'
import { useChatMessages, type ChatMessage } from '../../../lib/queries/useChat'
import { useProposals } from '../../../lib/queries/useProposals'
import { useParticipants } from '../../../lib/queries/useTrip'
import { useTripActivityLog } from '../../organizer/lib/activity'
import { defaultDeps } from '../actions/deps'
import type { ExecCtx } from '../actions/types'
import { chatActionsKey, chatThreadKey, makeChatRpc, markChatSeen, startNewChat, useChatActions, useChatThreadInfo } from '../lib/chatApi'
import { CHAT_OFF_MESSAGE } from '../lib/chatSettings'
import { useChatAvailability } from '../lib/useChatSettings'
import { chipsFor, spaceFor, type ChatChip } from '../lib/chips'
import { mergeAction } from '../lib/confirmFlow'
import { ownPendingProposals } from '../lib/ownProposals'
import { readLive, refreshLive, useChatLive } from '../lib/live'
import { dedupeLinkCards, detachedActions, resolveLink, storedLinks, withoutLinkCards } from '../lib/linkTargets'
import { ChatMarkdown } from '../lib/markdown'
import type { ChatActionEnvelope } from '../lib/payload'
import { ChatOffError, ChatQuotaError, streamChatMessage } from '../lib/streamChat'
import { statusLine } from '../lib/turnStatus'
import { useRevealedText } from '../lib/useRevealedText'
import { ActionCard, type ActionRuntime } from './ActionCard'
import { LinkCard } from './LinkCard'
import { ProposalReview } from './ProposalReview'
import type { Trip } from '../../../types'

export interface ChatSheetProps {
  isOpen: boolean
  onClose: () => void
  trip: Trip
  /** Tab the chat was opened from: picks the starter chips. */
  context?: string
  /** A link card was tapped: the shell closes the chat and opens `?open=<param>` (the same routing the emails use). */
  onOpenLink?: (openParam: string) => void
}

type ChatRow = ChatMessage & { thread_user_id?: string | null; turn_id?: string | null }

interface EchoMessage {
  id: string
  turnId: string
  content: string
}

const newId = (): string => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`)

const bubble = 'max-w-[85%] rounded-[var(--radius-lg)] px-3 py-2 text-sm break-words'

/**
 * Trip assistant. Private to the person (when the private-thread migration is live), streams its answer with a status line,
 * renders markdown safely, and shows suggested actions as cards built from structured data. Nothing is ever written
 * until the person taps Confirm; the write then goes through the same functions the screens use, under their own login.
 * Before the new tables / function exist it behaves as the old shared chat did (no cards arrive, no private header).
 */
export function ChatSheet({ isOpen, onClose, trip, context, onOpenLink }: ChatSheetProps) {
  const tripId = trip.id
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const { canManageTrip } = useTripPermissions(trip)
  const logActivity = useTripActivityLog(tripId)
  const { data: messages, isLoading } = useChatMessages(isOpen ? tripId : undefined)
  const { data: proposals } = useProposals(isOpen ? tripId : undefined)
  const { data: participants } = useParticipants(isOpen ? tripId : undefined)
  const { data: threadInfo } = useChatThreadInfo(isOpen ? tripId : undefined, user?.id)
  const { data: fetchedActions } = useChatActions(isOpen ? tripId : undefined)
  const live = useChatLive(trip, user?.id, canManageTrip, isOpen)
  const { chatOn } = useChatAvailability(tripId)
  /** The server said no (403 chat_off) even though the page thought chat was on. */
  const [refusedOff, setRefusedOff] = useState<string | null>(null)
  const chatOff = !chatOn || refusedOff === tripId

  const [input, setInput] = useState('')
  const [echo, setEcho] = useState<EchoMessage[]>([])
  const [streamText, setStreamText] = useState<string | null>(null)
  const [statusLabel, setStatusLabel] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  /** The reply is still arriving (false from the moment the stream ends, while `sending` also covers the refetch after it). */
  const [streaming, setStreaming] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [retry, setRetry] = useState<{ text: string; turnId: string } | null>(null)
  const [currentTurn, setCurrentTurn] = useState<string | null>(null)
  const [known, setKnown] = useState<Record<string, ChatActionEnvelope>>({})
  const [showInfo, setShowInfo] = useState(false)
  const [actionsEnabled, setActionsEnabled] = useState<boolean | null>(null)
  const [clearedLocally, setClearedLocally] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Everything below is per trip: opening the sheet for another trip must not show the last one's turn, cards or status.
  const shownTrip = useRef(tripId)
  useEffect(() => {
    if (shownTrip.current === tripId) return
    shownTrip.current = tripId
    setInput('')
    setEcho([])
    setStreamText(null)
    setStreaming(false)
    setStatusLabel(null)
    setNotice(null)
    setRetry(null)
    setCurrentTurn(null)
    setKnown({})
    setActionsEnabled(null)
    setClearedLocally(null)
    setShowLegacy(false)
  }, [tripId])

  const upsertAction = useCallback((a: ChatActionEnvelope) => setKnown((prev) => ({ ...prev, [a.id]: mergeAction(prev[a.id], a) })), [])

  // The server's rows are the truth whenever they arrive (a reload, another device, a refetch after a confirm).
  useEffect(() => {
    if (!fetchedActions?.length) return
    setKnown((prev) => {
      const next = { ...prev }
      // A late refetch never overwrites a card that has already finished (a stale snapshot lands after the tap's own result).
      for (const a of fetchedActions) next[a.id] = mergeAction(prev[a.id], a)
      return next
    })
  }, [fetchedActions])

  // "What changed since I last looked" reads the last-seen time, so it is stamped when the chat is closed, not opened.
  useEffect(() => {
    if (!isOpen) return
    return () => {
      void markChatSeen(tripId)
    }
  }, [isOpen, tripId])

  const revealed = useRevealedText(streamText ?? '', streamText !== null)

  const usersById = useMemo(() => {
    const map = new Map<string, { name: string; avatar_url: unknown; avatar_data: unknown }>()
    for (const p of participants ?? []) {
      map.set(p.user_id, {
        name: (p.user?.full_name || p.user?.email || 'Someone').split(' ')[0],
        avatar_url: p.user?.avatar_url ?? null,
        avatar_data: p.user?.avatar_data ?? null,
      })
    }
    return map
  }, [participants])

  // ---- threads: legacy shared history is read-only and kept apart once private threads are live -------------------------
  const rows = useMemo(() => (messages ?? []) as ChatRow[], [messages])
  const threadsLive = !!threadInfo?.available || rows.some((m) => !!m.thread_user_id)
  const clearedAt = clearedLocally ?? threadInfo?.clearedAt ?? null
  const legacyRows = threadsLive ? rows.filter((m) => !m.thread_user_id) : []
  const myRows = threadsLive ? rows.filter((m) => m.thread_user_id === user?.id && (!clearedAt || (m.created_at ?? '') > clearedAt)) : rows
  const [showLegacy, setShowLegacy] = useState(false)

  // ---- legacy organizer proposals (ai_proposals): kept for organizers only; delete cards are never rendered (ProposalReview) -
  const pendingProposals = useMemo(() => {
    // My own staged proposals only: another organiser's pending proposal (and the wording they typed) belongs to their private chat.
    return ownPendingProposals(proposals, user?.id, canManageTrip, Date.now())
  }, [proposals, canManageTrip, user?.id])
  const proposalsById = useMemo(() => new Map(pendingProposals.map((p) => [p.id, p])), [pendingProposals])
  const inlineProposalIds = useMemo(() => {
    const ids = new Set<string>()
    for (const msg of rows) {
      const meta = msg.metadata as { proposal_id?: string } | null
      if (meta?.proposal_id) ids.add(meta.proposal_id)
    }
    return ids
  }, [rows])
  const orphanProposals = pendingProposals.filter((p) => !inlineProposalIds.has(p.id))

  // ---- actions grouped by the turn that proposed them -------------------------------------------------------------------
  const actionsByTurn = useMemo(() => {
    const map = new Map<string, ChatActionEnvelope[]>()
    const all = Object.values(known).sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''))
    for (const a of all) {
      const key = a.turn_id ?? 'none'
      map.set(key, [...(map.get(key) ?? []), a])
    }
    return map
  }, [known])
  const turnsWithMessage = new Set(myRows.filter((m) => m.role === 'assistant' && m.turn_id).map((m) => m.turn_id as string))
  // Once the stored reply for this turn is in the list, the streamed copy (and its echo / cards) must not also be drawn.
  const currentTurnStored = !!currentTurn && turnsWithMessage.has(currentTurn)
  const storedUserTurns = new Set(myRows.filter((m) => m.role === 'user' && m.turn_id).map((m) => m.turn_id as string))
  const detached = detachedActions(known, currentTurn, turnsWithMessage)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, echo, revealed, statusLabel, isOpen, orphanProposals.length, known])

  // ---- confirming -----------------------------------------------------------------------------------------------------
  const runtime = useMemo<ActionRuntime | null>(() => {
    if (!user) return null
    const userId = user.id
    return {
      rpc: makeChatRpc(),
      onUpdate: upsertAction,
      askAgain: (text) => setInput(`Please check this again and suggest it fresh: ${text}`.slice(0, 1000)),
      recheckServer: async () => {
        await queryClient.invalidateQueries({ queryKey: chatActionsKey(tripId) })
      },
      makeCtx: (): ExecCtx => ({
        tripId,
        userId,
        queryClient,
        live: () => readLive(queryClient, trip, userId, canManageTrip),
        refresh: () => refreshLive(queryClient, tripId),
        logActivity,
        deps: defaultDeps,
        now: () => new Date(),
      }),
    }
  }, [user, upsertAction, queryClient, tripId, trip, canManageTrip, logActivity])

  const renderActions = (list: ChatActionEnvelope[] | undefined) =>
    dedupeLinkCards(list ?? []).map((a) => {
      if (a.kind === 'open_screen') {
        const link = resolveLink(a.params)
        return link && onOpenLink ? (
          <LinkCard
            key={a.id}
            link={link}
            onOpen={(p) => {
              onClose()
              onOpenLink(p)
            }}
          />
        ) : null
      }
      return runtime ? <ActionCard key={a.id} action={a} live={live} runtime={runtime} /> : null
    })

  // ---- sending ------------------------------------------------------------------------------------------------------
  const send = async (text: string, reuseTurnId?: string) => {
    const trimmed = text.trim()
    if (!trimmed || sending) return
    const turnId = reuseTurnId ?? newId()
    setInput('')
    setNotice(null)
    setRetry(null)
    setSending(true)
    setStreaming(true)
    setCurrentTurn(turnId)
    if (!reuseTurnId) setEcho((prev) => [...prev, { id: `echo-${turnId}`, turnId, content: trimmed }])
    setStreamText('')
    setStatusLabel(null)

    let failed = false
    try {
      await streamChatMessage(
        tripId,
        trimmed,
        {
          onText: (delta) => {
            if (shownTrip.current !== tripId) return
            setStatusLabel(null)
            setStreamText((prev) => (prev ?? '') + delta)
          },
          onStatus: (label) => {
            if (shownTrip.current === tripId) setStatusLabel(label)
          },
          onAction: (a) => shownTrip.current === tripId && upsertAction({ ...a, turn_id: a.turn_id ?? turnId }),
          onProposal: () => queryClient.invalidateQueries({ queryKey: queryKeys.proposals(tripId) }),
          onDone: (_full, info) => {
            setStreaming(false)
            setStatusLabel(null)
            if (info?.actionsEnabled != null) setActionsEnabled(info.actionsEnabled)
          },
          onError: (error) => {
            failed = true
            setStreaming(false)
            setStatusLabel(null)
            setNotice(error)
          },
        },
        { turnId, page: spaceFor(context) }
      )
    } catch (err) {
      failed = true
      if (err instanceof ChatOffError) {
        failed = false // retrying cannot help
        setRefusedOff(tripId)
        void queryClient.invalidateQueries({ queryKey: queryKeys.chatAvailability(tripId) })
      } else if (err instanceof ChatQuotaError) {
        setNotice(`⏳ ${err.message}`)
        if (err.code === 'spend_limit') failed = false // retrying cannot help until usage ages out
      } else setNotice((err as Error).message)
    } finally {
      if (failed) setRetry({ text: trimmed, turnId })
      // The turn is over however it ended: the status line goes now, not after the refetch below.
      setStreaming(false)
      setStatusLabel(null)
      await Promise.all([queryClient.invalidateQueries({ queryKey: queryKeys.chatMessages(tripId) }), queryClient.invalidateQueries({ queryKey: chatActionsKey(tripId) })])
      setStreamText(null)
      setStatusLabel(null)
      if (!failed) setEcho([])
      setSending(false)
    }
  }

  const onChip = (chip: ChatChip) => (chip.insert ? setInput(chip.insert) : void send(chip.label))

  const onNewChat = async () => {
    try {
      const at = await startNewChat(tripId)
      if (at) {
        setClearedLocally(at)
        setEcho([])
        setNotice(null)
        setRetry(null)
        setCurrentTurn(null)
        setStreamText(null)
        setStreaming(false)
        setStatusLabel(null)
        // Link cards are not stored anywhere else: they belong to the chat that was just closed.
        setKnown(withoutLinkCards)
        void queryClient.invalidateQueries({ queryKey: chatThreadKey(tripId, user?.id ?? '') })
      }
    } catch (err) {
      setNotice((err as Error).message)
    }
  }

  // When the server says actions are off for this trip, only the question chips are offered.
  const chips = chipsFor(spaceFor(context), canManageTrip).filter((c) => actionsEnabled !== false || !c.insert)
  const hasThread = myRows.length > 0 || echo.length > 0 || legacyRows.length > 0

  const renderMessage = (msg: ChatRow, readOnly = false) => {
    const isUser = msg.role === 'user'
    const sender = msg.user_id ? usersById.get(msg.user_id) : undefined
    const mine = msg.user_id === user?.id
    const meta = msg.metadata as { proposal_id?: string } | null
    const inlineProposal = meta?.proposal_id ? proposalsById.get(meta.proposal_id) : undefined
    // Buttons come back from the stored reply; while this device still holds the live ones for the turn, those are drawn instead (never both).
    const liveHasLinks = !!msg.turn_id && (actionsByTurn.get(msg.turn_id) ?? []).some((a) => a.kind === 'open_screen')
    const keptLinks = msg.role === 'assistant' && !liveHasLinks ? storedLinks(msg.metadata) : []
    return (
      <div key={msg.id}>
        <div className={`flex items-end gap-2 ${isUser && mine ? 'flex-row-reverse' : ''}`}>
          {isUser ? (
            <UserAvatar avatarData={sender ?? null} size="xs" />
          ) : (
            <span className="text-lg" aria-hidden="true">
              ✨
            </span>
          )}
          <div
            className={`${bubble} ${
              isUser && mine
                ? 'bg-accent-600 text-white whitespace-pre-wrap'
                : isUser
                  ? 'bg-[var(--surface-sunken)] text-[var(--text-primary)] whitespace-pre-wrap'
                  : 'border border-[var(--border-subtle)] bg-[var(--surface-raised)] text-[var(--text-primary)]'
            }`}
          >
            {isUser && !mine && sender && <span className="block text-xs font-semibold opacity-70">{sender.name}</span>}
            {isUser ? msg.content : <ChatMarkdown>{msg.content}</ChatMarkdown>}
          </div>
        </div>
        {!readOnly && inlineProposal && (
          <div className="mt-2 pl-7">
            <ProposalReview proposal={inlineProposal} trip={trip} />
          </div>
        )}
        {!readOnly && msg.role === 'assistant' && msg.turn_id && actionsByTurn.get(msg.turn_id) && <div className="mt-2 space-y-2 pl-7">{renderActions(actionsByTurn.get(msg.turn_id))}</div>}
        {!readOnly && msg.role === 'assistant' && keptLinks.length > 0 && onOpenLink && (
          <div className="mt-2 space-y-2 pl-7">
            {keptLinks.map((link) => (
              <LinkCard
                key={link.openParam}
                link={link}
                onOpen={(p) => {
                  onClose()
                  onOpenLink(p)
                }}
              />
            ))}
          </div>
        )}
      </div>
    )
  }

  if (chatOff) {
    return (
      <Modal isOpen={isOpen} onClose={onClose} size="lg" title="Trip assistant">
        <p className="py-6 text-center text-sm text-[var(--text-secondary)]" role="status">
          {CHAT_OFF_MESSAGE}
        </p>
      </Modal>
    )
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="lg" title={threadsLive ? 'Trip assistant' : `Ask about ${trip.name}`}>
      <div className="flex h-[65vh] flex-col">
        <div className="flex items-center justify-between gap-2 pb-2">
          <p className="min-w-0 truncate text-xs text-[var(--text-muted)]">{threadsLive ? 'Only you see this chat' : 'Ask about plans, money and who is coming'}</p>
          <div className="flex shrink-0 items-center gap-1">
            <button type="button" aria-label="What can the assistant do?" aria-expanded={showInfo} onClick={() => setShowInfo((v) => !v)} className="flex h-11 w-11 items-center justify-center rounded-full text-[var(--text-muted)]">
              ⓘ
            </button>
            {threadsLive && (
              <Button size="md" variant="ghost" onClick={() => void onNewChat()} disabled={sending}>
                New chat
              </Button>
            )}
          </div>
        </div>
        {showInfo && <p className="mb-2 rounded-[var(--radius-md)] bg-[var(--surface-sunken)] px-3 py-2 text-xs text-[var(--text-secondary)]">It can look things up and suggest changes. Nothing changes until you approve a suggestion.</p>}

        <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto pb-3 pr-1">
          {legacyRows.length > 0 && (
            <div>
              <button type="button" className="min-h-11 text-xs font-medium text-[var(--text-muted)] underline underline-offset-2" onClick={() => setShowLegacy((v) => !v)}>
                {showLegacy ? 'Hide earlier group chat' : `Earlier group chat (${legacyRows.length})`}
              </button>
              {showLegacy && <div className="mt-2 space-y-3 opacity-80">{legacyRows.map((m) => renderMessage(m, true))}</div>}
            </div>
          )}

          {isLoading ? (
            <Skeleton variant="list" lines={4} />
          ) : !hasThread ? (
            <div className="py-6 text-center">
              <p className="text-3xl" aria-hidden="true">
                ✨
              </p>
              <p className="mt-2 text-sm font-medium text-[var(--text-primary)]">Ask anything about {trip.name}</p>
              <p className="mt-1 text-sm text-[var(--text-secondary)]">Or ask me to do things: add a to-do, record your vote, log an expense. You confirm before anything changes.</p>
            </div>
          ) : (
            <>
              {myRows.map((m) => renderMessage(m))}

              {echo.filter((msg) => !storedUserTurns.has(msg.turnId)).map((msg) => (
                <div key={msg.id} className="flex flex-row-reverse items-end gap-2">
                  <UserAvatar avatarData={usersById.get(user?.id ?? '') ?? null} size="xs" />
                  <div className={`${bubble} bg-accent-600 text-white whitespace-pre-wrap`}>{msg.content}</div>
                </div>
              ))}
            </>
          )}

          {streamText !== null && !currentTurnStored && (
            <div className="flex items-end gap-2">
              <span className="text-lg" aria-hidden="true">
                ✨
              </span>
              <div className={`${bubble} border border-[var(--border-subtle)] bg-[var(--surface-raised)] text-[var(--text-primary)]`} aria-live="polite">
                {revealed ? <ChatMarkdown>{revealed}</ChatMarkdown> : <span className="text-[var(--text-muted)]">{statusLine({ streaming, hasText: false, label: statusLabel }) ?? ''}</span>}
                {revealed && statusLine({ streaming, hasText: true, label: statusLabel }) && <span className="mt-1 block text-xs text-[var(--text-muted)]">{statusLine({ streaming, hasText: true, label: statusLabel })}</span>}
              </div>
            </div>
          )}

          {currentTurn && actionsByTurn.get(currentTurn) && !currentTurnStored && <div className="space-y-2 pl-7">{renderActions(actionsByTurn.get(currentTurn))}</div>}
          {detached.length > 0 && <div className="space-y-2 pl-7">{renderActions(detached)}</div>}

          {orphanProposals.map((proposal) => (
            <ProposalReview key={proposal.id} proposal={proposal} trip={trip} />
          ))}

          {notice && (
            <div className="rounded-[var(--radius-md)] bg-warn-50 px-3 py-2 text-sm text-warn-800 dark:bg-warn-950 dark:text-warn-200" role="alert">
              <p>{notice}</p>
              {retry && !sending && (
                <Button size="md" variant="secondary" className="mt-2" onClick={() => void send(retry.text, retry.turnId)}>
                  Try again
                </Button>
              )}
            </div>
          )}
        </div>

        <div className="border-t border-[var(--border-subtle)] pt-3">
          {!sending && (
            <div className="mb-2 flex gap-2 overflow-x-auto pb-1">
              {chips.map((chip) => (
                <Chip key={chip.label} size="sm" onClick={() => onChip(chip)}>
                  {chip.label}
                </Chip>
              ))}
            </div>
          )}
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              void send(input)
            }}
          >
            <div className="flex-1">
              <TextArea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                rows={1}
                placeholder="Ask about the trip…"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void send(input)
                  }
                }}
              />
            </div>
            <Button type="submit" isLoading={sending} disabled={!input.trim()}>
              Send
            </Button>
          </form>
        </div>
      </div>
    </Modal>
  )
}
