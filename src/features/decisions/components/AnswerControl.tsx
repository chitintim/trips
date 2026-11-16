import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Badge, Button, Input, PriceTag, Select, SelectionAvatars, useToast } from '../../../components/ui'
import { useAnswer, type OptionWithSelections, type SectionWithOptions } from '../../../lib/queries/usePlanning'
import { formatMoney } from '../../../lib/money'
import { useOptionPrice } from '../lib/useOptionPrice'
import { CHANGE_ANY_TIME, TOAST_FAILED, describeAnswerError } from '../lib/answerCopy'
import { ownRowsToItems, ownTotals, recomputeOwnRow, type AnswerControlModel, type AnswerRow, type OwnRow } from '../lib/answerModel'
import { useQuestionAnswers } from '../lib/useQuestionAnswers'
import type { AnswerPlan } from '../lib/answerModel'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'
import type { Trip } from '../../../types'

export interface AnswerControlProps {
  trip: Trip
  /** The question with nested options and selections (`useSections` row). */
  section: SectionWithOptions
  /**
   * Render read-only because the question is decided/booked even though its
   * stored status is not 'completed' (QuestionCard passes this for a legacy
   * booked option on an open question).
   */
  closed?: boolean
  /**
   * Price slot for each option row. Defaults to the one price display
   * (`computeOptionPrice` + PriceTag: "≈£222 each" over "£2,000 total · 9 going · est.").
   */
  renderPrice?: (option: OptionWithSelections, section: SectionWithOptions) => ReactNode
  /** Hide the "Pick one / Pick any / Rank your top choices" line (the card header already says it). */
  hideInstruction?: boolean
  /** Hide the results line and per-option counts/avatars. */
  hideResults?: boolean
  /** Called when my state flips between unanswered / answered / passed (AnswerFlow gates "Next" on this). */
  onStateChange?: (state: AnswerControlModel['myState']) => void
  /** Called after an answer was written successfully. */
  onAnswered?: (plan: AnswerPlan) => void
  /** Option to emphasise and scroll into view (the item sheet opened from this option's card). Answering is unchanged. */
  focusOptionId?: string | null
  className?: string
}

const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-1'

/**
 * The single control to answer ANY question (proposal 5.4): choose one,
 * choose any, rank, date options, and own-choice orders with variants,
 * quantities and dates. Reads everything it needs from the query cache; writes
 * through `useAnswer`. It shows your current answer, the pass button
 * ("No preference" / "None for me"), why it is disabled when it is, and the
 * results inline when the question's stored setting makes them visible.
 */
