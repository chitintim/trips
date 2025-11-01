import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth'
import { Modal, Button, Input, Select, Badge } from './ui'
import { convertCurrency, formatCurrency, getSupportedCurrencies, type Currency } from '../lib/currency'
import { uploadReceipt } from '../lib/receiptUpload'
import { Database } from '../types/database.types'

type ExpenseCategory = Database['public']['Enums']['expense_category']
type SplitType = Database['public']['Enums']['split_type']

interface SplitData {
  userId: string
  amount?: number
  percentage?: number
}

interface AddExpenseModalProps {
  isOpen: boolean
  onClose: () => void
  tripId: string
  participants: any[]
  onSuccess: () => void
}

export function AddExpenseModal({
  isOpen,
  onClose,
  tripId,
  participants,
  onSuccess
}: AddExpenseModalProps) {
  const { user } = useAuth()
  const [step, setStep] = useState(1)
  const [loading, setLoading] = useState(false)

  // Step 1: Basic Info
  const [description, setDescription] = useState('')
  const [amount, setAmount] = useState('')
  const [currency, setCurrency] = useState<Currency>('GBP')
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().split('T')[0])
  const [category, setCategory] = useState<ExpenseCategory>('other')
  const [vendorName, setVendorName] = useState('')
  const [location, setLocation] = useState('')
  const [receiptFile, setReceiptFile] = useState<File | null>(null)

  // Step 2: Who Paid
  const [paidBy, setPaidBy] = useState(user?.id || '')

  // Step 3: Split Method
  const [splitType, setSplitType] = useState<SplitType>('equal')
  const [selectedParticipants, setSelectedParticipants] = useState<string[]>([])
  const [splits, setSplits] = useState<Record<string, SplitData>>({})

  // Step 4: Review (calculated)
  const [baseCurrencyAmount, setBaseCurrencyAmount] = useState<number | null>(null)
  const [fxRate, setFxRate] = useState<number | null>(null)

  useEffect(() => {
    if (isOpen && user) {
      // Reset form
      setStep(1)
      setDescription('')
      setAmount('')
      setCurrency('GBP')
      setPaymentDate(new Date().toISOString().split('T')[0])
      setCategory('other')
      setVendorName('')
      setLocation('')
      setPaidBy(user.id)
      setSplitType('equal')
      setSelectedParticipants([])
      setSplits({})
      setBaseCurrencyAmount(null)
      setFxRate(null)
      setReceiptFile(null)
    }
  }, [isOpen, user])

  const handleNext = async () => {
    // Validation for each step
    if (step === 1) {
      if (!description.trim() || !amount || parseFloat(amount) <= 0) {
        alert('Please enter a description and valid amount')
        return
      }
    }

    if (step === 2) {
      if (!paidBy) {
        alert('Please select who paid')
        return
      }
    }

    if (step === 3) {
      if (selectedParticipants.length === 0) {
        alert('Please select at least one person to split with')
        return
      }

      // Validate splits based on type
      if (splitType === 'custom') {
        // Check for zero or missing amounts
        const hasZeroAmount = selectedParticipants.some(userId => {
          const amount = splits[userId]?.amount || 0
          return amount <= 0
        })
        if (hasZeroAmount) {
          alert('All selected participants must have an amount greater than 0')
          return
        }

        const totalSplit = selectedParticipants.reduce((sum, userId) => {
          return sum + (splits[userId]?.amount || 0)
        }, 0)
        const amountNum = parseFloat(amount)
        if (Math.abs(totalSplit - amountNum) > 0.01) {
          alert(`Split amounts (${formatCurrency(totalSplit, currency)}) must equal total (${formatCurrency(amountNum, currency)})`)
          return
        }
      }

      if (splitType === 'percentage') {
        // Check for zero or missing percentages
        const hasZeroPercentage = selectedParticipants.some(userId => {
          const percentage = splits[userId]?.percentage || 0
          return percentage <= 0
        })
        if (hasZeroPercentage) {
          alert('All selected participants must have a percentage greater than 0')
          return
        }

        const totalPercentage = selectedParticipants.reduce((sum, userId) => {
          return sum + (splits[userId]?.percentage || 0)
        }, 0)
        if (Math.abs(totalPercentage - 100) > 0.01) {
          alert(`Percentages must add up to 100% (currently ${totalPercentage.toFixed(1)}%)`)
          return
        }
      }

      // Calculate FX conversion for review
      if (currency !== 'GBP') {
        const conversion = await convertCurrency(parseFloat(amount), currency, paymentDate, 'GBP')
        if (conversion) {
          setBaseCurrencyAmount(conversion.convertedAmount)
          setFxRate(conversion.rate.rate)
        }
      } else {
        setBaseCurrencyAmount(parseFloat(amount))
        setFxRate(1)
      }
    }

    setStep(step + 1)
  }

  const handleBack = () => {
    setStep(step - 1)
  }

  const handleSubmit = async () => {
    setLoading(true)

    try {
      const amountNum = parseFloat(amount)
      let receiptUrl: string | null = null

      // Upload receipt if provided
      if (receiptFile && user) {
        try {
          const uploadResult = await uploadReceipt(receiptFile, user.id)
          receiptUrl = uploadResult.path // Store path, not full URL
          console.log('Receipt uploaded:', receiptUrl)
        } catch (uploadError: any) {
          console.error('Receipt upload failed:', uploadError)
          alert(`Receipt upload failed: ${uploadError.message}\n\nExpense will be created without receipt.`)
        }
      }

      // Insert expense
      const { data: expenseData, error: expenseError } = await supabase
        .from('expenses')
        .insert({
          trip_id: tripId,
          paid_by: paidBy,
          amount: amountNum,
          currency,
          description: description.trim(),
          payment_date: paymentDate,
          category,
          vendor_name: vendorName.trim() || null,
          location: location.trim() || null,
          base_currency_amount: baseCurrencyAmount,
          fx_rate: fxRate,
          fx_rate_date: currency !== 'GBP' ? paymentDate : null,
          receipt_url: receiptUrl
        })
        .select()
        .single()

      if (expenseError) throw expenseError

      // Calculate split amounts and filter out zero amounts
      const splitInserts = selectedParticipants
        .map(userId => {
          let splitAmount: number
          let splitPercentage: number | null = null
          let splitBaseCurrencyAmount: number | null = null

          if (splitType === 'equal') {
            splitAmount = amountNum / selectedParticipants.length
            if (baseCurrencyAmount) {
              splitBaseCurrencyAmount = baseCurrencyAmount / selectedParticipants.length
            }
          } else if (splitType === 'custom') {
            splitAmount = splits[userId]?.amount || 0
            if (baseCurrencyAmount && fxRate) {
              splitBaseCurrencyAmount = splitAmount * fxRate
            }
          } else { // percentage
            splitPercentage = splits[userId]?.percentage || 0
            splitAmount = (amountNum * splitPercentage) / 100
            if (baseCurrencyAmount) {
              splitBaseCurrencyAmount = (baseCurrencyAmount * splitPercentage) / 100
            }
          }

          return {
            expense_id: expenseData.id,
            user_id: userId,
            amount: splitAmount,
            split_type: splitType,
            percentage: splitPercentage,
            base_currency_amount: splitBaseCurrencyAmount
          }
        })
        .filter(split => split.amount > 0) // Filter out zero amounts to avoid constraint violation

      const { error: splitsError } = await supabase
        .from('expense_splits')
        .insert(splitInserts)

      if (splitsError) throw splitsError

      onSuccess()
      onClose()
    } catch (error: any) {
      console.error('Error adding expense:', error)
      alert(`Error adding expense: ${error.message}`)
    } finally {
      setLoading(false)
    }
  }

  const toggleParticipant = (userId: string) => {
    if (selectedParticipants.includes(userId)) {
      setSelectedParticipants(selectedParticipants.filter(id => id !== userId))
      const newSplits = { ...splits }
      delete newSplits[userId]
      setSplits(newSplits)
    } else {
      setSelectedParticipants([...selectedParticipants, userId])
      // Initialize split data
      if (splitType === 'equal') {
        // No initialization needed for equal
      } else if (splitType === 'custom') {
        setSplits({
          ...splits,
          [userId]: { userId, amount: 0 }
        })
      } else {
        setSplits({
          ...splits,
          [userId]: { userId, percentage: 0 }
        })
      }
    }
  }

  const updateSplit = (userId: string, value: number) => {
    setSplits({
      ...splits,
      [userId]: {
        userId,
        ...(splitType === 'custom' ? { amount: value } : { percentage: value })
      }
    })
  }

  const getCategoryOptions = (): Array<{ value: ExpenseCategory; label: string }> => {
    return [
      { value: 'accommodation', label: '🏠 Accommodation' },
      { value: 'transport', label: '🚗 Transport' },
      { value: 'food', label: '🍽️ Food & Dining' },
      { value: 'activities', label: '⛷️ Activities' },
      { value: 'equipment', label: '🎿 Equipment' },
      { value: 'other', label: '📦 Other' }
    ]
  }

  const getCurrencyOptions = () => {
    return getSupportedCurrencies().map(curr => ({
      value: curr,
      label: `${curr} - ${getCurrencyName(curr)}`
    }))
  }

  const getCurrencyName = (curr: Currency): string => {
    const names: Record<Currency, string> = {
      GBP: 'British Pound',
      EUR: 'Euro',
      USD: 'US Dollar',
      CHF: 'Swiss Franc',
      JPY: 'Japanese Yen',
      AUD: 'Australian Dollar',
      CAD: 'Canadian Dollar'
    }
    return names[curr]
  }

  const renderStep = () => {
    switch (step) {
      case 1:
        return (
          <div className="space-y-4">
            <h3 className="text-lg font-semibold text-gray-900">Basic Information</h3>

            <Input
              label="Description *"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g., Restaurant dinner, Ski lift tickets"
              maxLength={500}
            />

            <div className="grid grid-cols-2 gap-4">
              <Input
                label="Amount *"
                type="number"
                step="0.01"
                min="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
              />

              <Select
                label="Currency *"
                value={currency}
                onChange={(e) => setCurrency(e.target.value as Currency)}
                options={getCurrencyOptions()}
              />
            </div>

            <Input
              label="Payment Date *"
              type="date"
              value={paymentDate}
              onChange={(e) => setPaymentDate(e.target.value)}
            />

            <Select
              label="Category *"
              value={category}
              onChange={(e) => setCategory(e.target.value as ExpenseCategory)}
              options={getCategoryOptions()}
            />

            <Input
              label="Vendor/Company (optional)"
              value={vendorName}
              onChange={(e) => setVendorName(e.target.value)}
              placeholder="e.g., Lift pass office, La Folie Douce"
              maxLength={200}
            />

            <Input
              label="Location (optional)"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="e.g., Val Thorens, France"
              maxLength={200}
            />

            {/* Receipt Upload */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Receipt (optional)
              </label>
              <input
                type="file"
                accept="image/jpeg,image/jpg,image/png,image/heic,image/heif,application/pdf"
                onChange={(e) => setReceiptFile(e.target.files?.[0] || null)}
                className="block w-full text-sm text-gray-500
                  file:mr-4 file:py-2 file:px-4
                  file:rounded-lg file:border-0
                  file:text-sm file:font-medium
                  file:bg-sky-50 file:text-sky-700
                  hover:file:bg-sky-100
                  file:cursor-pointer cursor-pointer"
              />
              <p className="mt-1 text-xs text-gray-500">
                Supports: JPEG, PNG, HEIC (iPhone), PDF • Max 6MB (will be compressed)
              </p>
              {receiptFile && (
                <div className="mt-2 text-sm text-gray-700">
                  Selected: <strong>{receiptFile.name}</strong> ({(receiptFile.size / 1024 / 1024).toFixed(2)}MB)
                </div>
              )}
            </div>
          </div>
        )

      case 2:
        return (
          <div className="space-y-4">
            <h3 className="text-lg font-semibold text-gray-900">Who Paid?</h3>
            <p className="text-sm text-gray-600">Select the person who paid for this expense</p>

            <div className="space-y-2">
              {participants.map(participant => (
                <button
                  key={participant.user_id}
                  onClick={() => setPaidBy(participant.user_id)}
                  className={`w-full flex items-center gap-3 p-3 rounded-lg border-2 transition-colors ${
                    paidBy === participant.user_id
                      ? 'border-sky-500 bg-sky-50'
                      : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <div
                    className="w-10 h-10 rounded-full flex items-center justify-center text-xl flex-shrink-0"
                    style={{
                      backgroundColor: (participant.user.avatar_data as any)?.bgColor || '#0ea5e9',
                    }}
                  >
                    <span className="relative">
                      {(participant.user.avatar_data as any)?.emoji || '😊'}
                    </span>
                  </div>
                  <div className="text-left flex-1">
                    <div className="font-medium text-gray-900">
                      {participant.user.full_name || participant.user.email}
                    </div>
                    <div className="text-sm text-gray-500">
                      {participant.user.email}
                    </div>
                  </div>
                  {paidBy === participant.user_id && (
                    <Badge variant="success">Selected</Badge>
                  )}
                </button>
              ))}
            </div>
          </div>
        )

      case 3:
        return (
          <div className="space-y-4">
            <h3 className="text-lg font-semibold text-gray-900">Split Method</h3>

            {/* Split Type Selector */}
            <div className="flex gap-2">
              <button
                onClick={() => setSplitType('equal')}
                className={`flex-1 px-4 py-2 rounded-lg border-2 font-medium transition-colors ${
                  splitType === 'equal'
                    ? 'border-sky-500 bg-sky-50 text-sky-700'
                    : 'border-gray-200 text-gray-700 hover:border-gray-300'
                }`}
              >
                Equal Split
              </button>
              <button
                onClick={() => setSplitType('custom')}
                className={`flex-1 px-4 py-2 rounded-lg border-2 font-medium transition-colors ${
                  splitType === 'custom'
                    ? 'border-sky-500 bg-sky-50 text-sky-700'
                    : 'border-gray-200 text-gray-700 hover:border-gray-300'
                }`}
              >
                Custom Amounts
              </button>
              <button
                onClick={() => setSplitType('percentage')}
                className={`flex-1 px-4 py-2 rounded-lg border-2 font-medium transition-colors ${
                  splitType === 'percentage'
                    ? 'border-sky-500 bg-sky-50 text-sky-700'
                    : 'border-gray-200 text-gray-700 hover:border-gray-300'
                }`}
              >
                Percentage
              </button>
            </div>

            {/* Participant Selection */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Select people to split with *
              </label>
              <div className="space-y-2">
                {participants.map(participant => (
                  <div key={participant.user_id}>
                    <button
                      onClick={() => toggleParticipant(participant.user_id)}
                      className={`w-full flex items-center gap-3 p-3 rounded-lg border-2 transition-colors ${
                        selectedParticipants.includes(participant.user_id)
                          ? 'border-sky-500 bg-sky-50'
                          : 'border-gray-200 hover:border-gray-300'
                      }`}
                    >
                      <div
                        className="w-8 h-8 rounded-full flex items-center justify-center text-lg flex-shrink-0"
                        style={{
                          backgroundColor: (participant.user.avatar_data as any)?.bgColor || '#0ea5e9',
                        }}
                      >
                        <span className="relative">
                          {(participant.user.avatar_data as any)?.emoji || '😊'}
                        </span>
                      </div>
                      <div className="text-left flex-1">
                        <div className="font-medium text-gray-900">
                          {participant.user.full_name || participant.user.email}
                        </div>
                      </div>
                      {selectedParticipants.includes(participant.user_id) && (
                        <Badge variant="success">✓</Badge>
                      )}
                    </button>

                    {/* Custom amount/percentage input */}
                    {selectedParticipants.includes(participant.user_id) && splitType !== 'equal' && (
                      <div className="mt-2 ml-11">
                        <Input
                          type="number"
                          step={splitType === 'percentage' ? '0.1' : '0.01'}
                          min="0"
                          max={splitType === 'percentage' ? '100' : undefined}
                          value={
                            splitType === 'custom'
                              ? splits[participant.user_id]?.amount || ''
                              : splits[participant.user_id]?.percentage || ''
                          }
                          onChange={(e) => updateSplit(participant.user_id, parseFloat(e.target.value) || 0)}
                          placeholder={splitType === 'custom' ? '0.00' : '0.0'}
                          label={splitType === 'custom' ? 'Amount' : 'Percentage (%)'}
                        />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Running Total */}
            {selectedParticipants.length > 0 && (
              <div className="bg-gray-100 p-4 rounded-lg">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600">Total expense:</span>
                  <span className="font-medium">{formatCurrency(parseFloat(amount) || 0, currency)}</span>
                </div>
                {splitType === 'equal' && (
                  <div className="flex justify-between text-sm mt-1">
                    <span className="text-gray-600">Per person:</span>
                    <span className="font-medium">
                      {formatCurrency((parseFloat(amount) || 0) / selectedParticipants.length, currency)}
                    </span>
                  </div>
                )}
                {splitType === 'custom' && (
                  <div className="flex justify-between text-sm mt-1">
                    <span className="text-gray-600">Split total:</span>
                    <span className={`font-medium ${
                      Math.abs(selectedParticipants.reduce((sum, id) => sum + (splits[id]?.amount || 0), 0) - (parseFloat(amount) || 0)) < 0.01
                        ? 'text-green-600'
                        : 'text-red-600'
                    }`}>
                      {formatCurrency(
                        selectedParticipants.reduce((sum, id) => sum + (splits[id]?.amount || 0), 0),
                        currency
                      )}
                    </span>
                  </div>
                )}
                {splitType === 'percentage' && (
                  <div className="flex justify-between text-sm mt-1">
                    <span className="text-gray-600">Total percentage:</span>
                    <span className={`font-medium ${
                      Math.abs(selectedParticipants.reduce((sum, id) => sum + (splits[id]?.percentage || 0), 0) - 100) < 0.01
                        ? 'text-green-600'
                        : 'text-red-600'
                    }`}>
                      {selectedParticipants.reduce((sum, id) => sum + (splits[id]?.percentage || 0), 0).toFixed(1)}%
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        )

      case 4:
        return (
          <div className="space-y-4">
            <h3 className="text-lg font-semibold text-gray-900">Review & Submit</h3>

            {/* Expense Summary */}
            <div className="bg-gray-50 p-4 rounded-lg space-y-3">
              <div>
                <div className="text-sm text-gray-600">Description</div>
                <div className="font-medium text-gray-900">{description}</div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="text-sm text-gray-600">Amount</div>
                  <div className="font-medium text-gray-900">{formatCurrency(parseFloat(amount), currency)}</div>
                </div>
                <div>
                  <div className="text-sm text-gray-600">Date</div>
                  <div className="font-medium text-gray-900">{new Date(paymentDate).toLocaleDateString('en-GB')}</div>
                </div>
              </div>

              {currency !== 'GBP' && baseCurrencyAmount && fxRate && (
                <div className="bg-sky-50 p-3 rounded border border-sky-200">
                  <div className="text-sm text-sky-700">
                    Converted to GBP: <strong>{formatCurrency(baseCurrencyAmount, 'GBP')}</strong>
                  </div>
                  <div className="text-xs text-sky-600 mt-1">
                    Rate: 1 {currency} = {fxRate.toFixed(4)} GBP on {new Date(paymentDate).toLocaleDateString('en-GB')}
                  </div>
                </div>
              )}

              <div>
                <div className="text-sm text-gray-600">Paid by</div>
                <div className="font-medium text-gray-900">
                  {participants.find(p => p.user_id === paidBy)?.user.full_name || 'Unknown'}
                </div>
              </div>
            </div>

            {/* Split Summary */}
            <div>
              <h4 className="font-medium text-gray-900 mb-2">Split Details</h4>
              <div className="space-y-2">
                {selectedParticipants.map(userId => {
                  const participant = participants.find(p => p.user_id === userId)
                  let splitAmount: number

                  if (splitType === 'equal') {
                    splitAmount = parseFloat(amount) / selectedParticipants.length
                  } else if (splitType === 'custom') {
                    splitAmount = splits[userId]?.amount || 0
                  } else {
                    splitAmount = (parseFloat(amount) * (splits[userId]?.percentage || 0)) / 100
                  }

                  return (
                    <div key={userId} className="flex items-center justify-between p-2 bg-gray-50 rounded">
                      <div className="flex items-center gap-2">
                        <div
                          className="w-6 h-6 rounded-full flex items-center justify-center text-sm"
                          style={{
                            backgroundColor: (participant?.user.avatar_data as any)?.bgColor || '#0ea5e9',
                          }}
                        >
                          <span>{(participant?.user.avatar_data as any)?.emoji || '😊'}</span>
                        </div>
                        <span className="text-sm text-gray-900">
                          {participant?.user.full_name || 'Unknown'}
                        </span>
                      </div>
                      <span className="font-medium text-gray-900">
                        {formatCurrency(splitAmount, currency)}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        )

      default:
        return null
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Add Expense" size="lg">
      {/* Step Indicator */}
      <div className="flex items-center justify-between mb-6">
        {[1, 2, 3, 4].map((s) => (
          <div key={s} className="flex items-center">
            <div
              className={`w-8 h-8 rounded-full flex items-center justify-center font-medium ${
                s === step
                  ? 'bg-sky-500 text-white'
                  : s < step
                  ? 'bg-green-500 text-white'
                  : 'bg-gray-200 text-gray-600'
              }`}
            >
              {s < step ? '✓' : s}
            </div>
            {s < 4 && (
              <div
                className={`w-16 h-0.5 ${
                  s < step ? 'bg-green-500' : 'bg-gray-200'
                }`}
              />
            )}
          </div>
        ))}
      </div>

      {/* Step Content */}
      {renderStep()}

      {/* Footer Buttons */}
      <div className="flex justify-between mt-6 pt-6 border-t border-gray-200">
        <Button
          variant="outline"
          onClick={step === 1 ? onClose : handleBack}
          disabled={loading}
        >
          {step === 1 ? 'Cancel' : 'Back'}
        </Button>
        <Button
          variant="primary"
          onClick={step === 4 ? handleSubmit : handleNext}
          disabled={loading}
        >
          {loading ? 'Saving...' : step === 4 ? 'Add Expense' : 'Next'}
        </Button>
      </div>
    </Modal>
  )
}
