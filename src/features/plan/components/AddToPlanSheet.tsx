import { isTripFinished } from '../../../lib/answers/answers'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Modal, Button, useToast, ConfirmDiscardSheet } from '../../../components/ui'
import { useFormDraft, useUnsavedChangesGuard } from '../../../lib/forms'
import { useAuth } from '../../../hooks/useAuth'
import { useTripPermissions } from '../../../hooks/useTripPermissions'
import { useParticipants } from '../../../lib/queries/useTrip'
import { PlacePicker } from '../../places'
import { PasteALinkSheet } from '../../decisions/components/PasteALinkSheet'
import { pricingFromDraft } from '../../decisions/lib/optionPricingForm'
import {
  INTENT_TILES,
  applyTemplate,
  availableIntents,
  emptyHappening,
  emptyIdea,
  emptyQuestion,
  validateHappening,
  validateIdea,
  validateQuestion,
  viewLink,
  type AddIntent,
  type HappeningValues,
  type IdeaValues,
  type QuestionValues,
} from '../lib/addFlow'
import { useAddToPlanSave } from '../lib/useAddToPlanSave'
import { useCanSuggestIdea } from '../lib/useCanSuggestIdea'
import { validateSuggestion } from '../../decisions/lib/suggestOption'
import { IntentChooser } from './add/IntentChooser'
import { HappeningForm } from './add/HappeningForm'
import { QuestionForm } from './add/QuestionForm'
import { IdeaForm } from './add/IdeaForm'
import type { Trip } from '../../../types'
import type { Tables } from '../../../types/database.types'
import type { OptionDraft } from '../../../shared/contracts'

interface AddFormState {
  intent: AddIntent | null
  happening: HappeningValues
  question: QuestionValues
  idea: IdeaValues
}

function seedState(baseCurrency: string, defaultDate: string, defaultIsVote: boolean): AddFormState {
  return {
    intent: defaultIsVote ? 'question' : null,
    happening: emptyHappening(defaultDate, baseCurrency),
    question: emptyQuestion(baseCurrency),
    idea: emptyIdea(),
  }
}

export interface AddToPlanSheetProps {
  isOpen: boolean
  onClose: () => void
  trip: Trip
  /** Pre-fill the day (e.g. tapping "+" on a specific day header). */
  defaultDate?: string
  /**
   * Skip the first screen and open on "A question for the group" (the organiser "Set up" to-do and the
   * `add-to-plan` deep link with `asQuestion`).
   */
  defaultIsVote?: boolean
}

/**
 * Add: three intents (proposal 5.5). A first screen of three plain choices; each form needs at most two
 * fields to save and keeps everything else behind "More options". Only people who can run the trip see it
 * (RLS rejects everyone else), so nobody is shown a form the server will refuse.
 */
