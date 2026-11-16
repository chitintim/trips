import { Input } from '../../../../components/ui'
import type { IdeaValues } from '../../lib/addFlow'
import { MoreOptions } from './MoreOptions'
import { TitleField } from './TitleField'

interface IdeaFormProps {
  values: IdeaValues
  onChange: (patch: Partial<IdeaValues>) => void
  onPullLink: (url: string) => void
}

/** Minimum: a title. A link is optional and sits under More options. */
export function IdeaForm({ values, onChange, onPullLink }: IdeaFormProps) {
  return (
    <div className="space-y-4">
      <TitleField label="Idea" value={values.title} onChange={(title) => onChange({ title })} placeholder="e.g. TeamLab Planets" onPullLink={onPullLink} autoFocus />
      <MoreOptions>
        <Input label="Link (optional)" type="url" value={values.link} onChange={(e) => onChange({ link: e.target.value })} placeholder="https://..." />
      </MoreOptions>
      <p className="text-xs text-[var(--text-muted)]">Ideas go in a question called “Ideas”, where everyone can say which they like.</p>
    </div>
  )
}
