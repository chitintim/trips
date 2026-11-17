import { useMemo, useRef, useState, type ReactNode } from 'react'
import { Button, Modal, Tabs, useToast } from '../../../components/ui'
import { fromMinorUnits } from '../../../lib/money'
import { useFormDraft } from '../../../lib/forms'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'
import { ReceiptLightbox } from '../components/ReceiptLightbox'
import { ParticipantChipRow } from '../components/ParticipantChipRow'
import { LineItemEditor } from './LineItemEditor'
import { AdjustmentsPanel } from './AdjustmentsPanel'
import { buildSaveLines, describeTotalsMismatch, addGapAsService, addGapAsDiscount, validateDraftLines, draftTotalMinor, ZERO_TOTAL_MESSAGE, type ItemizedDraft, type ItemizedSaveLine } from './itemizedState'
import { diffReitemise, clearedClaimsWarningText } from './reitemizeDiff'
import { formatMoneyMinor } from '../lib/formatMoney'
import { reitemizeErrorMessage } from '../editor/reitemizeRun'

export type { ItemizedSaveLine } from './itemizedState'

/** What a save would clear, for the confirm dialog. `all` = every claim on the receipt (the database function is not there yet). */
export interface ClearClaimsPreview {
  userIds: string[]
  /** People who said "That's everything" and will be asked to check again (their answer is deleted). */
  reconfirmUserIds?: string[]
  claimCount?: number
  all?: boolean
  leftoversCleared?: boolean
}

export interface ItemizedSaveParams {
  lineItems: ItemizedSaveLine[]
  totalMajor: number
  participantIds: string[]
}

export interface ItemizedEditorScreenProps {
  initialDraft: ItemizedDraft
  onBack: () => void
  onSave: (params: ItemizedSaveParams) => Promise<boolean>
  /** Asked at Save time on a receipt that already has items: whose claims would be cleared? Null/empty = none. Without it the editor works it out from `existingClaims` alone. */
  onPreviewClear?: (params: ItemizedSaveParams) => Promise<ClearClaimsPreview | null>
  isSaving?: boolean
  /** True when a receipt WAS parsed but came back with zero line items -- the UI must say so rather than silently showing one blank row as if nothing had been attempted (Form & Flow Standard: no dead-empty states). */
  noItemsParsedNotice?: boolean
  /**
   * Bridges edits made in here up to the parent wizard's own `isDirty`
   * (audit finding #3a) -- without this, itemizing a receipt and then
   * backing out or closing the modal never triggered the unsaved-changes
   * guard because the wizard had no idea this screen's local draft state
   * had changed.
   */
  onDirty?: () => void
  /**
   * sessionStorage draft-persistence key + enable flag, mirroring the outer
   * wizard's useFormDraft usage (audit finding #3c) -- disabled in edit mode
   * so re-editing an already-itemized expense always seeds from the saved
   * line items, never a stale autosave (Form & Flow Standard point 2).
   */
  draftKey: string
  draftEnabled?: boolean
  /** Storage path of the source receipt, if any -- lets the user double-check ambiguous fields against the original image without leaving this screen (audit finding #3d). */
  receiptPath?: string | null
  /** Everyone who can be on the receipt (the trip's active participants). */
  participants: ParticipantWithUser[]
  /** Who is ticked in "Who was at this meal?" to start with. */
  initialParticipantIds: string[]
  /** Saved line items of the expense being re-edited (edit mode); with `existingClaims` it drives the "claims will be cleared" warning. */
  existingLineItems?: Array<{ id: string; name_original: string; quantity: number; subtotal: number; total_amount: number }>
  /** Currency the saved expense is in (a change leaves no claim unchanged). */
  existingCurrency?: string
  existingClaims?: Array<{ line_item_id: string; user_id: string; quantity_claimed: number }>
  /** Phase 2 fills this with the claim-deadline line; rendered just above the save button, nothing when undefined. */
  claimDeadlineSlot?: ReactNode
  /** Messages about the title/vendor set on the form (too long for the database); they block Save here too. */
  headerProblems?: string[]
}

/**
 * Combines the line-item editor + adjustments review panel (plan §10 #3)
 * into one screen with tabs, and computes the final per-line totals
 * (subtotal + this line's proportional share of tax/service, matching
 * the money module's exact-sum guarantee) on save. Also: a totals mismatch
 * notice with one-tap fixes, "Who was at this meal?", and a warning before a
 * save that would clear people's claims.
 */
