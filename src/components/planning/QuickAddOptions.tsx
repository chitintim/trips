import { useState } from 'react'
import { Button, Input } from '../ui'
import { supabase } from '../../lib/supabase'

interface OptionRow {
  id: string
  title: string
  price: string
  description: string
}

interface QuickAddOptionsProps {
  sectionId: string
  onSuccess: () => void
  onCancel: () => void
}

export function QuickAddOptions({ sectionId, onSuccess, onCancel }: QuickAddOptionsProps) {
  const [rows, setRows] = useState<OptionRow[]>([
    { id: '1', title: '', price: '', description: '' },
    { id: '2', title: '', price: '', description: '' },
  ])
  const [currency, setCurrency] = useState('EUR')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const addRow = () => {
    setRows([...rows, { id: Date.now().toString(), title: '', price: '', description: '' }])
  }

  const removeRow = (id: string) => {
    if (rows.length > 1) {
      setRows(rows.filter((r) => r.id !== id))
    }
  }

  const updateRow = (id: string, field: keyof OptionRow, value: string) => {
    setRows(rows.map((r) => (r.id === id ? { ...r, [field]: value } : r)))
  }

  const validRows = rows.filter((r) => r.title.trim())

  const handleSubmit = async () => {
    if (validRows.length === 0) {
      setError('Please enter at least one option with a title')
      return
    }

    setLoading(true)
    setError(null)

    try {
      const optionsToInsert = validRows.map((row) => ({
        section_id: sectionId,
        title: row.title.trim(),
        description: row.description.trim() || null,
        price: row.price ? parseFloat(row.price) : null,
        currency: row.price ? currency : null,
        status: 'available' as const,
        price_type: 'per_person_fixed' as const,
      }))

      const { error: insertError } = await supabase.from('options').insert(optionsToInsert)

      if (insertError) {
        setError(insertError.message)
        setLoading(false)
        return
      }

      setLoading(false)
      onSuccess()
    } catch (err) {
      setError('An unexpected error occurred')
      setLoading(false)
    }
  }

  return (
    <div className="bg-gradient-to-b from-sky-50 to-white border border-sky-200 rounded-lg p-4 mt-4">
      <div className="flex items-center justify-between mb-4">
        <h4 className="font-semibold text-gray-900 flex items-center gap-2">
          <span className="text-lg">➕</span>
          Quick Add Options
        </h4>
        <button onClick={onCancel} className="text-gray-400 hover:text-gray-600 p-1">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 text-sm mb-4">
          {error}
        </div>
      )}

      {/* Currency selector */}
      <div className="flex items-center gap-2 mb-4">
        <span className="text-sm text-gray-600">Currency:</span>
        <select
          value={currency}
          onChange={(e) => setCurrency(e.target.value)}
          className="text-sm border border-gray-300 rounded-md px-2 py-1"
        >
          <option value="EUR">EUR €</option>
          <option value="GBP">GBP £</option>
          <option value="USD">USD $</option>
          <option value="CHF">CHF</option>
        </select>
      </div>

      {/* Option rows */}
      <div className="space-y-3">
        {rows.map((row, index) => (
          <div
            key={row.id}
            className="bg-white border border-gray-200 rounded-lg p-3 flex flex-col sm:flex-row gap-2"
          >
            <div className="flex items-center gap-2 text-gray-400 text-sm font-medium min-w-[24px]">
              {index + 1}.
            </div>
            <div className="flex-1 grid grid-cols-1 sm:grid-cols-[2fr,1fr,2fr] gap-2">
              <Input
                type="text"
                placeholder="Option title (required)"
                value={row.title}
                onChange={(e) => updateRow(row.id, 'title', e.target.value)}
                className="!py-2"
              />
              <Input
                type="number"
                placeholder="Price"
                value={row.price}
                onChange={(e) => updateRow(row.id, 'price', e.target.value)}
                className="!py-2"
              />
              <Input
                type="text"
                placeholder="Description (optional)"
                value={row.description}
                onChange={(e) => updateRow(row.id, 'description', e.target.value)}
                className="!py-2"
              />
            </div>
            {rows.length > 1 && (
              <button
                onClick={() => removeRow(row.id)}
                className="text-gray-400 hover:text-red-500 p-1 self-center"
                title="Remove"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                  />
                </svg>
              </button>
            )}
          </div>
        ))}
      </div>

      {/* Add another row button */}
      <button
        onClick={addRow}
        className="mt-3 text-sm text-sky-600 hover:text-sky-700 font-medium flex items-center gap-1"
      >
        <span>+</span> Add Another Row
      </button>

      {/* Actions */}
      <div className="flex items-center justify-between mt-4 pt-4 border-t border-gray-200">
        <span className="text-sm text-gray-500">
          {validRows.length} option{validRows.length !== 1 ? 's' : ''} to create
        </span>
        <div className="flex gap-2">
          <Button variant="outline" onClick={onCancel} disabled={loading}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleSubmit} isLoading={loading} disabled={validRows.length === 0}>
            Create {validRows.length} Option{validRows.length !== 1 ? 's' : ''}
          </Button>
        </div>
      </div>
    </div>
  )
}
