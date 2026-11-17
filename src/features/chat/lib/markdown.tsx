import type { ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { safeHref } from './safeHref'

const ALLOWED = ['p', 'strong', 'em', 'del', 'ul', 'ol', 'li', 'a', 'br', 'code', 'blockquote']

/** Never let react-markdown turn anything into an <img>, <script> or raw HTML: only the elements above are rendered. */
export function ChatMarkdown({ children, className = '' }: { children: string; className?: string }): ReactNode {
  return (
    <div className={`min-w-0 max-w-full break-words space-y-2 ${className}`.trim()}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        skipHtml
        allowedElements={ALLOWED}
        unwrapDisallowed
        urlTransform={(url) => (safeHref(url) ? url : '')}
        components={{
          p: ({ children: c }) => <p className="leading-relaxed">{c}</p>,
          a: ({ href, children: c }) => {
            const safe = safeHref(href)
            if (!safe) return <span>{c}</span>
            return safe.kind === 'external' ? (
              <a href={safe.href} target="_blank" rel="noopener noreferrer nofollow" className="text-accent-700 underline underline-offset-2 break-all dark:text-accent-400">
                {c}
              </a>
            ) : (
              <a href={safe.href} className="text-accent-700 underline underline-offset-2 dark:text-accent-400">
                {c}
              </a>
            )
          },
          ul: ({ children: c }) => <ul className="list-disc space-y-1 pl-5">{c}</ul>,
          ol: ({ children: c }) => <ol className="list-decimal space-y-1 pl-5">{c}</ol>,
          li: ({ children: c }) => <li className="leading-relaxed">{c}</li>,
          strong: ({ children: c }) => <strong className="font-semibold">{c}</strong>,
          code: ({ children: c }) => <code className="rounded bg-[var(--surface-sunken)] px-1 py-0.5 font-mono text-[0.85em]">{c}</code>,
          blockquote: ({ children: c }) => <blockquote className="border-l-2 border-[var(--border-default)] pl-3 italic text-[var(--text-muted)]">{c}</blockquote>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
