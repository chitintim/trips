import { useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Badge, Button, Card, useToast } from '../../../components/ui'
import { useAuth } from '../../../hooks/useAuth'
import { queryKeys } from '../../../lib/queries/queryKeys'
import { useUpdateProposalStatus, type AiProposal } from '../../../lib/queries/useProposals'
import { useTripActivityLog } from '../../organizer/lib/activity'
import {
  applyAction,
  describeAction,
  parseProposalActions,
  loadAppliedKeys,
  saveAppliedKey,
  type ParsedActionEntry,
} from '../lib/applyProposal'
import { ProposalActionEditSheet } from './ProposalActionEditSheet'
import type { ProposedAction } from '../../../shared/contracts/aiProposal'
import type { Trip } from '../../../types'

type CardStatus = 'pending' | 'applying' | 'applied' | 'discarded' | 'error'

export interface ProposalReviewProps {
  proposal: AiProposal
  trip: Trip
}

/**
 * Review cards for one ai_proposals row (plan §13.2): each ProposedAction
 * renders as a card with per-card Approve / Edit / Discard plus an
 * Approve-all — except delete_request, which is excluded from bulk apply
 * and needs an individual two-step confirm (danger styling). Applies run
 * under the reviewing user's JWT; idempotency keys already applied (this
 * or a previous session) are skipped.
 */
