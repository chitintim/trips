import { useEffect, useMemo, useRef, useState } from 'react'
import { Modal, Button, Stepper, Skeleton, ConfirmDiscardSheet, useToast } from '../../../components/ui'
import { useAuth } from '../../../hooks/useAuth'
import {
  useCreateExpense,
  useUpdateExpense,
  useCreateItemizedExpense,
  useConvertToItemizedExpense,
  useConvertFromItemizedExpense,
  useDeleteExpense,
  type SplitRow,
} from '../../../lib/queries/useExpenses'
import { useTimeline } from '../../../lib/queries/useTimeline'
import { uploadReceipt, getReceiptUrl } from '../../../lib/receiptUpload'
import { generateLinkCode } from '../../../lib/receiptParsing'
import { useTripActivityLog } from '../../organizer/lib/activity'
import { useFormDraft, useUnsavedChangesGuard } from '../../../lib/forms'
import { findDuplicateCandidates } from '../lib/duplicateDetection'
import { defaultTaggedParticipantIds } from '../lib/participantDefaults'
import { ReceiptLightbox } from '../components/ReceiptLightbox'
import { DetailsStep } from './DetailsStep'
import { PayerStep } from './PayerStep'
import { SplitStep } from './SplitStep'
import { ReviewStep } from './ReviewStep'
import { computeSplits, validateSplitSum } from './computeSplits'
import { WIZARD_STEPS, emptyWizardDraft, type ExpenseWizardDraft } from './wizardState'
import { emptyItemizedDraft, fromReceiptParseResult, fromExpenseLineItems } from '../itemized/itemizedState'
import { ItemizedEditorScreen } from '../itemized/ItemizedEditorScreen'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'
import type { ExpenseWithDetails } from '../../../lib/queries/useExpenses'
import type { ReceiptParseResult } from '../../../shared/contracts/receiptParseResult'
import type { Trip } from '../../../types'

export interface ExpenseEditorWizardProps {
  isOpen: boolean
  onClose: () => void
  trip: Trip
  participants: ParticipantWithUser[]
  allExpenses: ExpenseWithDetails[]
  /** Present -> edit mode, seeded from this record. Absent -> fresh create. */
  editingExpense?: ExpenseWithDetails | null
  /** Pre-attached receipt (from quick capture's "refine later" hand-off). */
  initialReceiptPath?: string | null
  /** The v2 parse result from quick capture's receipt scan (if any) -- seeds the itemized editor with real line items instead of a blank draft. */
  initialParsedReceipt?: ReceiptParseResult | null
}

/**
 * Expense editor: decomposed wizard (details -> payer -> split -> review),
 * each step its own component file (plan §10 #2). Fresh-state guarantee:
 * remounted via `key` by the caller on every open so no previous
 * submission's values leak in (Form & Flow Standard point 2); this
 * component itself never has to reset internal state on open/close.
 */
