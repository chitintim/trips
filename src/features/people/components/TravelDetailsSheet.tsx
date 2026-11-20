import { useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Modal, Button, Input, useToast, ConfirmDiscardSheet } from '../../../components/ui'
import { useAuth } from '../../../hooks/useAuth'
import { useTrip } from '../../../lib/queries/useTrip'
import { useTimeline } from '../../../lib/queries/useTimeline'
import { queryKeys } from '../../../lib/queries/queryKeys'
import { useFormDraft } from '../../../lib/forms/useFormDraft'
import { useUnsavedChangesGuard } from '../../../lib/forms/useUnsavedChangesGuard'
import { dateNote } from '../../../lib/tripWindow'
import { legsFromEvents, ownTravelRowIds, setMyTravel, travelLegErrors, travelSaveErrorMessage } from '../lib/myTravel'
import { decideTravelSeed, travelFingerprint } from '../lib/travelDraft'
import type { TravelLegField, TravelLegInput } from '../lib/myTravel'
import type { TravelDirection } from '../lib/travelDetails'

export interface TravelDetailsSheetProps {
  isOpen: boolean
  onClose: () => void
  tripId: string
}

/** A main leg: the arrival or the departure. `otherDate` is the set-off day (arrival) or the get-home day (departure). */
interface MainDraft {
  id: string | null
  date: string
  time: string
  flightRef: string
  airportCode: string
  otherDate: string
  otherTime: string
}

/** An extra journey before or after the main legs. */
interface ExtraDraft {
  key: string
  id: string | null
  title: string
  date: string
  time: string
  flightRef: string
  airportCode: string
}

interface TravelFormValues {
  /** Fingerprint of the saved travel this form was built on; a stored draft is only reused while it still matches. */
  basedOn: string
  arrival: MainDraft
  departure: MainDraft
  before: ExtraDraft[]
  after: ExtraDraft[]
}

const MAX_EXTRA = 3

const emptyMain: MainDraft = { id: null, date: '', time: '', flightRef: '', airportCode: '', otherDate: '', otherTime: '' }
const EMPTY_VALUES: TravelFormValues = { basedOn: '', arrival: emptyMain, departure: emptyMain, before: [], after: [] }

function valuesFromLegs(legs: TravelLegInput[], basedOn: string): TravelFormValues {
  const main = (direction: TravelDirection): MainDraft => {
    const l = legs.find((x) => x.leg === 'main' && x.direction === direction)
    if (!l) return emptyMain
    return {
      id: l.id,
      date: l.date,
      time: l.time ?? '',
      flightRef: l.flightRef ?? '',
      airportCode: l.airportCode ?? '',
      otherDate: (direction === 'arrival' ? l.setOffDate : l.homeDate) ?? '',
      otherTime: (direction === 'arrival' ? l.setOffTime : l.homeTime) ?? '',
    }
  }
  const extras = (direction: TravelDirection): ExtraDraft[] =>
    legs
      .filter((x) => x.leg === 'extra' && x.direction === direction)
      .map((l) => ({
        key: l.id ?? `seed-${direction}-${l.date}`,
        id: l.id,
        title: l.title ?? '',
        date: l.date,
        time: l.time ?? '',
        flightRef: l.flightRef ?? '',
        airportCode: l.airportCode ?? '',
      }))
  return { basedOn, arrival: main('arrival'), departure: main('departure'), before: extras('arrival'), after: extras('departure') }
}

const blank = (v: string) => v.trim() === ''
const orNull = (v: string) => (blank(v) ? null : v.trim())

type Slot = 'arrival' | 'departure' | `before:${number}` | `after:${number}`
interface BuiltLeg {
  slot: Slot
  input: TravelLegInput
}

