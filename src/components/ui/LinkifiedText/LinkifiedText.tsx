import { Fragment } from 'react'
import { useNavigate } from 'react-router-dom'
import { linkifySegments } from '../../../lib/linkify'

export interface LinkifiedTextProps {
  /** Raw plain text (not markdown) — e.g. an action note or a bring-list item title. */
  text: string
  /** Classes on the wrapping element; combine with break-words/min-w-0 discipline at the call site if the container isn't already flex-shrinkable. */
  className?: string
  /** Wrapping element tag — `span` by default (inline within a row), `p` when the note is its own block. */
  as?: 'span' | 'p'
}

/**
 * Renders `text` with any http(s) URLs auto-detected and turned into
 * clickable links, display-shortened to a bare hostname (+ "/…" when
 * there's a path) so a long tracking URL doesn't overflow mobile — the
 * surrounding prose is otherwise untouched. Links into this app itself
 * (trips.fontem.ai deep links, e.g. a note pointing at "?tab=decisions")
 * navigate in-app via react-router instead of opening a new tab, and show a
 * friendly label ("Decisions") instead of the raw URL.
 *
 * Read-only rendering only — the edit textarea for these fields keeps raw
 * text, unlinkified, so it round-trips exactly what the user typed.
 */
export function LinkifiedText({ text, className, as = 'span' }: LinkifiedTextProps) {
  const navigate = useNavigate()
  const segments = linkifySegments(text)
  const Tag = as

  if (segments.length === 0) return null

  return (
    <Tag className={className}>
      {segments.map((segment, i) => {
        if (segment.type === 'text') return <Fragment key={i}>{segment.value}</Fragment>
        if (segment.type === 'internal-link') {
          return (
            <button
              key={i}
              type="button"
              onClick={() => navigate(segment.href)}
              className="text-accent-700 dark:text-accent-400 underline underline-offset-2 hover:text-accent-600"
            >
              {segment.label}
            </button>
          )
        }
        return (
          <a
            key={i}
            href={segment.href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent-700 dark:text-accent-400 underline underline-offset-2 break-all hover:text-accent-600"
          >
            {segment.label}
          </a>
        )
      })}
    </Tag>
  )
}
