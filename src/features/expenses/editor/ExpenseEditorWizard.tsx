import { useMemo, useState } from 'react'
import { Modal, Button } from '../../../components/ui'
import { useAuth } from '../../../hooks/useAuth'
import { useCreateExpense, useUpdateExpense, type SplitRow } from '../../../lib/queries/useExpenses'
import { useCreateItemizedExpense } from '../../../lib/queries/useExpenses'
import { useTimeline } from '../../../lib/queries/useTimeline'
import { uploadReceipt } from '../../../lib/receiptUpload'
import { generateLinkCode } from '../../../lib/receiptParsing'
import { useToast } from '../../../components/ui'
import { Stepper } from '../components/Stepper'
import { ConfirmDiscardSheet } from '../components/ConfirmDiscardSheet'
import { useFormDraft } from '../lib/useFormDraft'
import { useUnsavedChangesGuard } from '../lib/useUnsavedChangesGuard'
import { findDuplicateCandidates } from '../lib/duplicateDetection'
import { DetailsStep } from './DetailsStep'
import { PayerStep } from './PayerStep'
import { SplitStep } from './SplitStep'
import { ReviewStep } from './ReviewStep'
import { computeSplits, validateSplitSum } from './computeSplits'
import { WIZARD_STEPS, emptyWizardDraft, type ExpenseWizardDraft } from './wizardState'
import { emptyItemizedDraft } from '../itemized/itemizedState'
import { ItemizedEditorScreen } from '../itemized/ItemizedEditorScreen'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'
import type { ExpenseWithDetails } from '../../../lib/queries/useExpenses'
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
}: ExpenseEditorWizardProps) {
  const { user } = useAuth()
  const { showToast } = useToast()
  const { data: timelineEvents = [] } = useTimeline(trip.id)
  const createExpense = useCreateExpense(trip.id)
  const updateExpense = useUpdateExpense(trip.id)
  const createItemizedExpense = useCreateItemizedExpense(trip.id)

  const isEditMode = !!editingExpense
  const draftKey = `expense-draft:${trip.id}:${editingExpense?.id ?? 'new'}`

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
    splitMode: expense.splits[0]?.split_type ?? 'equal',
    splitEntries: expense.splits.map((s) => ({
      userId: s.user_id,
      value: s.split_type === 'percentage' ? String(s.percentage ?? '') : String(s.amount),
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
            allParticipantIds: participants.map((p) => p.user_id),
          }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  // Draft persistence only makes sense for fresh creates (edit mode always
  // seeds from the record -- Form & Flow Standard point 2's "edit-modals
  // always seed from the record", not from a stale autosave).
  const { value: draft, setValue: setDraft, clearDraft } = useFormDraft<ExpenseWizardDraft>({
    key: draftKey,
    initialValue: initialReceiptPath ? { ...initialValue, receiptPath: initialReceiptPath } : initialValue,
    enabled: !isEditMode,
  })

  const [stepIndex, setStepIndex] = useState(0)
  const [receiptFile, setReceiptFile] = useState<File | null>(null)
  const [showItemized, setShowItemized] = useState(false)
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)

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

  const guard = useUnsavedChangesGuard(isDirty && !isSaving, handleClosed)

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
        const removedUserIds = editingExpense.splits.map((s) => s.user_id).filter((id) => !draft.participantIds.includes(id))
        await updateExpense.mutateAsync({
          expenseId: editingExpense.id,
          expense: expensePayload,
          splits: splitRows,
          removedUserIds,
        })
      } else {
        await createExpense.mutateAsync({ expense: expensePayload, splits: splitRows })
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

  const handleItemizedSave = async (params: {
    lineItems: Array<{ name_original: string; name_english: string | null; quantity: number; unit_price: number; subtotal: number; tax_amount: number; service_amount: number; line_discount_amount: number | null; total_amount: number }>
    totalMajor: number
  }) => {
    if (!user) return
    setIsSaving(true)
    try {
      const code = generateLinkCode()
      await createItemizedExpense.mutateAsync({
        expense: {
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
          status: 'unallocated',
        },
        lineItems: params.lineItems.map((li, i) => ({
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
        })),
        allocationCode: code,
        createdBy: user.id,
      })
      showToast({ type: 'success', message: 'Itemized expense created', description: `Share code: ${code}` })
      clearDraft()
      handleClosed()
    } catch (err) {
      showToast({ type: 'error', message: 'Failed to create itemized expense', description: err instanceof Error ? err.message : undefined })
    } finally {
      setIsSaving(false)
    }
  }

  if (showItemized) {
    return (
      <Modal isOpen={isOpen} onClose={guard.requestClose} title="Itemize receipt" size="lg">
        <ItemizedEditorScreen
          initialDraft={emptyItemizedDraft(draft.currency)}
          onBack={() => setShowItemized(false)}
          onSave={handleItemizedSave}
          isSaving={isSaving}
        />
        <ConfirmDiscardSheet isOpen={guard.isConfirmOpen} onKeepEditing={guard.cancelDiscard} onDiscard={guard.confirmDiscard} />
      </Modal>
    )
  }

  return (
    <Modal isOpen={isOpen} onClose={guard.requestClose} title={isEditMode ? 'Edit expense' : 'Add expense'} size="lg">
      <div className="space-y-5">
        <Stepper steps={[...WIZARD_STEPS]} currentIndex={stepIndex} onStepClick={setStepIndex} />

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
              <input
                type="file"
                accept="image/jpeg,image/jpg,image/png,image/heic,image/heif,application/pdf"
                onChange={(e) => setReceiptFile(e.target.files?.[0] ?? null)}
                className="text-sm"
              />
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
          />
        )}
        {stepIndex === 3 && <ReviewStep draft={draft} onChange={patchDraft} baseCurrency={trip.base_currency} participantNames={participantNames} />}

        <div className="flex items-center gap-3 pt-2">
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

      <ConfirmDiscardSheet isOpen={guard.isConfirmOpen} onKeepEditing={guard.cancelDiscard} onDiscard={guard.confirmDiscard} />
    </Modal>
  )
}
