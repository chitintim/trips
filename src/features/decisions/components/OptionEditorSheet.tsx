import { useEffect } from 'react'
import { Modal, Button, Input, TextArea, Select, SegmentedControl, useToast } from '../../../components/ui'
import { useCreateOption, useUpdateOption, useDeleteOption } from '../../../lib/queries/usePlanning'
import { useFormDraft } from '../../../lib/forms/useFormDraft'
import { useUnsavedChangesGuard } from '../../../lib/forms/useUnsavedChangesGuard'
import { ConfirmDiscardSheet } from '../../../components/ui'
import { useTripActivityLog } from '../../organizer/lib/activity'
import { readOptionPricing, readPriceTiers } from '../lib/decisionShapes'
import type { DecisionShape } from '../lib/decisionShapes'
import type { OptionMetadata } from '../lib/optionMetadata'
import type { Option } from '../../../types'
import type { Enums, Json } from '../../../types/database.types'
import type { OptionDraft } from '../../../shared/contracts'

type PriceType = Enums<'price_type'>

const PRICE_TYPE_OPTIONS: Array<{ value: PriceType; label: string }> = [
  { value: 'per_person_fixed', label: 'Per person' },
  { value: 'total_split', label: 'Total (split across group)' },
  { value: 'per_person_tiered', label: 'Per person (tiered/matrix)' },
]

/** One row of the optional catalog-pricing variants editor (shape 2 sections). */
interface VariantRow {
  label: string
  perDay: string
  flat: string
}

/** One row of the optional price-tiers editor (shape 3, headcount-dependent pricing). */
interface TierRow {
  maxPeople: string
  total: string
}

interface OptionFormValues {
  title: string
  description: string
  price: string
  currency: string
  priceType: PriceType
  gridRow: string
  gridColumn: string
  pricingPerDay: string
  pricingFlat: string
  variants: VariantRow[]
  tiers: TierRow[]
}

const EMPTY_VALUES: OptionFormValues = {
  title: '',
  description: '',
  price: '',
  currency: 'GBP',
  priceType: 'per_person_fixed',
  gridRow: '',
  gridColumn: '',
  pricingPerDay: '',
  pricingFlat: '',
  variants: [],
  tiers: [],
}

function fromOption(option: Option | null): OptionFormValues {
  if (!option) return EMPTY_VALUES
  const meta = (option.metadata && typeof option.metadata === 'object' && !Array.isArray(option.metadata) ? option.metadata : {}) as Record<string, unknown>
  const pricing = readOptionPricing(option.metadata)
  const tiers = readPriceTiers(option.metadata)
  return {
    title: option.title,
    description: option.description || '',
    price: option.price?.toString() || '',
    currency: option.currency || 'GBP',
    priceType: option.price_type,
    gridRow: typeof meta.grid_row === 'string' ? meta.grid_row : '',
    gridColumn: typeof meta.grid_column === 'string' ? meta.grid_column : '',
    pricingPerDay: pricing?.per_day?.toString() || '',
    pricingFlat: pricing?.flat?.toString() || '',
    variants: (pricing?.variants || []).map((v) => ({ label: v.label, perDay: v.per_day?.toString() || '', flat: v.flat?.toString() || '' })),
    tiers: tiers.map((t) => ({ maxPeople: t.max_people.toString(), total: t.total.toString() })),
  }
}

