/**
 * Public surface of the chat v2 feature (workstream G, plan §13). The
 * coordinator wires `chatEntryConfig` into the shell: the FAB/header "Ask"
 * affordance opens <ChatSheet trip={trip} context={activeTabId} /> —
 * ChatSheet owns streaming, suggestion chips and the proposal review flow.
 */
import { lazy, type ComponentType } from 'react'
import type { ChatSheetProps } from './components/ChatSheet'

// `ChatSheet` is loaded lazily (WSH perf pass, plan §16 code-splitting
// target) -- it pulls in the streaming/markdown rendering + proposal review
// UI which isn't needed until a user actually opens "Ask AI". Consumers that
// render it directly (rather than via `chatEntryConfig.Component`) should
// import `LazyChatSheet` below and wrap it in a `<Suspense>`.
export const LazyChatSheet = lazy(() => import('./components/ChatSheet').then((m) => ({ default: m.ChatSheet })))
export type { ChatSheetProps } from './components/ChatSheet'
export { ProposalReview } from './components/ProposalReview'
export type { ProposalReviewProps } from './components/ProposalReview'

export { streamChatMessage, ChatQuotaError } from './lib/streamChat'
export type { ChatStreamCallbacks } from './lib/streamChat'
export { applyAction, describeAction, parseProposalActions } from './lib/applyProposal'
export type { ApplyContext, ActionDescription, ParsedActionEntry } from './lib/applyProposal'

export const chatEntryConfig: {
  id: 'chat'
  label: string
  icon: string
  Component: ComponentType<ChatSheetProps>
} = {
  id: 'chat',
  label: 'Ask',
  icon: '✨',
  Component: LazyChatSheet,
}
