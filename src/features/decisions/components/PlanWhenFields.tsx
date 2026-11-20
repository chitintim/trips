import { Input } from '../../../components/ui'
import { dateNote } from '../../../lib/tripWindow'

export interface PlanWhenFieldsProps {
  /** Trip dates, for the quiet note under the day ("3 days before the trip starts."). */
  tripStart?: string
  tripEnd?: string
  date: string
  startTime: string
  onDateChange: (value: string) => void
  onStartTimeChange: (value: string) => void
  disabled?: boolean
}

/**
 * The one small "when" form used wherever something is put on the plan: the
 * Decide sheet's "Put it on the plan" toggle and the item sheet's Put it on the
 * plan. A day, plus an optional time (no time = all day).
 */
export function PlanWhenFields({ tripStart, tripEnd, date, startTime, onDateChange, onStartTimeChange, disabled }: PlanWhenFieldsProps) {
  const note = tripStart && tripEnd && date ? dateNote(date, tripStart, tripEnd) : null
  return (
    <div className="grid grid-cols-2 items-start gap-3">
      <Input label="Day" type="date" value={date} onChange={(e) => onDateChange(e.target.value)} disabled={disabled} helperText={note?.text} required />
      <Input label="Time (optional)" type="time" value={startTime} onChange={(e) => onStartTimeChange(e.target.value)} disabled={disabled} />
    </div>
  )
}
