import { useEffect, useMemo } from 'react'
import { useAuth } from '../../../hooks/useAuth'
import { useTimeline } from '../../../lib/queries/useTimeline'
import { useSaveOrderItems } from '../../../lib/queries/usePlanning'
import { useFormDraft } from '../../../lib/forms/useFormDraft'
import { useUnsavedChangesGuard } from '../../../lib/forms/useUnsavedChangesGuard'
import { useToast } from '../../../components/ui'
import { getMyTravelEvents } from '../../people/lib/travelDetails'
import {
  readOptionPricing,
  readOrderItemMetadata,
  buildOrderLine,
  sumOrderLinesByCurrency,
  buildOrderItemMetadata,
  type OrderLine,
  type OrderItemMetadata,
} from '../../decisions/lib/decisionShapes'
import type { SectionWithOptions, OrderItemChange } from '../../../lib/queries/usePlanning'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'
import type { Trip } from '../../../types'

export interface OrderRowValues {
  checked: boolean
  variant: string
  quantity: number
  startDate: string
  endDate: string
}

export type OrderFormValues = Record<string, OrderRowValues>

export interface UseOrderFormResult {
  values: OrderFormValues
  updateRow: (optionId: string, patch: Partial<OrderRowValues>) => void
  orderLines: OrderLine[]
  totalsByCurrency: Record<string, number>
  respondedUsers: Array<{ id: string; user: ParticipantWithUser['user'] | undefined }>
  fallbackCurrency: string
  isDirty: boolean
  isSaving: boolean
  /** Renders the shared ConfirmDiscardSheet via this hook's dirty-close guard. Callers own the Modal chrome. */
  guardProps: ReturnType<typeof useUnsavedChangesGuard>['guardProps']
  confirmClose: (onConfirm: () => void) => void
  save: () => Promise<boolean>
}

/**
 * All the state/logic behind a participant's personal order (UX_REDESIGN.md
 * Part 5, shape 2) — shared between the standalone OrderFormSheet (opened
 * from the Plan tray) and the AnswerFlow stepper's inline personal-order
 * step, so the two never drift out of sync. Presentational rendering lives
 * in OrderFormFields; this hook owns state, draft persistence, and saving.
 */
export function useOrderForm(trip: Trip, section: SectionWithOptions): UseOrderFormResult {
  const { user } = useAuth()
  const { showToast } = useToast()
  const { data: events = [] } = useTimeline(trip.id)
  const saveOrderItems = useSaveOrderItems(trip.id)

  const myTravel = getMyTravelEvents(events, user?.id)
  const defaultStart = myTravel.arrival?.event_date || trip.start_date
  const defaultEnd = myTravel.departure?.event_date || trip.end_date
  const fallbackCurrency = trip.base_currency || 'GBP'

  const existingByOption = useMemo(() => {
    const map = new Map<string, { selectionId: string; item: OrderItemMetadata }>()
    if (!user) return map
    for (const option of section.options) {
      const mine = option.selections.find((s) => s.user_id === user.id)
      if (mine) map.set(option.id, { selectionId: mine.id, item: readOrderItemMetadata(mine.metadata) })
    }
    return map
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section.options, user?.id])

  function seedValues(): OrderFormValues {
    const seed: OrderFormValues = {}
    for (const option of section.options) {
      const existing = existingByOption.get(option.id)
      seed[option.id] = {
        checked: !!existing,
        variant: existing?.item.variant ?? '',
        quantity: existing?.item.quantity ?? 1,
        startDate: existing?.item.start_date ?? defaultStart,
        endDate: existing?.item.end_date ?? defaultEnd,
      }
    }
    return seed
  }

  const draftKey = `order-form:${section.id}:${user?.id ?? 'anon'}`
  const { values, setValues, clearDraft } = useFormDraft<OrderFormValues>(draftKey, seedValues())

  useEffect(() => {
    setValues(seedValues())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section.id, user?.id])

  const seed = seedValues()
  const isDirty = JSON.stringify(values) !== JSON.stringify(seed)
  const { confirmClose, guardProps: rawGuardProps } = useUnsavedChangesGuard(isDirty)
  // Discarding unsaved changes must also clear the persisted draft, so the
  // next open doesn't silently restore what the user just chose to throw away.
  const guardProps = { ...rawGuardProps, onDiscard: () => { clearDraft(); rawGuardProps.onDiscard() } }

  const updateRow = (optionId: string, patch: Partial<OrderRowValues>) => {
    setValues((prev) => ({ ...prev, [optionId]: { ...prev[optionId], ...patch } }))
  }

  const orderLines = useMemo(() => {
    return section.options
      .filter((option) => values[option.id]?.checked)
      .map((option) => {
        const row = values[option.id]
        const pricing = readOptionPricing(option.metadata) || {}
        const item: OrderItemMetadata = { start_date: row.startDate, end_date: row.endDate, variant: row.variant || undefined, quantity: row.quantity }
        return buildOrderLine({ id: option.id, title: option.title, currency: option.currency }, pricing, item, fallbackCurrency)
      })
  }, [section.options, values, fallbackCurrency])

  const totalsByCurrency = sumOrderLinesByCurrency(orderLines)

  const respondedUsers = useMemo(() => {
    const seen = new Map<string, ParticipantWithUser['user'] | undefined>()
    for (const option of section.options) {
      for (const selection of option.selections) {
        if (!seen.has(selection.user_id)) seen.set(selection.user_id, undefined)
      }
    }
    return Array.from(seen.entries()).map(([id, u]) => ({ id, user: u }))
  }, [section.options])

  const save = async (): Promise<boolean> => {
    if (!user) return false
    const changes: OrderItemChange[] = section.options.map((option) => {
      const row = values[option.id]
      const existing = existingByOption.get(option.id)
      if (!row?.checked) {
        return { optionId: option.id, selectionId: existing?.selectionId ?? null, metadata: null }
      }
      const item: OrderItemMetadata = { start_date: row.startDate, end_date: row.endDate, variant: row.variant || undefined, quantity: row.quantity }
      return { optionId: option.id, selectionId: existing?.selectionId ?? null, metadata: buildOrderItemMetadata(item) }
    })

    try {
      await saveOrderItems.mutateAsync({ userId: user.id, changes })
      showToast({ type: 'success', message: 'Your order is saved' })
      clearDraft()
      return true
    } catch (err) {
      showToast({ type: 'error', message: 'Could not save your order', description: (err as Error).message })
      return false
    }
  }

  return {
    values,
    updateRow,
    orderLines,
    totalsByCurrency,
    respondedUsers,
    fallbackCurrency,
    isDirty,
    isSaving: saveOrderItems.isPending,
    guardProps,
    confirmClose,
    save,
  }
}