export function AnswerControl({ trip, section, closed, renderPrice, hideInstruction, hideResults, onStateChange, onAnswered, focusOptionId = null, className = '' }: AnswerControlProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const { control, passesAvailable, headcount, participants } = useQuestionAnswers(trip, section, { closed })
  const { showToast } = useToast()
  const { answer, pendingSectionId } = useAnswer(trip.id)
  const pending = pendingSectionId === section.id

  useEffect(() => {
    onStateChange?.(control.myState)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [control.myState])

  // Bring the tapped option into view once it is rendered (no-op where scrollIntoView is missing).
  useEffect(() => {
    if (!focusOptionId) return
    const el = rootRef.current?.querySelector<HTMLElement>(`[data-option-id="${CSS.escape(focusOptionId)}"]`)
    el?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
  }, [focusOptionId])
  const focusClass = (optionId: string) => (focusOptionId === optionId ? ' rounded-[var(--radius-lg)] ring-2 ring-accent-500 ring-offset-2' : '')

  const run = (action: Parameters<typeof answer>[0]['action']) => {
    answer(
      { section: closed ? { ...section, status: 'completed' } : section, action },
      {
        onSuccess: (plan) => {
          if (!plan.noop) showToast({ type: 'success', message: plan.toast })
          onAnswered?.(plan)
        },
        onError: (error) => showToast({ type: 'error', message: TOAST_FAILED, description: describeAnswerError(error) }),
      }
    )
  }

  const optionsById = useMemo(() => new Map(section.options.map((o) => [o.id, o])), [section.options])
  const priceOf = useOptionPrice(trip, section, headcount, closed)
  const price = (optionId: string): ReactNode => {
    const option = optionsById.get(optionId)
    if (!option) return null
    if (renderPrice) return renderPrice(option, section)
    const p = priceOf(option)
    return p ? <PriceTag price={p} className="mt-1" /> : null
  }

  const voters = (ids: string[]): ReactNode => {
    if (hideResults || ids.length === 0) return null
    const people = (participants ?? []) as ParticipantWithUser[]
    return (
      <div className="mt-1.5 pl-1">
        <SelectionAvatars
          selections={ids.map((id) => {
            const u = people.find((p) => p.user_id === id)?.user
            return {
              id,
              user: u
                ? {
                    full_name: u.full_name ?? undefined,
                    email: u.email ?? undefined,
                    avatar_url: u.avatar_url ?? undefined,
                    avatar_data: (u.avatar_data as { emoji: string; bgColor: string } | null) ?? undefined,
                  }
                : undefined,
            }
          })}
          maxAvatars={4}
          size="sm"
          entityLabel="answered with this"
        />
      </div>
    )
  }

  const { gate, pass } = control
  const showPass = pass.visible && passesAvailable && !(pass.disabled && !pass.active)

  return (
    <div ref={rootRef} className={`space-y-3 ${className}`} data-testid="answer-control">
      {(!hideInstruction || gate.disabledLabel) && (
        <div className="flex items-center justify-between gap-2">
          {!hideInstruction ? <p className="text-xs font-medium text-[var(--text-secondary)]">{control.instruction}</p> : <span />}
          {gate.disabledLabel && (
            <Badge variant="neutral" size="sm">
              {gate.disabledLabel}
            </Badge>
          )}
        </div>
      )}

      {control.mode === 'own' && control.own ? (
        <OwnChoice
          model={control}
          pending={pending}
          disabled={!gate.canAnswer}
          voters={hideResults ? undefined : voters}
          focusOptionId={focusOptionId}
          onSave={(rows) => run({ type: 'save_own', items: ownRowsToItems(rows) })}
        />
      ) : (
        <div
          role={control.mode === 'single' ? 'radiogroup' : 'group'}
          aria-label={control.instruction}
          className="space-y-2"
        >
          {control.rows.map((row) => (
            <div key={row.optionId} data-option-id={row.optionId} data-focused={focusOptionId === row.optionId ? 'true' : undefined} className={focusClass(row.optionId).trim() || undefined}>
              <GroupRow
                row={row}
                mode={control.mode}
                hideResults={!!hideResults}
                onPick={() => run({ type: 'pick', optionId: row.optionId })}
                price={price(row.optionId)}
              />
              {voters(row.voterIds)}
            </div>
          ))}
        </div>
      )}

      {(showPass || (control.mode === 'ranked' && control.canClear && gate.canAnswer)) && (
        <div className="flex flex-wrap items-center gap-2">
          {showPass && (
            <Button
              variant={pass.active ? 'primary' : 'outline'}
              size="sm"
              aria-pressed={pass.active}
              disabled={pass.disabled}
              onClick={() => run(pass.active ? { type: 'unpass' } : { type: 'pass' })}
            >
              {pass.active ? `✓ ${pass.label}` : pass.label}
            </Button>
          )}
          {control.mode === 'ranked' && control.canClear && gate.canAnswer && (
            <Button variant="ghost" size="sm" onClick={() => run({ type: 'clear' })}>
              Clear
            </Button>
          )}
        </div>
      )}

      {/* Polite live region: my current answer, then the results line. */}
      <div aria-live="polite" className="space-y-1">
        {control.mySummary && <p className="text-sm font-medium text-[var(--text-primary)]">{control.mySummary}</p>}
        {!hideResults && control.results.leaderLabel && <p className="text-xs text-[var(--text-secondary)]">{control.results.leaderLabel}</p>}
        {!hideResults && control.results.hiddenNote && <p className="text-xs text-[var(--text-muted)]">{control.results.hiddenNote}</p>}
        {gate.reason && <p className="text-xs text-[var(--text-muted)]">{gate.reason}</p>}
        {gate.canAnswer && control.myState !== 'unanswered' && control.mode !== 'own' && <p className="text-xs text-[var(--text-muted)]">{CHANGE_ANY_TIME}</p>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Group choice row
// ---------------------------------------------------------------------------

function Indicator({ row }: { row: AnswerRow }) {
  if (row.indicator === 'rank') {
    return (
      <span
        aria-hidden="true"
        className={`mt-0.5 flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full border-2 px-1 text-[10px] font-semibold ${
          row.selected ? 'border-accent-600 bg-accent-600 text-white' : 'border-[var(--border-default)] text-transparent'
        }`}
      >
        {row.selected ? row.marker : '•'}
      </span>
    )
  }
  if (row.indicator === 'checkbox') {
    return (
      <span
        aria-hidden="true"
        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--radius-sm)] border-2 text-xs text-white ${
          row.selected ? 'border-accent-600 bg-accent-600' : 'border-[var(--border-default)]'
        }`}
      >
        {row.selected ? '✓' : ''}
      </span>
    )
  }
  return (
    <span
      aria-hidden="true"
      className={`mt-0.5 h-5 w-5 shrink-0 rounded-full border-2 ${
        row.selected ? 'border-accent-600 bg-accent-600 shadow-[inset_0_0_0_3px_var(--surface-raised)]' : 'border-[var(--border-default)]'
      }`}
    />
  )
}

function GroupRow({ row, mode, hideResults, onPick, price }: { row: AnswerRow; mode: AnswerControlModel['mode']; hideResults: boolean; onPick: () => void; price: ReactNode }) {
  const role = mode === 'single' ? 'radio' : mode === 'any' ? 'checkbox' : undefined
  const label = [row.title, row.dateLabel, row.selected ? (mode === 'ranked' ? `ranked ${row.marker}` : 'your answer') : null].filter(Boolean).join(', ')
  return (
    <button
      type="button"
      role={role}
      aria-checked={role ? row.selected : undefined}
      aria-pressed={role ? undefined : row.selected}
      aria-label={label}
      aria-describedby={undefined}
      disabled={row.disabled}
      title={row.disabled ? row.disabledReason ?? undefined : undefined}
      onClick={onPick}
      className={`flex min-h-[44px] w-full items-start gap-3 rounded-[var(--radius-lg)] border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-70 ${FOCUS_RING} ${
        row.selected ? 'border-accent-400 bg-accent-50 dark:bg-accent-950/30' : 'border-[var(--border-default)] hover:border-accent-300'
      }`}
    >
      <Indicator row={row} />
      <span className="min-w-0 flex-1">
        <span className="block break-words font-medium text-[var(--text-primary)]">{row.dateLabel ?? row.title}</span>
        {row.dateLabel && row.title !== row.dateLabel && <span className="block text-xs text-[var(--text-secondary)]">{row.title}</span>}
        {row.description && <span className="mt-0.5 block break-words text-xs text-[var(--text-secondary)]">{row.description}</span>}
        {price}
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1 text-right">
        {row.selected && mode !== 'ranked' && <span className="text-xs font-semibold text-accent-700 dark:text-accent-300">{row.marker}</span>}
        {!hideResults && row.countLabel && (
          <span className={`text-xs ${row.leading ? 'font-semibold text-[var(--text-primary)]' : 'text-[var(--text-muted)]'}`}>{row.countLabel}</span>
        )}
      </span>
    </button>
  )
}

// ---------------------------------------------------------------------------
// Own choice (order form with variants, quantities and dates)
// ---------------------------------------------------------------------------

function OwnChoice({
  model,
  pending,
  disabled,
  voters,
  focusOptionId = null,
  onSave,
}: {
  model: AnswerControlModel
  pending: boolean
  disabled: boolean
  voters?: (ids: string[]) => ReactNode
  focusOptionId?: string | null
  onSave: (rows: OwnRow[]) => void
}) {
  const serverRows = model.own?.rows ?? []
  const seedKey = JSON.stringify(ownRowsToItems(serverRows))
  const [draft, setDraft] = useState<OwnRow[]>(serverRows)

  // A saved change (or another device) re-seeds the draft.
  useEffect(() => {
    setDraft(serverRows)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedKey])

  const dirty = JSON.stringify(ownRowsToItems(draft)) !== seedKey
  const totals = ownTotals(draft)
  const update = (optionId: string, patch: Partial<Pick<OwnRow, 'checked' | 'variant' | 'quantity' | 'startDate' | 'endDate'>>) =>
    setDraft((rows) => rows.map((r) => (r.optionId === optionId ? recomputeOwnRow(r, patch) : r)))

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        {draft.map((row) => (
          <div
            key={row.optionId}
            data-option-id={row.optionId}
            data-focused={focusOptionId === row.optionId ? 'true' : undefined}
            className={`space-y-3 rounded-[var(--radius-lg)] border p-3 ${focusOptionId === row.optionId ? 'border-accent-500 ring-2 ring-accent-500' : 'border-[var(--border-default)]'}`}
          >
            <label className="flex min-h-[44px] cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                checked={row.checked}
                disabled={disabled || row.disabled}
                onChange={(e) => update(row.optionId, { checked: e.target.checked })}
                className={`mt-0.5 h-5 w-5 accent-accent-600 ${FOCUS_RING}`}
              />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-[var(--text-primary)]">{row.title}</span>
                  {row.perDay != null && <PriceTag text={{ headline: `${formatMoney(row.perDay, row.currency)}/day each` }} size="inline" />}
                  {row.flat != null && <PriceTag text={{ headline: `${formatMoney(row.flat, row.currency)} each` }} size="inline" />}
                  {row.countLabel && <span className="text-xs text-[var(--text-muted)]">{row.countLabel}</span>}
                </span>
                {row.description && <span className="mt-0.5 block text-xs text-[var(--text-secondary)]">{row.description}</span>}
              </span>
            </label>
            {voters?.(row.voterIds)}

            {row.checked && (
              <div className="space-y-3 pl-8">
                {row.variants.length > 0 && (
                  <Select
                    label="Variant"
                    value={row.variant}
                    disabled={disabled}
                    onChange={(e) => update(row.optionId, { variant: e.target.value })}
                    options={[{ value: '', label: 'Standard' }, ...row.variants.map((v) => ({ value: v, label: v }))]}
                  />
                )}
                {row.needsDates && (
                  <div className="grid grid-cols-2 gap-3">
                    <Input label="From" type="date" value={row.startDate} disabled={disabled} onChange={(e) => update(row.optionId, { startDate: e.target.value })} />
                    <Input label="To" type="date" value={row.endDate} disabled={disabled} onChange={(e) => update(row.optionId, { endDate: e.target.value })} />
                  </div>
                )}
                <div className="flex items-center gap-3">
                  <span id={`qty-${row.optionId}`} className="text-sm text-[var(--text-secondary)]">
                    Quantity
                  </span>
                  <div className="flex items-center gap-2" role="group" aria-labelledby={`qty-${row.optionId}`}>
                    <Button variant="outline" size="sm" aria-label={`Fewer ${row.title}`} disabled={disabled || row.quantity <= 1} onClick={() => update(row.optionId, { quantity: row.quantity - 1 })}>
                      −
                    </Button>
                    <span className="w-6 text-center text-sm font-medium text-[var(--text-primary)]" aria-live="polite">
                      {row.quantity}
                    </span>
                    <Button variant="outline" size="sm" aria-label={`More ${row.title}`} disabled={disabled} onClick={() => update(row.optionId, { quantity: row.quantity + 1 })}>
                      +
                    </Button>
                  </div>
                  {row.pricing && row.total > 0 && <span className="ml-auto text-sm font-semibold text-[var(--text-primary)]">{formatMoney(row.total, row.currency)}</span>}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {totals.totalLabel && (
      <div className="flex items-center justify-between gap-3 rounded-[var(--radius-lg)] bg-[var(--surface-sunken)] p-3">
        <span className="text-sm font-medium text-[var(--text-primary)]">Your total</span>
        <span className="text-lg font-semibold text-[var(--text-primary)]">{totals.totalLabel}</span>
      </div>
      )}

      {!disabled && (
        <Button onClick={() => onSave(draft)} isLoading={pending} disabled={!dirty || pending}>
          {totals.hasChecked || !dirty ? 'Save my answer' : 'Remove my answer'}
        </Button>
      )}
    </div>
  )
}
