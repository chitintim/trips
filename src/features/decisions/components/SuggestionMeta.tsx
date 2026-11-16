import { useState, type FormEvent } from 'react'
import { Button, Input, useToast } from '../../../components/ui'
import { externalHostLabel, safeExternalUrl } from '../../../lib/externalLink'
import { useSuggestOption, useWithdrawSuggestion } from '../../../lib/queries/useSuggestions'
import { SUGGEST_ENTRY_LABEL, SUGGEST_TITLE_MAX, normalizeSuggestionLink, validateSuggestion } from '../lib/suggestOption'

/**
 * "＋ Suggest an option": a quiet row on an open question card that opens a tiny inline form
 * (title, optional link). Who sees it is decided by `canSuggestOption` in the card; the server
 * re-checks everything. The new option shows up in the list straight away (queries invalidate).
 */
export function SuggestOptionRow({ tripId, sectionId, onAdded }: { tripId: string; sectionId: string; onAdded?: () => void }) {
  const { showToast } = useToast()
  const suggest = useSuggestOption(tripId)
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [link, setLink] = useState('')

  const reset = () => {
    setOpen(false)
    setTitle('')
    setLink('')
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const problem = validateSuggestion({ title, link })
    if (problem) {
      showToast({ type: 'error', message: problem })
      return
    }
    suggest.mutate(
      { sectionId, title, link: normalizeSuggestionLink(link) ?? '' },
      {
        onSuccess: () => {
          showToast({ type: 'success', message: 'Option added. Everyone can answer with it now.' })
          reset()
          onAdded?.()
        },
        onError: (err) => showToast({ type: 'error', message: 'Could not add your suggestion', description: err.message }),
      }
    )
  }

  if (!open) {
    return (
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        <span aria-hidden="true">＋ </span>
        {SUGGEST_ENTRY_LABEL}
      </Button>
    )
  }

  return (
    <form onSubmit={submit} className="space-y-2 rounded-[var(--radius-lg)] border border-[var(--border-subtle)] p-3" aria-label={SUGGEST_ENTRY_LABEL}>
      <Input label="Your suggestion" value={title} maxLength={SUGGEST_TITLE_MAX} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Hotel Aurora" autoFocus />
      <Input label="Link (optional)" type="url" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://..." />
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={reset} disabled={suggest.isPending}>
          Cancel
        </Button>
        <Button type="submit" size="sm" isLoading={suggest.isPending}>
          Add option
        </Button>
      </div>
    </form>
  )
}

/** Small, calm "Suggested by Alex" under an option, plus Withdraw for the suggester while it is allowed. */
export function SuggestedMeta({ tripId, optionId, label, canWithdraw, sourceUrl }: { tripId: string; optionId: string; label: string; canWithdraw: boolean; sourceUrl?: string | null }) {
  const href = safeExternalUrl(sourceUrl)
  const host = externalHostLabel(sourceUrl)
  const { showToast } = useToast()
  const withdraw = useWithdrawSuggestion(tripId)
  return (
    <p className="mt-1 flex items-center gap-2 pl-1 text-xs text-[var(--text-muted)]">
      <span>{label}</span>
      {href && host && (
        <a href={href} target="_blank" rel="noopener noreferrer" className="font-medium text-accent-700 underline-offset-2 hover:underline dark:text-accent-300">
          ↗ {host}
        </a>
      )}
      {canWithdraw && (
        <button
          type="button"
          disabled={withdraw.isPending}
          onClick={() =>
            withdraw.mutate(optionId, {
              onSuccess: () => showToast({ type: 'success', message: 'Suggestion withdrawn' }),
              onError: (err) => showToast({ type: 'error', message: 'Could not withdraw this', description: err.message }),
            })
          }
          className="font-medium text-accent-700 underline-offset-2 hover:underline disabled:opacity-60 dark:text-accent-300"
        >
          Withdraw
        </button>
      )}
    </p>
  )
}
