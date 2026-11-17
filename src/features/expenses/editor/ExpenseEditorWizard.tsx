import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Modal, Button, Skeleton, ConfirmDiscardSheet, useToast } from '../../../components/ui'
import { useAuth } from '../../../hooks/useAuth'
import {
  useCreateExpense,
  useUpdateExpense,
  useCreateItemizedExpense,
  useConvertFromItemizedExpense,
  useDeleteExpense,
} from '../../../lib/queries/useExpenses'
import { useTimeline } from '../../../lib/queries/useTimeline'
import { uploadReceipt, getReceiptUrl, isPdfFile, RECEIPT_ACCEPT } from '../../../lib/receiptUpload'
import { todayLocal } from '../../../lib/localDate'
import { resolveExpenseFxFields } from '../../../lib/fx/resolveExpenseFxFields'
import { generateLinkCode } from '../../../lib/receiptParsing'
import { useTripActivityLog } from '../../organizer/lib/activity'
import { useFormDraft, useUnsavedChangesGuard } from '../../../lib/forms'
import { findDuplicateCandidates } from '../lib/duplicateDetection'
import { isConfirmationEnabled } from '../../../lib/tripStatus'
import { defaultTaggedParticipantIds } from '../lib/participantDefaults'
import { ReceiptLightbox } from '../components/ReceiptLightbox'
import { OneScreenForm } from './OneScreenForm'
import { buildSplitRows, buildExpensePayload, buildItemizedExpensePayload, buildItemizedHeaderEditPayload } from './expenseSavePayload'
import { useReitemizeExpense, previewReitemizeExpense } from './useReitemizeExpense'
import { useSendToTable } from '../../../lib/queries/useReceiptTable'
import { peopleToTellAfterReitemise, reitemiseNoticeLine, receiptColumnsOf, type SendOutcome } from '../claims/receiptTable'
import { itemiseChoice, isFrozen, pickEditorScreen, startsDirty } from './expenseFormLogic'
import { FROZEN_EXPENSES_MESSAGE } from '../quick-capture/addExpenseEntry'
import { emptyWizardDraft, draftFromExpense, draftFromParsedReceipt, parsedLineCount, seedParticipantIds, participantSelectionChanged, withDefaultPayer, type ExpenseWizardDraft } from './wizardState'
import { emptyItemizedDraft, fromReceiptParseResult, fromExpenseLineItems, itemizedWriteProblem, headerTextProblems, itemizedMissingHeader } from '../itemized/itemizedState'
import { ItemizedEditorScreen, type ClearClaimsPreview, type ItemizedSaveParams } from '../itemized/ItemizedEditorScreen'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'
import type { ExpenseWithDetails } from '../../../lib/queries/useExpenses'
import type { ReceiptParseResult } from '../../../shared/contracts/receiptParseResult'
import type { ParsedReceiptData } from '../../../lib/receiptParsing'
import type { Trip } from '../../../types'

/** A readable message from whatever was thrown (supabase errors are plain objects, not Errors). */
function errorText(err: unknown): string | undefined {
  if (err instanceof Error) return err.message || undefined
  const m = (err as { message?: unknown } | null)?.message
  return typeof m === 'string' && m ? m : undefined
}

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
  /** The whole scan result: vendor, total, currency, date and category pre-fill the form, and the itemise choice counts its lines. */
  initialParsedData?: ParsedReceiptData | null
}