/** Seed values from a paste-a-link OptionDraft (see IngestResult contract). */
function fromDraft(draft: OptionDraft): OptionFormValues {
  return {
    title: draft.title,
    description: draft.description || '',
    price: draft.price?.toString() || '',
    currency: draft.currency || 'GBP',
    priceType: (draft.price_type as PriceType) || 'per_person_fixed',
    gridRow: '',
    gridColumn: '',
    pricingPerDay: '',
    pricingFlat: '',
    variants: [],
    tiers: [],
  }
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
  const logActivity = useTripActivityLog(tripId)
  const { showToast } = useToast()

  const isEditing = !!option
  const draftKey = isEditing ? `option-editor:${option!.id}` : `option-editor:new:${sectionId}`
  // Edit mode always seeds from the option record -- draft persistence is
  // disabled so a stale autosave can never leak in (Form & Flow Standard
  // §5.2). Create mode (including paste-a-link prefill) keeps draft
  // persistence.
  const { values, setValues, updateField, clearDraft } = useFormDraft<OptionFormValues>(draftKey, EMPTY_VALUES, {
    enabled: !isEditing,
  })

  useEffect(() => {
    if (isOpen) {
      if (option) {
        setValues(fromOption(option))
      } else if (prefillDraft) {
        setValues(fromDraft(prefillDraft))
      } else {
        setValues(EMPTY_VALUES)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, option?.id])

  const seed = option ? fromOption(option) : prefillDraft ? fromDraft(prefillDraft) : EMPTY_VALUES
  const isDirty = JSON.stringify(values) !== JSON.stringify(seed)
  const { confirmClose, guardProps } = useUnsavedChangesGuard(isDirty)
  const handleClose = () => confirmClose(onClose)

  const isPending = createOption.isPending || updateOption.isPending || deleteOption.isPending

  const addVariantRow = () => setValues((prev) => ({ ...prev, variants: [...prev.variants, { label: '', perDay: '', flat: '' }] }))
  const updateVariantRow = (index: number, field: keyof VariantRow, value: string) =>
    setValues((prev) => ({ ...prev, variants: prev.variants.map((row, i) => (i === index ? { ...row, [field]: value } : row)) }))
  const removeVariantRow = (index: number) => setValues((prev) => ({ ...prev, variants: prev.variants.filter((_, i) => i !== index) }))

  const addTierRow = () => setValues((prev) => ({ ...prev, tiers: [...prev.tiers, { maxPeople: '', total: '' }] }))
  const updateTierRow = (index: number, field: keyof TierRow, value: string) =>
    setValues((prev) => ({ ...prev, tiers: prev.tiers.map((row, i) => (i === index ? { ...row, [field]: value } : row)) }))
  const removeTierRow = (index: number) => setValues((prev) => ({ ...prev, tiers: prev.tiers.filter((_, i) => i !== index) }))

  /** Builds the option.metadata payload from grid/pricing/tier fields, or null when none apply — see decisionShapes.ts for the read side. */
  function buildMetadata(): Json | null {
    const metadata: OptionMetadata = {}

    if (values.gridRow.trim() && values.gridColumn.trim()) {
      metadata.grid_row = values.gridRow.trim()
      metadata.grid_column = values.gridColumn.trim()
    }

    if (decisionShape === 'personal') {
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
      }
    }

    const tiers = values.tiers
      .filter((t) => t.maxPeople.trim() && t.total.trim())
      .map((t) => ({ max_people: parseInt(t.maxPeople, 10), total: parseFloat(t.total) }))
    if (tiers.length > 0) metadata.price_tiers = tiers

    return Object.keys(metadata).length > 0 ? (metadata as unknown as Json) : null
  }

  const handleSave = async () => {
    if (!values.title.trim()) {
      showToast({ type: 'error', message: 'Please enter a title' })
      return
    }

    const metadata = buildMetadata()
    // Personal-order (shape 2) options price entirely through metadata.pricing
    // (no `price`/`price_type` on the row), but still need a currency for
    // that pricing to be denominated in — persist it even though `price`
    // itself stays null. Vote-shape options keep the existing "only set a
    // currency if a price was actually entered" rule.
    const currency = decisionShape === 'personal' ? values.currency : values.price ? values.currency : null

    try {
      if (isEditing) {
        await updateOption.mutateAsync({
          id: option!.id,
          update: {
            title: values.title.trim(),
            description: values.description.trim() || null,
            price: values.price ? parseFloat(values.price) : null,
            currency,
            price_type: values.priceType,
            metadata,
          },
        })
        showToast({ type: 'success', message: 'Option updated' })
      } else {
        const created = await createOption.mutateAsync({
          section_id: sectionId,
          title: values.title.trim(),
          description: values.description.trim() || null,
          price: values.price ? parseFloat(values.price) : null,
          currency,
          price_type: values.priceType,
          metadata,
        })
        logActivity({ verb: 'option_added', entity: { type: 'option', id: created.id, label: values.title.trim() } })
        showToast({ type: 'success', message: 'Option added' })
      }
      clearDraft()
      onClose()
    } catch (err) {
      showToast({ type: 'error', message: 'Could not save option', description: (err as Error).message })
    }
  }

  const handleDelete = async () => {
    if (!option) return
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
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Price (optional)"
                type="number"
                value={values.price}
                onChange={(e) => updateField('price', e.target.value)}
                placeholder="0.00"
              />
              <Select
                label="Currency"
                value={values.currency}
                onChange={(e) => updateField('currency', e.target.value)}
                options={['GBP', 'EUR', 'USD', 'JPY', 'CHF', 'AUD', 'CAD'].map((c) => ({ value: c, label: c }))}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-[var(--text-primary)] mb-2">How is the price applied?</label>
              <SegmentedControl
                fullWidth
                value={values.priceType}
                onChange={(v) => updateField('priceType', v)}
                options={PRICE_TYPE_OPTIONS}
                size="sm"
              />
            </div>

            {values.priceType === 'per_person_tiered' && (
              <div className="grid grid-cols-2 gap-3 p-3 bg-[var(--surface-sunken)] rounded-[var(--radius-md)]">
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
            )}

            {/* Tiered group pricing (UX_REDESIGN.md Part 5, shape 3): headcount
                breakpoints that override price/price_type for the per-person
                cost display when filled in — see decisionShapes.ts's
                applicableTier/getTierCostImpact. */}
            <div className="space-y-2 p-3 bg-[var(--surface-sunken)] rounded-[var(--radius-md)]">
              <p className="text-sm font-medium text-[var(--text-primary)]">Tiered group pricing (optional)</p>
              <p className="text-xs text-[var(--text-muted)]">
                For a venue that charges a different total depending on group size — e.g. "up to 6 people: £300", "up to 12: £450". Leave empty to use the price above instead.
              </p>
              {values.tiers.map((row, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    type="number"
                    value={row.maxPeople}
                    onChange={(e) => updateTierRow(i, 'maxPeople', e.target.value)}
                    placeholder="Up to N people"
                    fullWidth
                  />
                  <Input
                    type="number"
                    value={row.total}
                    onChange={(e) => updateTierRow(i, 'total', e.target.value)}
                    placeholder="Total price"
                    fullWidth
                  />
                  <Button variant="ghost" size="sm" onClick={() => removeTierRow(i)}>
                    ✕
                  </Button>
                </div>
              ))}
              <Button variant="ghost" size="sm" onClick={addTierRow}>
                + Add a tier
              </Button>
            </div>
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
