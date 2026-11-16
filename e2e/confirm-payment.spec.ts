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

  test('missing token: a distinct message and no call to the function', async ({ page }) => {
    const calls = await mock(page, { peek: { state: 'invalid' } })
    await page.goto('/trips/confirm-payment')
    await expect(page.getByText('This link is missing its code — open the email again or open the app.')).toBeVisible()
    await expect(page.getByText("This link isn't valid.")).toHaveCount(0)
    await expect(page.getByRole('link', { name: /Open Tim's Trip Planner/ })).toBeVisible()
    expect(calls).toHaveLength(0)
  })

  test('a=yes: preselected, one big button, confirms; token and a= leave the address bar', async ({ page }) => {
    const calls = await mock(page, { peek: { state: 'valid', payment }, post: { state: 'confirmed', payment } })
    await page.goto('/trips/confirm-payment?t=abc&a=yes')
    const yes = page.getByRole('button', { name: 'Yes, I received £105.11 from Salim' })
    await expect(yes).toBeVisible()
    await expect(page.getByRole('button', { name: "Tell Salim it hasn't arrived" })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Change my answer' })).toBeVisible()
    expect(page.url()).not.toContain('abc')
    expect(page.url()).not.toContain('a=')
    // Opening changed nothing: only peeks so far.
    expect(calls.every((c) => (c.body as { action: string }).action === 'peek')).toBe(true)
    await yes.click()
    await expect(page.getByText(/you've confirmed it/i)).toBeVisible()
    expect(collapse(calls.map((c) => (c.body as { action: string }).action))).toEqual(['peek', 'confirm'])
    expect(calls.every((c) => !c.url.includes('abc'))).toBe(true)
  })

  test('a=no: preselected, tells the payer', async ({ page }) => {
    const calls = await mock(page, { peek: { state: 'valid', payment }, post: { state: 'disputed', payment } })
    await page.goto('/trips/confirm-payment?t=abc&a=no')
    await page.getByRole('button', { name: "Tell Salim it hasn't arrived" }).click()
    await expect(page.getByText("Thanks. We've told Salim.")).toBeVisible()
    expect(collapse(calls.map((c) => (c.body as { action: string }).action))).toEqual(['peek', 'not_received'])
  })

  test('change my answer flips the choice and posts the other action; a refresh keeps the hint', async ({ page }) => {
    const calls = await mock(page, { peek: { state: 'valid', payment }, post: { state: 'confirmed', payment } })
    await page.goto('/trips/confirm-payment?t=abc&a=no')
    await page.reload()
    await expect(page.getByRole('button', { name: "Tell Salim it hasn't arrived" })).toBeVisible()
    await page.getByRole('button', { name: 'Change my answer' }).click()
    await expect(page.getByRole('button', { name: 'Yes, I received £105.11 from Salim' })).toBeVisible()
    await page.getByRole('button', { name: 'Change my answer' }).click()
    await expect(page.getByRole('button', { name: "Tell Salim it hasn't arrived" })).toBeVisible()
    await page.getByRole('button', { name: 'Change my answer' }).click()
    await page.getByRole('button', { name: 'Yes, I received £105.11 from Salim' }).click()
    await expect(page.getByText(/you've confirmed it/i)).toBeVisible()
    expect(calls.filter((c) => (c.body as { action: string }).action !== 'peek').map((c) => (c.body as { action: string }).action)).toEqual(['confirm'])
  })

  test('junk a= shows both explicit buttons', async ({ page }) => {
    await mock(page, { peek: { state: 'valid', payment } })
    await page.goto('/trips/confirm-payment?t=abc&a=maybe')
    await expect(page.getByRole('button', { name: 'Yes, I received it' })).toBeVisible()
    await expect(page.getByRole('button', { name: "I haven't received it" })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Change my answer' })).toHaveCount(0)
  })

  test('old links show the current truth, with no action buttons', async ({ page }) => {
    await mock(page, { peek: { state: 'asked_again', payment: { ...payment, settlementId: 's-1' } } })
    await page.goto('/trips/confirm-payment?t=abc&a=no')
    await expect(page.getByText("Salim says they've sent it — check again.")).toBeVisible()
    await expect(page.getByRole('link', { name: 'Open this payment in the app' })).toHaveAttribute('href', /trip-1\?open=payment:s-1/)
    // The only button is the link-wrapped "open the payment" one; no answer buttons.
    await expect(page.getByRole('button', { name: /received|arrived/i })).toHaveCount(0)
  })

  test('retracted and disputed revisits', async ({ page }) => {
    await mock(page, { peek: { state: 'retracted', payment } })
    await page.goto('/trips/confirm-payment?t=abc')
    await expect(page.getByText("Salim's payment is no longer marked as paid.")).toBeVisible()
    await page.unroute('**/functions/v1/payment-confirm*')
    await mock(page, { peek: { state: 'disputed', payment } })
    await page.goto('/trips/confirm-payment?t=def')
    await expect(page.getByText("You told Salim it hasn't arrived.")).toBeVisible()
  })
})
