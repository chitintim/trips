import { test, expect, type Page } from '@playwright/test'

/** Public /confirm-payment page with the payment-confirm function mocked. No sign-in, no live calls. */

const payment = { payerName: 'Salim', receiverName: 'Tim', amount: 105.11, currency: 'GBP', formatted: '£105.11', tripName: 'Japow', tripId: 'trip-1', note: null }
const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) })

/** Every call to the function is a POST with the token in the body; `calls` records [method, url, body]. */
async function mock(page: Page, opts: { peek: unknown; post?: unknown }) {
  const calls: Array<{ method: string; url: string; body: unknown }> = []
  await page.route('**/functions/v1/payment-confirm*', async (route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } })
    const body = req.method() === 'POST' ? req.postDataJSON() : null
    calls.push({ method: req.method(), url: req.url(), body })
    if (req.method() !== 'POST') return route.fulfill(json({ state: 'invalid' }, 405))
    return route.fulfill(json((body as { action: string }).action === 'peek' ? opts.peek : opts.post))
  })
  return calls
}

/** The dev server runs React StrictMode, which repeats the (read-only) peek; collapse repeats. */
const collapse = <T,>(xs: T[]) => xs.filter((x, i) => i === 0 || JSON.stringify(x) !== JSON.stringify(xs[i - 1]))

test.describe('confirm payment page', () => {
  test('valid link: shows whose payment it is, moves the token out of the URL, confirms', async ({ page }) => {
    const calls = await mock(page, { peek: { state: 'valid', payment }, post: { state: 'confirmed', payment } })
    await page.goto('/trips/confirm-payment?t=abc')
    await expect(page.getByText('Salim says they paid you £105.11 for Japow')).toBeVisible()
    await expect(page.getByText('For Tim')).toBeVisible()
    await expect(page.getByText('Check the money has arrived before you confirm.')).toBeVisible()
    // The token is no longer in the address bar, and the page asks not to send a referrer.
    expect(page.url()).not.toContain('t=abc')
    expect(new URL(page.url()).pathname).toBe('/trips/confirm-payment')
    await expect(page.locator('meta[name="referrer"]')).toHaveAttribute('content', 'no-referrer')
    await page.getByRole('button', { name: 'Yes, I received it' }).click()
    await expect(page.getByText(/you've confirmed it/i)).toBeVisible()
    await expect(page.getByRole('link', { name: /Open Japow/ })).toBeVisible()
    expect(collapse(calls.map((c) => [c.method, c.body]))).toEqual([
      ['POST', { t: 'abc', action: 'peek' }],
      ['POST', { t: 'abc', action: 'confirm' }],
    ])
    // The token never appears in any request URL.
    expect(calls.every((c) => !c.url.includes('abc') && !c.url.includes('?t='))).toBe(true)
  })

  test('a refresh still works after the token left the URL', async ({ page }) => {
    const calls = await mock(page, { peek: { state: 'valid', payment } })
    await page.goto('/trips/confirm-payment?t=abc')
    await expect(page.getByText('For Tim')).toBeVisible()
    await page.reload()
    await expect(page.getByText('For Tim')).toBeVisible()
    expect(calls.length).toBeGreaterThanOrEqual(2)
    expect(calls.every((c) => (c.body as { t: string; action: string }).t === 'abc' && (c.body as { action: string }).action === 'peek')).toBe(true)
  })

  test('valid link: not received tells the payer', async ({ page }) => {
    const calls = await mock(page, { peek: { state: 'valid', payment }, post: { state: 'disputed', payment } })
    await page.goto('/trips/confirm-payment?t=abc')
    await page.getByRole('button', { name: "I haven't received it" }).click()
    await expect(page.getByText("Thanks. We've told Salim.")).toBeVisible()
    expect(collapse(calls.map((c) => (c.body as { action: string }).action))).toEqual(['peek', 'not_received'])
  })

  test('expired link', async ({ page }) => {
    await mock(page, { peek: { state: 'expired', payment } })
    await page.goto('/trips/confirm-payment?t=abc')
    await expect(page.getByText('This link has expired. Open the trip to confirm it there.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Yes, I received it' })).toHaveCount(0)
  })

  test('already confirmed (also what a link shows after the receiver confirmed in the app)', async ({ page }) => {
    await mock(page, { peek: { state: 'confirmed', payment } })
    await page.goto('/trips/confirm-payment?t=abc')
    await expect(page.getByText(/you've confirmed it/i)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Yes, I received it' })).toHaveCount(0)
  })

  test('missing token', async ({ page }) => {
    await page.goto('/trips/confirm-payment')
    await expect(page.getByText("This link isn't valid.")).toBeVisible()
  })
})
