/**
 * Public surface of the chat v2 feature (workstream G, plan §13). The
 * coordinator wires `chatEntryConfig` into the shell: the FAB/header "Ask"
 * affordance opens <ChatSheet trip={trip} context={activeTabId} /> —
 * ChatSheet owns streaming, suggestion chips and the proposal review flow.
 */
import type { ComponentType } from 'react'
import { ChatSheet, type ChatSheetProps } from './components/ChatSheet'

export { ChatSheet } from './components/ChatSheet'
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
  Component: ChatSheet,
}
