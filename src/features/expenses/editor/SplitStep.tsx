import { SegmentedControl, Input, Button, Badge, UserAvatar } from '../../../components/ui'
import { computeSplits, validateSplitSum, computeNightsWeightSplitEntries } from './computeSplits'
import { formatMoney } from '../lib/formatMoney'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'
import type { TimelineEvent } from '../../../types'
import type { ExpenseWizardDraft, SplitEntry } from './wizardState'
import type { SplitMode } from '../types'

export interface SplitStepProps {
  draft: ExpenseWizardDraft
  onChange: (patch: Partial<ExpenseWizardDraft>) => void
  participants: ParticipantWithUser[]
  timelineEvents: TimelineEvent[]
  tripStartDate: string
  tripEndDate: string
  onGoToItemized: () => void
}

const SPLIT_MODE_OPTIONS: Array<{ value: SplitMode; label: string }> = [
  { value: 'equal', label: 'Equal' },
  { value: 'custom', label: 'Custom' },
  { value: 'percentage', label: '%' },
  { value: 'shares', label: 'Shares' },
  { value: 'itemized', label: 'Itemized' },
]

/**
 * Split step (plan §10 #2): Equal / Custom / Percentage / Shares (with
 * weight steppers, "couples count 2x") / Itemized. Accommodation-category
 * expenses get a one-tap "weight by nights present" button that pre-fills
 * Shares mode from each tagged participant's timeline arrival/departure.
 */
export function SplitStep({
  draft,
  onChange,
  participants,
  timelineEvents,
  tripStartDate,
  tripEndDate,
  onGoToItemized,
}: SplitStepProps) {
  const activeParticipants = participants.filter((p) => draft.participantIds.includes(p.user_id))
  const amountMajor = parseFloat(draft.amount) || 0

  const updateEntry = (userId: string, value: string) => {
    const next = draft.splitEntries.some((e) => e.userId === userId)
      ? draft.splitEntries.map((e) => (e.userId === userId ? { ...e, value } : e))
      : [...draft.splitEntries, { userId, value }]
    onChange({ splitEntries: next })
  }

  const entryValue = (userId: string): string => draft.splitEntries.find((e) => e.userId === userId)?.value ?? ''

  const handleModeChange = (mode: SplitMode) => {
    if (mode === 'itemized') {
      onGoToItemized()
      return
    }
    onChange({ splitMode: mode })
  }

  const applyNightsWeighting = () => {
    const entries: SplitEntry[] = computeNightsWeightSplitEntries(
      draft.participantIds,
      timelineEvents,
      tripStartDate,
      tripEndDate
    )
    onChange({ splitMode: 'shares', splitEntries: entries, nightsWeightingApplied: true })
  }

  const preview =
    draft.splitMode !== 'itemized'
      ? computeSplits({
          mode: draft.splitMode,
          amountMajor,
          currency: draft.currency,
          participantIds: draft.participantIds,
          entries: draft.splitEntries,
        })
      : []

  const validation =
    draft.splitMode === 'custom' || draft.splitMode === 'percentage'
      ? validateSplitSum(draft.splitMode, draft.splitEntries, draft.participantIds, amountMajor, draft.currency)
      : null

  return (
    <div className="space-y-4">
      <SegmentedControl
        options={SPLIT_MODE_OPTIONS}
        value={draft.splitMode}
        onChange={handleModeChange}
        fullWidth
        size="sm"
      />

      {draft.category === 'accommodation' && (
        <Button variant="secondary" size="sm" onClick={applyNightsWeighting} leftIcon={<span>🌙</span>}>
          Weight by nights present
        </Button>
      )}

      {draft.nightsWeightingApplied && draft.splitMode === 'shares' && (
        <Badge variant="info" size="sm">Weighted by nights present — edit weights below if needed</Badge>
      )}

      <div className="space-y-2">
        {activeParticipants.map((p) => {
          const computed = preview.find((s) => s.userId === p.user_id)
          return (
            <div key={p.user_id} className="flex items-center gap-3">
              <UserAvatar avatarData={p.user.avatar_data} size="xs" alt={p.user.full_name ?? p.user.email} />
              <span className="flex-1 text-sm font-medium text-[var(--text-primary)] truncate">
                {p.user.full_name || p.user.email}
              </span>

              {draft.splitMode === 'equal' && (
                <span className="text-sm text-[var(--text-secondary)] tabular-nums">
                  {computed ? formatMoney(computed.amountMajor, draft.currency) : '—'}
                </span>
              )}

              {draft.splitMode === 'custom' && (
                <Input
                  size="sm"
                  inputMode="decimal"
                  value={entryValue(p.user_id)}
                  onChange={(e) => updateEntry(p.user_id, e.target.value)}
                  className="w-28"
                  fullWidth={false}
                  leftAddon={draft.currency}
                />
              )}

              {draft.splitMode === 'percentage' && (
                <Input
                  size="sm"
                  inputMode="decimal"
                  value={entryValue(p.user_id)}
                  onChange={(e) => updateEntry(p.user_id, e.target.value)}
                  className="w-20"
                  fullWidth={false}
                  rightAddon="%"
                />
              )}

              {draft.splitMode === 'shares' && (
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      const current = parseFloat(entryValue(p.user_id)) || 1
                      updateEntry(p.user_id, String(Math.max(0, current - 1)))
                    }}
                    className="w-7 h-7 flex items-center justify-center rounded-[var(--radius-sm)] border border-[var(--border-default)] hover:bg-[var(--surface-sunken)]"
                  >
                    −
                  </button>
                  <span className="w-6 text-center text-sm tabular-nums">{entryValue(p.user_id) || '1'}</span>
                  <button
                    type="button"
                    onClick={() => {
                      const current = parseFloat(entryValue(p.user_id)) || 1
                      updateEntry(p.user_id, String(current + 1))
                    }}
                    className="w-7 h-7 flex items-center justify-center rounded-[var(--radius-sm)] border border-[var(--border-default)] hover:bg-[var(--surface-sunken)]"
                  >
                    +
                  </button>
                  {computed && (
                    <span className="text-sm text-[var(--text-secondary)] tabular-nums ml-1 w-16 text-right">
                      {formatMoney(computed.amountMajor, draft.currency)}
                    </span>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {validation && !validation.isValid && (
        <p className="text-sm text-danger-600" role="alert">
          {draft.splitMode === 'percentage'
            ? `Percentages sum to ${validation.sumMajor}%, must equal 100%.`
            : `Splits sum to ${formatMoney(validation.sumMajor, draft.currency)}, must equal ${formatMoney(
                validation.targetMajor,
                draft.currency
              )}.`}
        </p>
      )}
    </div>
  )
}
