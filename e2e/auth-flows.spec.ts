import { test, expect, type Page } from '@playwright/test'

/**
 * Credential-free auth/PWA checks. Supabase is never contacted: every request
 * to the placeholder host (https://placeholder.supabase.co, see ci.yml) is
 * fulfilled locally by mockSupabase().
 */

async function mockSupabase(page: Page, otpCalls?: string[]) {
  await page.route('**/*.supabase.co/**', async (route) => {
    const url = route.request().url()
    if (url.includes('/auth/v1/otp')) {
      otpCalls?.push(route.request().postData() ?? '')
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  })
}

test.describe('deep link through login', () => {
  test('logged-out deep link keeps the full return URL (path + query) in router state', async ({ page }) => {
    await mockSupabase(page)
    await page.goto('/trips/some-trip-slug?open=question:abc')
    await expect(page).toHaveURL(/\/trips\/login$/)
    await expect(page.getByRole('heading', { name: /welcome back/i })).toBeVisible()

    // ProtectedRoute does <Navigate to="/login" state={{ from: location }}>;
    // react-router stores it in window.history.state.usr.from.
    const from = await page.evaluate(() => (window.history.state as { usr?: { from?: Record<string, string> } })?.usr?.from)
    expect(from?.pathname).toBe('/some-trip-slug')
    expect(from?.search).toBe('?open=question:abc')
  })
})

test.describe('PWA manifest', () => {
  test('manifest is consistent with the /trips/ base and its icons load', async ({ request, baseURL }) => {
    const res = await request.get(new URL('/trips/manifest.webmanifest', baseURL).toString())
    expect(res.ok()).toBeTruthy()
    const m = await res.json()
    expect(m.name).toBeTruthy()
    expect(m.short_name).toBeTruthy()
    expect(m.start_url).toBe('/trips/')
    expect(m.scope).toBe('/trips/')
    expect(m.start_url.startsWith(m.scope)).toBe(true)
    expect(m.display).toBe('standalone')

    const sizes = (m.icons as { sizes: string }[]).map((i) => i.sizes)
    expect(sizes).toContain('192x192')
    expect(sizes).toContain('512x512')
    expect((m.icons as { purpose: string }[]).some((i) => i.purpose === 'maskable')).toBe(true)

    for (const icon of m.icons as { src: string }[]) {
      // Icon srcs are relative to the manifest URL (/trips/).
      const r = await request.get(new URL(icon.src, new URL('/trips/manifest.webmanifest', baseURL)).toString())
      expect(r.ok(), `icon ${icon.src} -> ${r.status()}`).toBeTruthy()
    }
  })
})

test.describe('email-code login', () => {
  test('request code (mocked) reveals a 6-digit field that accepts only 6 digits', async ({ page }) => {
    const otpCalls: string[] = []
    await mockSupabase(page, otpCalls)
    await page.goto('/trips/login')
    await page.getByRole('tab', { name: 'Email me a code' }).click()
    await page.getByLabel(/^Email/).fill('test@example.com')
    await page.getByRole('button', { name: 'Send code' }).click()

    const code = page.getByLabel(/^6-digit code/)
    await expect(code).toBeVisible()
    expect(otpCalls.length).toBe(1)
    expect(otpCalls[0]).toContain('test@example.com')

    const verify = page.getByRole('button', { name: /verify & sign in/i })
    await expect(verify).toBeDisabled()

    await code.fill('12ab34')
    await expect(code).toHaveValue('1234') // non-digits stripped
    await expect(verify).toBeDisabled()

    await code.fill('')
    await code.pressSequentially('1234567890')
    await expect(code).toHaveValue('123456') // maxLength 6
    await expect(verify).toBeEnabled()
  })
})

test.describe('console cleanliness', () => {
  for (const path of ['/trips/', '/trips/login', '/trips/join/FAKE-CODE']) {
    test(`no console errors or page errors on ${path}`, async ({ page }) => {
      await mockSupabase(page) // no filtering needed: Supabase is fully mocked
      const errors: string[] = []
      page.on('console', (msg) => {
        if (msg.type() === 'error') errors.push(msg.text())
      })
      page.on('pageerror', (err) => errors.push(err.message))
      await page.goto(path)
      await page.waitForLoadState('networkidle')
      expect(errors, errors.join('\n')).toEqual([])
    })
  }
})
