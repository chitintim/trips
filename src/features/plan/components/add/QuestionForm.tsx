import { Chip, Input, SegmentedControl, Select, TextArea } from '../../../../components/ui'
import { FREQUENT_CURRENCIES } from '../../../../lib/money'
import { PRICING_CHOICES } from '../../../decisions/lib/optionPricingForm'
import { PRICE_BASIS_HELP } from '../../../../lib/cost/priceBasis'
import { QUESTION_TEMPLATES, parseOptionLines, type QuestionValues } from '../../lib/addFlow'
import { MoreOptions } from './MoreOptions'
import { TitleField } from './TitleField'

interface QuestionFormProps {
  values: QuestionValues
  onChange: (patch: Partial<QuestionValues>) => void
  onTemplate: (title: string) => void
  onPullLink: (url: string) => void
}

/** Minimum: the question + at least two options (one per line). */
export function QuestionForm({ values, onChange, onTemplate, onPullLink }: QuestionFormProps) {
  const options = parseOptionLines(values.optionsText)
  const isGroup = values.shape === 'vote'
  const basis = PRICING_CHOICES.find((c) => c.basis === values.basis) ?? PRICING_CHOICES[0]
  const setPrice = (title: string, price: string) => onChange({ prices: { ...values.prices, [title.toLowerCase()]: price } })

  return (
    <div className="space-y-4">
      {values.title.trim() === '' && (
        <div className="flex flex-wrap gap-2" aria-label="Quick starts">
          {QUESTION_TEMPLATES.map((t) => (
            <Chip key={t.title} onClick={() => onTemplate(t.title)}>
              {t.title}
            </Chip>
          ))}
        </div>
      )}

      <TitleField label="Question" value={values.title} onChange={(title) => onChange({ title })} placeholder="e.g. Where are we staying?" onPullLink={onPullLink} autoFocus />

      <TextArea
        label="Options"
        value={values.optionsText}
        onChange={(e) => onChange({ optionsText: e.target.value })}
        rows={4}
        placeholder={'One per line. Paste a list if you have one.\nOsaka\nKyoto'}
        helperText={options.length >= 2 ? `${options.length} options` : 'Add at least two.'}
      />

      <MoreOptions>
        <div>
          <span className="mb-2 block text-sm font-medium text-[var(--text-primary)]">Who chooses</span>
          <SegmentedControl
            fullWidth
            size="sm"
            value={values.shape}
            onChange={(shape) => onChange({ shape })}
            options={[
              { value: 'vote', label: 'Group choice' },
              { value: 'personal', label: 'Own choice' },
            ]}
          />
          <p className="mt-1.5 text-xs text-[var(--text-muted)]">
            {isGroup ? 'One answer for everyone. The group chooses between the options.' : 'Each person chooses for themselves, like rental gear or lessons.'}
          </p>
        </div>

        {isGroup && (
          <div>
            <span className="mb-2 block text-sm font-medium text-[var(--text-primary)]">How people answer</span>
            <SegmentedControl
              fullWidth
              size="sm"
              value={values.method}
              onChange={(method) => onChange({ method })}
              options={[
                { value: 'single', label: 'Choose one' },
                { value: 'approval', label: 'Choose any' },
                { value: 'ranked', label: 'Rank them' },
              ]}
            />
          </div>
        )}

        <Input label="Answer by (optional)" type="datetime-local" value={values.answerBy} onChange={(e) => onChange({ answerBy: e.target.value })} />

        {isGroup && (
          <label className="flex min-h-[44px] cursor-pointer items-start gap-3">
            <input type="checkbox" checked={values.hideResults} onChange={(e) => onChange({ hideResults: e.target.checked })} className="mt-0.5 h-5 w-5 accent-accent-600" />
            <span className="text-sm text-[var(--text-primary)]">
              Hide answers until it’s decided
              <span className="block text-xs text-[var(--text-muted)]">Off by default: people see how the group is leaning.</span>
            </span>
          </label>
        )}

        {options.length >= 2 && (
          <div className="space-y-3">
            <span className="block text-sm font-medium text-[var(--text-primary)]">Prices (optional)</span>
            {isGroup && (
              <div className="space-y-1.5">
                <Select
                  label="How is this priced?"
                  value={values.basis}
                  onChange={(e) => onChange({ basis: e.target.value as QuestionValues['basis'] })}
                  options={PRICING_CHOICES.map((c) => ({ value: c.basis, label: c.label }))}
                  helperText={PRICE_BASIS_HELP[values.basis]}
                />
                {values.basis === 'per_night' && (
                  <Input label="Nights (optional)" type="number" inputMode="numeric" min="1" value={values.nights} onChange={(e) => onChange({ nights: e.target.value })} helperText="Left empty, nights come from the trip dates." />
                )}
              </div>
            )}
            <Select
              aria-label="Currency"
              value={values.currency}
              onChange={(e) => onChange({ currency: e.target.value })}
              options={Array.from(new Set([values.currency, ...FREQUENT_CURRENCIES])).map((c) => ({ value: c, label: c }))}
            />
            {values.basis === 'by_group_size' && isGroup ? (
              <p className="text-xs text-[var(--text-muted)]">Set the price for each group size later, from the option’s own editor.</p>
            ) : (
              options.map((o) => (
                <Input
                  key={o.toLowerCase()}
                  label={o}
                  type="number"
                  inputMode="decimal"
                  min="0"
                  value={values.prices[o.toLowerCase()] ?? ''}
                  onChange={(e) => setPrice(o, e.target.value)}
                  placeholder={isGroup ? basis.priceLabel : 'Price'}
                />
              ))
            )}
          </div>
        )}

        <TextArea label="Description (optional)" value={values.description} onChange={(e) => onChange({ description: e.target.value })} rows={2} />
      </MoreOptions>
    </div>
  )
}