export function ExpenseEditorWizard({
  isOpen,
  onClose,
  trip,
  participants,
  allExpenses,
  editingExpense = null,
  initialReceiptPath = null,
  initialParsedReceipt = null,
}: ExpenseEditorWizardProps) {
  const { user } = useAuth()
  const { showToast } = useToast()
  const { data: timelineEvents = [] } = useTimeline(trip.id)
  const createExpense = useCreateExpense(trip.id)
  const updateExpense = useUpdateExpense(trip.id)
  const createItemizedExpense = useCreateItemizedExpense(trip.id)
  const convertToItemizedExpense = useConvertToItemizedExpense(trip.id)
  const convertFromItemizedExpense = useConvertFromItemizedExpense(trip.id)
  const deleteExpense = useDeleteExpense(trip.id)
  const logActivity = useTripActivityLog(trip.id)

  const isEditMode = !!editingExpense
  const draftKey = `expense-draft:${trip.id}:${editingExpense?.id ?? 'new'}`

  // Itemized-ness of the RECORD being edited (constant for this editing
  // session, independent of whatever the user does with the split-mode
  // selector locally) -- drives both the initial itemized seed and the
  // claims guard when switching away from itemized.
  const existingLineItemCount = editingExpense?.line_items.length ?? 0
  const existingClaimCount = editingExpense?.claims.length ?? 0
  const wasItemized = isEditMode && existingLineItemCount > 0

  const seedFromExpense = (expense: ExpenseWithDetails): ExpenseWizardDraft => ({
    description: expense.description,
    vendorName: expense.vendor_name ?? '',
    amount: String(expense.amount),
    currency: expense.currency,
    paymentDate: expense.payment_date,
    category: expense.category,
    participantIds: expense.participant_ids ?? participants.map((p) => p.user_id),
    receiptPath: expense.receipt_url,
    paidBy: expense.paid_by,
    // Itemized expenses have no expense_splits rows (their split lives in
    // line items + claims instead), so split_type can't tell us that --
    // line_items presence is the real signal.
    splitMode: expense.line_items.length > 0 ? 'itemized' : expense.splits[0]?.split_type ?? 'equal',
    splitEntries: expense.splits.map((s) => ({
      userId: s.user_id,
      value:
        s.split_type === 'percentage'
          ? String(s.percentage ?? '')
          : s.split_type === 'shares'
            ? String(s.shares ?? '1')
            : s.split_type === 'custom'
              ? String(s.amount)
              : '', // equal: unused by computeSplits, never shown raw in another mode's input
    })),
    nightsWeightingApplied: false,
    fxRateOverride: expense.rate_source === 'manual' && expense.fx_rate ? String(expense.fx_rate) : null,
  })

  const initialValue = useMemo(
    () =>
      isEditMode && editingExpense
        ? seedFromExpense(editingExpense)
        : emptyWizardDraft({
            today: new Date().toISOString().slice(0, 10),
            baseCurrency: trip.base_currency,
            currentUserId: user?.id ?? '',
            // Defaults to CONFIRMED participants (falling back to everyone
            // if nobody's confirmed yet) -- declined/pending people
            // shouldn't be pre-tagged into a new expense or auto-chased.
            allParticipantIds: defaultTaggedParticipantIds(participants),
          }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  // Draft persistence only makes sense for fresh creates (edit mode always
  // seeds from the record -- Form & Flow Standard point 2's "edit-modals
  // always seed from the record", not from a stale autosave). `enabled:
  // !isEditMode` disables both restore-on-mount and debounced writes for
  // edit mode, so a stale sessionStorage draft from a different (or the
  // same) expense can never leak into the form.
  const seededInitialValue = initialReceiptPath ? { ...initialValue, receiptPath: initialReceiptPath } : initialValue
  const {
    values: draft,
    setValues: setDraft,
    clearDraft,
  } = useFormDraft<ExpenseWizardDraft>(draftKey, seededInitialValue, { enabled: !isEditMode })

  const [stepIndex, setStepIndex] = useState(0)
  const [receiptFile, setReceiptFile] = useState<File | null>(null)
  const [receiptPreviewUrl, setReceiptPreviewUrl] = useState<string | null>(null)
  const [showReceiptLightbox, setShowReceiptLightbox] = useState(false)
  // Starts already in the itemized screen when editing a record that's
  // already itemized -- otherwise "Itemized" would show selected in the
  // segmented control but land the user on the regular stepper (which has
  // no per-participant inputs for that mode).
  const [showItemized, setShowItemized] = useState(() => initialValue.splitMode === 'itemized')
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  // Local preview for a NEWLY picked receipt file (not yet uploaded) --
  // separate from the existing-receipt thumbnail below.
  useEffect(() => {
    if (!receiptFile) {
      setReceiptPreviewUrl(null)
      return
    }
    const url = URL.createObjectURL(receiptFile)
    setReceiptPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [receiptFile])

  const patchDraft = (patch: Partial<ExpenseWizardDraft>) => {
    setIsDirty(true)
    setDraft((prev) => ({ ...prev, ...patch }))
  }

  const handleClosed = () => {
    clearDraft()
    setIsDirty(false)
    setStepIndex(0)
    setShowItemized(false)
    onClose()
  }

  const { confirmClose, guardProps } = useUnsavedChangesGuard(isDirty && !isSaving)
  const requestClose = () => confirmClose(handleClosed)

  const participantNames = useMemo(
    () => Object.fromEntries(participants.map((p) => [p.user_id, p.user.full_name || p.user.email])),
    [participants]
  )

  const activeParticipants = participants.filter((p) => draft.participantIds.includes(p.user_id))
  const amountMajor = parseFloat(draft.amount) || 0

  const duplicates = useMemo(
    () =>
      draft.vendorName && amountMajor > 0
        ? findDuplicateCandidates(
            { vendor_name: draft.vendorName, amount: amountMajor, currency: draft.currency, payment_date: draft.paymentDate },
            allExpenses,
            editingExpense?.id
          )
        : [],
    [draft.vendorName, amountMajor, draft.currency, draft.paymentDate, allExpenses, editingExpense?.id]
  )

  const canAdvance = (): boolean => {
    if (stepIndex === 0) return draft.description.trim().length > 0 && amountMajor > 0 && draft.participantIds.length > 0
    if (stepIndex === 1) return !!draft.paidBy
    if (stepIndex === 2) {
      if (draft.splitMode === 'custom' || draft.splitMode === 'percentage') {
        return validateSplitSum(draft.splitMode, draft.splitEntries, draft.participantIds, amountMajor, draft.currency).isValid
      }
      return true
    }
    return true
  }

  const handleNext = () => {
    if (stepIndex < WIZARD_STEPS.length - 1) setStepIndex(stepIndex + 1)
    else void handleSubmit()
  }

  const handleBack = () => {
    if (stepIndex > 0) setStepIndex(stepIndex - 1)
  }

  const handleSubmit = async () => {
    if (!user) return
    setIsSaving(true)
    try {
      let receiptUrl = draft.receiptPath
      if (receiptFile) {
        const uploaded = await uploadReceipt(receiptFile, user.id)
        receiptUrl = uploaded.path
      }

      const fxRateOverride = draft.fxRateOverride ? parseFloat(draft.fxRateOverride) : null
      const rateSource = fxRateOverride != null ? 'manual' : null

      const splits = computeSplits({
        mode: draft.splitMode,
        amountMajor,
        currency: draft.currency,
        participantIds: draft.participantIds,
        entries: draft.splitEntries,
      })

      const splitRows: SplitRow[] = splits.map((s) => ({
        user_id: s.userId,
        amount: s.amountMajor,
        split_type: draft.splitMode === 'shares' ? 'shares' : draft.splitMode === 'percentage' ? 'percentage' : draft.splitMode === 'custom' ? 'custom' : 'equal',
        percentage: s.percentage,
        shares: s.shares,
      }))

      const expensePayload = {
        description: draft.description.trim(),
        amount: amountMajor,
        currency: draft.currency,
        category: draft.category as ExpenseWithDetails['category'],
        vendor_name: draft.vendorName.trim() || null,
        payment_date: draft.paymentDate,
        paid_by: draft.paidBy,
        participant_ids: draft.participantIds,
        receipt_url: receiptUrl,
        fx_rate: fxRateOverride,
        rate_source: rateSource,
      }

      if (isEditMode && editingExpense) {
        if (wasItemized && draft.splitMode === 'itemized') {
          // The record IS (and still will be) itemized -- the user backed
          // out of the itemized screen (or jumped straight to another step
          // via the stepper) without changing the split method, so this is
          // just a header-field edit (description/payer/date/receipt/etc).
          // Line items/claims/allocation link are untouched; expense_splits
          // don't apply to itemized expenses (skipSplits mirrors that).
          await updateExpense.mutateAsync({
            expenseId: editingExpense.id,
            expense: expensePayload,
            skipSplits: true,
          })
        } else if (wasItemized && draft.splitMode !== 'itemized') {
          // The record WAS itemized but the user switched the split mode
          // away from itemized in this session -- convert it back (clean
          // up line items/allocation link, write real expense_splits).
          // SplitStep's mode-change guard already refuses this switch
          // client-side when claims exist; useConvertFromItemizedExpense
          // re-checks server-side as a defensive backstop.
          await convertFromItemizedExpense.mutateAsync({
            expenseId: editingExpense.id,
            expense: { ...expensePayload, status: null, ai_parsed: false },
            splits: splitRows,
          })
        } else {
          const removedUserIds = editingExpense.splits.map((s) => s.user_id).filter((id) => !draft.participantIds.includes(id))
          await updateExpense.mutateAsync({
            expenseId: editingExpense.id,
            expense: expensePayload,
            splits: splitRows,
            removedUserIds,
          })
        }
      } else {
        const created = await createExpense.mutateAsync({ expense: expensePayload, splits: splitRows })
        logActivity({ verb: 'expense_added', entity: { type: 'expense', id: created.id, label: created.description } })
      }

      showToast({ type: 'success', message: isEditMode ? 'Expense updated' : 'Expense added' })
      clearDraft()
      handleClosed()
    } catch (err) {
      showToast({ type: 'error', message: 'Failed to save expense', description: err instanceof Error ? err.message : undefined })
    } finally {
      setIsSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!editingExpense) return
    try {
      await deleteExpense.mutateAsync(editingExpense.id)
      showToast({ type: 'success', message: 'Expense deleted' })
      setConfirmingDelete(false)
      handleClosed()
    } catch (err) {
      showToast({ type: 'error', message: 'Failed to delete expense', description: err instanceof Error ? err.message : undefined })
    }
  }

  const handleItemizedSave = async (params: {
    lineItems: Array<{ name_original: string; name_english: string | null; quantity: number; unit_price: number; subtotal: number; tax_amount: number; service_amount: number; line_discount_amount: number | null; total_amount: number }>
    totalMajor: number
  }): Promise<boolean> => {
    if (!user) return false
    setIsSaving(true)
    try {
      const lineItems = params.lineItems.map((li, i) => ({
        line_number: i + 1,
        name_original: li.name_original,
        name_english: li.name_english,
        quantity: li.quantity,
        unit_price: li.unit_price,
        subtotal: li.subtotal,
        tax_amount: li.tax_amount,
        service_amount: li.service_amount,
        line_discount_amount: li.line_discount_amount,
        total_amount: li.total_amount,
      }))

      const itemizedExpensePayload = {
        description: draft.description.trim() || draft.vendorName || 'Itemized receipt',
        amount: params.totalMajor,
        currency: draft.currency,
        category: draft.category as ExpenseWithDetails['category'],
        vendor_name: draft.vendorName.trim() || null,
        payment_date: draft.paymentDate,
        paid_by: draft.paidBy,
        participant_ids: draft.participantIds,
        receipt_url: draft.receiptPath,
        ai_parsed: true,
        status: 'unallocated' as const,
      }

      if (isEditMode && editingExpense) {
        // UPDATE the record being edited -- never insert a new one (that
        // was the bug: this always called the create/insert path
        // regardless of edit mode, so converting an existing expense to
        // itemized silently created a duplicate expense instead).
        if (existingClaimCount > 0) {
          showToast({ type: 'info', message: 'Claims reset', description: `${existingClaimCount} existing claim(s) were cleared because the line items changed.` })
        }
        const code = editingExpense.allocation_link?.code ?? generateLinkCode()
        const result = await convertToItemizedExpense.mutateAsync({
          expenseId: editingExpense.id,
          expense: itemizedExpensePayload,
          lineItems,
          allocationCode: code,
          createdBy: user.id,
        })
        showToast({ type: 'success', message: 'Itemized expense updated', description: `Share code: ${result.code}` })
      } else {
        const code = generateLinkCode()
        const created = await createItemizedExpense.mutateAsync({
          expense: itemizedExpensePayload,
          lineItems,
          allocationCode: code,
          createdBy: user.id,
        })
        logActivity({ verb: 'expense_added', entity: { type: 'expense', id: created.id, label: created.description } })
        showToast({ type: 'success', message: 'Itemized expense created', description: `Share code: ${code}` })
      }
      clearDraft()
      handleClosed()
      return true
    } catch (err) {
      showToast({ type: 'error', message: 'Failed to save itemized expense', description: err instanceof Error ? err.message : undefined })
      return false
    } finally {
      setIsSaving(false)
    }
  }

  // Itemized draft seed, in priority order: an already-itemized record
  // being re-edited > a freshly parsed receipt handed off from quick
  // capture > a blank manual draft. Recomputed only when the inputs that
  // matter change, NOT on every render, so in-progress edits inside
  // ItemizedEditorScreen aren't clobbered by unrelated draft field changes.
  const itemizedSeed = useMemo(() => {
    if (wasItemized && editingExpense) {
      return fromExpenseLineItems(editingExpense.line_items, draft.currency)
    }
    if (!isEditMode && initialParsedReceipt && initialParsedReceipt.line_items.length > 0) {
      return fromReceiptParseResult(initialParsedReceipt)
    }
    return emptyItemizedDraft(draft.currency)
  }, [wasItemized, editingExpense, isEditMode, initialParsedReceipt, draft.currency])

  const noItemsParsedNotice = !isEditMode && !!initialParsedReceipt && initialParsedReceipt.line_items.length === 0

  if (showItemized) {
    return (
      <Modal isOpen={isOpen} onClose={requestClose} title="Itemize receipt" size="lg">
        <ItemizedEditorScreen
          initialDraft={itemizedSeed}
          noItemsParsedNotice={noItemsParsedNotice}
          // Audit #3b: Back used to bypass the unsaved-changes guard
          // entirely (a direct setShowItemized(false)) -- route it through
          // the same confirmClose the modal's own onClose uses, so
          // in-progress itemized edits get the same discard confirmation.
          onBack={() => confirmClose(() => setShowItemized(false))}
          onSave={handleItemizedSave}
          isSaving={isSaving}
          // Audit #3a: bridges this screen's local draft edits up into the
          // wizard's own isDirty so the guard above actually fires.
          onDirty={() => setIsDirty(true)}
          // Audit #3c: sessionStorage draft persistence, disabled in edit
          // mode so re-editing an already-itemized expense always seeds
          // from the saved line items (Form & Flow Standard point 2).
          draftKey={`${draftKey}:itemized`}
          draftEnabled={!isEditMode}
          // Audit #3d: lets the user check the original receipt image
          // against LineItemEditor's "ambiguous field" warnings without
          // leaving this screen.
          receiptPath={draft.receiptPath}
        />
        <ConfirmDiscardSheet isOpen={guardProps.showConfirm} onKeep={guardProps.onKeep} onDiscard={guardProps.onDiscard} />
      </Modal>
    )
  }

  return (
    <Modal isOpen={isOpen} onClose={requestClose} title={isEditMode ? 'Edit expense' : 'Add expense'} size="lg">
      <div className="space-y-5">
        <Stepper steps={[...WIZARD_STEPS]} current={stepIndex} onStepClick={setStepIndex} />

        {duplicates.length > 0 && stepIndex === 0 && (
          <div className="rounded-[var(--radius-md)] border border-warn-200 bg-warn-50 dark:bg-warn-900 dark:border-warn-800 px-3 py-2.5 text-sm text-warn-700 dark:text-warn-300">
            ⚠️ Possible duplicate: "{duplicates[0].expense.description}" on the same day for a similar amount.
          </div>
        )}

        {stepIndex === 0 && (
          <>
            <DetailsStep draft={draft} onChange={patchDraft} participants={participants} />
            <div className="pt-2 border-t border-[var(--border-subtle)]">
              <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1.5">Receipt (optional)</label>
              {receiptFile ? (
                <div className="flex items-center gap-3">
                  {receiptPreviewUrl && (
                    <img src={receiptPreviewUrl} alt="New receipt preview" className="w-12 h-12 rounded-[var(--radius-sm)] object-cover border border-[var(--border-subtle)]" />
                  )}
                  <span className="text-sm text-[var(--text-secondary)] truncate flex-1">{receiptFile.name}</span>
                  <Button variant="ghost" size="sm" onClick={() => setReceiptFile(null)}>
                    Remove
                  </Button>
                </div>
              ) : draft.receiptPath ? (
                <ExistingReceiptRow
                  path={draft.receiptPath}
                  onView={() => setShowReceiptLightbox(true)}
                  onReplace={(file) => setReceiptFile(file)}
                  onRemove={() => patchDraft({ receiptPath: null })}
                />
              ) : (
                <input
                  type="file"
                  accept="image/jpeg,image/jpg,image/png,image/heic,image/heif,application/pdf"
                  onChange={(e) => setReceiptFile(e.target.files?.[0] ?? null)}
                  className="text-sm"
                />
              )}
            </div>
          </>
        )}
        {stepIndex === 1 && <PayerStep draft={draft} onChange={patchDraft} participants={participants} />}
        {stepIndex === 2 && (
          <SplitStep
            draft={draft}
            onChange={patchDraft}
            participants={activeParticipants}
            timelineEvents={timelineEvents}
            tripStartDate={trip.start_date}
            tripEndDate={trip.end_date}
            onGoToItemized={() => setShowItemized(true)}
            existingItemizedInfo={wasItemized ? { lineItemCount: existingLineItemCount, claimCount: existingClaimCount } : undefined}
            onItemizedSwitchBlocked={() =>
              showToast({
                type: 'error',
                message: "Can't switch off itemized split",
                description: `${existingClaimCount} item claim(s) already exist — remove those claims first.`,
              })
            }
          />
        )}
        {stepIndex === 3 && <ReviewStep draft={draft} onChange={patchDraft} baseCurrency={trip.base_currency} participantNames={participantNames} />}

        <div className="flex items-center gap-3 pt-2">
          {isEditMode && stepIndex === 0 && (
            <Button variant="danger" onClick={() => setConfirmingDelete(true)} disabled={isSaving}>
              Delete
            </Button>
          )}
          {stepIndex > 0 && (
            <Button variant="secondary" onClick={handleBack} disabled={isSaving}>
              Back
            </Button>
          )}
          <Button variant="primary" fullWidth onClick={handleNext} disabled={!canAdvance()} isLoading={isSaving}>
            {stepIndex === WIZARD_STEPS.length - 1 ? (isEditMode ? 'Save changes' : 'Add expense') : 'Continue'}
          </Button>
        </div>
      </div>

      <ConfirmDiscardSheet isOpen={guardProps.showConfirm} onKeep={guardProps.onKeep} onDiscard={guardProps.onDiscard} />

      {showReceiptLightbox && draft.receiptPath && (
        <ReceiptLightbox path={draft.receiptPath} title={draft.description || 'Receipt'} onClose={() => setShowReceiptLightbox(false)} />
      )}

      {confirmingDelete && editingExpense && (
        <Modal isOpen onClose={() => setConfirmingDelete(false)} size="sm" title="Delete this expense?">
          <div className="space-y-4">
            <p className="text-sm text-[var(--text-secondary)]">
              This can't be undone.
              {existingClaimCount > 0 && ` ${existingClaimCount} item claim(s) on this expense will also be removed.`}
            </p>
            <div className="flex items-center gap-3">
              <Button variant="ghost" onClick={() => setConfirmingDelete(false)} disabled={deleteExpense.isPending}>
                Cancel
              </Button>
              <Button variant="danger" fullWidth onClick={handleDelete} isLoading={deleteExpense.isPending}>
                Delete expense
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </Modal>
  )
}

/** Existing-receipt row for edit mode: thumbnail + view (lightbox) + replace + remove, so editing an expense that already has a receipt doesn't look like a blank/no-receipt state (it silently did before). */
function ExistingReceiptRow({
  path,
  onView,
  onReplace,
  onRemove,
}: {
  path: string
  onView: () => void
  onReplace: (file: File) => void
  onRemove: () => void
}) {
  const [thumbUrl, setThumbUrl] = useState<string | null>(null)
  const replaceInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let cancelled = false
    getReceiptUrl(path)
      .then((url) => !cancelled && setThumbUrl(url))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [path])

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={onView}
        aria-label="View receipt"
        className="shrink-0 rounded-[var(--radius-sm)] overflow-hidden border border-[var(--border-subtle)]"
      >
        {thumbUrl ? (
          <img src={thumbUrl} alt="Receipt" className="w-12 h-12 object-cover" />
        ) : (
          <Skeleton variant="card" width={48} height={48} className="rounded-none" />
        )}
      </button>
      <span className="text-sm text-[var(--text-secondary)] flex-1">Receipt attached</span>
      {/* Hidden input triggered by a real, focusable <button> (not a <label>
          wrapping a hidden input, which is unreachable by keyboard) --
          mirrors QuickCaptureSheet's file-picker pattern (audit #9). */}
      <input
        ref={replaceInputRef}
        type="file"
        accept="image/jpeg,image/jpg,image/png,image/heic,image/heif,application/pdf"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) onReplace(file)
        }}
      />
      <button
        type="button"
        onClick={() => replaceInputRef.current?.click()}
        className="text-sm font-medium text-accent-700 dark:text-accent-400 press-scale"
      >
        Replace
      </button>
      <Button variant="ghost" size="sm" onClick={onRemove}>
        Remove
      </Button>
    </div>
  )
}
