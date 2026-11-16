import { useEffect } from 'react'
import { Modal, Button, Input, TextArea, Select, useToast } from '../../../components/ui'
import { useCreateOption, useUpdateOption, useDeleteOption, useUpdateSection, useSections, useVotes } from '../../../lib/queries/usePlanning'
import { useTrip, useParticipants } from '../../../lib/queries/useTrip'
import { computeOptionPrice } from '../../../lib/cost/optionPrice'
import { PRICE_BASIS_HELP, deriveNights } from '../../../lib/cost/priceBasis'
import { readCostScope } from '../../../lib/cost/yourCost'
import { inScopeHeadcount } from '../../people/lib/inScopePeople'
import { useFormDraft } from '../../../lib/forms/useFormDraft'
import { useUnsavedChangesGuard } from '../../../lib/forms/useUnsavedChangesGuard'
import { ConfirmDiscardSheet } from '../../../components/ui'
import { useTripActivityLog } from '../../organizer/lib/activity'
import { isDecidedOption } from '../lib/resolveDecision'
import { readOptionPricing } from '../lib/decisionShapes'
import {
  PRICING_CHOICES,
  OPTIONAL_COST_LABEL,
  OPTIONAL_COST_HELP,
  applyGridFields,
  buildPricing,
  defaultBasisForSection,
  emptyPricing,
  pricingFromDraft,
  pricingFromOption,
  previewOption,
  validatePricing,
  type PricingFormValues,
  type TierRow,
} from '../lib/optionPricingForm'
import type { DecisionShape } from '../lib/decisionShapes'
import type { Option } from '../../../types'
import type { Json } from '../../../types/database.types'
import type { OptionDraft } from '../../../shared/contracts'

/** One row of the optional catalog-pricing variants editor (shape 2 sections). */
interface VariantRow {
  label: string
  perDay: string
  flat: string
}

interface OptionFormValues extends PricingFormValues {
  title: string
  description: string
  pricingPerDay: string
  pricingFlat: string
  variants: VariantRow[]
  /** Question-level: only people who choose this option pay. */
  optionalCost: boolean
}

const CURRENCIES = ['GBP', 'EUR', 'USD', 'JPY', 'CHF', 'AUD', 'CAD']

function emptyValues(basis: PricingFormValues['basis'], optionalCost: boolean): OptionFormValues {
  return { ...emptyPricing(basis), title: '', description: '', pricingPerDay: '', pricingFlat: '', variants: [], optionalCost }
}

function fromOption(option: Option | null, ctx: SeedContext): OptionFormValues {
  if (!option) return emptyValues(ctx.defaultBasis, ctx.optionalCost)
  const pricing = readOptionPricing(option.metadata)
  return {
    ...pricingFromOption(option, ctx.trip),
    title: option.title,
    description: option.description || '',
    pricingPerDay: pricing?.per_day?.toString() || '',
    pricingFlat: pricing?.flat?.toString() || '',
    variants: (pricing?.variants || []).map((v) => ({ label: v.label, perDay: v.per_day?.toString() || '', flat: v.flat?.toString() || '' })),
    optionalCost: ctx.optionalCost,
  }
}

/** Seed values from a paste-a-link OptionDraft (see IngestResult contract). */
function fromDraft(draft: OptionDraft, ctx: SeedContext): OptionFormValues {
  return {
    ...emptyValues(ctx.defaultBasis, ctx.optionalCost),
    ...pricingFromDraft(draft, ctx.defaultBasis),
    title: draft.title,
    description: draft.description || '',
  }
}

interface SeedContext {
  defaultBasis: PricingFormValues['basis']
  optionalCost: boolean
  trip: { start_date?: string | null; end_date?: string | null } | null
}

interface OptionEditorSheetProps {
  isOpen: boolean
  onClose: () => void
  tripId: string
  sectionId: string
  /** Null = creating a new option. Present = editing. */
  option: Option | null
  /** Pre-fill from a paste-a-link draft when creating (ignored when editing). */
  prefillDraft?: OptionDraft | null
  /** The parent section's decision shape (UX_REDESIGN.md Part 5) — 'personal' reveals the catalog-pricing fields (per-day/flat/variants) instead of the vote price/price_type fields. Defaults to 'vote' for callers that haven't wired shape yet. */
  decisionShape?: DecisionShape
}