export function ProposalReview({ proposal, trip }: ProposalReviewProps) {
  const { user } = useAuth()
  const { showToast } = useToast()
  const queryClient = useQueryClient()
  const updateStatus = useUpdateProposalStatus(trip.id)
  const logActivity = useTripActivityLog(trip.id)

  const entries = useMemo(() => parseProposalActions(proposal.actions), [proposal.actions])

  const [statuses, setStatuses] = useState<Record<string, CardStatus>>(() => {
    const applied = loadAppliedKeys(proposal.id)
    const initial: Record<string, CardStatus> = {}
    for (const entry of entries) initial[entry.key] = applied.has(entry.key) ? 'applied' : 'pending'
    return initial
  })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [overrides, setOverrides] = useState<Record<string, ProposedAction>>({})
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [armedDeleteKey, setArmedDeleteKey] = useState<string | null>(null)
  const [bulkApplying, setBulkApplying] = useState(false)

  const setStatus = (key: string, status: CardStatus) => setStatuses((prev) => ({ ...prev, [key]: status }))

  const effectiveAction = (entry: ParsedActionEntry): ProposedAction | null => overrides[entry.key] ?? entry.action

  const finalizeIfDone = async (nextStatuses: Record<string, CardStatus>) => {
    const values = entries.map((e) => nextStatuses[e.key])
    if (values.some((s) => s === 'pending' || s === 'applying')) return
    const appliedCount = values.filter((s) => s === 'applied').length
    const problemCount = values.filter((s) => s === 'discarded' || s === 'error').length
    const status = appliedCount === 0 ? 'rejected' : problemCount > 0 ? 'partially_applied' : 'approved'
    try {
      await updateStatus.mutateAsync({
        id: proposal.id,
        status,
        reviewedBy: user?.id,
        appliedAt: appliedCount > 0 ? new Date().toISOString() : undefined,
      })
      if (appliedCount > 0) {
        logActivity({
          verb: 'proposal_applied',
          entity: { type: 'ai_proposal', id: proposal.id, label: `${appliedCount} change${appliedCount === 1 ? '' : 's'}` },
          metadata: { applied: appliedCount, total: entries.length },
        })
      }
    } catch {
      // Status bookkeeping failure shouldn't undo the applied writes; the
      // proposal stays pending and applied keys are remembered locally.
    }
  }

  const applyOne = async (entry: ParsedActionEntry): Promise<boolean> => {
    const action = effectiveAction(entry)
    if (!action || !user) return false
    setStatus(entry.key, 'applying')
    try {
      await applyAction(action, { tripId: trip.id, userId: user.id, baseCurrency: trip.base_currency || 'GBP' })
      saveAppliedKey(proposal.id, entry.key)
      const desc = describeAction(action)
      showToast({ type: 'success', message: `${desc.title} — done`, description: desc.summary })
      queryClient.invalidateQueries({ queryKey: queryKeys.trip(trip.id) })
      return true
    } catch (err) {
      setErrors((prev) => ({ ...prev, [entry.key]: (err as Error).message }))
      showToast({ type: 'error', message: 'Could not apply change', description: (err as Error).message })
      return false
    }
  }

  const handleApprove = async (entry: ParsedActionEntry) => {
    const ok = await applyOne(entry)
    const next = { ...statuses, [entry.key]: ok ? ('applied' as const) : ('error' as const) }
    setStatuses(next)
    await finalizeIfDone(next)
  }

  const handleDiscard = async (entry: ParsedActionEntry) => {
    const next = { ...statuses, [entry.key]: 'discarded' as const }
    setStatuses(next)
    await finalizeIfDone(next)
  }

  const handleApproveAll = async () => {
    setBulkApplying(true)
    const next = { ...statuses }
    for (const entry of entries) {
      if (next[entry.key] !== 'pending') continue
      const action = effectiveAction(entry)
      if (!action || action.type === 'delete_request') continue // deletes are never bulk-approved
      const ok = await applyOne(entry)
      next[entry.key] = ok ? 'applied' : 'error'
      setStatuses({ ...next })
    }
    setBulkApplying(false)
    await finalizeIfDone(next)
  }

  const pendingEntries = entries.filter((e) => statuses[e.key] === 'pending')
  const bulkable = pendingEntries.filter((e) => {
    const a = effectiveAction(e)
    return a && a.type !== 'delete_request'
  })

  const editingEntry = editingKey ? entries.find((e) => e.key === editingKey) : null

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
          ✨ Proposed changes ({entries.length}) — nothing is applied until you approve it
        </p>
        {bulkable.length > 1 && (
          <Button size="sm" variant="secondary" onClick={handleApproveAll} isLoading={bulkApplying}>
            Approve all ({bulkable.length})
          </Button>
        )}
      </div>

      {entries.map((entry) => {
        const action = effectiveAction(entry)
        const status = statuses[entry.key]
        const desc = action ? describeAction(action) : null
        const isArmed = armedDeleteKey === entry.key

        return (
          <Card key={entry.key} variant="flat" className={desc?.isDelete ? 'border border-danger-300' : ''}>
            <Card.Content>
              <div className="flex items-start gap-3">
                <span className="text-xl" aria-hidden="true">
                  {desc?.icon ?? '⚠️'}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-[var(--text-primary)]">
                      {desc?.title ?? 'Invalid suggestion'}
                    </span>
                    {desc && (
                      <Badge variant={desc.isDelete ? 'error' : 'neutral'} size="sm">
                        {desc.target}
                      </Badge>
                    )}
                    {status === 'applied' && (
                      <Badge variant="success" size="sm">
                        Applied
                      </Badge>
                    )}
                    {status === 'discarded' && (
                      <Badge variant="neutral" size="sm">
                        Discarded
                      </Badge>
                    )}
                    {status === 'error' && (
                      <Badge variant="error" size="sm">
                        Failed
                      </Badge>
                    )}
                  </div>
                  <p className="mt-0.5 text-sm text-[var(--text-secondary)] break-words">
                    {desc?.summary ?? `The AI sent something malformed (${entry.error}). Edit it into shape or discard.`}
                  </p>
                  {status === 'error' && errors[entry.key] && (
                    <p className="mt-1 text-xs text-danger-600">{errors[entry.key]}</p>
                  )}

                  {status === 'pending' && (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {desc?.isDelete ? (
                        isArmed ? (
                          <>
                            <Button size="sm" variant="danger" onClick={() => handleApprove(entry)}>
                              Yes, delete it
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setArmedDeleteKey(null)}>
                              Keep it
                            </Button>
                          </>
                        ) : (
                          <Button size="sm" variant="danger" onClick={() => setArmedDeleteKey(entry.key)}>
                            Delete…
                          </Button>
                        )
                      ) : (
                        action && (
                          <Button size="sm" onClick={() => handleApprove(entry)}>
                            Approve
                          </Button>
                        )
                      )}
                      {!desc?.isDelete && (
                        <Button size="sm" variant="ghost" onClick={() => setEditingKey(entry.key)}>
                          Edit
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => handleDiscard(entry)}>
                        Discard
                      </Button>
                    </div>
                  )}
                  {status === 'applying' && <p className="mt-2 text-xs text-[var(--text-muted)]">Applying…</p>}
                </div>
              </div>
            </Card.Content>
          </Card>
        )
      })}

      {editingEntry && (
        <ProposalActionEditSheet
          key={editingEntry.key}
          isOpen
          onClose={() => setEditingKey(null)}
          tripId={trip.id}
          action={effectiveAction(editingEntry) ?? ((editingEntry.raw ?? {}) as Record<string, unknown>)}
          onSave={(edited) => setOverrides((prev) => ({ ...prev, [editingEntry.key]: edited }))}
        />
      )}
    </div>
  )
}
