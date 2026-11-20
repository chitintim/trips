import { INTENT_TILES, MEMBER_HAPPENING_HINT, type AddIntent } from '../../lib/addFlow'

/** First screen: three large, plainly worded choices. */
export function IntentChooser({
  intents,
  onChoose,
  memberHappening = false,
}: {
  intents: AddIntent[]
  onChoose: (intent: AddIntent) => void
  /** A member (not an organiser): the happening tile says it is their own plan. */
  memberHappening?: boolean
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-[var(--text-secondary)]">What do you want to add?</p>
      {INTENT_TILES.filter((t) => intents.includes(t.intent)).map((tile) => (
        <button
          key={tile.intent}
          type="button"
          onClick={() => onChoose(tile.intent)}
          className="flex min-h-[72px] w-full items-center gap-4 rounded-[var(--radius-lg)] border border-[var(--border-default)] bg-[var(--surface-raised)] p-4 text-left transition-colors hover:bg-[var(--surface-sunken)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-600"
        >
          <span className="text-3xl" aria-hidden="true">
            {tile.icon}
          </span>
          <span>
            <span className="block text-base font-semibold text-[var(--text-primary)]">{tile.title}</span>
            <span className="block text-sm text-[var(--text-muted)]">{memberHappening && tile.intent === 'happening' ? MEMBER_HAPPENING_HINT : tile.hint}</span>
          </span>
        </button>
      ))}
    </div>
  )
}
