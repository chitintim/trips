import { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth'
import { Modal, Button, Input, Select, Badge } from './ui'
import { convertCurrency, formatCurrency, getSupportedCurrencies, type Currency } from '../lib/currency'
import { uploadReceipt } from '../lib/receiptUpload'
import { parseReceipt, type ParsedReceiptData } from '../lib/receiptParsing'
import { ItemizedSplitWizard } from './ItemizedSplitWizard'
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

  // AI Receipt Parsing
  const [parsingReceipt, setParsingReceipt] = useState(false)
  const [parsedData, setParsedData] = useState<ParsedReceiptData | null>(null)
  const [parseError, setParseError] = useState<string | null>(null)
  const [parsingProgress, setParsingProgress] = useState(0)
  const [parsingMessage, setParsingMessage] = useState('')
  const [uploadedReceiptPath, setUploadedReceiptPath] = useState<string | null>(null)

  // Step 2: Who Paid
  const [paidBy, setPaidBy] = useState(user?.id || '')

  // Step 3: Split Method
  const [splitType, setSplitType] = useState<SplitType>('equal')
  const [useItemizedSplit, setUseItemizedSplit] = useState(false)
  const [selectedParticipants, setSelectedParticipants] = useState<string[]>([])
  const [splits, setSplits] = useState<Record<string, SplitData>>({})

  // Step 4: Review (calculated)
  const [baseCurrencyAmount, setBaseCurrencyAmount] = useState<number | null>(null)
  const [fxRate, setFxRate] = useState<number | null>(null)

  // Track if modal was previously open to detect fresh opens vs. re-renders
  const wasOpenRef = useRef(false)
  const sessionIdRef = useRef<string | null>(null)

  // Load saved draft from localStorage
  useEffect(() => {
    if (isOpen && user) {
      // Detect fresh open (transition from closed to open)
      const isFreshOpen = !wasOpenRef.current
      wasOpenRef.current = true

      const draftKey = `expense_draft_${tripId}`
      const savedDraft = localStorage.getItem(draftKey)

      if (savedDraft) {
        try {
          const draft = JSON.parse(savedDraft)
          setDescription(draft.description || '')
          setAmount(draft.amount || '')
          setCurrency(draft.currency || 'GBP')
          setPaymentDate(draft.paymentDate || new Date().toISOString().split('T')[0])
          setCategory(draft.category || 'other')
          setVendorName(draft.vendorName || '')
          setLocation(draft.location || '')
        } catch (err) {
          console.error('Failed to load draft:', err)
        }
      }

      // Load parsing state if it exists
      const parsingKey = `expense_parsing_${tripId}`
      const savedParsing = localStorage.getItem(parsingKey)

      if (savedParsing) {
        try {
          const parsingState = JSON.parse(savedParsing)

          // If parsing was interrupted, clear it and show message
          if (parsingState.parsingReceipt) {
            setParseError('Parsing was interrupted. Please try again.')
            // Clear the interrupted parsing state
            localStorage.removeItem(parsingKey)
          } else {
            // Restore completed parsing state
            if (parsingState.parsedData) {
              setParsedData(parsingState.parsedData)
            }
            if (parsingState.uploadedReceiptPath) {
              setUploadedReceiptPath(parsingState.uploadedReceiptPath)
            }
            // Note: We can't restore the actual File object, but we show the parsing was successful
          }
        } catch (err) {
          console.error('Failed to load parsing state:', err)
        }
      }

      // Load step state (persists across app switches on mobile)
      const stepKey = `expense_step_${tripId}`
      const savedStep = localStorage.getItem(stepKey)

      if (isFreshOpen) {
        // Fresh open: check if we have saved step state from interrupted session
        if (savedStep) {
          try {
            const stepState = JSON.parse(savedStep)
            // Restore step state if session is recent (within last hour)
            const savedAt = new Date(stepState.savedAt).getTime()
            const now = Date.now()
            const oneHour = 60 * 60 * 1000

            if (now - savedAt < oneHour && stepState.sessionId) {
              // Restore the session
              sessionIdRef.current = stepState.sessionId
              setStep(stepState.step || 1)
              setPaidBy(stepState.paidBy || user.id)
              setSplitType(stepState.splitType || 'equal')
              setUseItemizedSplit(stepState.useItemizedSplit || false)
            } else {
              // Session expired, start fresh
              sessionIdRef.current = Date.now().toString()
              setStep(1)
              setPaidBy(user.id)
              setSplitType('equal')
              setUseItemizedSplit(false)
              localStorage.removeItem(stepKey)
            }
          } catch (err) {
            console.error('Failed to load step state:', err)
            sessionIdRef.current = Date.now().toString()
            setStep(1)
            setPaidBy(user.id)
            setSplitType('equal')
            setUseItemizedSplit(false)
          }
        } else {
          // No saved step state, start fresh
          sessionIdRef.current = Date.now().toString()
          setStep(1)
          setPaidBy(user.id)
          setSplitType('equal')
          setUseItemizedSplit(false)
        }

        // Always reset these on fresh open
        setSelectedParticipants([])
        setSplits({})
        setBaseCurrencyAmount(null)
        setFxRate(null)
        setReceiptFile(null)
        setParsingReceipt(false)
        setParsingProgress(0)
        setParsingMessage('')
      }
      // If not fresh open (re-render while modal is open), don't reset anything
    } else if (!isOpen) {
      // Modal is closing
      wasOpenRef.current = false
    }
  }, [isOpen, user, tripId])

  // Save step state to localStorage whenever it changes (for mobile app switching)
  useEffect(() => {
    if (isOpen && sessionIdRef.current) {
      const stepKey = `expense_step_${tripId}`
      const stepState = {
        sessionId: sessionIdRef.current,
        step,
        paidBy,
        splitType,
        useItemizedSplit,
        savedAt: new Date().toISOString()
      }
      localStorage.setItem(stepKey, JSON.stringify(stepState))
    }
  }, [isOpen, tripId, step, paidBy, splitType, useItemizedSplit])

  // Save draft to localStorage whenever form fields change
  useEffect(() => {
    if (isOpen && description) {
      const draftKey = `expense_draft_${tripId}`
      const draft = {
        description,
        amount,
        currency,
        paymentDate,
        category,
        vendorName,
        location,
        savedAt: new Date().toISOString()
      }
      localStorage.setItem(draftKey, JSON.stringify(draft))
    }
  }, [isOpen, tripId, description, amount, currency, paymentDate, category, vendorName, location])

  // Save parsing state separately (including receipt file info)
  useEffect(() => {
    if (isOpen) {
      const parsingKey = `expense_parsing_${tripId}`
      const parsingState = {
        hasReceiptFile: !!receiptFile,
        receiptFileName: receiptFile?.name,
        receiptFileSize: receiptFile?.size,
        parsingReceipt,
        parsedData,
        parseError,
        uploadedReceiptPath,
        savedAt: new Date().toISOString()
      }
      localStorage.setItem(parsingKey, JSON.stringify(parsingState))
    }
  }, [isOpen, tripId, receiptFile, parsingReceipt, parsedData, parseError, uploadedReceiptPath])

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
      // If using itemized split, the wizard handles everything - no validation needed
      if (useItemizedSplit) {
        // Itemized split wizard is self-contained, should not reach here
        return
      }

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
        try {
          const conversion = await convertCurrency(parseFloat(amount), currency, paymentDate, 'GBP')
          if (conversion) {
            setBaseCurrencyAmount(conversion.convertedAmount)
            setFxRate(conversion.rate.rate)
          } else {
            // FX conversion failed - use 1:1 rate as fallback but warn user
            alert(`Warning: Could not fetch exchange rate for ${currency} to GBP. Using amount as-is. You can edit the expense later if needed.`)
            setBaseCurrencyAmount(parseFloat(amount))
            setFxRate(null)
          }
        } catch (error) {
          console.error('FX conversion error:', error)
          alert(`Warning: Exchange rate conversion failed. Using amount as-is. You can edit the expense later if needed.`)
          setBaseCurrencyAmount(parseFloat(amount))
          setFxRate(null)
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
    console.log('handleSubmit called - starting submission')
    setLoading(true)

    try {
      const amountNum = parseFloat(amount)
      console.log('Submitting expense:', { amount: amountNum, currency, baseCurrencyAmount, selectedParticipants: selectedParticipants.length })

      // Ensure baseCurrencyAmount is set (should have been set in step 3)
      if (!baseCurrencyAmount) {
        console.error('baseCurrencyAmount not set - this should not happen!')
        alert('Error: Currency conversion not completed. Please go back and try again.')
        setLoading(false)
        return
      }

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

      // Clear draft and step state on success
      localStorage.removeItem(`expense_draft_${tripId}`)
      localStorage.removeItem(`expense_step_${tripId}`)

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

  const handleParseReceipt = async () => {
    if (!receiptFile || !user) return

    setParsingReceipt(true)
    setParseError(null)
    setParsingProgress(0)
    setParsingMessage('Uploading receipt...')

    // Fake progress bar with non-linear timing
    let progressInterval: NodeJS.Timeout
    let elapsedSeconds = 0
    let currentProgress = 0
    let completed = false

    const updateProgress = () => {
      elapsedSeconds++

      // Non-linear progress curve
      if (elapsedSeconds <= 3) {
        // 0-3s: Fast start (0-15%)
        currentProgress = elapsedSeconds * 5
        setParsingMessage('Uploading receipt...')
      } else if (elapsedSeconds <= 10) {
        // 3-10s: Moderate (15-35%)
        currentProgress = 15 + (elapsedSeconds - 3) * 2.86
        setParsingMessage('AI analyzing receipt structure...')
      } else if (elapsedSeconds <= 30) {
        // 10-30s: Slower middle (35-60%)
        currentProgress = 35 + (elapsedSeconds - 10) * 1.25
        setParsingMessage('Extracting items and prices...')
      } else if (elapsedSeconds <= 60) {
        // 30-60s: Very slow (60-85%)
        currentProgress = 60 + (elapsedSeconds - 30) * 0.83
        setParsingMessage('Calculating taxes and totals...')
      } else if (elapsedSeconds <= 85) {
        // 60-85s: Crawling to finish (85-95%)
        currentProgress = 85 + (elapsedSeconds - 60) * 0.4
        setParsingMessage('Translating and validating...')
      } else {
        // 85+s: Stay at 95% until complete
        currentProgress = 95
        setParsingMessage('Almost there...')
      }

      setParsingProgress(Math.min(currentProgress, 95))

      // If completed early, accelerate to 100%
      if (completed) {
        clearInterval(progressInterval)
        setParsingProgress(100)
        setParsingMessage('Finalizing results...')
      }
    }

    progressInterval = setInterval(updateProgress, 1000)

    try {
      // 1. Upload receipt to Supabase Storage first
      const uploadResult = await uploadReceipt(receiptFile, user.id)
      setUploadedReceiptPath(uploadResult.path) // Store path for later use

      // 2. Call Edge Function to parse (takes 75-100 seconds)
      const parsed = await parseReceipt(uploadResult.path, tripId)

      // Signal completion to progress bar
      completed = true

      // Wait for progress to catch up
      await new Promise(resolve => setTimeout(resolve, 500))

      setParsedData(parsed)

      // 3. Auto-populate form fields from parsed data
      setDescription(parsed.vendor_name)
      setVendorName(parsed.vendor_name)
      if (parsed.vendor_location) setLocation(parsed.vendor_location)
      setAmount(parsed.total.toString())
      setCurrency(parsed.currency as Currency)
      if (parsed.receipt_date) setPaymentDate(parsed.receipt_date)

      // Use LLM's category inference
      if (parsed.expense_category) {
        setCategory(parsed.expense_category as ExpenseCategory)
      }

      // Clear draft since AI filled it
      localStorage.removeItem(`expense_draft_${tripId}`)

    } catch (error: any) {
      completed = true
      clearInterval(progressInterval)
      console.error('Receipt parsing error:', error)
      setParseError(error.message || 'Failed to parse receipt. Please try again.')
    } finally {
      clearInterval(progressInterval)
      setParsingReceipt(false)
      setParsingProgress(0)
      setParsingMessage('')
    }
  }

  const renderStep = () => {
    switch (step) {
      case 1:
        return (
          <div className="space-y-4">
            <h3 className="text-lg font-semibold text-gray-900">Basic Information</h3>

            {/* Receipt Upload - MOVED TO TOP */}
            <div className="space-y-3">
              <label className="block text-sm font-medium text-gray-700">
                Receipt (optional - use AI to auto-fill form)
              </label>
              <input
                type="file"
                accept="image/jpeg,image/jpg,image/png,image/heic,image/heif,application/pdf"
                onChange={(e) => {
                  setReceiptFile(e.target.files?.[0] || null)
                  // Reset ALL parsing state when new file selected
                  setParsedData(null)
                  setParseError(null)
                  setUploadedReceiptPath(null)
                }}
                disabled={parsingReceipt}
                className="block w-full text-sm text-gray-500
                  file:mr-4 file:py-2 file:px-4
                  file:rounded-lg file:border-0
                  file:text-sm file:font-medium
                  file:bg-sky-50 file:text-sky-700
                  hover:file:bg-sky-100
                  file:cursor-pointer cursor-pointer
                  disabled:opacity-50 disabled:cursor-not-allowed"
              />
              <p className="text-xs text-gray-500">
                Supports: JPEG, PNG, PDF • Max 6MB (will be compressed)
              </p>
              <p className="text-xs text-amber-600 font-medium">
                📱 iPhone users: Please screenshot photos first before uploading
              </p>

              {(receiptFile || parsedData) && (
                <div className="space-y-2">
                  {receiptFile && (
                    <div className="text-sm text-gray-700">
                      Selected: <strong>{receiptFile.name}</strong> ({(receiptFile.size / 1024 / 1024).toFixed(2)}MB)
                    </div>
                  )}

                  {!receiptFile && parsedData && (
                    <div className="text-sm text-gray-700">
                      <span className="text-green-600">✓</span> Receipt was previously parsed and auto-filled fields
                    </div>
                  )}

                  {/* AI Parse Button - only show if we have a file and haven't parsed yet */}
                  {receiptFile && !parsedData && (
                    <Button
                      variant="secondary"
                      onClick={handleParseReceipt}
                      disabled={parsingReceipt}
                      className="w-full"
                    >
                      {parsingReceipt ? (
                        <span className="flex items-center justify-center gap-2">
                          <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                          </svg>
                          {parsingProgress > 0 ? `${Math.round(parsingProgress)}%` : 'Starting...'}
                        </span>
                      ) : (
                        '🤖 Parse Receipt with AI'
                      )}
                    </Button>
                  )}

                  {receiptFile && parsedData && (
                    <div className="text-sm font-medium text-green-600 py-2">
                      ✅ Receipt Parsed Successfully
                    </div>
                  )}

                  {/* Parsing Progress Bar */}
                  {parsingReceipt && (
                    <div className="space-y-2">
                      {/* Progress Bar */}
                      <div className="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
                        <div
                          className="bg-sky-500 h-2 transition-all duration-1000 ease-out"
                          style={{ width: `${parsingProgress}%` }}
                        />
                      </div>
                      {/* Progress Message */}
                      <div className="p-3 bg-sky-50 border border-sky-200 rounded-lg">
                        <p className="text-xs text-sky-900 font-medium">
                          {parsingMessage}
                        </p>
                        <p className="text-xs text-sky-700 mt-1">
                          Processing time: ~75-100 seconds. Your form will auto-fill when ready!
                        </p>
                      </div>
                    </div>
                  )}

                  {/* Success Message */}
                  {parsedData && (
                    <div className="p-3 bg-green-50 border border-green-200 rounded-lg">
                      <p className="text-sm font-medium text-green-900">
                        ✅ Receipt parsed successfully! Fields auto-filled below.
                      </p>
                      <p className="text-xs text-green-700 mt-1">
                        Found {parsedData.line_items.length} items • Total: {parsedData.currency} {parsedData.total.toFixed(2)}
                      </p>
                      {!parsedData.total_matches && (
                        <p className="text-xs text-amber-700 mt-1 font-medium">
                          ⚠️ Total mismatch detected - please review amounts
                        </p>
                      )}
                    </div>
                  )}

                  {/* Error Message */}
                  {parseError && (
                    <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
                      <p className="text-sm font-medium text-red-900">
                        ❌ Parsing failed
                      </p>
                      <p className="text-xs text-red-700 mt-1">{parseError}</p>
                      <Button
                        variant="outline"
                        onClick={handleParseReceipt}
                        className="mt-2 text-xs py-1 px-3"
                      >
                        Try Again
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Divider */}
            {receiptFile && <div className="border-t border-gray-200 my-4" />}

            {/* Form Fields */}
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
        // If user selected itemized split and we have parsed data, show the wizard
        if (useItemizedSplit && parsedData) {
          return (
            <ItemizedSplitWizard
              parsedData={parsedData}
              tripId={tripId}
              paidBy={paidBy}
              receiptUrl={uploadedReceiptPath}
              currency={currency}
              paymentDate={paymentDate}
              onSuccess={() => {
                // Clear ALL localStorage state on success (including parsing state)
                localStorage.removeItem(`expense_draft_${tripId}`)
                localStorage.removeItem(`expense_step_${tripId}`)
                localStorage.removeItem(`expense_parsing_${tripId}`)
                onSuccess()
                onClose()
              }}
              onBack={() => {
                setUseItemizedSplit(false)
              }}
            />
          )
        }

        // Regular split method selection
        return (
          <div className="space-y-4">
            <h3 className="text-lg font-semibold text-gray-900">Split Method</h3>

            {/* Split Type Selector */}
            <div className="flex gap-2 flex-wrap">
              <button
                onClick={() => {
                  setUseItemizedSplit(false)
                  setSplitType('equal')
                }}
                className={`flex-1 min-w-[120px] px-4 py-2 rounded-lg border-2 font-medium transition-colors ${
                  !useItemizedSplit && splitType === 'equal'
                    ? 'border-sky-500 bg-sky-50 text-sky-700'
                    : 'border-gray-200 text-gray-700 hover:border-gray-300'
                }`}
              >
                Equal Split
              </button>
              <button
                onClick={() => {
                  setUseItemizedSplit(false)
                  setSplitType('custom')
                }}
                className={`flex-1 min-w-[120px] px-4 py-2 rounded-lg border-2 font-medium transition-colors ${
                  !useItemizedSplit && splitType === 'custom'
                    ? 'border-sky-500 bg-sky-50 text-sky-700'
                    : 'border-gray-200 text-gray-700 hover:border-gray-300'
                }`}
              >
                Custom
              </button>
              <button
                onClick={() => {
                  setUseItemizedSplit(false)
                  setSplitType('percentage')
                }}
                className={`flex-1 min-w-[120px] px-4 py-2 rounded-lg border-2 font-medium transition-colors ${
                  !useItemizedSplit && splitType === 'percentage'
                    ? 'border-sky-500 bg-sky-50 text-sky-700'
                    : 'border-gray-200 text-gray-700 hover:border-gray-300'
                }`}
              >
                Percentage
              </button>

              {/* Itemized option - only show if we have parsed data */}
              {parsedData && (
                <button
                  onClick={() => {
                    setUseItemizedSplit(true)
                  }}
                  className={`flex-1 min-w-[120px] px-4 py-2 rounded-lg border-2 font-medium transition-colors ${
                    useItemizedSplit
                      ? 'border-purple-500 bg-purple-50 text-purple-700'
                      : 'border-gray-200 text-gray-700 hover:border-gray-300'
                  }`}
                >
                  🤖 Itemized
                </button>
              )}
            </div>

            {/* Show info badge for itemized option */}
            {parsedData && !useItemizedSplit && (
              <div className="bg-purple-50 border border-purple-200 rounded-lg p-3">
                <p className="text-xs text-purple-900 font-medium">
                  ✨ AI detected {parsedData.line_items.length} items - Try "Itemized" split!
                </p>
                <p className="text-xs text-purple-700 mt-1">
                  Let people claim which items they ordered instead of splitting equally.
                </p>
              </div>
            )}

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
      {/* Step Indicator - Hide when itemized wizard is showing */}
      {!(step === 3 && useItemizedSplit) && (
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
      )}

      {/* Step Content */}
      {renderStep()}

      {/* Footer Buttons - Hide when itemized wizard is showing */}
      {!(step === 3 && useItemizedSplit) && (
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
      )}
    </Modal>
  )
}
