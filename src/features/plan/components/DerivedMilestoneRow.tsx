import { Button } from '../../../components/ui'
import type { DerivedMilestone } from '../lib/derivedMilestones'

export interface DerivedMilestoneRowProps {
  milestone: DerivedMilestone
  onMaterialize: (milestone: DerivedMilestone) => void
  isMaterializing?: boolean
  /**
   * Gates the "+ Make it an event" button (developer call: the row itself
   * is informative for every participant, but turning it into a real,
   * editable plan item is an organizer action — the same tier that edits
   * vote-shape options/sections elsewhere in this board). Defaults to true
   * so any test/story that doesn't pass it keeps the old always-visible
   * behavior.
   */
  canMaterialize?: boolean
}

const MATERIALIZE_HINT = 'Added automatically from your trip dates — not yet a real plan item'

/**
 * One date-derived system row (UX_REDESIGN.md Part 3 "Date-derived
 * presets"): rendered from trip/booking data, never stored. Deliberately a
 * plain low-chrome row (no border, no card shadow, no border-dashed
 * treatment — that's PlanItemCard's "idea" styling, and this must read as
 * unmistakably system-generated rather than a real plan item) with a small
 * "Auto" hint (title tooltip explains what that means) plus, for
 * organizers, a "+ Make it an event" affordance that materializes it via
 * the existing create-event mutation. Once materialized, the
 * metadata.derived_key this row wrote onto the real event causes
 * deriveMilestones() to stop producing this row (see derivedMilestones.ts's
 * materializedDerivedKeys).
 */
export function DerivedMilestoneRow({ milestone, onMaterialize, isMaterializing, canMaterialize = true }: DerivedMilestoneRowProps) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-[var(--radius-md)] px-3 py-2 bg-[var(--surface-page)] text-[var(--text-muted)]">
      <div className="min-w-0 flex items-center gap-2">
        <span aria-hidden="true" className="text-sm opacity-70">
          {milestone.emoji}
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <p className="text-sm truncate">
              {milestone.title}
              {milestone.subtitle && <span className="text-xs"> · {milestone.subtitle}</span>}
            </p>
            <span
              className="shrink-0 text-[10px] font-medium uppercase tracking-wide opacity-60 cursor-help"
              title={MATERIALIZE_HINT}
            >
              Auto
            </span>
          </div>
          {milestone.isSpan && (
            <p className="text-xs opacity-80">
              {milestone.date} → {milestone.endDate}
            </p>
          )}
        </div>
      </div>
      {canMaterialize && (
        <Button variant="ghost" size="sm" onClick={() => onMaterialize(milestone)} isLoading={isMaterializing}>
          + Make it an event
        </Button>
      )}
    </div>
  )
}
