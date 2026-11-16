import { Button, Input } from '../../../../components/ui'
import { asPastedUrl } from '../../lib/addFlow'

interface TitleFieldProps {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder: string
  /** Pasting a link into the title offers to pull the details from it. */
  onPullLink: (url: string) => void
  autoFocus?: boolean
}

export function TitleField({ label, value, onChange, placeholder, onPullLink, autoFocus }: TitleFieldProps) {
  const url = asPastedUrl(value)
  return (
    <div className="space-y-2">
      <Input label={label} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} autoFocus={autoFocus} required />
      {url && (
        <div className="flex items-center justify-between gap-3 rounded-[var(--radius-md)] bg-[var(--surface-sunken)] p-3 text-sm text-[var(--text-primary)]">
          <span>That looks like a link. Pull the title and price from it?</span>
          <Button size="sm" variant="secondary" onClick={() => onPullLink(url)}>
            Pull details
          </Button>
        </div>
      )}
    </div>
  )
}
