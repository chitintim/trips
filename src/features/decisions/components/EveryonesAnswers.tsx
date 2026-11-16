import { useMemo, useState } from 'react'
import { Badge, Button, useToast } from '../../../components/ui'
import type { OptionVoteWithUser, QuestionPass, SectionWithOptions } from '../../../lib/queries/usePlanning'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'
import { areResultsVisible } from '../lib/answerModel'
import { sectionHasMatrixLayout } from '../lib/optionMetadata'
import { formatMoney } from '../lib/costImpact'
import { ordinal, RESULTS_HIDDEN } from '../lib/answerCopy'
import { buildAnswersText, buildEveryonesAnswers, type PersonAnswerRow } from '../lib/everyonesAnswers'
import { MatrixView } from './MatrixView'

export interface EveryonesAnswersProps {
  section: SectionWithOptions
  participants: ParticipantWithUser[]
  votes: OptionVoteWithUser[]
  passes: ReadonlyArray<QuestionPass>
  fallbackCurrency: string
  /**
   * Read-only view for ordinary participants (QuestionCard's "See what everyone
   * chose"). It shows who chose what, never prices, per-item totals, the group
   * total or the copy button, and shows nothing about choices while the
   * question's visibility rule hides them. Organisers (Manage sheet) leave this off.
   */
  participantView?: boolean
}

function lineDates(start: string | null, end: string | null): string {
  if (!start && !end) return ''
  if (!end || start === end) return start ?? ''
  return `${start} – ${end}`
}

function NameList({ names }: { names: string[] }) {
  return <span className="min-w-0 break-words text-sm text-[var(--text-secondary)]">{names.join(', ')}</span>
}

/**
 * "See everyone's answers": who answered what and who has not, for group
 * choices (including ranked) and own choices (per person lines, per item
 * totals, group total, copy-to-clipboard). Grid-layout own choices (legacy
 * ski rental) also get the grid. Read-only. Shown to organisers regardless of
 * the "hide results" setting, and says so.
 */
