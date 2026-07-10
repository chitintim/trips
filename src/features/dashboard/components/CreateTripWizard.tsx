import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Modal, Button, Input, SegmentedControl, Select, Stepper, useToast, ConfirmDiscardSheet } from '../../../components/ui'
import { useCreateTrip, useUpdateTrip } from '../../../lib/queries/useTrip'
import { useUnsavedChangesGuard } from '../../../lib/forms/useUnsavedChangesGuard'
import { supabase } from '../../../lib/supabase'
import { useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '../../../lib/queries/queryKeys'
import { mergeChaseSettingsJson, TRIP_DATES_SECTION_TITLE } from '../../today'
import { CURRENCY_LIST } from '../../expenses/lib/currencyList'
import type { Json } from '../../../types/database.types'
import type { Trip, TripStatus } from '../../../types'

type StepKey = 'basics' | 'dates' | 'extras'
type DatesMode = 'fixed' | 'vote'

interface CandidateRange {
  start: string
  end: string
}

export interface CreateTripWizardProps {
  isOpen: boolean
  onClose: () => void
  /**
   * When set, the wizard edits this trip instead of creating a new one:
   * fields seed from the record, dates are a plain start/end pair (no
   * "let the group vote" flow — that's a creation-time-only feature), the
   * extras step exposes a stage/status selector, and saving updates the
   * record rather than inserting one. Called by both "Edit trip" sites
   * (TripDetail's overflow menu, the admin trips console).
   */
  editTrip?: Trip | null
  /** Extra success callback (e.g. a caller-owned refetch/invalidate) on top of the wizard's own cache invalidation. */
  onSuccess?: () => void
}

const STEPS = [
  { key: 'basics', label: 'Trip' },
  { key: 'dates', label: 'Dates' },
  { key: 'extras', label: 'Details' },
]

const CURRENCY_OPTIONS = CURRENCY_LIST.slice(0, 12).map((c) => ({ value: c.code, label: `${c.code} — ${c.name}` }))

const STATUS_OPTIONS: { value: TripStatus; label: string }[] = [
  { value: 'gathering_interest', label: '💭 Gathering Interest - Seeing who might be interested' },
  { value: 'confirming_participants', label: '✋ Confirming Participants - Getting commitments' },
  { value: 'booking_details', label: '🔄 Booking Details - Planning flights, transport, etc.' },
  { value: 'booked_awaiting_departure', label: '✅ Booked - All set, awaiting departure' },
  { value: 'trip_ongoing', label: '🎿 Trip Ongoing - Currently happening' },
  { value: 'trip_completed', label: '🏁 Trip Completed - All done' },
]

/**
 * Trip creation AND edit wizard (UX_REDESIGN Part 2 "Trip creation → guided
 * setup"; edit mode added to retire the legacy CreateTripModal fields-dump
 * — UPGRADE_MASTER_PLAN.md §5 Form & Flow Standard). Three steps: (1) name
 * + location, (2) dates — fixed pickers, or (create-only) "let the group
 * vote" which creates a 'Trip dates' date-poll section and flags
 * chase_settings.dates_pending — (3) stage/visibility/cost extras. New
 * trips always start gathering_interest; editing an existing trip exposes
 * its stage instead of the cost band (matching what the retired modal let
 * organizers/admins change).
 */
export function CreateTripWizard({ isOpen, onClose, editTrip = null, onSuccess }: CreateTripWizardProps) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const createTrip = useCreateTrip()
  const updateTrip = useUpdateTrip(editTrip?.id ?? '')
  const { showToast } = useToast()

  const [step, setStep] = useState<StepKey>('basics')
  const [name, setName] = useState('')
  const [location, setLocation] = useState('')
  const [datesMode, setDatesMode] = useState<DatesMode>('fixed')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [status, setStatus] = useState<TripStatus>('gathering_interest')
  const [candidates, setCandidates] = useState<CandidateRange[]>([
    { start: '', end: '' },
    { start: '', end: '' },
  ])
  const [estimatedCost, setEstimatedCost] = useState('')
  const [costCurrency, setCostCurrency] = useState('GBP')
  const [isPublic, setIsPublic] = useState(false)
  const [saving, setSaving] = useState(false)

  const isDirty = editTrip
    ? name !== editTrip.name ||
      location !== editTrip.location ||
      startDate !== editTrip.start_date ||
      endDate !== editTrip.end_date ||
      status !== editTrip.status ||
      isPublic !== editTrip.is_public
    : !!(name || location || startDate || endDate || candidates.some((c) => c.start || c.end) || estimatedCost)
  const { confirmClose, guardProps } = useUnsavedChangesGuard(isDirty && !saving)

  const reset = () => {
    setStep('basics')
    if (editTrip) {
      setName(editTrip.name)
      setLocation(editTrip.location)
      setDatesMode('fixed')
      setStartDate(editTrip.start_date)
      setEndDate(editTrip.end_date)
      setStatus(editTrip.status)
      setIsPublic(editTrip.is_public)
    } else {
      setName('')
      setLocation('')
      setDatesMode('fixed')
      setStartDate('')
      setEndDate('')
      setStatus('gathering_interest')
      setIsPublic(false)
    }
    setCandidates([
      { start: '', end: '' },
      { start: '', end: '' },
    ])
    setEstimatedCost('')
    setCostCurrency('GBP')
  }

  // Fresh-state guarantee (Form & Flow Standard §5.2): every open seeds
  // clean state — from the record being edited, or blank for a new trip —
  // rather than leaking whatever the previous open left behind (the wizard
  // instance persists across opens; its callers don't key-remount it).
  // Deliberately depends on `isOpen` alone, NOT `editTrip`: TripDetail keeps
  // a realtime subscription live while this modal is open, so re-seeding on
  // every `editTrip` reference change would wipe in-progress edits out from
  // under the user on an unrelated refetch (Form & Flow Standard §5.5,
  // refetch isolation) instead of only on a deliberate open.
  useEffect(() => {
    if (isOpen) reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  const handleClose = () =>
    confirmClose(() => {
      reset()
      onClose()
    })

  // ---- validation per step -------------------------------------------------
  const validRange = (r: CandidateRange) => r.start && r.end && r.end >= r.start
  const completeCandidates = candidates.filter(validRange)

  const canLeaveBasics = name.trim().length > 0 && location.trim().length > 0
  const canLeaveDates =
    editTrip || datesMode === 'fixed'
      ? !!(startDate && endDate && endDate >= startDate)
      : completeCandidates.length >= 2

  const goNext = () => {
    if (step === 'basics') {
      if (!canLeaveBasics) {
        showToast({ type: 'error', message: 'Give the trip a name and a location' })
        return
      }
      setStep('dates')
    } else if (step === 'dates') {
      if (!canLeaveDates) {
        showToast({
          type: 'error',
          message: !editTrip && datesMode === 'vote' ? 'Add at least two complete date options' : 'Pick valid start and end dates',
        })
        return
      }
      setStep('extras')
    }
  }

  const formatRangeTitle = (r: CandidateRange) => {
    const s = new Date(r.start + 'T00:00:00')
    const e = new Date(r.end + 'T00:00:00')
    const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }
    return `${s.toLocaleDateString('en-GB', opts)} – ${e.toLocaleDateString('en-GB', opts)} ${e.getFullYear()}`
  }

  const handleSaveEdit = async () => {
    if (!editTrip || !canLeaveBasics || !canLeaveDates) return
    setSaving(true)
    try {
      await updateTrip.mutateAsync({
        name: name.trim(),
        location: location.trim(),
        start_date: startDate,
        end_date: endDate,
        status,
        is_public: isPublic,
      })
      showToast({ type: 'success', message: 'Trip updated' })
      onSuccess?.()
      onClose()
    } catch (err) {
      showToast({ type: 'error', message: 'Could not update the trip', description: (err as Error).message })
    } finally {
      setSaving(false)
    }
  }

  const handleCreate = async () => {
    if (!canLeaveBasics || !canLeaveDates) return
    setSaving(true)
    try {
      // Trip dates: fixed, or the EARLIEST candidate range as placeholder.
      const sorted = [...completeCandidates].sort((a, b) => a.start.localeCompare(b.start))
      const tripStart = datesMode === 'fixed' ? startDate : sorted[0].start
      const tripEnd = datesMode === 'fixed' ? endDate : sorted[0].end

      const tripId = await createTrip.mutateAsync({
        name: name.trim(),
        location: location.trim(),
        start_date: tripStart,
        end_date: tripEnd,
        status: 'gathering_interest',
        is_public: isPublic,
      })

      // Optional cost band + the date poll, applied after creation.
      const tripPatch: Record<string, Json | null> = {}
      const cost = parseFloat(estimatedCost)
      if (!Number.isNaN(cost) && cost > 0) {
        tripPatch.estimated_accommodation_cost = cost
        tripPatch.accommodation_cost_currency = costCurrency
      }

      if (datesMode === 'vote') {
        const { data: section, error: sectionError } = await supabase
          .from('planning_sections')
          .insert({
            trip_id: tripId,
            title: TRIP_DATES_SECTION_TITLE,
            description: 'When should we go? Vote for the dates that work for you.',
            section_type: 'activities',
            status: 'in_progress',
            voting_method: 'single',
            order_index: 0,
          })
          .select()
          .single()
        if (sectionError) throw sectionError

        const { error: optionsError } = await supabase.from('options').insert(
          sorted.map((r, i) => ({
            section_id: section.id,
            title: formatRangeTitle(r),
            order_index: i,
            metadata: { date_range: { start: r.start, end: r.end } } as Json,
          }))
        )
        if (optionsError) throw optionsError

        tripPatch.chase_settings = mergeChaseSettingsJson(null, {
          dates_pending: true,
          dates_section_id: section.id,
        })
      }

      if (Object.keys(tripPatch).length > 0) {
        const { error: patchError } = await supabase.from('trips').update(tripPatch).eq('id', tripId)
        if (patchError) throw patchError
      }

      queryClient.invalidateQueries({ queryKey: queryKeys.trips() })
      showToast({ type: 'success', message: 'Trip created', description: datesMode === 'vote' ? 'The date poll is live.' : undefined })
      onSuccess?.()
      reset()
      onClose()
      navigate(`/${tripId}`)
    } catch (err) {
      showToast({ type: 'error', message: 'Could not create the trip', description: (err as Error).message })
    } finally {
      setSaving(false)
    }
  }

  const handleSubmit = editTrip ? handleSaveEdit : handleCreate

  const updateCandidate = (index: number, patch: Partial<CandidateRange>) => {
    setCandidates((prev) => prev.map((c, i) => (i === index ? { ...c, ...patch } : c)))
  }

  return (
    <Modal isOpen={isOpen} onClose={handleClose} size="md" title={editTrip ? 'Edit trip' : 'Create a new trip'}>
      <div className="space-y-5">
        <Stepper steps={STEPS} current={step} size="sm" />

        {step === 'basics' && (
          <div className="space-y-4">
            <Input label="Trip name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Chamonix 2027" required autoFocus />
            <Input label="Location" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Chamonix, France" required />
            <div className="flex justify-end gap-3 pt-2">
              <Button variant="ghost" onClick={handleClose}>
                Cancel
              </Button>
              <Button onClick={goNext} disabled={!canLeaveBasics}>
                Next
              </Button>
            </div>
          </div>
        )}

        {step === 'dates' && (
          <div className="space-y-4">
            {!editTrip && (
              <SegmentedControl
                fullWidth
                value={datesMode}
                onChange={setDatesMode}
                options={[
                  { value: 'fixed', label: 'We know the dates' },
                  { value: 'vote', label: 'Let the group vote' },
                ]}
              />
            )}

            {editTrip || datesMode === 'fixed' ? (
              <div className="grid grid-cols-2 gap-3">
                <Input label="Start date" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
                <Input label="End date" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} required />
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-[var(--text-secondary)]">
                  Add candidate date ranges — a "{TRIP_DATES_SECTION_TITLE}" poll goes up for the group, and you set the
                  final dates from the winner.
                </p>
                {candidates.map((c, i) => (
                  <div key={i} className="flex items-end gap-2">
                    <div className="grid grid-cols-2 gap-2 flex-1">
                      <Input label={i === 0 ? 'From' : undefined} type="date" value={c.start} onChange={(e) => updateCandidate(i, { start: e.target.value })} />
                      <Input label={i === 0 ? 'To' : undefined} type="date" value={c.end} onChange={(e) => updateCandidate(i, { end: e.target.value })} />
                    </div>
                    {candidates.length > 2 && (
                      <Button variant="ghost" size="sm" onClick={() => setCandidates((prev) => prev.filter((_, idx) => idx !== i))} aria-label={`Remove option ${i + 1}`}>
                        ✕
                      </Button>
                    )}
                  </div>
                ))}
                {candidates.length < 5 && (
                  <Button variant="ghost" size="sm" onClick={() => setCandidates((prev) => [...prev, { start: '', end: '' }])}>
                    + Add another option
                  </Button>
                )}
              </div>
            )}

            <div className="flex justify-between gap-3 pt-2">
              <Button variant="ghost" onClick={() => setStep('basics')}>
                Back
              </Button>
              <Button onClick={goNext} disabled={!canLeaveDates}>
                Next
              </Button>
            </div>
          </div>
        )}

        {step === 'extras' && (
          <div className="space-y-4">
            {editTrip ? (
              <Select
                label="Trip status"
                value={status}
                onChange={(e) => setStatus(e.target.value as TripStatus)}
                options={STATUS_OPTIONS}
                helperText="Set the current stage of this trip"
              />
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <Input
                  label="Rough cost per person (optional)"
                  type="number"
                  min="0"
                  value={estimatedCost}
                  onChange={(e) => setEstimatedCost(e.target.value)}
                  placeholder="450"
                />
                <Select label="Currency" value={costCurrency} onChange={(e) => setCostCurrency(e.target.value)} options={CURRENCY_OPTIONS} />
              </div>
            )}
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={isPublic}
                onChange={(e) => setIsPublic(e.target.checked)}
                className="mt-1 w-5 h-5 accent-accent-600"
              />
              <span className="text-sm text-[var(--text-primary)]">
                Make this trip publicly visible (anyone with an account can see and ask to join)
              </span>
            </label>

            <div className="flex justify-between gap-3 pt-2">
              <Button variant="ghost" onClick={() => setStep('dates')} disabled={saving}>
                Back
              </Button>
              <Button onClick={handleSubmit} isLoading={saving}>
                {editTrip ? 'Save changes' : 'Create trip'}
              </Button>
            </div>
          </div>
        )}
      </div>

      <ConfirmDiscardSheet isOpen={guardProps.showConfirm} onKeep={guardProps.onKeep} onDiscard={guardProps.onDiscard} />
    </Modal>
  )
}
