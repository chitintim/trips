import { SelectionAvatars } from '../../../components/ui'
import type { OptionWithSelections } from '../../../lib/queries/usePlanning'
import { readOptionMetadata, getMatrixAxes } from '../lib/optionMetadata'

interface MatrixViewProps {
  /** Kept so existing callers compile; the grid no longer writes anything. */
  tripId?: string
  options: OptionWithSelections[]
  currency?: string
}

function isOptOut(title: string): boolean {
  const t = title.toLowerCase()
  return t.includes('not renting') || t.includes('own equipment')
}

/**
 * "Everyone's answers" grid for tiered / grid-layout own-choice questions
 * (the legacy ski-rental pattern): rows x columns of options, each cell
 * showing how many people picked it and who. READ-ONLY. It is a view for the
 * organiser inside the Manage sheet; people answer with the one AnswerControl
 * (the old tap-a-cell-to-pick popover wrote `selections` directly and is
 * gone). There never was an "answer on someone's behalf" control here, so none
 * is offered.
 */
export function MatrixView({ options, currency = 'GBP' }: MatrixViewProps) {
  const { rows, columns } = getMatrixAxes(options)
  const cellMap = new Map<string, OptionWithSelections>()
  options.forEach((opt) => {
    const meta = readOptionMetadata(opt.metadata)
    if (meta.grid_row && meta.grid_column) cellMap.set(`${meta.grid_row}|${meta.grid_column}`, opt)
  })
  const optOut = options.find((opt) => isOptOut(opt.title))

  return (
    <div className="min-w-0 space-y-3">
      <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Everyone's answers, grid">
        <table className="w-full min-w-[400px] border-collapse">
          <caption className="sr-only">Number of people who chose each option, by row and column</caption>
          <thead>
            <tr>
              <th scope="col" className="rounded-tl-[var(--radius-md)] bg-[var(--surface-sunken)] p-2 text-left text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
                Level
              </th>
              {columns.map((col, i) => (
                <th
                  key={col}
                  scope="col"
                  className={`bg-[var(--surface-sunken)] p-2 text-center text-xs font-medium uppercase tracking-wide text-[var(--text-muted)] ${i === columns.length - 1 ? 'rounded-tr-[var(--radius-md)]' : ''}`}
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row}>
                <th scope="row" className="border-t border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-2 text-left text-sm font-medium text-[var(--text-primary)]">
                  {row}
                </th>
                {columns.map((col) => {
                  const option = cellMap.get(`${row}|${col}`)
                  if (!option) {
                    return (
                      <td key={col} className="border-t border-[var(--border-subtle)] p-1">
                        <div className="p-2 text-center text-xs text-[var(--text-muted)]" aria-label="Not offered">
                          —
                        </div>
                      </td>
                    )
                  }
                  const n = option.selections.length
                  return (
                    <td key={col} className="border-t border-[var(--border-subtle)] p-1">
                      <div className="rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--surface-raised)] p-2 text-center">
                        <div className="sr-only">{option.title}</div>
                        {option.price != null && (
                          <div className="text-sm font-semibold text-[var(--text-primary)]">
                            {option.currency || currency} {option.price.toFixed(0)}
                          </div>
                        )}
                        <div className={`text-xs ${n > 0 ? 'font-medium text-[var(--text-primary)]' : 'text-[var(--text-muted)]'}`}>
                          {n === 0 ? 'No one' : n === 1 ? '1 person' : `${n} people`}
                        </div>
                        {n > 0 && (
                          <div className="mt-1 flex justify-center">
                            <SelectionAvatars selections={toAvatars(option)} maxAvatars={3} size="sm" entityLabel="chose this" />
                          </div>
                        )}
                      </div>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {optOut && (
        <div className="flex min-w-0 items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--surface-raised)] p-3">
          <span className="min-w-0 break-words text-sm font-medium text-[var(--text-primary)]">{optOut.title}</span>
          <span className="shrink-0 text-xs text-[var(--text-secondary)]">
            {optOut.selections.length === 1 ? '1 person' : `${optOut.selections.length} people`}
          </span>
        </div>
      )}
    </div>
  )
}

function toAvatars(option: OptionWithSelections) {
  return option.selections.map((s) => ({
    id: s.id,
    user: s.user
      ? {
          full_name: s.user.full_name ?? undefined,
          email: s.user.email ?? undefined,
          avatar_url: s.user.avatar_url ?? undefined,
          avatar_data: (s.user.avatar_data as { emoji: string; bgColor: string } | null) ?? undefined,
        }
      : undefined,
  }))
}
