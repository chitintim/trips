import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Modal, Button, TextArea, Chip, Spinner, useToast } from '../../../components/ui'
import { queryKeys } from '../../../lib/queries/queryKeys'
import { useProposals } from '../../../lib/queries/useProposals'
import { ProposalReview } from '../../chat/components/ProposalReview'
import { requestReorganizePlan, ReorganizeQuotaError } from '../lib/reorganizeClient'
import type { Trip } from '../../../types'

export interface OrganizeSheetProps {
  isOpen: boolean
  onClose: () => void
  trip: Trip
}

const INSTRUCTION_CHIPS = [
  'Convert rental lists into order forms',
  'Extract dates & prices from descriptions',
  'Group restaurants by evening',
]

type Stage = 'form' | 'running' | 'result' | 'quota_limited'

/**
 * "Organize with AI" (UPGRADE_MASTER_PLAN.md §13 build brief, organizer-only):
 * an on-demand tidy-up pass over the whole plan — the reorganize-plan edge
 * function reads the trip's current questions/options/timeline, drafts a
 * batch of ProposedActions (matrix -> catalog consolidation, prose-fact
 * extraction, question-style titles), and stages them as ai_proposals rows.
 * Nothing changes until the organizer reviews and approves each card here
 * (same ProposalReview component the chat feature uses) — this sheet is
 * just a dedicated entry point + inline result view, not a second apply
 * path. The proposals also surface automatically as "orphan" cards next
 * time the trip chat is opened (ChatSheet already renders any pending
 * proposal for the trip), so closing this sheet without reviewing
 * everything loses nothing.
 */
export function OrganizeSheet({ isOpen, onClose, trip }: OrganizeSheetProps) {
  const { showToast } = useToast()
  const queryClient = useQueryClient()
  const { data: proposals } = useProposals(isOpen ? trip.id : undefined)

  const [instructions, setInstructions] = useState('')
  const [contextText, setContextText] = useState('')
  const [stage, setStage] = useState<Stage>('form')
  const [summary, setSummary] = useState('')
  const [proposalIds, setProposalIds] = useState<string[]>([])
  const [quotaMessage, setQuotaMessage] = useState('')

  const reset = () => {
    setInstructions('')
    setContextText('')
    setStage('form')
    setSummary('')
    setProposalIds([])
    setQuotaMessage('')
  }

  const handleClose = () => {
    // Nothing to lose on close — any staged proposals already persisted
    // server-side and reappear next time chat/this sheet is opened.
    reset()
    onClose()
  }

  const toggleChip = (phrase: string) => {
    setInstructions((prev) => {
      if (prev.includes(phrase)) return prev
      return prev.trim() ? `${prev.trim()}; ${phrase}` : phrase
    })
  }

  const handleRun = async () => {
    setStage('running')
    try {
      const result = await requestReorganizePlan({
        trip_id: trip.id,
        instructions: instructions.trim() || undefined,
        context_text: contextText.trim() || undefined,
      })
      await queryClient.invalidateQueries({ queryKey: queryKeys.proposals(trip.id) })
      setSummary(result.summary)
      setProposalIds(result.proposal_ids)
      setStage('result')
    } catch (err) {
      if (err instanceof ReorganizeQuotaError) {
        setQuotaMessage(err.message)
        setStage('quota_limited')
        return
      }
      showToast({ type: 'error', message: 'Could not reorganize the plan', description: (err as Error).message })
      setStage('form')
    }
  }

  const resultProposals = (proposals || []).filter((p) => proposalIds.includes(p.id))

  return (
    <Modal isOpen={isOpen} onClose={handleClose} size="lg" title="Organize with AI">
      <div className="space-y-4">
        {stage === 'form' && (
          <>
            <p className="text-sm text-[var(--text-secondary)]">
              Let AI tidy up your plan — turning messy rental/pricing lists into clean order forms, pulling suggested
              days/times/prices out of prose descriptions, and phrasing questions clearly. Nothing changes until you
              review and approve each suggestion, same as everywhere else in Tim's Trip Planner.
            </p>

            <div>
              <TextArea
                label="Anything specific you'd like tidied up? (optional)"
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                rows={3}
                placeholder="e.g. Convert the ski rental options into one order form"
              />
              <div className="mt-2 flex flex-wrap gap-1.5">
                {INSTRUCTION_CHIPS.map((phrase) => (
                  <Chip key={phrase} size="sm" onClick={() => toggleChip(phrase)} disabled={instructions.includes(phrase)}>
                    {phrase}
                  </Chip>
                ))}
              </div>
            </div>

            <TextArea
              label="Paste extra context (optional)"
              value={contextText}
              onChange={(e) => setContextText(e.target.value)}
              rows={4}
              placeholder="Paste a WhatsApp planning thread or notes to fold in…"
            />

            <div className="flex justify-end gap-3 pt-2 border-t border-[var(--border-subtle)]">
              <Button variant="ghost" onClick={handleClose}>
                Cancel
              </Button>
              <Button onClick={handleRun}>✨ Reorganize with AI</Button>
            </div>
          </>
        )}

        {stage === 'running' && (
          <div className="flex flex-col items-center gap-3 py-10 text-center">
            <Spinner size="lg" />
            <p className="text-sm font-medium text-[var(--text-primary)]">Reading your whole plan and drafting suggestions…</p>
            <p className="text-xs text-[var(--text-muted)] max-w-xs">
              This can take 30–60 seconds — it's reading every question, option, and event on this trip. Feel free to
              keep this sheet open; nothing is applied until you review it.
            </p>
          </div>
        )}

        {stage === 'quota_limited' && (
          <div className="space-y-3 py-6 text-center">
            <p className="text-3xl" aria-hidden="true">
              ⏳
            </p>
            <p className="text-sm text-[var(--text-secondary)]">{quotaMessage}</p>
            <Button variant="secondary" onClick={handleClose}>
              Close
            </Button>
          </div>
        )}

        {stage === 'result' && (
          <div className="space-y-3">
            <div className="rounded-[var(--radius-md)] bg-[var(--surface-sunken)] p-3">
              <p className="text-sm text-[var(--text-primary)]">{summary}</p>
            </div>

            {resultProposals.length > 0 ? (
              <div className="space-y-4">
                {resultProposals.map((proposal) => (
                  <ProposalReview key={proposal.id} proposal={proposal} trip={trip} />
                ))}
              </div>
            ) : (
              <p className="text-sm text-[var(--text-muted)]">
                Nothing staged this time. You can still open trip chat later — any suggestion always shows up there too.
              </p>
            )}

            <div className="flex justify-end gap-3 pt-2 border-t border-[var(--border-subtle)]">
              <Button
                variant="ghost"
                onClick={() => {
                  reset()
                }}
              >
                Run again
              </Button>
              <Button onClick={handleClose}>Done</Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