export function ItemizedEditorScreen({
  initialDraft,
  onBack,
  onSave,
  onPreviewClear,
  isSaving,
  noItemsParsedNotice,
  onDirty,
  draftKey,
  draftEnabled = true,
  receiptPath,
  participants,
  initialParticipantIds,
  existingLineItems,
  existingCurrency,
  existingClaims,
  claimDeadlineSlot,
  headerProblems = [],
}: ItemizedEditorScreenProps) {
  const { values: draft, setValues: setDraft, clearDraft } = useFormDraft<ItemizedDraft>(draftKey, initialDraft, { enabled: draftEnabled })
  const { showToast } = useToast()
  const [tab, setTab] = useState<'items' | 'adjustments'>('items')
  const [showReceiptLightbox, setShowReceiptLightbox] = useState(false)
  const [participantIds, setParticipantIds] = useState<string[]>(initialParticipantIds)
  const [pendingClear, setPendingClear] = useState<ClearClaimsPreview | null>(null)
  const [checking, setChecking] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const handleDraftChange = (next: ItemizedDraft) => {
    setDraft(next)
    onDirty?.()
  }

  const toggleParticipant = (userId: string) => {
    setParticipantIds((prev) => (prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId]))
    onDirty?.()
  }

  const mismatch = useMemo(() => describeTotalsMismatch(draft), [draft])
  const noOneChosen = participantIds.length === 0
  const problems = useMemo(() => validateDraftLines(draft), [draft])
  const zeroTotal = draftTotalMinor(draft) <= 0
  const hasProblems = problems.length > 0 || headerProblems.length > 0 || zeroTotal
  const hasClaimData = existingLineItems !== undefined && existingLineItems.length > 0

  const goEditItems = () => {
    setTab('items')
    // Wait a tick so the items panel is mounted, then land on the first item.
    setTimeout(() => rootRef.current?.querySelector<HTMLInputElement>('input[placeholder="Item name"]')?.focus(), 0)
  }

  const nameOf = (userId: string) => {
    const p = participants.find((x) => x.user_id === userId)
    return p?.user.full_name || p?.user.email || 'Someone'
  }

  const buildParams = (): ItemizedSaveParams => {
    const { lines, totalMinor } = buildSaveLines(draft)
    // Only people still in the roster can be unticked, so drop ids the chip row cannot show.
    const known = new Set(participants.map((p) => p.user_id))
    const chosen = participants.length > 0 ? participantIds.filter((id) => known.has(id)) : participantIds
    return { lineItems: lines, totalMajor: fromMinorUnits(totalMinor, draft.currency), participantIds: chosen }
  }

  // Every async step reports a failure on screen: nothing here may reject unseen.
  const guarded = async (fn: () => Promise<void>) => {
    setSaveError(null)
    try {
      await fn()
    } catch (err) {
      setSaveError(err instanceof Error && err.message ? err.message : "We couldn't save this receipt. Try again.")
    }
  }

  const runSave = async () => {
    // onSave reports success/failure explicitly (rather than throwing) so
    // the draft is only cleared once the save actually lands -- a failed
    // save must leave the in-progress itemization intact (audit #3c).
    const ok = await onSave(buildParams())
    if (ok) clearDraft()
  }

  const handleSaveClick = () =>
    guarded(async () => {
      if (noOneChosen || hasProblems) return
      if (!hasClaimData) return runSave()
      const params = buildParams()
      if (onPreviewClear) {
        setChecking(true)
        try {
          const preview = await onPreviewClear(params)
          if (preview && (preview.userIds.length > 0 || (preview.reconfirmUserIds?.length ?? 0) > 0)) {
            setPendingClear(preview)
            return
          }
        } catch (err) {
          // The preview itself was refused (frozen, claims closed, a bad amount): say why instead of a Save tap that does nothing.
          showToast({ type: 'error', message: 'Could not check this change', description: reitemizeErrorMessage(err as { hint?: string }) })
          return
        } finally {
          setChecking(false)
        }
        return runSave()
      }
      const diff = diffReitemise({
        existingLines: existingLineItems ?? [],
        existingClaims: existingClaims ?? [],
        newLines: params.lineItems,
        currency: draft.currency,
        previousCurrency: existingCurrency,
      })
      if (diff.clearedClaimCount > 0) {
        setPendingClear({ userIds: diff.clearedUserIds, claimCount: diff.clearedClaimCount })
        return
      }
      return runSave()
    })

  return (
    <div className="space-y-4" ref={rootRef}>
      {noItemsParsedNotice && (
        <div className="rounded-[var(--radius-md)] border border-warn-200 bg-warn-50 dark:bg-warn-900 dark:border-warn-800 px-3 py-2.5 text-sm text-warn-700 dark:text-warn-300">
          ⚠️ No line items were read from this receipt — add them manually below, or go back and re-scan.
        </div>
      )}

      {draft.foldedSavingsMinor ? (
        <div role="status" className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] px-3 py-2.5 text-sm text-[var(--text-secondary)]">
          The receipt listed savings of {formatMoneyMinor(draft.foldedSavingsMinor, draft.currency)}. We took them off as a discount.
        </div>
      ) : null}

      {receiptPath && (
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={() => setShowReceiptLightbox(true)}>
            📄 View receipt
          </Button>
        </div>
      )}

      {mismatch.kind !== 'match' && (
        <div
          role="status"
          className="rounded-[var(--radius-md)] border border-warn-200 bg-warn-50 dark:bg-warn-900 dark:border-warn-800 px-3 py-2.5 text-sm text-warn-700 dark:text-warn-300"
        >
          <p className="font-medium">{mismatch.message}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {mismatch.kind === 'short' && (
              <Button size="sm" variant="secondary" onClick={() => handleDraftChange(addGapAsService(draft))}>
                Add {mismatch.deltaText} as service
              </Button>
            )}
            {mismatch.kind === 'over' && (
              <Button size="sm" variant="secondary" onClick={() => handleDraftChange(addGapAsDiscount(draft))}>
                Add {mismatch.deltaText} discount
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={goEditItems}>
              Edit items
            </Button>
          </div>
        </div>
      )}

      <Tabs value={tab} onChange={(v) => setTab(v as 'items' | 'adjustments')}>
        <Tabs.List>
          <Tabs.Tab value="items">Line items</Tabs.Tab>
          <Tabs.Tab value="adjustments">Tax & service</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="items" className="pt-4">
          <LineItemEditor draft={draft} onChange={handleDraftChange} />
        </Tabs.Panel>
        <Tabs.Panel value="adjustments" className="pt-4">
          <AdjustmentsPanel draft={draft} onChange={handleDraftChange} />
        </Tabs.Panel>
      </Tabs>

      <section
        aria-labelledby="itemized-who-heading"
        className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] p-3 space-y-2"
      >
        <h3 id="itemized-who-heading" className="text-sm font-medium text-[var(--text-primary)]">
          Who was at this meal?
        </h3>
        <p className="text-xs text-[var(--text-muted)]">Untick anyone who was not there. Only these people are asked to claim items.</p>
        <ParticipantChipRow participants={participants} selectedUserIds={participantIds} onToggle={toggleParticipant} disabled={isSaving} />
        {noOneChosen && (
          <p id="itemized-who-error" role="alert" className="text-xs text-danger-600">
            Choose at least one person.
          </p>
        )}
      </section>

      {claimDeadlineSlot != null && <div data-slot="claim-deadline">{claimDeadlineSlot}</div>}

      {problems.length > 0 && (
        <p role="alert" className="text-xs text-danger-600">
          Fix the items marked above to save.
        </p>
      )}
      {zeroTotal && (
        <p role="alert" className="text-xs text-danger-600">
          {ZERO_TOTAL_MESSAGE}
        </p>
      )}
      {headerProblems.map((m) => (
        <p key={m} role="alert" className="text-xs text-danger-600">
          {m}
        </p>
      ))}
      {saveError && (
        <p role="alert" className="text-sm text-danger-600">
          {saveError}
        </p>
      )}

      <div className="flex items-center gap-3 pt-2">
        <Button variant="secondary" onClick={onBack} disabled={isSaving}>
          Back
        </Button>
        <Button
          variant="primary"
          fullWidth
          onClick={() => void handleSaveClick()}
          isLoading={isSaving || checking}
          disabled={noOneChosen || hasProblems}
          aria-describedby={noOneChosen ? 'itemized-who-error' : undefined}
        >
          Save, then who had what
        </Button>
      </div>

      {showReceiptLightbox && receiptPath && (
        <ReceiptLightbox path={receiptPath} title="Receipt" onClose={() => setShowReceiptLightbox(false)} />
      )}

      <Modal isOpen={pendingClear !== null} onClose={() => setPendingClear(null)} title={pendingClear?.all ? 'Clear all claims?' : pendingClear && pendingClear.userIds.length === 0 ? 'Ask people to check again?' : 'Clear some claims?'} size="sm" showCloseButton={false} closeOnBackdropClick={false}>
        <p className="text-sm text-[var(--text-secondary)]">{pendingClear
            ? clearedClaimsWarningText(pendingClear.userIds.map(nameOf), {
                all: pendingClear.all,
                claimCount: pendingClear.claimCount,
                leftoversCleared: pendingClear.leftoversCleared,
                reconfirmCount: pendingClear.reconfirmUserIds?.length,
              })
            : ''}</p>
        <div className="mt-5 flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
          <Button variant="secondary" onClick={() => setPendingClear(null)}>
            Keep editing
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              setPendingClear(null)
              void guarded(runSave)
            }}
          >
            {pendingClear?.all ? 'Clear all claims and save' : pendingClear && pendingClear.userIds.length === 0 ? 'Save and ask them to check' : 'Clear those claims and save'}
          </Button>
        </div>
      </Modal>
    </div>
  )
}