/** Only legs with something filled in count. A blank section means "none", which is how a leg is removed. */
function buildLegs(values: TravelFormValues): BuiltLeg[] {
  const out: BuiltLeg[] = []
  const main = (direction: TravelDirection, m: MainDraft) => {
    if ([m.date, m.time, m.flightRef, m.airportCode, m.otherDate, m.otherTime].every(blank)) return
    const arrival = direction === 'arrival'
    out.push({
      slot: direction,
      input: {
        id: m.id,
        direction,
        leg: 'main',
        title: null,
        date: m.date.trim(),
        time: orNull(m.time),
        flightRef: orNull(m.flightRef),
        airportCode: orNull(m.airportCode),
        setOffDate: arrival ? orNull(m.otherDate) : null,
        setOffTime: arrival ? orNull(m.otherTime) : null,
        homeDate: arrival ? null : orNull(m.otherDate),
        homeTime: arrival ? null : orNull(m.otherTime),
      },
    })
  }
  const extras = (direction: TravelDirection, list: ExtraDraft[], prefix: 'before' | 'after') => {
    list.forEach((x, i) => {
      if ([x.title, x.date, x.time, x.flightRef].every(blank)) return
      out.push({
        slot: `${prefix}:${i}`,
        input: {
          id: x.id,
          direction,
          leg: 'extra',
          title: orNull(x.title),
          date: x.date.trim(),
          time: orNull(x.time),
          flightRef: orNull(x.flightRef),
          airportCode: orNull(x.airportCode),
          setOffDate: null,
          setOffTime: null,
          homeDate: null,
          homeTime: null,
        },
      })
    })
  }
  main('arrival', values.arrival)
  extras('arrival', values.before, 'before')
  main('departure', values.departure)
  extras('departure', values.after, 'after')
  return out
}

/** Draft comparison ignores the React keys, which differ between a seed and a restored draft. */
function comparable(values: TravelFormValues): string {
  const strip = (list: ExtraDraft[]) => list.map((x) => ({ ...x, key: '' }))
  return JSON.stringify({ ...values, basedOn: '', before: strip(values.before), after: strip(values.after) })
}

function isUsableDraft(v: unknown): v is TravelFormValues {
  const x = v as TravelFormValues | null
  return !!x && typeof x === 'object' && !!x.arrival && !!x.departure && Array.isArray(x.before) && Array.isArray(x.after)
}

type FieldErrors = Partial<Record<TravelLegField, string>>

/**
 * Your own travel: when you get to the trip, when you leave, and any other journeys either side. Every save goes through
 * `set_my_travel`, which replaces your whole set, so a blank section removes that leg.
 */
