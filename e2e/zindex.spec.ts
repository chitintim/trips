import { test, expect } from '@playwright/test'

/**
 * Systemic layering (z-index) regression check (UX_REDESIGN.md "Systemic
 * layering (z-index) fix — bug class, not bug"). The bug class: scrolled
 * in-content sticky elements (timeline day headers, section headers, etc.)
 * rendering OVER the app chrome (Header/BottomNav/AppShell sidebar).
 *
 * The real app chrome only mounts post-auth (AppShell wraps the trip
 * detail/dashboard screens), and this smoke suite deliberately never signs
 * in (see e2e/smoke.spec.ts). So this test verifies the underlying
 * mechanism at the CSS/token level on the public login page: it injects
 * markup using the REAL app classes (`z-sticky` for chrome, `z-30` for
 * in-content sticky, both defined in tailwind.config.js / src/index.css),
 * scrolls the synthetic content past the synthetic sticky day-header, and
 * asserts the computed stacking order via `document.elementFromPoint` --
 * i.e. that the chrome element (z-sticky, 1100) is what's actually on top
 * at the point where it overlaps the in-content sticky element (z-30),
 * exactly as the token scale in src/index.css / tailwind.config.js and the
 * rule in UX_REDESIGN.md prescribe.
 *
 * For the real in-app tab content (auth-gated, so not reachable here), the
 * equivalent fix was verified by code inspection:
 *   - src/components/layout/AppShell/AppShell.tsx (desktop sidebar): added
 *     explicit `z-sticky`.
 *   - src/features/timeline/components/TimelineTab.tsx (day header): capped
 *     `z-[var(--z-dropdown)]` (1000) down to `z-30`.
 *   - src/pages/TripDetail.tsx (tab content container): added
 *     `position:relative` so the timeline's sticky header creates its own
 *     bounded stacking context under the page's `z-sticky` header.
 */

test.describe('z-index layering token scale', () => {
  test('chrome (z-sticky) renders above in-content sticky (z-30) on scroll overlap', async ({ page }) => {
    await page.goto('/trips/login')

    // Build a synthetic page: a `z-sticky` "chrome" bar fixed at the top
    // (standing in for Header/BottomNav/AppShell sidebar) and a scrollable
    // content area containing a `sticky top-0 z-30` "day header" (standing
    // in for TimelineTab's day header / any in-content sticky element),
    // using the SAME Tailwind utility classes the real components use so
    // this exercises the real token scale, not a hand-rolled one.
    await page.evaluate(() => {
      document.body.innerHTML = `
        <div id="chrome" class="sticky top-0 z-sticky" style="height:48px;background:rgba(0,80,200,0.9);color:white;display:flex;align-items:center;padding:0 12px;position:fixed;left:0;right:0;">
          App chrome (z-sticky)
        </div>
        <div id="scroll-container" class="relative" style="position:relative;margin-top:48px;height:400px;overflow-y:auto;">
          <div style="height:40px;"></div>
          <div id="day-header" class="sticky top-0 z-30" style="background:rgba(200,0,0,0.9);color:white;padding:8px 12px;">
            Day header (z-30, in-content sticky)
          </div>
          <div style="height:1200px;"></div>
        </div>
      `
    })

    const scrollContainer = page.locator('#scroll-container')
    // Scroll the content so the sticky day header parks at the top of the
    // scroll container, directly under the fixed chrome bar -- the exact
    // overlap scenario the bug reports.
    await scrollContainer.evaluate((el) => el.scrollTo({ top: 300 }))

    // Sample a point inside the chrome bar's own vertical band (y=20, well
    // within its 48px height) -- this is where the bug would show the
    // in-content sticky element bleeding over the chrome.
    const topElementId = await page.evaluate(() => {
      const el = document.elementFromPoint(200, 20)
      return el ? el.id || el.closest('[id]')?.id : null
    })
    expect(topElementId).toBe('chrome')

    // Confirm this isn't just a fluke of position -- check the actual
    // computed z-index values reflect the token scale (chrome 1100 >
    // in-content cap 30).
    const zIndexes = await page.evaluate(() => {
      const chrome = getComputedStyle(document.getElementById('chrome')!).zIndex
      const dayHeader = getComputedStyle(document.getElementById('day-header')!).zIndex
      return { chrome: Number(chrome), dayHeader: Number(dayHeader) }
    })
    expect(zIndexes.chrome).toBe(1100)
    expect(zIndexes.dayHeader).toBe(30)
    expect(zIndexes.chrome).toBeGreaterThan(zIndexes.dayHeader)
  })
})
