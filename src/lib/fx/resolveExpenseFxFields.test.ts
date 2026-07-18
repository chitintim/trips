import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resolveExpenseFxFields, splitBaseCurrencyAmount } from './resolveExpenseFxFields'
import { fetchRate } from './fetchRate'

vi.mock('./fetchRate', () => ({ fetchRate: vi.fn() }))

const mockedFetchRate = vi.mocked(fetchRate)

beforeEach(() => {
  mockedFetchRate.mockReset()
})

describe('resolveExpenseFxFields', () => {
  it('same currency -> all-null fields, no fetch', async () => {
    const fx = await resolveExpenseFxFields({ amountMajor: 100, currency: 'GBP', baseCurrency: 'GBP', paymentDate: '2026-07-01' })
    expect(fx).toEqual({ fx_rate: null, fx_rate_date: null, base_currency_amount: null, rate_source: null })
    expect(mockedFetchRate).not.toHaveBeenCalled()
  })

  it('manual override wins over any fetch and writes rate_source=manual + base_currency_amount', async () => {
    const fx = await resolveExpenseFxFields({
      amountMajor: 200,
      currency: 'EUR',
      baseCurrency: 'GBP',
      paymentDate: '2026-07-01',
      manualRate: 0.85,
    })
    expect(fx).toEqual({ fx_rate: 0.85, fx_rate_date: null, base_currency_amount: 170, rate_source: 'manual' })
    expect(mockedFetchRate).not.toHaveBeenCalled()
  })

  it('persists an auto-fetched rate (fx_rate, fx_rate_date, base_currency_amount, rate_source)', async () => {
    mockedFetchRate.mockResolvedValue({ rate: 0.0053, date: '2026-07-01', from: 'JPY', to: 'GBP', source: 'frankfurter' })
    const fx = await resolveExpenseFxFields({
      amountMajor: 10000,
      currency: 'JPY',
      baseCurrency: 'GBP',
      paymentDate: '2026-07-01',
      today: '2026-07-02',
    })
    expect(fx).toEqual({ fx_rate: 0.0053, fx_rate_date: '2026-07-01', base_currency_amount: 53, rate_source: 'frankfurter' })
    expect(mockedFetchRate).toHaveBeenCalledWith('2026-07-01', 'JPY', 'GBP', '2026-07-02')
  })

  it('fetch returning null -> all-null fields (expense still saves, warning behavior stays)', async () => {
    mockedFetchRate.mockResolvedValue(null)
    const fx = await resolveExpenseFxFields({ amountMajor: 100, currency: 'EUR', baseCurrency: 'GBP', paymentDate: '2026-07-01' })
    expect(fx).toEqual({ fx_rate: null, fx_rate_date: null, base_currency_amount: null, rate_source: null })
  })

  it('fetch throwing -> all-null fields, never throws', async () => {
    mockedFetchRate.mockRejectedValue(new Error('network down'))
    const fx = await resolveExpenseFxFields({ amountMajor: 100, currency: 'EUR', baseCurrency: 'GBP', paymentDate: '2026-07-01' })
    expect(fx).toEqual({ fx_rate: null, fx_rate_date: null, base_currency_amount: null, rate_source: null })
  })

  it('zero/invalid manual rate falls through to auto fetch', async () => {
    mockedFetchRate.mockResolvedValue({ rate: 1.2, date: '2026-07-01', from: 'EUR', to: 'GBP', source: 'db' })
    const fx = await resolveExpenseFxFields({
      amountMajor: 10,
      currency: 'EUR',
      baseCurrency: 'GBP',
      paymentDate: '2026-07-01',
      manualRate: 0,
    })
    expect(fx.rate_source).toBe('db')
    expect(fx.fx_rate).toBe(1.2)
  })
})

describe('splitBaseCurrencyAmount', () => {
  it('converts a split amount with the resolved rate', () => {
    expect(splitBaseCurrencyAmount(50, { fx_rate: 0.5, fx_rate_date: '2026-07-01', base_currency_amount: 50, rate_source: 'frankfurter' })).toBe(25)
  })
  it('null when no rate resolved', () => {
    expect(splitBaseCurrencyAmount(50, { fx_rate: null, fx_rate_date: null, base_currency_amount: null, rate_source: null })).toBeNull()
  })
})
