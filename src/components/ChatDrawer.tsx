import { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth'
import { Trip, ChatMessage as ChatMessageType } from '../types'
import { AvatarData } from '../types'
import { Button, Spinner } from './ui'
import { ChatMessage } from './ChatMessage'
import { sendChatMessage } from '../lib/tripChat'

interface ChatDrawerProps {
  trip: Trip
  isOpen: boolean
  onClose: () => void
}

interface UserInfo {
  id: string
  full_name: string | null
  avatar_data: AvatarData | null
}

export function ChatDrawer({ trip, isOpen, onClose }: ChatDrawerProps) {
  const { user } = useAuth()
  const [messages, setMessages] = useState<ChatMessageType[]>([])
  const [usersMap, setUsersMap] = useState<Map<string, UserInfo>>(new Map())
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [loading, setLoading] = useState(true)
  const [isOrganizer, setIsOrganizer] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (isOpen) {
      fetchMessages()
      fetchUsers()
      checkOrganizerStatus()
    }
  }, [isOpen, trip.id])

  useEffect(() => {
    if (!isOpen) return

    // Real-time subscription for shared chat
    const channel = supabase
      .channel(`trip_chat_realtime:${trip.id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'trip_chat_messages',
          filter: `trip_id=eq.${trip.id}`,
        },
        (payload) => {
          const newMsg = payload.new as ChatMessageType
          setMessages(prev => {
            // Avoid duplicates (by real DB id)
            if (prev.some(m => m.id === newMsg.id)) return prev
            // Remove optimistic/streaming placeholders that this real message replaces
            const filtered = prev.filter(m => {
              // Remove optimistic user messages from same user
              if (m.id.startsWith('optimistic-') && newMsg.role === 'user' && m.user_id === newMsg.user_id) return false
              // Remove streaming assistant messages when real assistant message arrives
              if (m.id.startsWith('streaming-') && newMsg.role === 'assistant') return false
              return true
            })
            return [...filtered, newMsg]
          })
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [isOpen, trip.id])

  useEffect(() => {
    // Auto-scroll to bottom on new messages
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const fetchMessages = async () => {
    setLoading(true)
    const { data, error } = await supabase
      .from('trip_chat_messages')
      .select('*')
      .eq('trip_id', trip.id)
      .order('created_at', { ascending: true })

    if (error) {
      console.error('Error fetching chat messages:', error)
    } else {
      setMessages(data || [])
    }
    setLoading(false)
  }

  const fetchUsers = async () => {
    const { data } = await supabase
      .from('trip_participants')
      .select('user_id, user:user_id(id, full_name, avatar_data)')
      .eq('trip_id', trip.id)
      .eq('active', true)

    if (data) {
      const map = new Map<string, UserInfo>()
      for (const p of data as any[]) {
        if (p.user) {
          map.set(p.user.id, {
            id: p.user.id,
            full_name: p.user.full_name,
            avatar_data: p.user.avatar_data as AvatarData | null,
          })
        }
      }
      setUsersMap(map)
    }
  }

  const checkOrganizerStatus = async () => {
    if (!user) return
    const { data: userData } = await supabase
      .from('users')
      .select('role')
      .eq('id', user.id)
      .single()
    const isSystemAdmin = userData?.role === 'admin'

    const { data: participantData } = await supabase
      .from('trip_participants')
      .select('role')
      .eq('trip_id', trip.id)
      .eq('user_id', user.id)
      .single()

    const isTripOrganizer = participantData?.role === 'organizer'
    const isTripCreator = trip.created_by === user.id
    setIsOrganizer(isSystemAdmin || isTripCreator || isTripOrganizer)
  }

  const handleSend = async () => {
    const trimmed = input.trim()
    if (!trimmed || sending || !user) return

    setSending(true)
    setInput('')

    // Optimistic user message
    const optimisticMsg: ChatMessageType = {
      id: `optimistic-${Date.now()}`,
      trip_id: trip.id,
      user_id: user.id,
      role: 'user',
      content: trimmed,
      actions_executed: null,
      had_write_actions: null,
      metadata: null,
      created_at: new Date().toISOString(),
    }
    setMessages(prev => [...prev, optimisticMsg])

    // Create a streaming assistant placeholder
    const streamingId = `streaming-${Date.now()}`
    const streamingMsg: ChatMessageType = {
      id: streamingId,
      trip_id: trip.id,
      user_id: null,
      role: 'assistant',
      content: '',
      actions_executed: null,
      had_write_actions: null,
      metadata: null,
      created_at: new Date().toISOString(),
    }
    setMessages(prev => [...prev, streamingMsg])

    try {
      await sendChatMessage(trip.id, trimmed, {
        onText: (chunk) => {
          // Append streamed text to the assistant message
          setMessages(prev => prev.map(m =>
            m.id === streamingId
              ? { ...m, content: m.content + chunk }
              : m
          ))
        },
        onDone: (message, actions) => {
          // Replace streaming message with final version
          setMessages(prev => prev.map(m =>
            m.id === streamingId
              ? { ...m, content: message, actions_executed: (actions || null) as any, had_write_actions: actions.length > 0 }
              : m
          ))
        },
        onError: (error) => {
          // Replace streaming message with error
          setMessages(prev => prev.map(m =>
            m.id === streamingId
              ? { ...m, role: 'system' as const, content: `Error: ${error}` }
              : m
          ))
        },
      })
    } catch (error: any) {
      setMessages(prev => prev.map(m =>
        m.id === streamingId
          ? { ...m, role: 'system' as const, content: `Error: ${error.message}` }
          : m
      ))
    }

    setSending(false)
    textareaRef.current?.focus()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  if (!isOpen) return null

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/20 z-40 lg:bg-transparent"
        onClick={onClose}
      />

      {/* Drawer */}
      <div className="fixed right-0 top-0 bottom-0 w-full sm:w-[400px] bg-white shadow-2xl z-50 flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-white">
          <div>
            <h3 className="font-semibold text-gray-900">Trip Assistant</h3>
            <p className="text-xs text-gray-400">Shared chat - visible to all participants</p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors p-1"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Role notice */}
        {!isOrganizer && (
          <div className="px-4 py-2 bg-amber-50 border-b border-amber-100 text-xs text-amber-700">
            You can ask questions about the trip. Only organizers can make changes to the timeline.
          </div>
        )}

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-3 py-2">
          {loading ? (
            <div className="flex justify-center py-8">
              <Spinner />
            </div>
          ) : messages.length === 0 ? (
            <div className="text-center py-12 text-gray-400">
              <div className="text-4xl mb-3">🤖</div>
              <p className="text-sm font-medium">Trip Assistant</p>
              <p className="text-xs mt-1">
                Ask questions about the trip
                {isOrganizer && ' or tell me to add events to the timeline'}
              </p>
            </div>
          ) : (
            messages.map(msg => {
              const senderInfo = msg.user_id ? usersMap.get(msg.user_id) : null
              return (
                <ChatMessage
                  key={msg.id}
                  message={msg}
                  senderName={senderInfo?.full_name}
                  senderAvatar={senderInfo?.avatar_data}
                  isCurrentUser={msg.user_id === user?.id}
                />
              )
            })
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div className="border-t border-gray-200 p-3 bg-white">
          <div className="flex gap-2 items-end">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                isOrganizer
                  ? 'Ask a question or add events...'
                  : 'Ask a question about the trip...'
              }
              rows={1}
              className="flex-1 resize-none rounded-xl border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-300 focus:border-transparent max-h-24"
              style={{ minHeight: '38px' }}
              disabled={sending}
            />
            <Button
              variant="primary"
              size="sm"
              onClick={handleSend}
              disabled={!input.trim() || sending}
              className="!rounded-xl !px-3 flex-shrink-0"
            >
              {sending ? (
                <Spinner size="sm" />
              ) : (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                </svg>
              )}
            </Button>
          </div>
        </div>
      </div>
    </>
  )
}
