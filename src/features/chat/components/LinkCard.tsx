import { Button } from '../../../components/ui'
import type { ResolvedLink } from '../lib/linkTargets'

export interface LinkCardProps {
  link: ResolvedLink
  onOpen: (openParam: string) => void
}

/** "I can't do that from here, but it's one tap": a button into the real screen. Never writes anything. */
export function LinkCard({ link, onOpen }: LinkCardProps) {
  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-3" data-testid="link-card">
      <p className="text-sm text-[var(--text-secondary)]">{link.copy.message}</p>
      <div className="mt-2">
        <Button size="md" variant="secondary" onClick={() => onOpen(link.openParam)}>
          {link.copy.button}
        </Button>
      </div>
    </div>
  )
}
