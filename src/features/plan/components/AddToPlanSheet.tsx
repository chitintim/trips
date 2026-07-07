import { useEffect, useState } from 'react'
import {
  Modal,
  Button,
  Input,
  TextArea,
  Select,
  SegmentedControl,
  Chip,
  useToast,
  ConfirmDiscardSheet,
} from '../../../components/ui'
import { useFormDraft, useUnsavedChangesGuard } from '../../../lib/forms'
import { useAuth } from '../../../hooks/useAuth'
import { useCreateTimelineEvent } from '../../../lib/queries/useTimeline'
import { useSections, useCreateSection, useBulkCreateOptions } from '../../../lib/queries/usePlanning'
import { useTripActivityLog } from '../../organizer/lib/activity'
import { PlacePicker, PlaceChip } from '../../places'
import { PasteALinkSheet } from '../../decisions/components/PasteALinkSheet'
import { CATEGORY_OPTIONS } from '../../timeline/lib/categoryConfig'
import type { Trip, TimelineEventCategory } from '../../../types'
import type { Tables } from '../../../types/database.types'
import type { OptionDraft } from '../../../shared/contracts'

interface DraftOptionRow {
  title: string
  price: string
}

interface AddToPlanFormValues {
  title: string
  description: string
  category: TimelineEventCategory
  hasDate: boolean
  date: string
  hasTime: boolean
  startTime: string
  endTime: string
  price: string
  currency: string
  placeId: string | null
  isVote: boolean
  voteTarget: 'new' | 'existing'
  existingSectionId: string
  votingMethod: 'single' | 'approval' | 'ranked'
  voteDeadline: string
  optionRows: DraftOptionRow[]
}

function emptyValues(baseCurrency: string, defaultDate: string): AddToPlanFormValues {
  return {
    title: '',
    description: '',
    category: 'other',
    hasDate: true,
    date: defaultDate,
    hasTime: false,
    startTime: '',
    endTime: '',
    price: '',
    currency: baseCurrency,
    placeId: null,
    isVote: false,
    voteTarget: 'new',
    existingSectionId: '',
    votingMethod: 'single',
    voteDeadline: '',
    optionRows: [
      { title: '', price: '' },
      { title: '', price: '' },
    ],
  }
}

export interface AddToPlanSheetProps {
  isOpen: boolean
  onClose: () => void
  trip: Trip
  /** Pre-fill the date (e.g. tapping "+" on a specific day header). */
  defaultDate?: string
}

/**
 * The single "Add to plan" creation form (plan §2, Form & Flow Standard):
 * one form for title/day/time/place/price plus a "make it a vote?" toggle
 * that reveals either a 2+ option builder (creates a new section) or an
 * attach-to-existing-section picker. Routing on save:
 *  - votable -> planning_sections (+ bulk options)
 *  - direct  -> trip_timeline_events
 * Also offers a "paste a link" entry point that reuses decisions'
 * PasteALinkSheet, landing the extracted draft back into the option
 * builder for review.
 */
