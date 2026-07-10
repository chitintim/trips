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
import type { DecisionShape } from '../../decisions/lib/decisionShapes'
import type { Trip, TimelineEventCategory } from '../../../types'
import type { Json, Tables } from '../../../types/database.types'
import type { OptionDraft } from '../../../shared/contracts'

interface DraftOptionRow {
  title: string
  price: string
  /** Personal-picks (decision_shape 'personal') catalog pricing — see decisionShapes.ts's OptionPricing. Ignored in vote shape. */
  pricingPerDay: string
  pricingFlat: string
}

/** Builds an option row's `metadata.pricing` (shape 2, personal picks) from its per-day/flat inputs, or null when neither is set — mirrors OptionEditorSheet's buildMetadata pricing branch. */
function buildRowPricingMetadata(row: DraftOptionRow): Json | null {
  const perDay = row.pricingPerDay ? parseFloat(row.pricingPerDay) : undefined
  const flat = row.pricingFlat ? parseFloat(row.pricingFlat) : undefined
  if (perDay == null && flat == null) return null
  return { pricing: { ...(perDay != null ? { per_day: perDay } : {}), ...(flat != null ? { flat } : {}) } } as unknown as Json
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
  /** Group vote / Personal picks (UX_REDESIGN.md Part 5) — only meaningful (and shown) for the "new section" path; an existing section's shape is already fixed. */
  decisionShape: DecisionShape
  votingMethod: 'single' | 'approval' | 'ranked'
  voteDeadline: string
  optionRows: DraftOptionRow[]
}

function emptyValues(baseCurrency: string, defaultDate: string, defaultIsVote: boolean): AddToPlanFormValues {
  return {
    title: '',
    description: '',
    category: 'other',
    // "New question" (UX_REDESIGN.md Part 4 "Decisions: questions, not
    // sections") opens straight into vote mode with no date pinned yet --
    // most open questions ("Where are we staying?") don't have a day until
    // they're decided, so they land in the Undecided tray by default.
    hasDate: !defaultIsVote,
    date: defaultDate,
    hasTime: false,
    startTime: '',
    endTime: '',
    price: '',
    currency: baseCurrency,
    placeId: null,
    isVote: defaultIsVote,
    voteTarget: 'new',
    existingSectionId: '',
    decisionShape: 'vote',
    votingMethod: 'single',
    voteDeadline: '',
    optionRows: [
      { title: '', price: '', pricingPerDay: '', pricingFlat: '' },
      { title: '', price: '', pricingPerDay: '', pricingFlat: '' },
    ],
  }
}