/**
 * Expense editor: ONE screen (amount, what for, then Paid by / Split / Date
 * lines that open in place). Fresh-state guarantee:
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
  initialParsedData = null,
}: ExpenseEditorWizardProps) {
  const { user } = useAuth()
  const { showToast } = useToast()
  const navigate = useNavigate()
  const { data: timelineEvents = [] } = useTimeline(trip.id)
  const createExpense = useCreateExpense(trip.id)
  const updateExpense = useUpdateExpense(trip.id)
  const createItemizedExpense = useCreateItemizedExpense(trip.id)
  const reitemizeExpense = useReitemizeExpense(trip.id)
  const sendToTable = useSendToTable(trip.id)
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

  const withScanPrefill = (blank: ExpenseWizardDraft): ExpenseWizardDraft => {
    const hour = new Date().getHours()
    const atMealtime = (hour >= 7 && hour < 10) || (hour >= 12 && hour < 15) || (hour >= 18 && hour < 22)
    const withCategory = atMealtime ? { ...blank, category: 'food' } : blank
    return initialParsedData ? draftFromParsedReceipt(withCategory, initialParsedData, initialReceiptPath) : withCategory
  }

  // Confirmed people (everyone if nobody has confirmed yet): declined or
  // pending people are not pre-tagged into an expense or auto-chased. A saved
  // expense with no stored list is seeded from the same default.
  const defaultTaggedIds = defaultTaggedParticipantIds(participants, isConfirmationEnabled(trip))

  const initialValue = useMemo(
    () =>
      isEditMode && editingExpense
        ? draftFromExpense(editingExpense, defaultTaggedIds)
        : withScanPrefill(emptyWizardDraft({
            today: todayLocal(),
            baseCurrency: trip.base_currency,
            currentUserId: user?.id ?? '',
            allParticipantIds: defaultTaggedIds,
          })),
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

  // The signed-in user can arrive after the first render (the draft is seeded once): default the payer to them, never over a choice.
  useEffect(() => {
    if (isEditMode || !user?.id) return
    setDraft((prev) => withDefaultPayer(prev, user.id))
  }, [isEditMode, user?.id, setDraft])

  const [itemiseChoiceDismissed, setItemiseChoiceDismissed] = useState(false)
  const [receiptFile, setReceiptFile] = useState<File | null>(null)
  const [receiptPreviewUrl, setReceiptPreviewUrl] = useState<string | null>(null)
  const [showReceiptLightbox, setShowReceiptLightbox] = useState(false)
  // Starts already in the itemized screen when editing a record that's
  // already itemized -- otherwise "Itemized" would show selected in the
  // segmented control but land the user on the regular stepper (which has
  // no per-participant inputs for that mode).
  const [showItemized, setShowItemized] = useState(() => initialValue.splitMode === 'itemized')
  // A scan pre-fills the form, so closing it is already a discard (and costs the scan).
  const [isDirty, setIsDirty] = useState(() => startsDirty({ parsedData: initialParsedData, parsedReceipt: initialParsedReceipt, receiptPath: initialReceiptPath }))
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
    setShowItemized(false)
    onClose()
  }

  const { confirmClose, guardProps } = useUnsavedChangesGuard(isOpen && isDirty && !isSaving)
  const requestClose = () => confirmClose(handleClosed)

  const amountMajor = parseFloat(draft.amount) || 0

  // Whether the person changed who was there. If not, an edit leaves the
  // stored list (usually NULL = "the default people") alone.
  const seededParticipantIds = useMemo(
    () => (editingExpense ? seedParticipantIds(editingExpense, defaultTaggedIds) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editingExpense?.id]
  )
  const participantsChanged = isEditMode && participantSelectionChanged(draft.participantIds, seededParticipantIds)

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

  const handleSubmit = async () => {
    if (!user) return
    setIsSaving(true)
    try {
      let receiptUrl = draft.receiptPath
      if (receiptFile) {
        const uploaded = await uploadReceipt(receiptFile, user.id)
        receiptUrl = uploaded.path
      }

      // Persist the FX rate the ReviewStep previewed (bug fix: the preview's
      // auto-fetched rate lived only in ReviewStep local state, so fx_rate
      // saved as null for foreign-currency expenses and computeBalances
      // excluded them entirely). fetchRate's memory cache makes this an
      // instant re-read of the rate the preview just fetched; on fetch
      // failure the fields stay null (previous behavior, warning stays).
      if (isEditMode && editingExpense && wasItemized && draft.splitMode === 'itemized') {
        // The record IS (and still will be) itemized -- the user backed
        // out of the itemized screen without changing the split method, so
        // this is a header-field edit (description/payer/date/receipt/etc).
        // The total belongs to the items: no amount or FX figure is sent.
        // Line items/claims/allocation link are untouched; expense_splits
        // don't apply to itemized expenses.
        await updateExpense.mutateAsync({
          expenseId: editingExpense.id,
          expense: buildItemizedHeaderEditPayload(draft, receiptUrl, { includeParticipantIds: participantsChanged }),
          skipSplits: true,
        })
        showToast({ type: 'success', message: 'Expense updated' })
        clearDraft()
        handleClosed()
        return
      }

      const fx = await resolveExpenseFxFields({
        amountMajor,
        currency: draft.currency,
        baseCurrency: trip.base_currency,
        paymentDate: draft.paymentDate,
        manualRate: draft.fxRateOverride ? parseFloat(draft.fxRateOverride) || null : null,
      })

      const splitRows = buildSplitRows(draft, amountMajor, fx)
      const expensePayload = buildExpensePayload(draft, amountMajor, receiptUrl, fx, { includeParticipantIds: !isEditMode || participantsChanged })

      if (isEditMode && editingExpense) {
        if (wasItemized && draft.splitMode !== 'itemized') {
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
      showToast({ type: 'error', message: 'Failed to save expense', description: errorText(err) })
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
      showToast({ type: 'error', message: 'Failed to delete expense', description: errorText(err) })
    }
  }

  /** Header + lines of an itemised save, shared by the Save-time preview and the save itself. */
  const buildItemizedWrite = async (params: ItemizedSaveParams, receiptUrl: string | null) => {
    // Same FX persistence as the regular save path -- itemized claims are
    // converted via the expense's fx_rate at balance time, so a missing
    // rate excludes the whole expense there too.
    const fx = await resolveExpenseFxFields({
      amountMajor: params.totalMajor,
      currency: draft.currency,
      baseCurrency: trip.base_currency,
      paymentDate: draft.paymentDate,
      manualRate: draft.fxRateOverride ? parseFloat(draft.fxRateOverride) || null : null,
    })
    // "Who was at this meal?" decides the participants. On an edit that did
    // not change it, the stored value (often NULL = the default people) stays.
    const roster = new Set(participants.map((p) => p.user_id))
    const changed = !isEditMode || participantSelectionChanged(params.participantIds, seededParticipantIds.filter((id) => roster.size === 0 || roster.has(id)))
    const participantIds = changed ? params.participantIds : editingExpense?.participant_ids ?? null
    return buildItemizedExpensePayload(draft, params.totalMajor, fx, participantIds, receiptUrl)
  }

  /** At Save time on a saved itemised receipt: whose claims would this clear? */
  const handlePreviewClear = async (params: ItemizedSaveParams): Promise<ClearClaimsPreview | null> => {
    if (!editingExpense || !wasItemized) return null
    const expense = await buildItemizedWrite(params, draft.receiptPath)
    const preview = await previewReitemizeExpense({ expenseId: editingExpense.id, expense, lineItems: params.lineItems })
    if (preview.supported) {
      const o = preview.outcome
      return o.clearedUserIds.length > 0 || o.reconfirmUserIds.length > 0
        ? { userIds: o.clearedUserIds, reconfirmUserIds: o.reconfirmUserIds, claimCount: o.clearedClaims, leftoversCleared: o.leftoversCleared }
        : null
    }
    // The database function is not there yet: every claim goes.
    return preview.userIds.length > 0 ? { userIds: preview.userIds, claimCount: preview.claimCount, all: true } : null
  }

  const handleItemizedSave = async (params: ItemizedSaveParams): Promise<boolean> => {
    if (!user) return false
    const writeProblem = itemizedWriteProblem(
      { description: draft.description.trim() || draft.vendorName, vendor_name: draft.vendorName.trim(), amount: params.totalMajor, paid_by: draft.paidBy },
      params.lineItems,
    )
    if (writeProblem) {
      showToast({ type: 'error', message: 'Failed to save itemized expense', description: writeProblem })
      return false
    }
    if (isFrozen(trip)) {
      showToast({ type: 'error', message: 'Failed to save itemized expense', description: FROZEN_EXPENSES_MESSAGE })
      return false
    }
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

      // A receipt picked on the form but not uploaded yet goes up now.
      let receiptUrl = draft.receiptPath
      if (receiptFile) receiptUrl = (await uploadReceipt(receiptFile, user.id)).path

      const itemizedExpensePayload = await buildItemizedWrite(params, receiptUrl)

      let goToWhoHadWhat: string | null = null
      if (isEditMode && editingExpense) {
        // UPDATE the record being edited -- never insert a new one. Claims on
        // items that did not change survive (reitemize_expense); the screen
        // already warned about any that will be cleared.
        const code = editingExpense.allocation_link?.code ?? generateLinkCode()
        const result = await reitemizeExpense.mutateAsync({
          expenseId: editingExpense.id,
          expense: itemizedExpensePayload,
          lineItems: params.lineItems,
          allocationCode: code,
          createdBy: user.id,
        })
        // A receipt already out at the table: the people whose claims were cleared must look again, so ask for the "what changed" email for
        // them (the function enforces the caps) and tell the payer what happened.
        const cols = receiptColumnsOf(editingExpense)
        let notice: SendOutcome | null = null
        // Both groups look again: claims cleared, and "That's everything" answers deleted.
        // The person editing is not emailed or counted: they see their own cleared claim in the toast.
        const told = peopleToTellAfterReitemise(result.clearedUserIds, result.reconfirmUserIds, user.id)
        const lookAgain = [...new Set([...told.clearedOthers, ...told.reconfirmOthers])]
        if (lookAgain.length > 0 && cols?.claimsSentAt && !cols.claimsClosedAt) {
          notice = await sendToTable.mutateAsync({ expenseId: editingExpense.id, resendUserIds: lookAgain })
        }
        showToast({
          type: notice && (!notice.ok || notice.failed > 0) ? 'warning' : 'success',
          message: 'Itemized expense updated',
          description: reitemiseNoticeLine(told, notice),
        })
        goToWhoHadWhat = result.code
      } else {
        const code = generateLinkCode()
        const created = await createItemizedExpense.mutateAsync({
          expense: itemizedExpensePayload,
          lineItems,
          allocationCode: code,
          createdBy: user.id,
        })
        logActivity({ verb: 'expense_added', entity: { type: 'expense', id: created.id, label: created.description } })
        showToast({ type: 'success', message: 'Itemized expense created' })
        goToWhoHadWhat = code
      }
      clearDraft()
      handleClosed()
      // Straight on to "who had what" (the payer's phone at the table); the
      // claim screen shows it to the payer / organizers and the plain claim
      // list to anyone else.
      if (goToWhoHadWhat) navigate(`/claim/${encodeURIComponent(goToWhoHadWhat)}?assign=1`)
      return true
    } catch (err) {
      showToast({ type: 'error', message: 'Failed to save itemized expense', description: errorText(err) })
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
  const parsedReceipt: ReceiptParseResult | null = initialParsedReceipt ?? initialParsedData?.v2?.receipt ?? null
  const itemizedSeed = useMemo(() => {
    if (wasItemized && editingExpense) {
      return fromExpenseLineItems(editingExpense.line_items, draft.currency, { printedTotalMajor: editingExpense.amount })
    }
    if (!isEditMode && parsedReceipt && parsedReceipt.line_items.length > 0) {
      return fromReceiptParseResult(parsedReceipt)
    }
    return emptyItemizedDraft(draft.currency)
  }, [wasItemized, editingExpense, isEditMode, parsedReceipt, draft.currency])

  const noItemsParsedNotice = !isEditMode && !!parsedReceipt && parsedReceipt.line_items.length === 0

  const closedAt = isEditMode ? receiptColumnsOf(editingExpense)?.claimsClosedAt ?? null : null
  const screen = pickEditorScreen(isFrozen(trip), showItemized, !!closedAt)

  if (screen === 'frozen') {
    return (
      <Modal isOpen={isOpen} onClose={onClose} title={isEditMode ? 'Edit expense' : 'Add expense'} size="lg">
        <div className="space-y-4">
          <div className="rounded-[var(--radius-md)] border border-warn-200 bg-warn-50 dark:bg-warn-900 dark:border-warn-800 px-3 py-2.5 text-sm text-warn-700 dark:text-warn-300" role="status">
            🔒 {FROZEN_EXPENSES_MESSAGE}
          </div>
          <Button variant="secondary" fullWidth onClick={onClose}>
            Close
          </Button>
        </div>
      </Modal>
    )
  }

  if (screen === 'closed') {
    const code = editingExpense?.allocation_link?.code
    return (
      <Modal isOpen={isOpen} onClose={onClose} title="Edit expense" size="lg">
        <div className="space-y-4">
          <div className="rounded-[var(--radius-md)] border border-warn-200 bg-warn-50 dark:bg-warn-900 dark:border-warn-800 px-3 py-2.5 text-sm text-warn-700 dark:text-warn-300" role="status">
            This receipt is closed, so its amount, items, payer and people can't be changed. The person who paid or an organizer can reopen it from Who had what.
          </div>
          {code && (
            <Button
              variant="primary"
              fullWidth
              onClick={() => {
                onClose()
                navigate(`/claim/${encodeURIComponent(code)}`)
              }}
            >
              Open Who had what
            </Button>
          )}
          <Button variant="secondary" fullWidth onClick={onClose}>
            Close
          </Button>
        </div>
      </Modal>
    )
  }

  if (screen === 'itemized') {
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
          onPreviewClear={handlePreviewClear}
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
          participants={participants}
          initialParticipantIds={draft.participantIds}
          existingLineItems={wasItemized ? editingExpense?.line_items : undefined}
          existingCurrency={editingExpense?.currency}
          headerProblems={[...itemizedMissingHeader(draft.description.trim() || draft.vendorName, draft.paidBy), ...Object.values(headerTextProblems(draft.description, draft.vendorName))]}
          existingClaims={wasItemized ? editingExpense?.claims : undefined}
          // claimDeadlineSlot: Phase 2 supplies the "Claim by ..." line here.
        />
        <ConfirmDiscardSheet isOpen={guardProps.showConfirm} onKeep={guardProps.onKeep} onDiscard={guardProps.onDiscard} />
      </Modal>
    )
  }

  const parsedCount = parsedLineCount(initialParsedData) || (parsedReceipt?.line_items.length ?? 0)
  const choice = itemiseChoice(parsedCount)
  const showChoice = !isEditMode && !!(initialParsedData || parsedReceipt) && choice.show && !itemiseChoiceDismissed
  const reconciliation = initialParsedData?.v2?.reconciliation
  const topSlot = showChoice ? (
    <div className="rounded-[var(--radius-md)] border border-accent-200 bg-accent-50 dark:bg-accent-950 dark:border-accent-800 p-3 space-y-2" role="group" aria-label="How to split this receipt">
      <p className="text-sm text-[var(--text-secondary)]">We read this receipt. Everyone can pick what they had, or you can split the total.</p>
      <div className="flex flex-col sm:flex-row gap-2">
        <Button type="button" variant="primary" fullWidth onClick={() => setShowItemized(true)}>
          {choice.label}
        </Button>
        <Button type="button" variant="secondary" fullWidth onClick={() => setItemiseChoiceDismissed(true)}>
          Just split the total
        </Button>
      </div>
      {reconciliation && (
        <p className="text-xs text-[var(--text-muted)]" role="status">
          {reconciliation.reconciled ? '✓ Items add up to the printed total' : `⚠ ${reconciliation.explanation}`}
        </p>
      )}
    </div>
  ) : undefined

  const receiptSlot = (
    <div className="pt-2 border-t border-[var(--border-subtle)]">
      <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1.5">Receipt (optional)</label>
      {receiptFile ? (
        <div className="flex items-center gap-3">
          {receiptPreviewUrl && !isPdfFile(receiptFile) && (
            <img src={receiptPreviewUrl} alt="New receipt preview" className="w-12 h-12 rounded-[var(--radius-sm)] object-cover border border-[var(--border-subtle)]" />
          )}
          <span className="text-sm text-[var(--text-secondary)] truncate flex-1">{receiptFile.name}</span>
          <Button type="button" variant="ghost" size="sm" onClick={() => setReceiptFile(null)}>
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
          accept={RECEIPT_ACCEPT}
          onChange={(e) => setReceiptFile(e.target.files?.[0] ?? null)}
          className="text-sm"
        />
      )}
    </div>
  )

  return (
    <Modal isOpen={isOpen} onClose={requestClose} title={isEditMode ? 'Edit expense' : 'Add expense'} size="lg">
      <OneScreenForm
        draft={draft}
        onChange={patchDraft}
        participants={participants}
        baseCurrency={trip.base_currency}
        today={todayLocal()}
        amountLockedNote={wasItemized && draft.splitMode === 'itemized' ? 'Edit the items to change the total.' : undefined}
        isEdit={isEditMode}
        isSaving={isSaving}
        onSubmit={() => void handleSubmit()}
        onDelete={isEditMode ? () => setConfirmingDelete(true) : undefined}
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
        receiptSlot={receiptSlot}
        topSlot={topSlot}
        duplicateNote={duplicates.length > 0 ? `Possible duplicate: "${duplicates[0].expense.description}" on the same day for a similar amount.` : null}
        currentUserId={user?.id ?? ''}
      />

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
        accept={RECEIPT_ACCEPT}
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