export function AddToPlanSheet({ isOpen, onClose, trip, defaultDate }: AddToPlanSheetProps) {
  const { user } = useAuth()
  const { showToast } = useToast()
  const tripId = trip.id
  const baseCurrency = trip.base_currency || 'GBP'

  const { data: sections } = useSections(tripId)
  const createEvent = useCreateTimelineEvent(tripId)
  const createSection = useCreateSection(tripId)
  const bulkCreateOptions = useBulkCreateOptions(tripId)
  const logActivity = useTripActivityLog(tripId)

  const draftKey = `add-to-plan:new:${tripId}`
  const seed = emptyValues(baseCurrency, defaultDate || trip.start_date)
  const { values, setValues, updateField, clearDraft } = useFormDraft<AddToPlanFormValues>(draftKey, seed)

  const [placePickerOpen, setPlacePickerOpen] = useState(false)
  const [pickedPlace, setPickedPlace] = useState<Tables<'places'> | null>(null)
  const [pasteLinkOpen, setPasteLinkOpen] = useState(false)

  // Fresh-state guarantee: every open starts clean (unless a draft was
  // restored by useFormDraft itself, which is the intended autosave path).
  useEffect(() => {
    if (isOpen) {
      setPickedPlace(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  const isDirty = JSON.stringify(values) !== JSON.stringify(seed)
  const { confirmClose, guardProps } = useUnsavedChangesGuard(isDirty)
  const handleClose = () => confirmClose(onClose)

  const isSaving = createEvent.isPending || createSection.isPending || bulkCreateOptions.isPending

  const updateOptionRow = (index: number, field: keyof DraftOptionRow, value: string) => {
    setValues((prev) => ({
      ...prev,
      optionRows: prev.optionRows.map((row, i) => (i === index ? { ...row, [field]: value } : row)),
    }))
  }

  const addOptionRow = () => setValues((prev) => ({ ...prev, optionRows: [...prev.optionRows, { title: '', price: '' }] }))
  const removeOptionRow = (index: number) =>
    setValues((prev) => ({ ...prev, optionRows: prev.optionRows.filter((_, i) => i !== index) }))

  const handleApprovedFromLink = (draft: OptionDraft) => {
    setPasteLinkOpen(false)
    setValues((prev) => ({
      ...prev,
      isVote: true,
      title: prev.title || draft.title,
      optionRows: [{ title: draft.title, price: draft.price != null ? String(draft.price) : '' }, ...prev.optionRows.slice(1)],
      currency: draft.currency || prev.currency,
    }))
  }

  const handleSave = async () => {
    if (!user) return
    if (!values.title.trim()) {
      showToast({ type: 'error', message: 'Please enter a title' })
      return
    }

    try {
      if (values.isVote) {
        const filledRows = values.optionRows.filter((r) => r.title.trim())
        if (values.voteTarget === 'new' && filledRows.length < 2) {
          showToast({ type: 'error', message: 'Add at least 2 options to start a vote' })
          return
        }
        if (values.voteTarget === 'existing' && !values.existingSectionId) {
          showToast({ type: 'error', message: 'Choose a section to add this option to' })
          return
        }

        let sectionId = values.existingSectionId
        if (values.voteTarget === 'new') {
          const created = await createSection.mutateAsync({
            title: values.title.trim(),
            description: values.description.trim() || null,
            section_type: 'activities',
            status: 'in_progress',
            allow_multiple_selections: false,
            order_index: 0,
            voting_method: values.votingMethod,
            hide_votes_until_close: true,
            vote_deadline: values.voteDeadline ? new Date(values.voteDeadline).toISOString() : null,
            quorum: null,
          })
          sectionId = created.id

          await bulkCreateOptions.mutateAsync(
            filledRows.map((row) => ({
              section_id: sectionId,
              title: row.title.trim(),
              price: row.price ? parseFloat(row.price) : null,
              currency: row.price ? values.currency : null,
              price_type: 'per_person_fixed' as const,
              place_id: pickedPlace?.id ?? values.placeId,
            }))
          )
          logActivity({ verb: 'option_added', entity: { type: 'section', id: sectionId, label: values.title.trim() } })
        } else {
          await bulkCreateOptions.mutateAsync([
            {
              section_id: sectionId,
              title: values.title.trim(),
              description: values.description.trim() || null,
              price: values.price ? parseFloat(values.price) : null,
              currency: values.price ? values.currency : null,
              price_type: 'per_person_fixed' as const,
              place_id: pickedPlace?.id ?? values.placeId,
            },
          ])
          logActivity({ verb: 'option_added', entity: { type: 'option', label: values.title.trim() } })
        }

        showToast({ type: 'success', message: 'Added to the plan as a vote' })
      } else {
        if (values.hasDate && !values.date) {
          showToast({ type: 'error', message: 'Please pick a date, or turn off "has a date"' })
          return
        }

        const created = await createEvent.mutateAsync({
          trip_id: tripId,
          created_by: user.id,
          title: values.title.trim(),
          description: values.description.trim() || null,
          category: values.category,
          event_date: values.hasDate ? values.date : trip.start_date,
          all_day: values.hasDate ? !values.hasTime : true,
          start_time: values.hasDate && values.hasTime ? values.startTime || null : null,
          end_time: values.hasDate && values.hasTime ? values.endTime || null : null,
          place_id: pickedPlace?.id ?? values.placeId,
          location: pickedPlace?.name ?? null,
        })
        logActivity({ verb: 'event_added', entity: { type: 'timeline_event', label: values.title.trim() } })
        void created
        showToast({ type: 'success', message: 'Added to the plan' })
      }

      clearDraft()
      onClose()
    } catch (err) {
      showToast({ type: 'error', message: 'Could not add this to the plan', description: (err as Error).message })
    }
  }

  return (
    <>
      <Modal isOpen={isOpen} onClose={handleClose} size="lg" title="Add to plan">
        <div className="space-y-4">
          <div className="flex justify-end">
            <Button variant="ghost" size="sm" onClick={() => setPasteLinkOpen(true)}>
              🔗 Paste a link instead
            </Button>
          </div>

          <Input label="Title" value={values.title} onChange={(e) => updateField('title', e.target.value)} placeholder="e.g. Dinner at Kumo" required autoFocus />
          <TextArea label="Description (optional)" value={values.description} onChange={(e) => updateField('description', e.target.value)} rows={2} />

          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={values.hasDate} onChange={(e) => updateField('hasDate', e.target.checked)} className="w-5 h-5 accent-accent-600" />
            <span className="text-sm text-[var(--text-primary)]">This has a day</span>
          </label>

          {values.hasDate && (
            <div className="space-y-3 pl-1">
              <div className="grid grid-cols-2 gap-3">
                <Input label="Day" type="date" value={values.date} onChange={(e) => updateField('date', e.target.value)} />
                <Select
                  label="Category"
                  value={values.category}
                  onChange={(e) => updateField('category', e.target.value as TimelineEventCategory)}
                  options={CATEGORY_OPTIONS}
                />
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={values.hasTime} onChange={(e) => updateField('hasTime', e.target.checked)} className="w-5 h-5 accent-accent-600" />
                <span className="text-sm text-[var(--text-primary)]">Specific time (otherwise all day)</span>
              </label>
              {values.hasTime && (
                <div className="grid grid-cols-2 gap-3">
                  <Input label="Start time" type="time" value={values.startTime} onChange={(e) => updateField('startTime', e.target.value)} />
                  <Input label="End time" type="time" value={values.endTime} onChange={(e) => updateField('endTime', e.target.value)} />
                </div>
              )}
            </div>
          )}

          <div>
            <span className="mb-1.5 block text-sm font-medium text-[var(--text-primary)]">Place (optional)</span>
            {pickedPlace || values.placeId ? (
              <div className="flex items-center gap-2">
                {pickedPlace ? <PlaceChip place={pickedPlace} compact /> : <Chip icon={<span>📍</span>}>Linked place</Chip>}
                <Button variant="ghost" size="sm" onClick={() => { setPickedPlace(null); updateField('placeId', null) }}>
                  Remove
                </Button>
              </div>
            ) : (
              <Button variant="secondary" size="sm" onClick={() => setPlacePickerOpen(true)}>
                📍 Attach a place
              </Button>
            )}
          </div>

          {!values.isVote && (
            <div className="grid grid-cols-2 gap-3">
              <Input label="Price (optional)" type="number" value={values.price} onChange={(e) => updateField('price', e.target.value)} placeholder="0.00" />
              <Select
                label="Currency"
                value={values.currency}
                onChange={(e) => updateField('currency', e.target.value)}
                options={['GBP', 'EUR', 'USD', 'JPY', 'CHF', 'AUD', 'CAD'].map((c) => ({ value: c, label: c }))}
              />
            </div>
          )}

          <label className="flex items-start gap-3 cursor-pointer rounded-[var(--radius-md)] bg-[var(--surface-sunken)] p-3">
            <input type="checkbox" checked={values.isVote} onChange={(e) => updateField('isVote', e.target.checked)} className="mt-0.5 w-5 h-5 accent-accent-600" />
            <span className="text-sm text-[var(--text-primary)]">
              Make it a vote
              <span className="block text-xs text-[var(--text-muted)]">Not sure yet? Let the group decide between options.</span>
            </span>
          </label>

          {values.isVote && (
            <div className="space-y-3 rounded-[var(--radius-md)] border border-[var(--border-default)] p-3">
              <SegmentedControl
                fullWidth
                size="sm"
                value={values.voteTarget}
                onChange={(v) => updateField('voteTarget', v)}
                options={[
                  { value: 'new', label: 'New section' },
                  { value: 'existing', label: 'Add to existing section' },
                ]}
              />

              {values.voteTarget === 'existing' ? (
                <Select
                  label="Section"
                  value={values.existingSectionId}
                  onChange={(e) => updateField('existingSectionId', e.target.value)}
                  options={(sections || []).map((s) => ({ value: s.id, label: s.title }))}
                />
              ) : (
                <>
                  <div>
                    <span className="mb-1.5 block text-sm font-medium text-[var(--text-primary)]">Options (2+)</span>
                    <div className="space-y-2">
                      {values.optionRows.map((row, i) => (
                        <div key={i} className="flex gap-2">
                          <Input value={row.title} onChange={(e) => updateOptionRow(i, 'title', e.target.value)} placeholder={`Option ${i + 1}`} fullWidth />
                          <Input
                            type="number"
                            value={row.price}
                            onChange={(e) => updateOptionRow(i, 'price', e.target.value)}
                            placeholder="Price"
                            className="w-28"
                          />
                          {values.optionRows.length > 2 && (
                            <Button variant="ghost" size="sm" onClick={() => removeOptionRow(i)}>
                              ✕
                            </Button>
                          )}
                        </div>
                      ))}
                    </div>
                    <Button variant="ghost" size="sm" onClick={addOptionRow} className="mt-2">
                      + Add another option
                    </Button>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-[var(--text-primary)] mb-2">Voting method</label>
                    <SegmentedControl
                      fullWidth
                      size="sm"
                      value={values.votingMethod}
                      onChange={(v) => updateField('votingMethod', v)}
                      options={[
                        { value: 'single', label: 'Single choice' },
                        { value: 'approval', label: 'Approve multiple' },
                        { value: 'ranked', label: 'Ranked' },
                      ]}
                    />
                  </div>

                  <Input label="Vote deadline (optional)" type="datetime-local" value={values.voteDeadline} onChange={(e) => updateField('voteDeadline', e.target.value)} />
                </>
              )}
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2 border-t border-[var(--border-subtle)]">
            <Button variant="ghost" onClick={handleClose} disabled={isSaving}>
              Cancel
            </Button>
            <Button onClick={handleSave} isLoading={isSaving}>
              {values.isVote ? 'Add vote' : 'Add to plan'}
            </Button>
          </div>
        </div>

        <PlacePicker
          isOpen={placePickerOpen}
          onClose={() => setPlacePickerOpen(false)}
          tripId={tripId}
          title="Where is this?"
          onPicked={(place) => {
            setPickedPlace(place)
            updateField('placeId', place.id)
            setPlacePickerOpen(false)
          }}
        />

        <ConfirmDiscardSheet
          isOpen={guardProps.showConfirm}
          onKeep={guardProps.onKeep}
          onDiscard={() => {
            clearDraft()
            guardProps.onDiscard()
          }}
        />
      </Modal>

      <PasteALinkSheet isOpen={pasteLinkOpen} onClose={() => setPasteLinkOpen(false)} tripId={tripId} onApproved={handleApprovedFromLink} />
    </>
  )
}
