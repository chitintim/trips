import { useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Badge, Button, Chip, Modal, Skeleton, TextArea, UserAvatar } from '../../../components/ui'
import { useAuth } from '../../../hooks/useAuth'
import { queryKeys } from '../../../lib/queries/queryKeys'
import { useChatMessages } from '../../../lib/queries/useChat'
import { useProposals } from '../../../lib/queries/useProposals'
import { useParticipants } from '../../../lib/queries/useTrip'
import { streamChatMessage, ChatQuotaError, CHAT_QUOTA_MESSAGE } from '../lib/streamChat'
import { ProposalReview } from './ProposalReview'
import type { Trip } from '../../../types'

/** Suggestion chips, keyed by the space/tab the user opened chat from (v2.1 IA: today/plan/money-subtab/people; legacy keys kept for older callers). */
const SUGGESTIONS: Record<string, string[]> = {
  default: ['What do I owe?', "What's the plan?", "What's still undecided?"],
  today: ["What's happening today?", 'What needs my attention?', 'What do I owe?'],
  plan: ["What's winning the polls?", "What's next on the itinerary?", "What's still undecided?"],
  overview: ["What's the plan today?", 'Who still needs to confirm?', 'What do I owe?'],
  decisions: ["What's winning the polls?", "Who hasn't voted yet?", 'Summarize the open decisions'],
  expenses: ['How much do I owe?', "What's unclaimed?", 'Who has paid the most?'],
  'my-spending': ['How much have I spent?', 'What am I still owed?'],
  'settle-up': ['Who owes whom?', 'What settlements are unconfirmed?'],
  itinerary: ["What's the plan Saturday?", "What's next on the itinerary?"],
  people: ['Who still needs to confirm?', "Who's waiting on whom?"],
  organizer: ['Who is blocking what?', 'Draft a plan for the unbooked polls'],
  map: ['How far is dinner from the accommodation?'],
}

export interface ChatSheetProps {
  isOpen: boolean
  onClose: () => void
  trip: Trip
  /** Tab the chat was opened from — picks the suggestion chips. */
  context?: string
}

interface EchoMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
}

/**
 * Trip chat v2 (plan §13): streaming shared AI chat with per-tab
 * suggestion chips and inline proposal review cards. Writes never happen
 * from the model — staged proposals are applied by the human, under their
 * own JWT, via ProposalReview.
 */
