import { Button, Chip, Input, SegmentedControl, Select, TextArea } from '../../../../components/ui'
import { PlaceChip } from '../../../places'
import { FREQUENT_CURRENCIES } from '../../../../lib/money'
import type { Tables } from '../../../../types/database.types'
import type { HappeningValues } from '../../lib/addFlow'
import { MoreOptions } from './MoreOptions'
import { TitleField } from './TitleField'

export interface Attendee {
  id: string
  name: string
}

interface HappeningFormProps {
  values: HappeningValues
  onChange: (patch: Partial<HappeningValues>) => void
  pickedPlace: Tables<'places'> | null
  onPickPlace: () => void
  onClearPlace: () => void
  attendees: Attendee[]
  onPullLink: (url: string) => void
}

/** Minimum: what + day. Everything else is under More options. */
export function HappeningForm({ values, onChange, pickedPlace, onPickPlace, onClearPlace, attendees, onPullLink }: HappeningFormProps) {
  const toggleAttendee = (id: string) =>
    onChange({ attendeeIds: values.attendeeIds.includes(id) ? values.attendeeIds.filter((a) => a !== id) : [...values.attendeeIds, id] })
  return (
    <div className="space-y-4">
      <TitleField label="What" value={values.title} onChange={(title) => onChange({ title })} placeholder="e.g. Dinner at Kumo" onPullLink={onPullLink} autoFocus />
      <Input label="Day" type="date" value={values.day} onChange={(e) => onChange({ day: e.target.value })} required />

      <MoreOptions>
        <label className="flex min-h-[44px] cursor-pointer items-center gap-2">
          <input type="checkbox" checked={values.hasTime} onChange={(e) => onChange({ hasTime: e.target.checked })} className="h-5 w-5 accent-accent-600" />
          <span className="text-sm text-[var(--text-primary)]">At a set time (otherwise it’s all day)</span>
        </label>
        {values.hasTime && (
          <div className="grid grid-cols-2 gap-3">
            <Input label="Starts" type="time" value={values.startTime} onChange={(e) => onChange({ startTime: e.target.value })} />
            <Input label="Ends (optional)" type="time" value={values.endTime} onChange={(e) => onChange({ endTime: e.target.value })} />
          </div>
        )}

        <div>
          <span className="mb-1.5 block text-sm font-medium text-[var(--text-primary)]">Place (optional)</span>
          {pickedPlace ? (
            <div className="flex items-center gap-2">
              <PlaceChip place={pickedPlace} compact />
              <Button variant="ghost" size="sm" onClick={onClearPlace}>
                Remove
              </Button>
            </div>
          ) : (
            <Button variant="secondary" size="sm" onClick={onPickPlace}>
              📍 Add a place
            </Button>
          )}
        </div>

        <div className="space-y-2">
          <span className="block text-sm font-medium text-[var(--text-primary)]">Cost (optional)</span>
          <div className="grid grid-cols-[1fr_auto] gap-3">
            <Input aria-label="Cost" type="number" inputMode="decimal" min="0" value={values.costAmount} onChange={(e) => onChange({ costAmount: e.target.value })} placeholder="0.00" />
            <Select
              aria-label="Currency"
              value={values.costCurrency}
              onChange={(e) => onChange({ costCurrency: e.target.value })}
              options={Array.from(new Set([values.costCurrency, ...FREQUENT_CURRENCIES])).map((c) => ({ value: c, label: c }))}
            />
          </div>
          {values.costAmount.trim() !== '' && (
            <SegmentedControl
              fullWidth
              size="sm"
              value={values.costBasis}
              onChange={(costBasis) => onChange({ costBasis })}
              options={[
                { value: 'each', label: 'Each person' },
                { value: 'total_split', label: 'Total for the group' },
              ]}
            />
          )}
        </div>

        <TextArea label="Notes (optional)" value={values.notes} onChange={(e) => onChange({ notes: e.target.value })} rows={2} />

        {attendees.length > 1 && (
          <div>
            <span className="mb-1.5 block text-sm font-medium text-[var(--text-primary)]">Who’s going</span>
            <p className="mb-2 text-xs text-[var(--text-muted)]">{values.attendeeIds.length === 0 ? 'Everyone. Tap names to pick just some people.' : `${values.attendeeIds.length} chosen`}</p>
            <div className="flex flex-wrap gap-2">
              {attendees.map((a) => (
                <Chip key={a.id} selected={values.attendeeIds.includes(a.id)} onClick={() => toggleAttendee(a.id)}>
                  {a.name}
                </Chip>
              ))}
            </div>
          </div>
        )}
      </MoreOptions>
    </div>
  )
}
