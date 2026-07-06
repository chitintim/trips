import { useMemo, useState } from 'react'
import { Badge, Button, Card, Deadline, EmptyState, SegmentedControl } from '../../../components/ui'
import { useAuth } from '../../../hooks/useAuth'
import { useUpdateSection } from '../../../lib/queries/usePlanning'
import type { SectionWithOptions, OptionVote, Reaction, Comment } from '../../../lib/queries/usePlanning'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'
import { useTripActivityLog } from '../../organizer/lib/activity'
import { OptionCard } from './OptionCard'
import { MatrixView } from './MatrixView'
import { sectionHasMatrixLayout } from '../lib/optionMetadata'
import { getSectionRunningTotal } from '../lib/costImpact'
import { tallyVotes, getWinner, checkAutoClose, type VotingMethod } from '../lib/voting'

interface SectionCardProps {
  tripId: string
  section: SectionWithOptions
  votes: OptionVote[]
  reactions: Reaction[]
  comments: Comment[]
  participants: ParticipantWithUser[]
  confirmedCount: number
  isOrganizer: boolean
  onAddOption: () => void
  onEditOption: (optionId: string) => void
  onAddFromLink: () => void
}

export function SectionCard({
  tripId,
  section,
  votes,
  reactions,
  comments,
  participants,
  confirmedCount,
  isOrganizer,
  onAddOption,
  onEditOption,
  onAddFromLink,
}: SectionCardProps) {
  const { user } = useAuth()
  const updateSection = useUpdateSection(tripId)
  const logActivity = useTripActivityLog(tripId)
  const [view, setView] = useState<'list' | 'matrix'>(sectionHasMatrixLayout(section.options) ? 'matrix' : 'list')

  const votingMethod = (section.voting_method as VotingMethod) || 'single'
  const optionIds = section.options.map((o) => o.id)
  const sectionVotes = votes.filter((v) => optionIds.includes(v.option_id))

  const tallies = useMemo(() => tallyVotes(optionIds, sectionVotes, votingMethod), [optionIds, sectionVotes, votingMethod])
  const winner = getWinner(tallies)
  const winnerOption = winner ? section.options.find((o) => o.id === winner.optionId) : null

  const distinctVoters = new Set(sectionVotes.map((v) => v.user_id)).size
  const autoClose = checkAutoClose({ vote_deadline: section.vote_deadline, quorum: section.quorum }, distinctVoters)

  const runningTotals = getSectionRunningTotal(
    section.options.map((o) => ({ price: o.price, currency: o.currency, price_type: o.price_type, status: o.status })),
    confirmedCount,
    null,
    optionIds
  )

  const myRankByOption = new Map(
    sectionVotes.filter((v) => v.user_id === user?.id && v.rank != null).map((v) => [v.option_id, v.rank as number])
  )

  const hasMatrixOptions = sectionHasMatrixLayout(section.options)

  return (
    <Card>
      <Card.Content className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="font-semibold text-[var(--text-primary)]">{section.title}</h3>
            {section.description && <p className="text-sm text-[var(--text-secondary)] mt-0.5">{section.description}</p>}
          </div>
          <Badge variant={section.status === 'completed' ? 'success' : section.status === 'in_progress' ? 'warning' : 'neutral'} size="sm">
            {section.status.replace('_', ' ')}
          </Badge>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {section.vote_deadline && <Deadline date={section.vote_deadline} kind="vote" size="sm" />}
          {section.quorum != null && (
            <Badge variant="neutral" size="sm">
              Quorum {distinctVoters}/{section.quorum}
            </Badge>
          )}
          {Object.entries(runningTotals).map(([currency, total]) => (
            <Badge key={currency} variant="info" size="sm">
              ~{currency} {total.toFixed(0)}/person running total
            </Badge>
          ))}
        </div>

        {autoClose.shouldClose && section.status !== 'completed' && (
          <div className="bg-warn-50 border border-warn-200 rounded-[var(--radius-md)] p-3 flex items-center justify-between gap-3 flex-wrap">
            <p className="text-sm text-warn-800">
              {autoClose.reason === 'deadline_passed' ? 'Voting deadline has passed' : 'Quorum has been met'}
              {winnerOption ? ` — leading option: ${winnerOption.title}` : ' — no votes yet'}.
            </p>
            {isOrganizer && (
              <Button
                size="sm"
                onClick={() => {
                  updateSection.mutate({ id: section.id, update: { status: 'completed' } })
                  logActivity({ verb: 'poll_closed', entity: { type: 'section', id: section.id, label: section.title } })
                }}
                isLoading={updateSection.isPending}
              >
                Close & confirm winner
              </Button>
            )}
          </div>
        )}

        {hasMatrixOptions && (
          <SegmentedControl
            size="sm"
            value={view}
            onChange={setView}
            options={[
              { value: 'list', label: 'List' },
              { value: 'matrix', label: 'Matrix' },
            ]}
          />
        )}

        {section.options.length === 0 ? (
          <EmptyState
            compact
            icon="🗳️"
            title="No options yet"
            action={
              isOrganizer ? (
                <Button size="sm" onClick={onAddOption}>
                  Add first option
                </Button>
              ) : undefined
            }
          />
        ) : view === 'matrix' && hasMatrixOptions ? (
          <MatrixView tripId={tripId} options={section.options} currency={section.options[0]?.currency || 'GBP'} />
        ) : (
          <div className="space-y-3">
            {section.options.map((option) => (
              <OptionCard
                key={option.id}
                tripId={tripId}
                option={option}
                votes={votes}
                reactions={reactions}
                comments={comments}
                participants={participants}
                votingMethod={votingMethod}
                hideVotesUntilClose={section.hide_votes_until_close}
                voteDeadline={section.vote_deadline}
                confirmedCount={confirmedCount}
                myRank={myRankByOption.get(option.id) ?? null}
                canEdit={isOrganizer}
                onEdit={() => onEditOption(option.id)}
              />
            ))}
          </div>
        )}

        {isOrganizer && section.options.length > 0 && (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onAddOption}>
              + Add option
            </Button>
            <Button variant="outline" size="sm" onClick={onAddFromLink}>
              📎 From a link
            </Button>
          </div>
        )}
      </Card.Content>
    </Card>
  )
}