export function ChatSheet({ isOpen, onClose, trip, context }: ChatSheetProps) {
  const tripId = trip.id
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const { data: messages, isLoading } = useChatMessages(isOpen ? tripId : undefined)
  const { data: proposals } = useProposals(isOpen ? tripId : undefined)
  const { data: participants } = useParticipants(isOpen ? tripId : undefined)

  const [input, setInput] = useState('')
  const [echo, setEcho] = useState<EchoMessage[]>([])
  const [streamText, setStreamText] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

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

  const pendingProposals = useMemo(() => {
    const now = Date.now()
    return (proposals ?? []).filter(
      (p) => p.status === 'pending' && (!p.expires_at || new Date(p.expires_at).getTime() > now)
    )
  }, [proposals])
  const proposalsById = useMemo(() => new Map(pendingProposals.map((p) => [p.id, p])), [pendingProposals])

  // Proposal ids already rendered inline next to their chat message.
  const inlineProposalIds = useMemo(() => {
    const ids = new Set<string>()
    for (const msg of messages ?? []) {
      const meta = msg.metadata as { proposal_id?: string } | null
      if (meta?.proposal_id) ids.add(meta.proposal_id)
    }
    return ids
  }, [messages])

  const orphanProposals = pendingProposals.filter((p) => !inlineProposalIds.has(p.id))

  useEffect(() => {
    // Stick to the bottom as messages/stream arrive.
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, echo, streamText, isOpen, orphanProposals.length])

  const send = async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed || sending) return
    setInput('')
    setNotice(null)
    setSending(true)
    setEcho((prev) => [...prev, { id: `echo-${Date.now()}`, role: 'user', content: trimmed }])
    setStreamText('')

    try {
      await streamChatMessage(tripId, trimmed, {
        onText: (delta) => setStreamText((prev) => (prev ?? '') + delta),
        onProposal: () => queryClient.invalidateQueries({ queryKey: queryKeys.proposals(tripId) }),
        onDone: async () => {
          await queryClient.invalidateQueries({ queryKey: queryKeys.chatMessages(tripId) })
          setEcho([])
          setStreamText(null)
        },
        onError: (error) => {
          setNotice(error)
          setStreamText(null)
        },
      })
    } catch (err) {
      setStreamText(null)
      setNotice(err instanceof ChatQuotaError ? `⏳ ${CHAT_QUOTA_MESSAGE}` : (err as Error).message)
    } finally {
      setSending(false)
    }
  }

  const chips = SUGGESTIONS[context ?? ''] ?? SUGGESTIONS.default
  const hasThread = (messages?.length ?? 0) > 0 || echo.length > 0

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="lg" title={`Ask about ${trip.name}`}>
      <div className="flex h-[65vh] flex-col">
        <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto pb-3 pr-1">
          {isLoading ? (
            <Skeleton variant="list" lines={4} />
          ) : !hasThread ? (
            <div className="py-8 text-center">
              <p className="text-3xl" aria-hidden="true">
                ✨
              </p>
              <p className="mt-2 text-sm text-[var(--text-secondary)]">
                Ask anything about the trip — plans, money, who's confirmed. Organizers can also ask for changes;
                you'll approve each one before it happens.
              </p>
            </div>
          ) : (
            <>
              {(messages ?? []).map((msg) => {
                const isUser = msg.role === 'user'
                const sender = msg.user_id ? usersById.get(msg.user_id) : undefined
                const mine = msg.user_id === user?.id
                const meta = msg.metadata as { proposal_id?: string } | null
                const inlineProposal = meta?.proposal_id ? proposalsById.get(meta.proposal_id) : undefined
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
                        className={`max-w-[85%] rounded-[var(--radius-lg)] px-3 py-2 text-sm whitespace-pre-wrap break-words ${
                          isUser && mine
                            ? 'bg-accent-600 text-white'
                            : isUser
                              ? 'bg-[var(--surface-sunken)] text-[var(--text-primary)]'
                              : 'bg-[var(--surface-raised)] border border-[var(--border-subtle)] text-[var(--text-primary)]'
                        }`}
                      >
                        {isUser && !mine && sender && (
                          <span className="block text-xs font-semibold opacity-70">{sender.name}</span>
                        )}
                        {msg.content}
                      </div>
                    </div>
                    {inlineProposal && (
                      <div className="mt-2 pl-7">
                        <ProposalReview proposal={inlineProposal} trip={trip} />
                      </div>
                    )}
                    {meta?.proposal_id && !inlineProposal && (
                      <div className="mt-1 pl-7">
                        <Badge variant="neutral" size="sm">
                          ✔ proposed changes reviewed
                        </Badge>
                      </div>
                    )}
                  </div>
                )
              })}

              {echo.map((msg) => (
                <div key={msg.id} className="flex flex-row-reverse items-end gap-2">
                  <UserAvatar avatarData={usersById.get(user?.id ?? '') ?? null} size="xs" />
                  <div className="max-w-[85%] rounded-[var(--radius-lg)] bg-accent-600 px-3 py-2 text-sm text-white whitespace-pre-wrap break-words">
                    {msg.content}
                  </div>
                </div>
              ))}

              {streamText !== null && (
                <div className="flex items-end gap-2">
                  <span className="text-lg" aria-hidden="true">
                    ✨
                  </span>
                  <div className="max-w-[85%] rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-3 py-2 text-sm text-[var(--text-primary)] whitespace-pre-wrap break-words">
                    {streamText || 'Thinking…'}
                    <span className="animate-pulse">▍</span>
                  </div>
                </div>
              )}
            </>
          )}

          {orphanProposals.map((proposal) => (
            <ProposalReview key={proposal.id} proposal={proposal} trip={trip} />
          ))}

          {notice && (
            <p className="rounded-[var(--radius-md)] bg-warn-50 px-3 py-2 text-sm text-warn-800 dark:bg-warn-950 dark:text-warn-200">
              {notice}
            </p>
          )}
        </div>

        <div className="border-t border-[var(--border-subtle)] pt-3">
          {!sending && (
            <div className="mb-2 flex gap-2 overflow-x-auto pb-1">
              {chips.map((chip) => (
                <Chip key={chip} size="sm" onClick={() => send(chip)}>
                  {chip}
                </Chip>
              ))}
            </div>
          )}
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              send(input)
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
                    send(input)
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
