import { Input } from '../../../components/ui'

export interface PlanWhenFieldsProps {
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
export function PlanWhenFields({ date, startTime, onDateChange, onStartTimeChange, disabled }: PlanWhenFieldsProps) {
  // [&>*]:min-w-0 -- native date/time inputs have a large intrinsic min-content
  // width, so the two-column row overflows a 375px sheet without it.
  return (
    <div className="grid grid-cols-2 gap-3 [&>*]:min-w-0">
      <Input label="Day" type="date" value={date} onChange={(e) => onDateChange(e.target.value)} disabled={disabled} required />
      <Input label="Time (optional)" type="time" value={startTime} onChange={(e) => onStartTimeChange(e.target.value)} disabled={disabled} />
    </div>
  )
}