export function TravelDetailsSheet({ isOpen, onClose, tripId }: TravelDetailsSheetProps) {
  const { user } = useAuth()
  const { showToast } = useToast()
  const queryClient = useQueryClient()
  const { data: trip } = useTrip(tripId)
  const { data: events = [], isSuccess: timelineReady } = useTimeline(tripId)

  const [saving, setSaving] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [revealed, setRevealed] = useState({ arrival: false, departure: false })
  const [seedInfo, setSeedInfo] = useState<{ fp: string; knownIds: string[] } | null>(null)
  const newKey = useRef(0)

  const savedLegs = useMemo(() => (user?.id ? legsFromEvents(events, user.id) : []), [events, user?.id])
  const fingerprint = useMemo(() => (user?.id ? travelFingerprint(events, user.id) : ''), [events, user?.id])
  const ownIds = useMemo(() => (user?.id ? ownTravelRowIds(events, user.id) : []), [events, user?.id])
  const seedValues = useMemo(() => valuesFromLegs(savedLegs, fingerprint), [savedLegs, fingerprint])
  const hadSaved = savedLegs.length > 0

  const draftKey = `travel-details:v2:${tripId}:${user?.id ?? 'anon'}`
  // A half-filled form is easy to lose (for example copying a flight number from an email). A stored draft is reused
  // once at mount, and only if it really differs and was built on the travel that is saved now (see decideTravelSeed).
  // Nothing is written until the form differs from what it was seeded with.
  const seedValuesRef = useRef(seedValues)
  seedValuesRef.current = seedValues
  const seededRef = useRef(false)
  seededRef.current = seedInfo !== null
  const { values, setValues, clearDraft, isRestored } = useFormDraft<TravelFormValues>(draftKey, EMPTY_VALUES, {
    shouldPersist: (v) => seededRef.current && isUsableDraft(v) && comparable(v) !== comparable(seedValuesRef.current),
  })
  const restoredDraftRef = useRef<TravelFormValues | null>(isRestored && isUsableDraft(values) ? values : null)

  useEffect(() => {
    if (!isOpen) {
      setSeedInfo(null)
      setSubmitted(false)
      return
    }
    if (!timelineReady || seedInfo) return
    const draft = restoredDraftRef.current
    restoredDraftRef.current = null
    const differs = !!draft && comparable(draft) !== comparable(seedValues)
    if (decideTravelSeed(draft, fingerprint, differs) === 'live') setValues(seedValues)
    setSeedInfo({ fp: fingerprint, knownIds: ownIds })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, timelineReady, seedInfo])

  const safeValues = isUsableDraft(values) ? values : EMPTY_VALUES
  const isDirty = !!seedInfo && comparable(safeValues) !== comparable(seedValues)
  const { confirmClose, guardProps } = useUnsavedChangesGuard(isOpen && isDirty)
  const handleClose = () => confirmClose(onClose)

  const built = useMemo(() => buildLegs(safeValues), [safeValues])
  const errors = useMemo(() => travelLegErrors(built.map((b) => b.input), trip?.start_date), [built, trip?.start_date])
  const fieldErrors = useMemo(() => {
    const map: Partial<Record<Slot, FieldErrors>> = {}
    const general: string[] = []
    for (const e of errors) {
      const slot = e.index >= 0 ? built[e.index]?.slot : undefined
      if (!slot || !e.field) {
        general.push(e.message)
        continue
      }
      map[slot] = { ...map[slot], [e.field]: map[slot]?.[e.field] ?? e.message }
    }
    return { map, general }
  }, [errors, built])
  const shown = (slot: Slot): FieldErrors => (submitted ? fieldErrors.map[slot] ?? {} : {})

  const nothingToSave = built.length === 0 && !hadSaved
  const canSave = !!seedInfo && !nothingToSave

  const update = (patch: Partial<TravelFormValues>) => setValues({ ...safeValues, ...patch })
  const updateMain = (direction: TravelDirection, patch: Partial<MainDraft>) =>
    update({ [direction]: { ...safeValues[direction], ...patch } } as Partial<TravelFormValues>)
  const updateExtra = (list: 'before' | 'after', index: number, patch: Partial<ExtraDraft>) =>
    update({ [list]: safeValues[list].map((x, i) => (i === index ? { ...x, ...patch } : x)) } as Partial<TravelFormValues>)
  const addExtra = (list: 'before' | 'after') => {
    newKey.current += 1
    update({
      [list]: [...safeValues[list], { key: `new-${newKey.current}`, id: null, title: '', date: '', time: '', flightRef: '', airportCode: '' }],
    } as Partial<TravelFormValues>)
  }
  const removeExtra = (list: 'before' | 'after', index: number) =>
    update({ [list]: safeValues[list].filter((_, i) => i !== index) } as Partial<TravelFormValues>)

  const handleSave = async () => {
    setSubmitted(true)
    if (errors.length > 0) return
    if (!seedInfo) return
    setSaving(true)
    try {
      await setMyTravel(tripId, built.map((b) => b.input), seedInfo.knownIds)
      await queryClient.invalidateQueries({ queryKey: queryKeys.timeline(tripId) })
      clearDraft()
      showToast({ type: 'success', message: 'Travel saved' })
      onClose()
    } catch (err) {
      if ((err as { hint?: unknown } | null)?.hint === 'stale') {
        clearDraft()
        await queryClient.invalidateQueries({ queryKey: queryKeys.timeline(tripId) })
        setSeedInfo(null)
      }
      showToast({ type: 'error', message: "Couldn't save your travel", description: travelSaveErrorMessage(err) })
    } finally {
      setSaving(false)
    }
  }

  const noteFor = (date: string) => {
    if (!trip?.start_date || !trip?.end_date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
    return dateNote(date, trip.start_date, trip.end_date)
  }

  const renderNote = (date: string) => {
    const note = noteFor(date)
    if (!note) return null
    return (
      <p className={`text-sm ${note.tone === 'check' ? 'text-warning-700 dark:text-warning-400' : 'text-[var(--text-muted)]'}`}>
        {note.text}
      </p>
    )
  }

  const renderMain = (direction: TravelDirection) => {
    const m = safeValues[direction]
    const arrival = direction === 'arrival'
    const errs = shown(direction)
    const list = arrival ? 'before' : 'after'
    const extras = safeValues[list]
    const otherOpen = revealed[direction] || !blank(m.otherDate) || !blank(m.otherTime)
    const idBase = `travel-${direction}`
    return (
      <section className="space-y-3" aria-labelledby={`${idBase}-heading`}>
        <h3 id={`${idBase}-heading`} className="text-sm font-semibold text-[var(--text-primary)]">
          {arrival ? 'Getting there' : 'Going home'}
        </h3>
        <div className="grid grid-cols-2 gap-3">
          <Input
            label={arrival ? 'Arrive on' : 'Leave on'}
            type="date"
            value={m.date}
            error={errs.date}
            onChange={(e) => updateMain(direction, { date: e.target.value })}
          />
          <Input
            label="Time (local)"
            type="time"
            value={m.time}
            error={errs.time}
            onChange={(e) => updateMain(direction, { time: e.target.value })}
          />
        </div>
        {renderNote(m.date)}
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Flight or train (optional)"
            value={m.flightRef}
            error={errs.flightRef}
            onChange={(e) => updateMain(direction, { flightRef: e.target.value })}
            placeholder={arrival ? 'BA 2704' : 'BA 2705'}
          />
          <Input
            label="Airport code (optional)"
            value={m.airportCode}
            error={errs.airportCode}
            onChange={(e) => updateMain(direction, { airportCode: e.target.value.toUpperCase().slice(0, 3) })}
            placeholder={arrival ? 'LHR' : 'JFK'}
            maxLength={3}
          />
        </div>

        {otherOpen ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Input
                label={arrival ? 'Set off on' : 'Get home on'}
                type="date"
                value={m.otherDate}
                error={arrival ? errs.setOffDate : errs.homeDate}
                onChange={(e) => updateMain(direction, { otherDate: e.target.value })}
              />
              <Input
                label="Time (local)"
                type="time"
                value={m.otherTime}
                error={arrival ? errs.setOffTime : errs.homeTime}
                onChange={(e) => updateMain(direction, { otherTime: e.target.value })}
              />
            </div>
            {renderNote(m.otherDate)}
          </div>
        ) : (
          <div>
            <Button variant="ghost" size="sm" onClick={() => setRevealed((r) => ({ ...r, [direction]: true }))}>
              {arrival ? 'Set off on an earlier day?' : 'Get home on a later day?'}
            </Button>
          </div>
        )}

        {extras.map((x, i) => {
          const slot = `${list}:${i}` as Slot
          const xe = shown(slot)
          const where = arrival ? 'before' : 'after'
          return (
            <div
              key={x.key}
              role="group"
              aria-label={`Journey ${where} this, number ${i + 1}`}
              className="space-y-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] p-3"
            >
              <Input
                label="What"
                value={x.title}
                error={xe.title}
                maxLength={60}
                placeholder="Flight to Tokyo"
                onChange={(e) => updateExtra(list, i, { title: e.target.value })}
              />
              <div className="grid grid-cols-2 gap-3">
                <Input
                  label="Date"
                  type="date"
                  value={x.date}
                  error={xe.date}
                  onChange={(e) => updateExtra(list, i, { date: e.target.value })}
                />
                <Input
                  label="Time (local)"
                  type="time"
                  value={x.time}
                  error={xe.time}
                  onChange={(e) => updateExtra(list, i, { time: e.target.value })}
                />
              </div>
              {renderNote(x.date)}
              <Input
                label="Flight or train (optional)"
                value={x.flightRef}
                error={xe.flightRef}
                onChange={(e) => updateExtra(list, i, { flightRef: e.target.value })}
              />
              <Button variant="ghost" size="sm" onClick={() => removeExtra(list, i)}>
                Remove
              </Button>
            </div>
          )
        })}

        <div className="flex flex-wrap gap-2">
          {extras.length < MAX_EXTRA && (
            <Button variant="outline" size="sm" onClick={() => addExtra(list)}>
              {arrival ? '＋ Add a journey before this' : '＋ Add a journey after this'}
            </Button>
          )}
          {m.id && (
            <Button variant="ghost" size="sm" onClick={() => updateMain(direction, { ...emptyMain })}>
              {arrival ? 'Remove arrival' : 'Remove departure'}
            </Button>
          )}
        </div>
      </section>
    )
  }

  return (
    <Modal isOpen={isOpen} onClose={handleClose} size="md" title="Your travel">
      <div className="space-y-6">
        <p className="text-sm text-[var(--text-secondary)]">
          When do you get there and when do you leave? Add any other travel too, like a few days in Tokyo on the way.
        </p>

        {renderMain('arrival')}
        {renderMain('departure')}

        {submitted && errors.length > 0 && (
          <div role="alert" className="text-sm text-danger-600 space-y-1">
            <p>Check the highlighted fields, then save again.</p>
            {fieldErrors.general.map((g) => (
              <p key={g}>{g}</p>
            ))}
          </div>
        )}

        <div className="flex justify-end gap-3 pt-4 border-t border-[var(--border-subtle)]">
          <Button variant="ghost" onClick={handleClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} isLoading={saving} disabled={!canSave}>
            Save travel
          </Button>
        </div>
      </div>

      <ConfirmDiscardSheet
        isOpen={guardProps.showConfirm}
        onKeep={guardProps.onKeep}
        onDiscard={() => {
          clearDraft()
          guardProps.onDiscard()
        }}
      />
    </Modal>
  )
}