export function AddToPlanSheet({ isOpen, onClose, trip, defaultDate, defaultIsVote = false }: AddToPlanSheetProps) {
  const { user } = useAuth()
  const { showToast } = useToast()
  const navigate = useNavigate()
  const tripId = trip.id
  const baseCurrency = trip.base_currency || 'GBP'
  const { canManageTrip, isLoading: permsLoading } = useTripPermissions(trip)
  // People who are coming but cannot run the trip get exactly one intent, "An idea", wired to the suggest RPC.
  const canSuggestIdea = useCanSuggestIdea(trip)
  const intents = availableIntents(canManageTrip, isTripFinished(trip), canSuggestIdea)
  const ideaOnly = !canManageTrip && canSuggestIdea
  const { data: participants } = useParticipants(tripId)
  const save = useAddToPlanSave(tripId, user?.id, ideaOnly)

  const seed = seedState(baseCurrency, defaultDate || trip.start_date, defaultIsVote)
  const { values, setValues, clearDraft } = useFormDraft<AddFormState>(`add-to-plan:v2:${tripId}`, seed)

  const [placePickerOpen, setPlacePickerOpen] = useState(false)
  const [pickedPlace, setPickedPlace] = useState<Tables<'places'> | null>(null)
  const [pasteUrl, setPasteUrl] = useState<string | null>(null)

  // Each open starts clean (a restored draft is the intended exception); a "set up the first question"
  // open always lands on the question form.
  useEffect(() => {
    if (!isOpen) return
    setPickedPlace(null)
    if (defaultIsVote) setValues((prev) => ({ ...prev, intent: 'question' }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, defaultIsVote])

  const isDirty = JSON.stringify({ ...values, intent: null }) !== JSON.stringify({ ...seed, intent: null })
  const { confirmClose, guardProps } = useUnsavedChangesGuard(isOpen && isDirty)
  const handleClose = () => confirmClose(onClose)

  const intent = values.intent && intents.includes(values.intent) ? values.intent : ideaOnly ? 'idea' : null
  const tile = INTENT_TILES.find((t) => t.intent === intent) ?? null

  const patch = <K extends 'happening' | 'question' | 'idea'>(key: K, p: Partial<AddFormState[K]>) =>
    setValues((prev) => ({ ...prev, [key]: { ...prev[key], ...p } }))

  const attendees = (participants || [])
    .filter((p) => p.active)
    .map((p) => ({ id: p.user_id, name: p.user?.full_name || p.user?.email || 'Someone' }))

  // ---- Paste a link: pull title / price, review, then drop into the current form -----------------
  const handleApprovedFromLink = (draft: OptionDraft) => {
    const link = pasteUrl
    setPasteUrl(null)
    setValues((prev) => {
      const title = draft.title || ''
      if (prev.intent === 'happening') {
        const cost = draft.price != null && draft.price > 0
        return {
          ...prev,
          happening: {
            ...prev.happening,
            title,
            notes: prev.happening.notes || link || '',
            ...(cost
              ? { costAmount: String(draft.price), costCurrency: draft.currency || prev.happening.costCurrency, costBasis: draft.price_type === 'total_split' ? ('total_split' as const) : ('each' as const) }
              : {}),
          },
        }
      }
      if (prev.intent === 'question') {
        // The link is one of the answers, so it joins the options. The title field held the address, so it empties.
        const q = prev.question
        const lines = q.optionsText.trim() ? q.optionsText.replace(/\s+$/, '') + '\n' : ''
        const priced = pricingFromDraft(draft, q.basis)
        return {
          ...prev,
          question: {
            ...q,
            title: '',
            optionsText: title ? `${lines}${title}` : q.optionsText,
            prices: title && priced.price ? { ...q.prices, [title.toLowerCase()]: priced.price } : q.prices,
            basis: priced.price ? priced.basis : q.basis,
            currency: priced.price && draft.currency ? draft.currency : q.currency,
          },
        }
      }
      return { ...prev, idea: { title, link: link || prev.idea.link } }
    })
  }

  const finish = (message: string, target: { type: 'question' | 'item'; id: string }) => {
    showToast({ type: 'success', message, action: { label: 'View', onClick: () => navigate(viewLink(tripId, target)) } })
    clearDraft()
    setValues(seed)
    setPickedPlace(null)
    onClose()
  }

  const handleSave = async () => {
    if (!intent) return
    const fail = (message: string) => showToast({ type: 'error', message })
    try {
      if (intent === 'happening') {
        const err = validateHappening(values.happening)
        if (err) return fail(err)
        const row = await save.happening.mutateAsync(values.happening)
        finish('Added to the plan', { type: 'item', id: row.id })
      } else if (intent === 'question') {
        const err = validateQuestion(values.question)
        if (err) return fail(err)
        const row = await save.question.mutateAsync(values.question)
        finish('Question added', { type: 'question', id: row.id })
      } else {
        const err = ideaOnly ? validateSuggestion(values.idea) : validateIdea(values.idea)
        if (err) return fail(err)
        const row = await save.idea.mutateAsync(values.idea)
        finish('Idea added', { type: 'question', id: row.questionId })
      }
    } catch (err) {
      showToast({ type: 'error', message: 'Could not save this', description: (err as Error).message })
    }
  }

  // Never render a form the server would reject.
  if (permsLoading || intents.length === 0) return null

  return (
    <>
      <Modal isOpen={isOpen} onClose={handleClose} size="lg" title={tile ? tile.title : 'Add'}>
        <div className="space-y-4">
          {!intent && <IntentChooser intents={intents} onChoose={(i) => setValues((prev) => ({ ...prev, intent: i }))} />}

          {intent === 'happening' && (
            <HappeningForm
              values={values.happening}
              onChange={(p) => patch('happening', p)}
              pickedPlace={pickedPlace}
              onPickPlace={() => setPlacePickerOpen(true)}
              onClearPlace={() => {
                setPickedPlace(null)
                patch('happening', { placeId: null, placeName: null })
              }}
              attendees={attendees}
              onPullLink={setPasteUrl}
            />
          )}
          {intent === 'question' && (
            <QuestionForm
              values={values.question}
              onChange={(p) => patch('question', p)}
              onTemplate={(title) => setValues((prev) => ({ ...prev, question: applyTemplate(prev.question, title) }))}
              onPullLink={setPasteUrl}
            />
          )}
          {intent === 'idea' && <IdeaForm values={values.idea} onChange={(p) => patch('idea', p)} onPullLink={setPasteUrl} />}

          {intent && (
            <div className="flex items-center justify-between gap-3 border-t border-[var(--border-subtle)] pt-3">
              {intents.length > 1 ? (
                <Button variant="ghost" onClick={() => setValues((prev) => ({ ...prev, intent: null }))} disabled={save.isSaving}>
                  Back
                </Button>
              ) : (
                <Button variant="ghost" onClick={handleClose} disabled={save.isSaving}>
                  Cancel
                </Button>
              )}
              <Button onClick={handleSave} isLoading={save.isSaving}>
                {tile?.saveLabel}
              </Button>
            </div>
          )}
        </div>

        <PlacePicker
          isOpen={placePickerOpen}
          onClose={() => setPlacePickerOpen(false)}
          tripId={tripId}
          title="Where is this?"
          onPicked={(place) => {
            setPickedPlace(place)
            patch('happening', { placeId: place.id, placeName: place.name })
            setPlacePickerOpen(false)
          }}
        />

        <ConfirmDiscardSheet
          isOpen={guardProps.showConfirm}
          onKeep={guardProps.onKeep}
          onDiscard={() => {
            clearDraft()
            setValues(seed)
            guardProps.onDiscard()
          }}
        />
      </Modal>

      <PasteALinkSheet
        isOpen={pasteUrl != null}
        onClose={() => setPasteUrl(null)}
        tripId={tripId}
        initialUrl={pasteUrl ?? undefined}
        onApproved={handleApprovedFromLink}
      />
    </>
  )
}