export function EveryonesAnswers({ section, participants, votes, passes, fallbackCurrency, participantView = false }: EveryonesAnswersProps) {
  const { showToast } = useToast()
  const [copied, setCopied] = useState(false)
  const data = useMemo(
    () =>
      buildEveryonesAnswers({
        section,
        votes,
        passes,
        participants,
        fallbackCurrency,
      }),
    [section, votes, passes, participants, fallbackCurrency]
  )
  const total = data.people.length
  const done = data.answeredCount + data.passedCount
  const hidden = section.status !== 'completed' && !areResultsVisible(section)
  const lockedForViewer = participantView && hidden
  const nameOf = (id: string) => data.people.find((p) => p.userId === id)?.name ?? 'Someone'
  const hasGrid = data.shape === 'own' && sectionHasMatrixLayout(section.options)
  const activeOptions = section.options.filter((o) => o.status !== 'cancelled')

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(buildAnswersText(section.title, data, fallbackCurrency))
      setCopied(true)
      showToast({ type: 'success', message: 'Answers copied' })
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      showToast({
        type: 'error',
        message: 'Could not copy to clipboard',
        description: (err as Error).message,
      })
    }
  }

  const totalsText =
    Object.entries(data.groupTotals)
      .map(([c, n]) => formatMoney(n, c))
      .join(' + ') || formatMoney(0, fallbackCurrency)

  return (
    <div className="min-w-0 space-y-4">
      <p className="text-sm text-[var(--text-secondary)]">
        {done} of {total} {data.shape === 'own' ? 'done' : 'answered'}
        {data.passedCount > 0 ? ` (${data.passedCount} with ${data.shape === 'own' ? 'None for me' : 'No preference'})` : ''}
      </p>
      {hidden && (
        <p className="text-xs text-[var(--text-muted)]">
          {RESULTS_HIDDEN}
          {participantView ? '' : ' Only organisers can see this until then.'}
        </p>
      )}
      {lockedForViewer ? null : (
        <>
          {hasGrid && !participantView && <MatrixView options={activeOptions} currency={fallbackCurrency} />}

          {data.shape === 'group' && (
            <ul className="space-y-2" aria-label="Answers by option">
              {data.perOption
                .filter((o) => !o.cancelled || o.count > 0)
                .map((o) => {
                  const names = data.ranked
                    ? data.people
                        .filter((p) => p.optionIds.includes(o.optionId))
                        .map((p) => `${nameOf(p.userId)} (${ordinal(p.ranks[o.optionId] ?? p.optionIds.indexOf(o.optionId) + 1)})`)
                    : o.userIds.map(nameOf)
                  return (
                    <li key={o.optionId} className="min-w-0 rounded-[var(--radius-lg)] border border-[var(--border-default)] p-3">
                      <div className="flex items-start justify-between gap-2">
                        <span className="min-w-0 break-words text-sm font-medium text-[var(--text-primary)]">{o.title}</span>
                        <Badge variant={o.count > 0 ? 'info' : 'neutral'} size="sm">
                          {o.count === 1 ? '1 person' : `${o.count} people`}
                        </Badge>
                      </div>
                      {names.length > 0 && (
                        <div className="mt-1">
                          <NameList names={names} />
                        </div>
                      )}
                    </li>
                  )
                })}
            </ul>
          )}

          {data.shape === 'own' && (
            <>
              {data.people.some((p) => p.state !== 'waiting') && (
                <ul className="space-y-2" aria-label="Answers by person">
                  {data.people
                    .filter((p) => p.state !== 'waiting')
                    .map((p) => (
                      <PersonLines key={p.userId} person={p} showMoney={!participantView} />
                    ))}
                </ul>
              )}
              {!participantView && (
                <>
                  <div className="space-y-1.5 rounded-[var(--radius-lg)] bg-[var(--surface-sunken)] p-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Totals</p>
                    {data.itemTotals.length === 0 ? (
                      <p className="text-sm text-[var(--text-muted)]">No answers yet.</p>
                    ) : (
                      data.itemTotals.map((t) => (
                        <div key={t.optionId} className="flex items-center justify-between gap-3 text-sm">
                          <span className="min-w-0 break-words text-[var(--text-secondary)]">
                            {t.title} ({t.quantity})
                          </span>
                          <span className="shrink-0 font-medium text-[var(--text-primary)]">{formatMoney(t.total, t.currency)}</span>
                        </div>
                      ))
                    )}
                    <div className="flex items-center justify-between gap-3 border-t border-[var(--border-default)] pt-1.5 text-sm">
                      <span className="font-semibold text-[var(--text-primary)]">Group total</span>
                      <span className="font-semibold text-[var(--text-primary)]">{totalsText}</span>
                    </div>
                  </div>
                  <div className="flex justify-end">
                    <Button variant="outline" size="sm" onClick={handleCopy}>
                      {copied ? '✓ Copied' : 'Copy answers'}
                    </Button>
                  </div>
                </>
              )}
            </>
          )}

          {data.shape === 'group' && data.passedCount > 0 && (
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">No preference</p>
              <NameList names={data.people.filter((p) => p.state === 'passed').map((p) => p.name)} />
            </div>
          )}

          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Not answered yet ({data.waiting.length})</p>
            {data.waiting.length === 0 ? (
              <p className="text-sm text-[var(--text-secondary)]">Everyone has answered.</p>
            ) : (
              <NameList names={data.waiting.map((w) => w.name)} />
            )}
          </div>
        </>
      )}
    </div>
  )
}

function PersonLines({ person, showMoney = true }: { person: PersonAnswerRow; showMoney?: boolean }) {
  return (
    <li className="min-w-0 rounded-[var(--radius-lg)] border border-[var(--border-default)] p-3">
      <p className="break-words text-sm font-medium text-[var(--text-primary)]">{person.name}</p>
      {person.state === 'passed' ? (
        <p className="text-sm text-[var(--text-secondary)]">{person.passLabel}</p>
      ) : (
        <ul className="mt-0.5 space-y-0.5">
          {person.lines.map((l, i) => (
            <li key={`${l.optionId}-${i}`} className="flex items-start justify-between gap-3 text-sm text-[var(--text-secondary)]">
              <span className="min-w-0 break-words">
                {l.optionTitle}
                {l.variant ? ` (${l.variant})` : ''}
                {l.quantity > 1 ? ` x${l.quantity}` : ''}
                {lineDates(l.startDate, l.endDate) ? ` · ${lineDates(l.startDate, l.endDate)}` : ''}
              </span>
              {showMoney && <span className="shrink-0 font-medium text-[var(--text-primary)]">{formatMoney(l.total, l.currency)}</span>}
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}
