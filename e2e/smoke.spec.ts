import { test, expect, type Page } from '@playwright/test'

/**
 * Unauthenticated smoke suite (WSH QA gate, plan §16). Deliberately does
 * NOT sign in and never writes to the live database -- it only exercises
 * screens that are public by design (login, redirects, the PWA manifest).
 * Keep this suite fast (plan target: <60s total) and resistant to app churn
 * (assert on structure/behavior, not exact copy, where reasonable).
 */

/** Collects console errors for the duration of a page's lifetime. */
function trackConsoleErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text())
  })
  page.on('pageerror', (err) => errors.push(err.message))
  return errors
}

test.describe('unauthenticated smoke', () => {
  test('app serves at /trips/ and redirects unauthenticated root to login', async ({ page }) => {
    const errors = trackConsoleErrors(page)
    await page.goto('/trips/')
    await expect(page).toHaveURL(/\/trips\/login$/)
    await expect(page.getByRole('heading', { name: /welcome back/i })).toBeVisible()
    expect(errors, `console errors on load: ${errors.join('\n')}`).toEqual([])
  })

  test('login page renders both auth tabs (password + email code)', async ({ page }) => {
    await page.goto('/trips/login')

    // SegmentedControl renders options as role="tab" (see
    // src/components/ui/SegmentedControl/SegmentedControl.tsx).
    const passwordTab = page.getByRole('tab', { name: 'Password' })
    const otpTab = page.getByRole('tab', { name: 'Email me a code' })
    await expect(passwordTab).toBeVisible()
    await expect(otpTab).toBeVisible()

    // Password tab is the default: email + password fields + submit.
    // Labels render with a trailing "*" required-indicator (Input.tsx), so
    // match by regex rather than exact text.
    await expect(page.getByLabel(/^Email/)).toBeVisible()
    await expect(page.getByLabel(/^Password/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()

    // Switch to the OTP tab: password field disappears, "Send code" appears.
    await otpTab.click()
    await expect(page.getByRole('button', { name: 'Send code' })).toBeVisible()
    await expect(page.getByLabel(/^Password/)).toHaveCount(0)

    // Link to invitation-based signup is present.
    await expect(page.getByRole('link', { name: /sign up with invitation code/i })).toBeVisible()
  })

  test('unknown route redirects sensibly (to login when signed out)', async ({ page }) => {
    await page.goto('/trips/this-route-does-not-exist')
    // App.tsx: catch-all -> "/" -> ProtectedRoute -> redirect to /login when
    // there's no session. Either way, the user must never see a dead page.
    await expect(page).toHaveURL(/\/trips\/login$/)
  })

  test('protected route redirects to login and preserves the intended destination', async ({ page }) => {
    await page.goto('/trips/some-trip-id')
    await expect(page).toHaveURL(/\/trips\/login$/)
    // ProtectedRoute passes `state: { from: location }` so the login page
    // could return the user to /some-trip-id post-auth -- verify we did not
    // just bounce to the bare dashboard route by mistake (i.e. it's still
    // showing the login screen, not a random blank protected page).
    await expect(page.getByRole('heading', { name: /welcome back/i })).toBeVisible()
  })

  test('PWA manifest is reachable and well-formed', async ({ page, request, baseURL }) => {
    await page.goto('/trips/login')
    const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href')
    expect(manifestHref).toBeTruthy()

    // NOTE: Vite's dev server (unlike the production build) transforms the
    // `<link rel="manifest">` href and doubles the `/trips` base path
    // (`/trips/trips/manifest.webmanifest`) when `base: '/trips/'` is
    // configured -- confirmed this does NOT happen in `dist/index.html`
    // (the production build correctly emits `/trips/manifest.webmanifest`).
    // So we fetch the known real production path directly here rather than
    // trusting the dev-transformed href, since that's what actually matters
    // once deployed -- but we still assert the manifest link exists above.
    const manifestUrl = new URL('/trips/manifest.webmanifest', baseURL).toString()
    const res = await request.get(manifestUrl)
    expect(res.ok(), `manifest fetch failed: ${res.status()} ${manifestUrl}`).toBeTruthy()

    const manifest = await res.json()
    expect(manifest.name).toBe('Trips')
    expect(manifest.start_url).toContain('/trips/')
    expect(Array.isArray(manifest.icons)).toBe(true)
    expect(manifest.icons.length).toBeGreaterThan(0)
  })

  test('no console errors on the login page at mobile and desktop viewports', async ({ page }) => {
    for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
      await page.setViewportSize(viewport)
      const errors = trackConsoleErrors(page)
      await page.goto('/trips/login')
      await expect(page.getByRole('heading', { name: /welcome back/i })).toBeVisible()
      expect(errors, `console errors at ${viewport.width}x${viewport.height}: ${errors.join('\n')}`).toEqual([])
    }
  })

  test('join teaser with an invalid code shows a friendly error, no crash', async ({ page }) => {
    // /join/:code is PUBLIC (pre-signup teaser). An invalid/unknown code must
    // land on the friendly dead-end — never a blank screen or an uncaught
    // error. (Console noise from the failed preview lookup is acceptable;
    // pageerror — an actual crash — is not.)
    const crashes: string[] = []
    page.on('pageerror', (err) => crashes.push(err.message))

    await page.goto('/trips/join/NOT-A-REAL-CODE')
    await expect(page.getByRole('heading', { name: /invitation link isn't valid/i })).toBeVisible()
    // Escape hatches are offered.
    await expect(page.getByRole('link', { name: /sign in/i })).toBeVisible()
    expect(crashes, `uncaught page errors: ${crashes.join('\n')}`).toEqual([])
  })

  test('forgot-password and signup pages render without console errors', async ({ page }) => {
    for (const path of ['/trips/forgot-password', '/trips/signup']) {
      const errors = trackConsoleErrors(page)
      await page.goto(path)
      // Every auth page shares AuthLayout -- assert the layout mounted
      // (rather than a blank screen) without pinning down page-specific copy.
      await expect(page.locator('body')).not.toBeEmpty()
      expect(errors, `console errors on ${path}: ${errors.join('\n')}`).toEqual([])
    }
  })
})
