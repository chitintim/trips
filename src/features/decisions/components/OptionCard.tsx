import { useMemo, useState } from 'react'
import { Badge, Button, Chip, SelectionAvatars, UserAvatar, TextArea } from '../../../components/ui'
import { useAuth } from '../../../hooks/useAuth'
import { useToggleVote, useToggleReaction, useCreateComment } from '../../../lib/queries/usePlanning'
import type { OptionWithSelections, OptionVote, Reaction, Comment } from '../../../lib/queries/usePlanning'
import type { ParticipantWithUser } from '../../../lib/queries/useTrip'
import { formatCostImpact } from '../lib/costImpact'
import { areVotesVisible, type VotingMethod } from '../lib/voting'

const QUICK_REACTIONS = ['🙌', '😬', '💸', '❤️', '👀']

interface OptionCardProps {
  tripId: string
  option: OptionWithSelections
  votes: OptionVote[]
  reactions: Reaction[]
  comments: Comment[]
  participants: ParticipantWithUser[]
  votingMethod: VotingMethod
  hideVotesUntilClose: boolean
  voteDeadline: string | null
  confirmedCount: number
  /** For ranked voting: this option's current rank in the user's ballot, if any. */
  myRank?: number | null
  onEdit?: () => void
  canEdit: boolean
}

function userLabel(p: ParticipantWithUser | undefined): string {
  return p?.user?.full_name || p?.user?.email || 'Someone'
}

