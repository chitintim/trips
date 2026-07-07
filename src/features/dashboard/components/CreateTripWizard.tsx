import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Modal, Button, Input, SegmentedControl, Select, Stepper, useToast, ConfirmDiscardSheet } from '../../../components/ui'
import { useCreateTrip } from '../../../lib/queries/useTrip'
import { useUnsavedChangesGuard } from '../../../lib/forms/useUnsavedChangesGuard'
import { supabase } from '../../../lib/supabase'
import { useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '../../../lib/queries/queryKeys'
import { mergeChaseSettingsJson, TRIP_DATES_SECTION_TITLE } from '../../today'
import { CURRENCY_LIST } from '../../expenses/lib/currencyList'
import type { Json } from '../../../types/database.types'

type StepKey = 'basics' | 'dates' | 'extras'
type DatesMode = 'fixed' | 'vote'

interface CandidateRange {
  start: string
  end: string
}

export interface CreateTripWizardProps {
  isOpen: boolean
  onClose: () => void
}

const STEPS = [
  { key: 'basics', label: 'Trip' },
  { key: 'dates', label: 'Dates' },
  { key: 'extras', label: 'Details' },
]

const CURRENCY_OPTIONS = CURRENCY_LIST.slice(0, 12).map((c) => ({ value: c.code, label: `${c.code} — ${c.name}` }))

/**
 * Member trip-creation wizard (UX_REDESIGN Part 2 "Trip creation → guided
 * setup"), replacing the old single-form sheet: (1) name + location,
 * (2) dates — fixed pickers OR "let the group vote" (creates a 'Trip dates'
 * date-poll section; trip start/end store the earliest candidate and
 * chase_settings.dates_pending flags the placeholder), (3) optional
 * per-person cost band + visibility. New trips always start
 * gathering_interest — there is no status field here (admin panel keeps
 * its own CreateTripModal).
 */
export function CreateTripWizard({ isOpen, onClose }: CreateTripWizardProps) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const createTrip = useCreateTrip()
  const { showToast } = useToast()

  const [step, setStep] = useState<StepKey>('basics')
  const [name, setName] = useState('')
  const [location, setLocation] = useState('')
  const [datesMode, setDatesMode] = useState<DatesMode>('fixed')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [candidates, setCandidates] = useState<CandidateRange[]>([
    { start: '', end: '' },
    { start: '', end: '' },
  ])
  const [estimatedCost, setEstimatedCost] = useState('')
  const [costCurrency, setCostCurrency] = useState('GBP')
  const [isPublic, setIsPublic] = useState(false)
  const [saving, setSaving] = useState(false)

  const isDirty = !!(name || location || startDate || endDate || candidates.some((c) => c.start || c.end) || estimatedCost)
  const { confirmClose, guardProps } = useUnsavedChangesGuard(isDirty && !saving)

  const reset = () => {
    setStep('basics')
    setName('')
    setLocation('')
    setDatesMode('fixed')
    setStartDate('')
    setEndDate('')
    setCandidates([
      { start: '', end: '' },
      { start: '', end: '' },
    ])
    setEstimatedCost('')
    setCostCurrency('GBP')
    setIsPublic(false)
  }

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
    datesMode === 'fixed' ? !!(startDate && endDate && endDate >= startDate) : completeCandidates.length >= 2

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
          message: datesMode === 'fixed' ? 'Pick valid start and end dates' : 'Add at least two complete date options',
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
      reset()
      onClose()
      navigate(`/${tripId}`)
    } catch (err) {
      showToast({ type: 'error', message: 'Could not create the trip', description: (err as Error).message })
    } finally {
      setSaving(false)
    }
  }

  const updateCandidate = (index: number, patch: Partial<CandidateRange>) => {
    setCandidates((prev) => prev.map((c, i) => (i === index ? { ...c, ...patch } : c)))
  }

  return (
    <Modal isOpen={isOpen} onClose={handleClose} size="md" title="Create a new trip">
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
            <SegmentedControl
              fullWidth
              value={datesMode}
              onChange={setDatesMode}
              options={[
                { value: 'fixed', label: 'We know the dates' },
                { value: 'vote', label: 'Let the group vote' },
              ]}
            />

            {datesMode === 'fixed' ? (
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
              <Button onClick={handleCreate} isLoading={saving}>
                Create trip
              </Button>
            </div>
          </div>
        )}
      </div>

      <ConfirmDiscardSheet isOpen={guardProps.showConfirm} onKeep={guardProps.onKeep} onDiscard={guardProps.onDiscard} />
    </Modal>
  )
}
