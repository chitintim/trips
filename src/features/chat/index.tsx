/**
 * Public surface of the chat v2 feature (workstream G, plan §13). The
 * coordinator wires `chatEntryConfig` into the shell: the FAB/header "Ask"
 * affordance opens <ChatSheet trip={trip} context={activeTabId} /> —
 * ChatSheet owns streaming, suggestion chips and the proposal review flow.
 */
import { Suspense, type ComponentType } from 'react'
import { lazyWithRetry } from '../../lib/lazyWithRetry'
import { ErrorBoundary } from '../../components/ErrorBoundary'
import { Modal, Skeleton } from '../../components/ui'
import type { ChatSheetProps } from './components/ChatSheet'

// `ChatSheet` is loaded lazily (WSH perf pass, plan §16 code-splitting
// target) -- it pulls in the streaming/markdown rendering + proposal review
// UI which isn't needed until a user actually opens "Ask AI".
const LazyChatSheetChunk = lazyWithRetry(() =>
  import('./components/ChatSheet').then((m) => ({ default: m.ChatSheet })),
)

// `LazyChatSheet` wraps the lazy chunk in its own Suspense + ErrorBoundary
// rather than exporting the bare `lazy()` result: its mount site
// (src/pages/TripDetail.tsx) only wraps it in `<Suspense fallback={null}>`,
// with no error boundary of its own, so a stale/missing chunk (e.g. right
// after a GitHub Pages redeploy retires the old hashed filename) would
// otherwise have nothing nearby to catch it. Consumers that render it
// directly should still use their own `<Suspense>` around it as before --
// this one is a belt-and-suspenders inner boundary, not a replacement.
export function LazyChatSheet(props: ChatSheetProps) {
  return (
    <ErrorBoundary label="Ask AI">
      <Suspense
        // While the chunk downloads on a cold first open, show the same
        // modal shell the sheet will render into (Modal is portal-rendered
        // and owns the layering) instead of nothing -- tapping "Ask" used
        // to appear to do nothing for the duration of the download.
        fallback={
          props.isOpen ? (
            <Modal isOpen onClose={props.onClose} size="lg" title="✨ Ask">
              <Skeleton variant="text" lines={4} />
            </Modal>
          ) : null
        }
      >
        <LazyChatSheetChunk {...props} />
      </Suspense>
    </ErrorBoundary>
  )
}

export type { ChatSheetProps } from './components/ChatSheet'
export { ProposalReview } from './components/ProposalReview'
export type { ProposalReviewProps } from './components/ProposalReview'

export { streamChatMessage, ChatQuotaError, CHAT_QUOTA_MESSAGE } from './lib/streamChat'
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
