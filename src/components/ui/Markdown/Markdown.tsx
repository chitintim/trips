import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'

export interface MarkdownProps {
  /** Raw markdown source. */
  children: string
  /** Extra classes on the wrapper (spacing/typography context, e.g. `text-sm`). */
  className?: string
}

/**
 * Shared markdown renderer (notes/announcements, and any future markdown
 * surface). The app has no @tailwindcss/typography plugin, so the `prose`
 * classes previously sprinkled on ReactMarkdown wrappers were inert — with
 * Tailwind's preflight reset that meant lists lost their bullets, headings
 * rendered at body size and links were unstyled, i.e. markdown looked like
 * raw text. This component styles each rendered element explicitly instead
 * (theme-aware via the design-token CSS variables), so markdown reads as
 * markdown everywhere without a plugin.
 *
 * GFM + hard line breaks match the previous NoteCard behavior. Wide content
 * (tables, code blocks) scrolls inside its own container rather than
 * spilling out of the card on mobile.
 */
export function Markdown({ children, className = '' }: MarkdownProps) {
  return (
    <div className={`min-w-0 max-w-full break-words space-y-2 ${className}`.trim()}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          h1: ({ children }) => <h1 className="text-lg font-semibold text-[var(--text-primary)]">{children}</h1>,
          h2: ({ children }) => <h2 className="text-base font-semibold text-[var(--text-primary)]">{children}</h2>,
          h3: ({ children }) => <h3 className="text-sm font-semibold text-[var(--text-primary)]">{children}</h3>,
          h4: ({ children }) => <h4 className="text-sm font-semibold text-[var(--text-secondary)]">{children}</h4>,
          h5: ({ children }) => <h5 className="text-sm font-medium text-[var(--text-secondary)]">{children}</h5>,
          h6: ({ children }) => <h6 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">{children}</h6>,
          p: ({ children }) => <p className="leading-relaxed">{children}</p>,
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent-700 dark:text-accent-400 underline underline-offset-2 break-all hover:text-accent-600"
            >
              {children}
            </a>
          ),
          ul: ({ children }) => <ul className="list-disc pl-5 space-y-1">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-5 space-y-1">{children}</ol>,
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          strong: ({ children }) => <strong className="font-semibold text-[var(--text-primary)]">{children}</strong>,
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-[var(--border-default)] pl-3 text-[var(--text-muted)] italic">{children}</blockquote>
          ),
          code: ({ children }) => (
            <code className="rounded bg-[var(--surface-sunken)] px-1 py-0.5 font-mono text-[0.85em]">{children}</code>
          ),
          pre: ({ children }) => (
            <pre className="overflow-x-auto rounded-[var(--radius-md)] bg-[var(--surface-sunken)] p-3 text-xs [&_code]:bg-transparent [&_code]:p-0">
              {children}
            </pre>
          ),
          hr: () => <hr className="border-[var(--border-subtle)]" />,
          table: ({ children }) => (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-xs">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-2 py-1 text-left font-semibold">{children}</th>
          ),
          td: ({ children }) => <td className="border border-[var(--border-subtle)] px-2 py-1 align-top">{children}</td>,
          input: ({ checked, disabled }) => (
            // GFM task-list checkboxes render read-only.
            <input type="checkbox" checked={checked ?? false} disabled={disabled ?? true} readOnly className="mr-1.5 align-middle accent-accent-600" />
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
