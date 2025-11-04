import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { Button, Badge } from './ui'
import { generateLinkCode, type ParsedReceiptData } from '../lib/receiptParsing'
import type { Currency } from '../lib/currency'

interface ItemizedSplitWizardProps {
  parsedData: ParsedReceiptData
  tripId: string
  paidBy: string
  receiptUrl: string | null
  currency: Currency
  paymentDate: string
  onSuccess: () => void
  onBack: () => void
}

export function ItemizedSplitWizard({
  parsedData,
  tripId,
  paidBy,
  receiptUrl,
  currency,
  paymentDate,
  onSuccess,
  onBack
}: ItemizedSplitWizardProps) {
  const [loading, setLoading] = useState(false)
  const [shareLink, setShareLink] = useState<string | null>(null)
  const [linkCode, setLinkCode] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const handleCreateItemizedExpense = async () => {
    setLoading(true)

    try {
      // 1. Generate unique 8-character code
      const code = generateLinkCode()
      setLinkCode(code)

      // 2. Create expense with status='unallocated'
      const { data: expense, error: expenseError } = await supabase
        .from('expenses')
        .insert({
          trip_id: tripId,
          paid_by: paidBy,
          amount: parsedData.total,
          currency: currency,
          payment_date: paymentDate,
          category: parsedData.expense_category as any, // Will be validated by DB
          vendor_name: parsedData.vendor_name,
          location: parsedData.vendor_location || null,
          description: `${parsedData.vendor_name} - Itemized`,
          receipt_url: receiptUrl,
          // Itemized expense fields
          status: 'unallocated',
          ai_parsed: true,
          subtotal: parsedData.subtotal,
          tax_percent: parsedData.tax_percent,
          tax_amount: parsedData.tax_amount,
          service_charge_percent: parsedData.service_charge_percent,
          service_charge_amount: parsedData.service_charge_amount,
          discount_amount: parsedData.discount_amount,
          discount_percent: parsedData.discount_percent,
          // FX conversion (will be null if currency = GBP)
          base_currency_amount: currency === 'GBP' ? parsedData.total : null,
          fx_rate: currency === 'GBP' ? 1 : null,
          fx_rate_date: currency === 'GBP' ? null : paymentDate
        })
        .select()
        .single()

      if (expenseError) throw expenseError

      console.log('Expense created:', expense.id)

      // 3. Create line items
      const lineItemsToInsert = parsedData.line_items.map(item => ({
        expense_id: expense.id,
        name_original: item.name_original,
        name_english: item.name_english || item.name_original,
        quantity: item.quantity,
        unit_price: item.unit_price,
        line_discount_amount: item.line_discount_amount || 0,
        line_discount_percent: item.line_discount_percent || 0,
        subtotal: item.subtotal,
        tax_amount: item.tax_amount,
        service_amount: item.service_amount,
        total_amount: item.total_amount,
        line_number: item.line_number
      }))

      const { error: lineItemsError } = await supabase
        .from('expense_line_items')
        .insert(lineItemsToInsert)

      if (lineItemsError) throw lineItemsError

      console.log('Line items created:', lineItemsToInsert.length)

      // 4. Create allocation link
      const expiresAt = new Date()
      expiresAt.setDate(expiresAt.getDate() + 7) // 7 days from now

      const { error: linkError } = await supabase
        .from('expense_allocation_links')
        .insert({
          expense_id: expense.id,
          trip_id: tripId,
          code: code,
          expires_at: expiresAt.toISOString(),
          created_by: paidBy
        })

      if (linkError) throw linkError

      console.log('Allocation link created:', code)

      // 5. Generate shareable URL
      const baseUrl = window.location.origin
      const link = `${baseUrl}/trips/claim/${code}`
      setShareLink(link)

      // Success! Don't call onSuccess() yet - wait for user to click "Done" on success screen

    } catch (error: any) {
      console.error('Error creating itemized expense:', error)
      alert(`Error creating itemized expense: ${error.message}`)
    } finally {
      setLoading(false)
    }
  }

  const handleCopyLink = () => {
    if (shareLink) {
      navigator.clipboard.writeText(shareLink)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  const handleShareWhatsApp = () => {
    if (shareLink) {
      const message = encodeURIComponent(
        `Hey! I've uploaded our receipt from ${parsedData.vendor_name}. Claim your items here: ${shareLink}`
      )
      window.open(`https://wa.me/?text=${message}`, '_blank')
    }
  }

  // If link created, show success state
  if (shareLink && linkCode) {
    return (
      <div className="space-y-4">
        <div className="text-center py-6">
          <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h3 className="text-xl font-semibold text-gray-900 mb-2">
            Itemized Expense Created!
          </h3>
          <p className="text-sm text-gray-600">
            Share this link with your group so everyone can claim their items
          </p>
        </div>

        {/* Share Link */}
        <div className="bg-sky-50 border border-sky-200 rounded-lg p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-medium text-sky-900 mb-1">Claim Link Code</p>
              <p className="text-2xl font-bold text-sky-700 font-mono tracking-wider">{linkCode}</p>
            </div>
            <Badge variant="info">Expires in 7 days</Badge>
          </div>

          <div className="pt-2 border-t border-sky-200">
            <p className="text-xs text-sky-700 mb-2">Share this link:</p>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={shareLink}
                readOnly
                className="flex-1 text-sm px-3 py-2 border border-sky-300 rounded-lg bg-white text-gray-700 font-mono"
              />
              <Button
                variant="primary"
                onClick={handleCopyLink}
                className="flex-shrink-0"
              >
                {copied ? '✓ Copied' : 'Copy'}
              </Button>
            </div>
          </div>

          {/* Share Buttons */}
          <div className="flex gap-2 pt-2">
            <Button
              variant="secondary"
              onClick={handleShareWhatsApp}
              className="flex-1 flex items-center justify-center gap-2"
            >
              <span>💬</span>
              Share on WhatsApp
            </Button>
          </div>
        </div>

        {/* Close Button */}
        <Button variant="primary" onClick={onSuccess} className="w-full">
          Done
        </Button>
      </div>
    )
  }

  // Preview state - show line items before creating
  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold text-gray-900">Itemized Expense Preview</h3>

      <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
        <p className="text-xs text-amber-900 font-medium">
          ℹ️ How Itemized Expenses Work
        </p>
        <p className="text-xs text-amber-700 mt-1">
          A shareable link will be created. Each person can claim which items they ordered,
          and the expense will automatically split based on what everyone claims.
        </p>
      </div>

      {/* Line Items Table */}
      <div className="border border-gray-200 rounded-lg overflow-hidden">
        <div className="bg-gray-50 px-4 py-2 border-b border-gray-200">
          <p className="text-sm font-medium text-gray-900">
            Line Items ({parsedData.line_items.length} items)
          </p>
        </div>

        <div className="divide-y divide-gray-200 max-h-64 overflow-y-auto">
          {parsedData.line_items.map((item) => (
            <div key={item.line_number} className="px-4 py-3 hover:bg-gray-50">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">
                    {item.name_english || item.name_original}
                  </p>
                  {item.name_english && item.name_english !== item.name_original && (
                    <p className="text-xs text-gray-500 mt-0.5">
                      {item.name_original}
                    </p>
                  )}
                  <p className="text-xs text-gray-500 mt-1">
                    {item.quantity} × {currency} {item.unit_price.toFixed(2)}
                  </p>
                </div>
                <div className="text-right flex-shrink-0">
                  <p className="text-sm font-semibold text-gray-900">
                    {currency} {item.total_amount.toFixed(2)}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    incl. tax & service
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Totals Breakdown */}
      <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 space-y-2">
        <div className="flex justify-between text-sm">
          <span className="text-gray-600">Subtotal</span>
          <span className="font-medium text-gray-900">
            {currency} {parsedData.subtotal.toFixed(2)}
          </span>
        </div>

        {parsedData.discount_amount && parsedData.discount_amount > 0 && (
          <div className="flex justify-between text-sm">
            <span className="text-gray-600">
              Discount {parsedData.discount_percent && parsedData.discount_percent > 0 ? `(${parsedData.discount_percent}%)` : ''}
            </span>
            <span className="font-medium text-green-600">
              -{currency} {parsedData.discount_amount.toFixed(2)}
            </span>
          </div>
        )}

        {parsedData.tax_amount && parsedData.tax_amount > 0 && (
          <div className="flex justify-between text-sm">
            <span className="text-gray-600">
              Tax {parsedData.tax_percent && parsedData.tax_percent > 0 ? `(${parsedData.tax_percent}%)` : ''}
            </span>
            <span className="font-medium text-gray-900">
              {currency} {parsedData.tax_amount.toFixed(2)}
            </span>
          </div>
        )}

        {parsedData.service_charge_amount && parsedData.service_charge_amount > 0 && (
          <div className="flex justify-between text-sm">
            <span className="text-gray-600">
              Service Charge {parsedData.service_charge_percent && parsedData.service_charge_percent > 0 ? `(${parsedData.service_charge_percent}%)` : ''}
            </span>
            <span className="font-medium text-gray-900">
              {currency} {parsedData.service_charge_amount.toFixed(2)}
            </span>
          </div>
        )}

        <div className="pt-2 mt-2 border-t border-gray-300">
          <div className="flex justify-between">
            <span className="font-semibold text-gray-900">Total</span>
            <span className="font-bold text-lg text-gray-900">
              {currency} {parsedData.total.toFixed(2)}
            </span>
          </div>
        </div>

        {!parsedData.total_matches && (
          <div className="mt-2 pt-2 border-t border-amber-200 bg-amber-50 -mx-4 -mb-4 px-4 py-2 rounded-b-lg">
            <p className="text-xs text-amber-900 font-medium">
              ⚠️ Warning: Line items don't sum exactly to total
            </p>
            {parsedData.calculation_notes && parsedData.calculation_notes.trim() && !/^[0.]+$/.test(parsedData.calculation_notes.trim()) && (
              <p className="text-xs text-amber-700 mt-1">
                {parsedData.calculation_notes}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Action Buttons */}
      <div className="flex gap-3 pt-4 border-t border-gray-200">
        <Button
          variant="outline"
          onClick={onBack}
          disabled={loading}
          className="flex-1"
        >
          Back
        </Button>
        <Button
          variant="primary"
          onClick={handleCreateItemizedExpense}
          disabled={loading}
          className="flex-1"
        >
          {loading ? 'Creating...' : 'Create & Share Link'}
        </Button>
      </div>
    </div>
  )
}