export interface AddToPlanSheetProps {
  isOpen: boolean
  onClose: () => void
  trip: Trip
  /** Pre-fill the date (e.g. tapping "+" on a specific day header). */
  defaultDate?: string
  /**
   * Open straight into "make it a vote" mode with no date pinned — the
   * Undecided tray's "New question" affordance (UX_REDESIGN.md Part 4) uses
   * this so organizers land directly on the question-authoring UI instead
   * of needing to find and tick the vote toggle themselves.
   */
  defaultIsVote?: boolean
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
export function AddToPlanSheet({ isOpen, onClose, trip, defaultDate, defaultIsVote = false }: AddToPlanSheetProps) {
  const { user } = useAuth()
  const { showToast } = useToast()
  const tripId = trip.id
  const baseCurrency = trip.base_currency || 'GBP'

  const { data: sections } = useSections(tripId)
  const createEvent = useCreateTimelineEvent(tripId)
  const createSection = useCreateSection(tripId)
  const bulkCreateOptions = useBulkCreateOptions(tripId)
  const logActivity = useTripActivityLog(tripId)

  // Namespaced by defaultIsVote (UPGRADE_MASTER_PLAN.md audit item 8): a
  // regular "+ Add" draft and a tray "+ New question" draft must never
  // collide — sharing one key meant a stale plain-item draft (isVote:
  // false, hasDate: true) could silently override the "New question"
  // intent (isVote: true, hasDate: false) on the next open, since
  // useFormDraft only restores/seeds once per mount.
  const draftKey = `add-to-plan:new:${tripId}:${defaultIsVote ? 'vote' : 'item'}`
  const seed = emptyValues(baseCurrency, defaultDate || trip.start_date, defaultIsVote)
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

  const addOptionRow = () =>
    setValues((prev) => ({ ...prev, optionRows: [...prev.optionRows, { title: '', price: '', pricingPerDay: '', pricingFlat: '' }] }))
  const removeOptionRow = (index: number) =>
    setValues((prev) => ({ ...prev, optionRows: prev.optionRows.filter((_, i) => i !== index) }))

  const handleApprovedFromLink = (draft: OptionDraft) => {
    setPasteLinkOpen(false)
    setValues((prev) => ({
      ...prev,
      isVote: true,
      title: prev.title || draft.title,
      optionRows: [
        { title: draft.title, price: draft.price != null ? String(draft.price) : '', pricingPerDay: '', pricingFlat: '' },
        ...prev.optionRows.slice(1),
      ],
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
          const isPersonal = values.decisionShape === 'personal'
          const created = await createSection.mutateAsync({
            title: values.title.trim(),
            description: values.description.trim() || null,
            metadata: { decision_shape: values.decisionShape },
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
              // Personal picks (shape 2) price entirely through
              // metadata.pricing (per-day/flat) -- no row-level price, but
              // still stamp a currency for that pricing to be denominated
              // in (mirrors OptionEditorSheet's buildMetadata/currency rule).
              price: isPersonal ? null : row.price ? parseFloat(row.price) : null,
              currency: isPersonal ? values.currency : row.price ? values.currency : null,
              price_type: 'per_person_fixed' as const,
              place_id: pickedPlace?.id ?? values.placeId,
              metadata: isPersonal ? buildRowPricingMetadata(row) : null,
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
              Ask the group
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
                    <label className="block text-sm font-medium text-[var(--text-primary)] mb-2">Question type</label>
                    <SegmentedControl
                      fullWidth
                      size="sm"
                      value={values.decisionShape}
                      onChange={(v) => updateField('decisionShape', v)}
                      options={[
                        { value: 'vote', label: 'Group vote' },
                        { value: 'personal', label: 'Personal picks' },
                      ]}
                    />
                    <p className="mt-1.5 text-xs text-[var(--text-muted)]">
                      {values.decisionShape === 'vote'
                        ? 'One winner for everyone — the group votes on options.'
                        : 'Each person orders their own items (rental gear, lessons) — not a vote.'}
                    </p>
                  </div>

                  <div>
                    <span className="mb-1.5 block text-sm font-medium text-[var(--text-primary)]">Options (2+)</span>
                    <div className="space-y-2">
                      {values.optionRows.map((row, i) => (
                        <div key={i} className="space-y-1.5">
                          <div className="flex gap-2">
                            <Input value={row.title} onChange={(e) => updateOptionRow(i, 'title', e.target.value)} placeholder={`Option ${i + 1}`} fullWidth />
                            {values.decisionShape === 'vote' && (
                              <Input
                                type="number"
                                value={row.price}
                                onChange={(e) => updateOptionRow(i, 'price', e.target.value)}
                                placeholder="Price"
                                className="w-28"
                              />
                            )}
                            {values.optionRows.length > 2 && (
                              <Button variant="ghost" size="sm" onClick={() => removeOptionRow(i)}>
                                ✕
                              </Button>
                            )}
                          </div>
                          {values.decisionShape === 'personal' && (
                            <div className="flex gap-2 pl-1">
                              <Input
                                type="number"
                                value={row.pricingPerDay}
                                onChange={(e) => updateOptionRow(i, 'pricingPerDay', e.target.value)}
                                placeholder="Price per day"
                                className="w-32"
                              />
                              <Input
                                type="number"
                                value={row.pricingFlat}
                                onChange={(e) => updateOptionRow(i, 'pricingFlat', e.target.value)}
                                placeholder="Flat price"
                                className="w-32"
                              />
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                    <Button variant="ghost" size="sm" onClick={addOptionRow} className="mt-2">
                      + Add another option
                    </Button>
                  </div>

                  {values.decisionShape === 'vote' && (
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
                  )}

                  <Input
                    label={values.decisionShape === 'personal' ? 'Answer by (optional)' : 'Vote deadline (optional)'}
                    type="datetime-local"
                    value={values.voteDeadline}
                    onChange={(e) => updateField('voteDeadline', e.target.value)}
                    helperText={
                      values.decisionShape === 'personal'
                        ? 'Reuses the same deadline field — shown as when orders close, not a vote.'
                        : undefined
                    }
                  />
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
