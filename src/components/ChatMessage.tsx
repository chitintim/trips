import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { ChatMessage as ChatMessageType } from '../types'
import { AvatarData } from '../types'

interface ChatMessageProps {
  message: ChatMessageType
  senderName?: string | null
  senderAvatar?: AvatarData | null
  isCurrentUser: boolean
}

export function ChatMessage({ message, senderName, senderAvatar, isCurrentUser }: ChatMessageProps) {
  const [actionsExpanded, setActionsExpanded] = useState(false)

  const actions = (message.actions_executed || []) as Array<Record<string, any>>

  if (message.role === 'system') {
    return (
      <div className="flex justify-center my-2">
        <span className="text-xs text-gray-400 bg-gray-50 px-3 py-1 rounded-full">
          {message.content}
        </span>
      </div>
    )
  }

  const isAssistant = message.role === 'assistant'

  return (
    <div className={`flex gap-2 my-3 ${isAssistant ? 'justify-start' : 'justify-end'}`}>
      {/* Avatar for assistant or other users */}
      {!isCurrentUser && (
        <div className="flex-shrink-0 mt-1">
          {isAssistant ? (
            <div className="w-7 h-7 rounded-full bg-purple-100 flex items-center justify-center text-sm">
              🤖
            </div>
          ) : (
            <div
              className="w-7 h-7 rounded-full flex items-center justify-center text-sm"
              style={{ backgroundColor: senderAvatar?.bgColor || '#0ea5e9' }}
            >
              {senderAvatar?.emoji || '😊'}
            </div>
          )}
        </div>
      )}

      <div className={`max-w-[80%] ${isAssistant ? '' : ''}`}>
        {/* Sender name */}
        {!isCurrentUser && (
          <span className="text-xs text-gray-400 ml-1 mb-0.5 block">
            {isAssistant ? 'Trip Assistant' : senderName || 'Unknown'}
          </span>
        )}

        {/* Message bubble */}
        <div
          className={`rounded-2xl px-3.5 py-2 text-sm leading-relaxed ${
            isCurrentUser
              ? 'bg-sky-500 text-white rounded-br-md'
              : isAssistant
                ? 'bg-gray-100 text-gray-800 rounded-bl-md'
                : 'bg-gray-100 text-gray-800 rounded-bl-md'
          }`}
        >
          {isAssistant ? (
            <div className="chat-markdown prose prose-sm max-w-none break-words [&>p]:my-1 [&>ul]:my-1 [&>ol]:my-1 [&>li]:my-0.5 [&>h1]:text-base [&>h2]:text-sm [&>h3]:text-sm [&>h1]:font-semibold [&>h2]:font-semibold [&>h3]:font-semibold [&>h1]:mt-2 [&>h2]:mt-2 [&>h3]:mt-1 [&>pre]:bg-gray-200 [&>pre]:rounded [&>pre]:p-2 [&>pre]:text-xs [&_code]:text-xs [&_code]:bg-gray-200 [&_code]:px-1 [&_code]:rounded [&>blockquote]:border-l-2 [&>blockquote]:border-gray-300 [&>blockquote]:pl-2 [&>blockquote]:text-gray-600">
              <ReactMarkdown>{message.content}</ReactMarkdown>
            </div>
          ) : (
            <div className="whitespace-pre-wrap break-words">{message.content}</div>
          )}
        </div>

        {/* Actions summary */}
        {isAssistant && actions.length > 0 && (
          <div className="mt-1.5 ml-1">
            <button
              onClick={() => setActionsExpanded(!actionsExpanded)}
              className="text-xs text-purple-500 hover:text-purple-700 flex items-center gap-1"
            >
              <svg
                className={`w-3 h-3 transition-transform ${actionsExpanded ? 'rotate-90' : ''}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
              {actions.length} action{actions.length !== 1 ? 's' : ''} taken
            </button>
            {actionsExpanded && (
              <div className="mt-1 space-y-1">
                {actions.map((action, i) => (
                  <div key={i} className="text-xs text-gray-500 bg-gray-50 rounded px-2 py-1">
                    {action.type === 'create_event' && `Created: ${action.event_title || 'event'}`}
                    {action.type === 'update_event' && `Updated: ${action.event_title || 'event'}`}
                    {action.type === 'delete_event' && `Deleted: ${action.event_title || 'event'}`}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Timestamp */}
        <span className={`text-[10px] text-gray-400 mt-0.5 block ${isCurrentUser ? 'text-right mr-1' : 'ml-1'}`}>
          {message.created_at
            ? new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : ''}
        </span>
      </div>

      {/* Current user avatar on right */}
      {isCurrentUser && (
        <div className="flex-shrink-0 mt-1">
          <div
            className="w-7 h-7 rounded-full flex items-center justify-center text-sm"
            style={{ backgroundColor: senderAvatar?.bgColor || '#0ea5e9' }}
          >
            {senderAvatar?.emoji || '😊'}
          </div>
        </div>
      )}
    </div>
  )
}