export function OptionCard({
  tripId,
  option,
  votes,
  reactions,
  comments,
  participants,
  votingMethod,
  hideVotesUntilClose,
  voteDeadline,
  confirmedCount,
  myRank,
  onEdit,
  canEdit,
}: OptionCardProps) {
  const { user } = useAuth()
  const toggleVote = useToggleVote(tripId)
  const toggleReaction = useToggleReaction(tripId)
  const createComment = useCreateComment(tripId)

  const [showComments, setShowComments] = useState(false)
  const [commentDraft, setCommentDraft] = useState('')

  const byUserId = useMemo(() => new Map(participants.map((p) => [p.user_id, p])), [participants])

  const optionVotes = votes.filter((v) => v.option_id === option.id)
  const myVote = optionVotes.find((v) => v.user_id === user?.id)
  const votesVisible = areVotesVisible({ vote_deadline: voteDeadline, hide_votes_until_close: hideVotesUntilClose })

  const optionReactions = reactions.filter((r) => r.option_id === option.id)
  const reactionCounts = new Map<string, number>()
  optionReactions.forEach((r) => reactionCounts.set(r.emoji, (reactionCounts.get(r.emoji) || 0) + 1))
  const myReactions = new Set(optionReactions.filter((r) => r.user_id === user?.id).map((r) => r.emoji))

  const optionComments = comments.filter((c) => c.option_id === option.id)

  const costImpact = formatCostImpact({
    price: option.price,
    currency: option.currency,
    priceType: option.price_type,
    confirmedCount,
  })

  const handleVote = () => {
    if (!user) return
    if (myVote) {
      toggleVote.mutate({ optionId: option.id, userId: user.id, action: 'remove', voteId: myVote.id })
    } else {
      toggleVote.mutate({ optionId: option.id, userId: user.id, action: 'add' })
    }
  }

  const handleReaction = (emoji: string) => {
    if (!user) return
    const existing = optionReactions.find((r) => r.user_id === user.id && r.emoji === emoji)
    if (existing) {
      toggleReaction.mutate({ targetType: 'option', targetId: option.id, userId: user.id, emoji, action: 'remove', reactionId: existing.id })
    } else {
      toggleReaction.mutate({ targetType: 'option', targetId: option.id, userId: user.id, emoji, action: 'add' })
    }
  }

  const handleAddComment = () => {
    if (!user || !commentDraft.trim()) return
    createComment.mutate({ option_id: option.id, user_id: user.id, content: commentDraft.trim() })
    setCommentDraft('')
  }

  return (
    <div className="border border-[var(--border-default)] rounded-[var(--radius-md)] p-4 space-y-3 bg-[var(--surface-raised)]">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className="font-semibold text-[var(--text-primary)]">{option.title}</h4>
            {option.locked && (
              <Badge variant="neutral" size="sm">
                🔒 Locked
              </Badge>
            )}
          </div>
          {option.description && <p className="text-sm text-[var(--text-secondary)] mt-0.5">{option.description}</p>}
          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            {option.price != null && (
              <span className="text-sm font-medium text-[var(--text-primary)]">
                {option.currency} {option.price.toFixed(2)}
              </span>
            )}
            {costImpact && (
              <Badge variant="info" size="sm">
                {costImpact}
              </Badge>
            )}
          </div>
        </div>
        {canEdit && onEdit && (
          <Button variant="ghost" size="sm" onClick={onEdit}>
            Edit
          </Button>
        )}
      </div>

      {/* Voting */}
      <div className="flex items-center gap-3 flex-wrap">
        {votingMethod === 'ranked' ? (
          <Button
            variant={myRank ? 'primary' : 'outline'}
            size="sm"
            onClick={handleVote}
            disabled={option.locked}
            isLoading={toggleVote.isPending}
          >
            {myRank ? `Ranked #${myRank}` : 'Tap to rank next'}
          </Button>
        ) : (
          <Button
            variant={myVote ? 'primary' : 'outline'}
            size="sm"
            onClick={handleVote}
            disabled={option.locked}
            isLoading={toggleVote.isPending}
          >
            {myVote ? '✓ Voted' : votingMethod === 'approval' ? 'Approve' : 'Vote'}
          </Button>
        )}

        {votesVisible ? (
          optionVotes.length > 0 && (
            <SelectionAvatars
              selections={optionVotes.map((v) => ({
                id: v.id,
                user: byUserId.get(v.user_id)?.user
                  ? {
                      full_name: byUserId.get(v.user_id)!.user!.full_name ?? undefined,
                      email: byUserId.get(v.user_id)!.user!.email ?? undefined,
                      avatar_url: byUserId.get(v.user_id)!.user!.avatar_url ?? undefined,
                      avatar_data: (byUserId.get(v.user_id)!.user!.avatar_data as { emoji: string; bgColor: string } | null) ?? undefined,
                    }
                  : undefined,
              }))}
              maxAvatars={4}
              size="sm"
            />
          )
        ) : (
          <span className="text-xs text-[var(--text-muted)]">
            {optionVotes.length} vote{optionVotes.length === 1 ? '' : 's'} (hidden until close)
          </span>
        )}
      </div>

      {/* Reactions */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {QUICK_REACTIONS.map((emoji) => {
          const count = reactionCounts.get(emoji) || 0
          const mine = myReactions.has(emoji)
          return (
            <Chip key={emoji} size="sm" selected={mine} onClick={() => handleReaction(emoji)}>
              {emoji} {count > 0 ? count : ''}
            </Chip>
          )
        })}
        <button
          type="button"
          onClick={() => setShowComments((s) => !s)}
          className="text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] ml-1"
        >
          💬 {optionComments.length > 0 ? optionComments.length : 'Comment'}
        </button>
      </div>

      {showComments && (
        <div className="space-y-2 pt-2 border-t border-[var(--border-subtle)]">
          {optionComments.map((c) => {
            const author = byUserId.get(c.user_id)
            return (
              <div key={c.id} className="flex items-start gap-2">
                <UserAvatar avatarData={author?.user} size="xs" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-[var(--text-secondary)]">{userLabel(author)}</p>
                  <p className="text-sm text-[var(--text-primary)]">{c.content}</p>
                </div>
              </div>
            )
          })}
          <div className="flex gap-2">
            <TextArea
              value={commentDraft}
              onChange={(e) => setCommentDraft(e.target.value)}
              placeholder="Add a comment..."
              rows={1}
              fullWidth
            />
            <Button size="sm" onClick={handleAddComment} disabled={!commentDraft.trim()} isLoading={createComment.isPending}>
              Send
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