export function OptionEditorSheet({ isOpen, onClose, tripId, sectionId, option, prefillDraft, decisionShape = 'vote' }: OptionEditorSheetProps) {
  const createOption = useCreateOption(tripId)
  const updateOption = useUpdateOption(tripId)
  const deleteOption = useDeleteOption(tripId)
  const updateSection = useUpdateSection(tripId)
  const { data: sections } = useSections(tripId)
  const { data: votes } = useVotes(tripId)
  const { data: trip } = useTrip(tripId)
  const { data: participants } = useParticipants(tripId)
  const logActivity = useTripActivityLog(tripId)
  const { showToast } = useToast()

  const isEditing = !!option
  const draftKey = isEditing ? `option-editor:${option!.id}` : `option-editor:new:${sectionId}`
  // Edit mode always seeds from the option record -- draft persistence is
  // disabled so a stale autosave can never leak in (Form & Flow Standard
  // §5.2). Create mode (including paste-a-link prefill) keeps draft
  // persistence.
  const parentSection = (sections || []).find((s) => s.id === sectionId) ?? null
  const seedCtx: SeedContext = {
    defaultBasis: defaultBasisForSection(parentSection?.section_type),
    optionalCost: parentSection ? readCostScope(parentSection) === 'opt_in' : false,
    trip: trip ?? null,
  }
  const blank = emptyValues(seedCtx.defaultBasis, seedCtx.optionalCost)
  const { values: draftValues, setValues, updateField, clearDraft } = useFormDraft<OptionFormValues>(draftKey, blank, {
    enabled: !isEditing,
  })
  // A draft autosaved before the pricing fields existed lacks them; fill from blank so the first render can't crash.
  const values: OptionFormValues = { ...blank, ...draftValues }

  const buildSeed = () => (option ? fromOption(option, seedCtx) : prefillDraft ? fromDraft(prefillDraft, seedCtx) : emptyValues(seedCtx.defaultBasis, seedCtx.optionalCost))

  useEffect(() => {
    if (isOpen) setValues(buildSeed())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, option?.id, !!parentSection, !!trip])

  const seed: OptionFormValues = { ...blank, ...buildSeed() } // same key order as `values`, so the dirty check is stable
  const isDirty = JSON.stringify(values) !== JSON.stringify(seed)
  const { confirmClose, guardProps } = useUnsavedChangesGuard(isOpen && isDirty)
  const handleClose = () => confirmClose(onClose)

  const activeChoice = PRICING_CHOICES.find((c) => c.basis === values.basis) ?? PRICING_CHOICES[0]
  const derivedNights = deriveNights(option?.metadata, trip).nights
  const problem = decisionShape === 'vote' ? validatePricing(values) : null
  const headcount = inScopeHeadcount(participants ?? [], !!trip?.confirmation_enabled)
  const preview =
    decisionShape === 'vote' && !problem
      ? computeOptionPrice(previewOption(values, option, trip), trip ?? null, headcount, {
          booked: option?.status === 'booked',
          confirmationEnabled: !!trip?.confirmation_enabled,
        })
      : null

  const isPending = createOption.isPending || updateOption.isPending || deleteOption.isPending

  const addVariantRow = () => setValues((prev) => ({ ...prev, variants: [...prev.variants, { label: '', perDay: '', flat: '' }] }))
  const updateVariantRow = (index: number, field: keyof VariantRow, value: string) =>
    setValues((prev) => ({ ...prev, variants: prev.variants.map((row, i) => (i === index ? { ...row, [field]: value } : row)) }))
  const removeVariantRow = (index: number) => setValues((prev) => ({ ...prev, variants: prev.variants.filter((_, i) => i !== index) }))

  const chooseBasis = (basis: PricingFormValues['basis']) =>
    setValues((prev) => ({
      ...prev,
      basis,
      nights: basis === 'per_night' && prev.nights === '' ? String(deriveNights(option?.metadata, trip).nights) : prev.nights,
    }))

  const addTierRow = () => setValues((prev) => ({ ...prev, tiers: [...prev.tiers, { maxPeople: '', total: '' }] }))
  const updateTierRow = (index: number, field: keyof TierRow, value: string) =>
    setValues((prev) => ({ ...prev, tiers: prev.tiers.map((row, i) => (i === index ? { ...row, [field]: value } : row)) }))
  const removeTierRow = (index: number) => setValues((prev) => ({ ...prev, tiers: prev.tiers.filter((_, i) => i !== index) }))

  /** Personal-order (catalog) metadata: merged into the stored keys, never replacing them. */
  function buildPersonalMetadata(): Json {
    const metadata: Record<string, unknown> = { ...(option?.metadata && typeof option.metadata === 'object' && !Array.isArray(option.metadata) ? (option.metadata as Record<string, unknown>) : {}) }
    const perDay = values.pricingPerDay ? parseFloat(values.pricingPerDay) : undefined
    const flat = values.pricingFlat ? parseFloat(values.pricingFlat) : undefined
    const variants = values.variants
      .filter((v) => v.label.trim())
      .map((v) => ({
        label: v.label.trim(),
        ...(v.perDay ? { per_day: parseFloat(v.perDay) } : {}),
        ...(v.flat ? { flat: parseFloat(v.flat) } : {}),
      }))
    if (perDay != null || flat != null || variants.length > 0) {
      metadata.pricing = {
        ...(perDay != null ? { per_day: perDay } : {}),
        ...(flat != null ? { flat } : {}),
        ...(variants.length > 0 ? { variants } : {}),
      }
    } else {
      delete metadata.pricing
    }
    applyGridFields(metadata, option ? option.metadata : undefined, values.gridRow, values.gridColumn)
    return metadata as Json
  }

  const handleSave = async () => {
    if (!values.title.trim()) {
      showToast({ type: 'error', message: 'Please enter a title' })
      return
    }

    let columns: { price: number | null; currency: string | null; price_type: Option['price_type']; metadata: Json }
    if (decisionShape === 'personal') {
      // Catalog pricing lives entirely in metadata.pricing (no `price` on the row), but still needs a currency.
      const metadata = buildPersonalMetadata()
      columns = {
        price: option?.price ?? null,
        // A catalog row stored with no currency keeps it null while the default is untouched.
        currency: option && option.currency == null && values.currency === (trip?.base_currency || 'GBP') ? null : values.currency,
        price_type: option?.price_type ?? 'per_person_fixed',
        metadata,
      }
    } else {
      const problem = validatePricing(values)
      if (problem) {
        showToast({ type: 'error', message: problem })
        return
      }
      columns = buildPricing(values, option, trip)
    }

    try {
      const payload = {
        title: values.title.trim(),
        description: values.description.trim() || null,
        ...columns,
      }
      if (isEditing) {
        await updateOption.mutateAsync({ id: option!.id, update: payload })
        showToast({ type: 'success', message: 'Option updated' })
      } else {
        const created = await createOption.mutateAsync({ section_id: sectionId, ...payload })
        logActivity({ verb: 'option_added', entity: { type: 'option', id: created.id, label: values.title.trim() } })
        showToast({ type: 'success', message: 'Option added' })
      }
    } catch (err) {
      showToast({ type: 'error', message: 'Could not save option', description: (err as Error).message })
      return
    }

    // Question-level "who pays": only written when the organiser changed it.
    if (decisionShape === 'vote' && parentSection && values.optionalCost !== seedCtx.optionalCost) {
      try {
        const sectionMeta = parentSection.metadata && typeof parentSection.metadata === 'object' && !Array.isArray(parentSection.metadata) ? parentSection.metadata : {}
        await updateSection.mutateAsync({
          id: sectionId,
          update: { metadata: { ...sectionMeta, cost_scope: values.optionalCost ? 'opt_in' : 'everyone' } as Json },
        })
      } catch (err) {
        showToast({ type: 'error', message: 'Option saved, but the “who pays” setting did not', description: (err as Error).message })
      }
    }
    clearDraft()
    onClose()
  }

  const handleDelete = async () => {
    if (!option) return
    // Deleting a closed question's decided option would silently promote the runner-up.
    const parent = (sections || []).find((s) => s.id === sectionId)
    if (parent && isDecidedOption(parent, votes || [], option.id)) {
      showToast({ type: 'error', message: 'This option is the answer', description: 'Reopen the question first, then delete the option.' })
      return
    }
    try {
      await deleteOption.mutateAsync(option.id)
      showToast({ type: 'success', message: 'Option deleted' })
      clearDraft()
      onClose()
    } catch (err) {
      showToast({ type: 'error', message: 'Could not delete option', description: (err as Error).message })
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={handleClose} size="md" title={isEditing ? 'Edit option' : 'Add option'}>
      <div className="space-y-4">
        <Input label="Title" value={values.title} onChange={(e) => updateField('title', e.target.value)} required autoFocus />
        <TextArea
          label="Description (optional)"
          value={values.description}
          onChange={(e) => updateField('description', e.target.value)}
          rows={3}
        />

        {decisionShape === 'vote' && (
          <>
            <fieldset className="space-y-2">
              <legend className="mb-1 block text-sm font-medium text-[var(--text-primary)]">How is this priced?</legend>
              {PRICING_CHOICES.map((choice) => (
                <label
                  key={choice.basis}
                  className={`flex min-h-[44px] cursor-pointer items-start gap-3 rounded-[var(--radius-md)] border p-3 ${
                    values.basis === choice.basis ? 'border-accent-500 bg-accent-50' : 'border-[var(--border-subtle)]'
                  }`}
                >
                  <input
                    type="radio"
                    name="price-basis"
                    className="mt-0.5 h-5 w-5 accent-accent-600"
                    checked={values.basis === choice.basis}
                    onChange={() => chooseBasis(choice.basis)}
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-[var(--text-primary)]">{choice.label}</span>
                    {values.basis === choice.basis && <span className="block text-xs text-[var(--text-muted)]">{PRICE_BASIS_HELP[choice.basis]}</span>}
                  </span>
                </label>
              ))}
            </fieldset>

            <div className="grid grid-cols-2 gap-3 [&>*]:min-w-0">
              {values.basis !== 'by_group_size' && (
                <Input
                  label={`${activeChoice.priceLabel} (optional)`}
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="any"
                  value={values.price}
                  onChange={(e) => updateField('price', e.target.value)}
                  placeholder={activeChoice.placeholder}
                />
              )}
              {values.basis === 'per_night' && (
                <Input
                  label="Nights"
                  type="number"
                  inputMode="numeric"
                  min="1"
                  step="1"
                  value={values.nights}
                  onChange={(e) => updateField('nights', e.target.value)}
                  helperText={`From the dates: ${derivedNights} ${derivedNights === 1 ? 'night' : 'nights'}. Change it if this stay is shorter.`}
                />
              )}
              <Select
                label="Currency"
                value={values.currency}
                onChange={(e) => updateField('currency', e.target.value)}
                options={CURRENCIES.map((c) => ({ value: c, label: c }))}
              />
            </div>

            {values.basis === 'by_group_size' && (
              <div className="space-y-2 p-3 bg-[var(--surface-sunken)] rounded-[var(--radius-md)]">
                <p className="text-sm font-medium text-[var(--text-primary)]">Total price by group size</p>
                <p className="text-xs text-[var(--text-muted)]">
                  For a venue that charges a different total depending on group size — e.g. "up to 6 people: £300", "up to 12: £450".
                </p>
                {values.tiers.map((row, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Input
                      type="number"
                      inputMode="numeric"
                      min="1"
                      value={row.maxPeople}
                      onChange={(e) => updateTierRow(i, 'maxPeople', e.target.value)}
                      placeholder="Up to N people"
                      fullWidth
                    />
                    <Input
                      type="number"
                      inputMode="decimal"
                      min="0"
                      value={row.total}
                      onChange={(e) => updateTierRow(i, 'total', e.target.value)}
                      placeholder="Total price"
                      fullWidth
                    />
                    <Button variant="ghost" size="sm" onClick={() => removeTierRow(i)} aria-label="Remove this row">
                      ✕
                    </Button>
                  </div>
                ))}
                <Button variant="ghost" size="sm" onClick={addTierRow}>
                  + Add a size
                </Button>
              </div>
            )}

            {preview ? (
              <p className="text-sm text-[var(--text-secondary)]" aria-live="polite" data-testid="price-preview">
                <span className="font-medium text-[var(--text-primary)]">{preview.headline}</span> · {preview.basisLine}
              </p>
            ) : (
              <p className="text-xs text-[var(--text-muted)]">No price yet — that’s fine, you can add one later.</p>
            )}
            {problem && <p className="text-xs text-danger-600">{problem}</p>}

            {parentSection && (
              <label className="flex min-h-[44px] cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-0.5 h-5 w-5 accent-accent-600"
                  checked={values.optionalCost}
                  onChange={(e) => updateField('optionalCost', e.target.checked)}
                />
                <span>
                  <span className="block text-sm font-medium text-[var(--text-primary)]">{OPTIONAL_COST_LABEL}</span>
                  <span className="block text-xs text-[var(--text-muted)]">{OPTIONAL_COST_HELP}</span>
                </span>
              </label>
            )}

            {(values.gridRow || values.gridColumn || option?.price_type === 'per_person_tiered') && (
              <details className="rounded-[var(--radius-md)] bg-[var(--surface-sunken)] p-3" open={!!(values.gridRow || values.gridColumn)}>
                <summary className="cursor-pointer text-sm font-medium text-[var(--text-primary)]">Grid layout</summary>
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <Input
                    label="Matrix row"
                    value={values.gridRow}
                    onChange={(e) => updateField('gridRow', e.target.value)}
                    placeholder="e.g. Level A"
                    helperText="Options sharing a row/column pair form a matrix"
                  />
                  <Input
                    label="Matrix column"
                    value={values.gridColumn}
                    onChange={(e) => updateField('gridColumn', e.target.value)}
                    placeholder="e.g. Skis+Boots"
                  />
                </div>
              </details>
            )}
          </>
        )}

        {decisionShape === 'personal' && (
          <div className="space-y-3 p-3 bg-[var(--surface-sunken)] rounded-[var(--radius-md)]">
            <p className="text-sm font-medium text-[var(--text-primary)]">Catalog pricing</p>
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Price per day (optional)"
                type="number"
                value={values.pricingPerDay}
                onChange={(e) => updateField('pricingPerDay', e.target.value)}
                placeholder="0.00"
              />
              <Input
                label="Flat price (optional)"
                type="number"
                value={values.pricingFlat}
                onChange={(e) => updateField('pricingFlat', e.target.value)}
                placeholder="0.00"
                helperText="Flat overrides per-day when both are set"
              />
            </div>
            <Select
              label="Currency"
              value={values.currency}
              onChange={(e) => updateField('currency', e.target.value)}
              options={['GBP', 'EUR', 'USD', 'JPY', 'CHF', 'AUD', 'CAD'].map((c) => ({ value: c, label: c }))}
            />

            <div className="space-y-2 pt-2 border-t border-[var(--border-subtle)]">
              <p className="text-xs font-medium text-[var(--text-secondary)]">Variants (optional — e.g. Adult vs Kids)</p>
              {values.variants.map((row, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input value={row.label} onChange={(e) => updateVariantRow(i, 'label', e.target.value)} placeholder="Label" fullWidth />
                  <Input
                    type="number"
                    value={row.perDay}
                    onChange={(e) => updateVariantRow(i, 'perDay', e.target.value)}
                    placeholder="Per day"
                    className="w-24"
                  />
                  <Input
                    type="number"
                    value={row.flat}
                    onChange={(e) => updateVariantRow(i, 'flat', e.target.value)}
                    placeholder="Flat"
                    className="w-24"
                  />
                  <Button variant="ghost" size="sm" onClick={() => removeVariantRow(i)}>
                    ✕
                  </Button>
                </div>
              ))}
              <Button variant="ghost" size="sm" onClick={addVariantRow}>
                + Add a variant
              </Button>
            </div>
          </div>
        )}

        <div className="flex justify-between items-center pt-4 border-t border-[var(--border-subtle)]">
          <div>
            {isEditing && (
              <Button variant="danger" size="sm" onClick={handleDelete} isLoading={deleteOption.isPending}>
                Delete
              </Button>
            )}
          </div>
          <div className="flex gap-3">
            <Button variant="outline" onClick={handleClose} disabled={isPending}>
              Cancel
            </Button>
            <Button onClick={handleSave} isLoading={createOption.isPending || updateOption.isPending}>
              {isEditing ? 'Save changes' : 'Add option'}
            </Button>
          </div>
        </div>
      </div>

      <ConfirmDiscardSheet
        isOpen={guardProps.showConfirm}
        onKeep={guardProps.onKeep}
        onDiscard={() => {
          clearDraft()
          guardProps.onDiscard()
        }}
      />
    </Modal>
  )
}
