import { expect, test, type Page } from '@playwright/test'

// What the user sees: item 1's name and the PUT's status in the DOM, recorded on every change from just before the
// click until the PUT settles. The assertion: once the optimistic name is shown, it stays while the PUT is pending.
// On @reduxjs/toolkit 2.13.0 the polling and focus tests fail (the old name comes back mid-PUT); the control passes.

type Seen = { t: number; name: string; put: string }

async function watch(page: Page) {
  await page.evaluate(() => {
    const name = document.querySelector('[data-testid=name]')!
    const put = document.querySelector('[data-testid=put-status]')!
    const seen: Seen[] = []
    const t0 = performance.now()
    const rec = () => {
      const s = { t: Math.round(performance.now() - t0), name: name.textContent ?? '', put: put.textContent ?? '' }
      const last = seen.at(-1)
      if (!last || last.name !== s.name || last.put !== s.put) seen.push(s)
    }
    rec()
    new MutationObserver(rec).observe(document.querySelector('main')!, { subtree: true, childList: true, characterData: true })
    ;(window as any).__seen = seen
  })
}

async function renameAndWatch(page: Page, variant: 'polling' | 'focus' | 'none') {
  await page.request.post('/api/reset')
  await page.goto(`/?variant=${variant}`)
  await expect(page.getByTestId('name')).toHaveText('Original')
  await watch(page)
  await page.getByRole('button', { name: 'Rename item 1 (optimistic update, PUT takes 2 s)' }).click()
  if (variant === 'focus') {
    await expect(page.getByTestId('name')).toHaveText('Edited 1')
    // the event the browser fires when the window gets focus back; setupListeners turns it into onFocus()
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  }
  await expect(page.getByTestId('put-status')).toHaveText('fulfilled', { timeout: 5_000 })
  // after the PUT, invalidatesTags refetches and the server's value is shown
  await expect(page.getByTestId('name')).toHaveText('Edited 1')

  const seen: Seen[] = await page.evaluate(() => (window as any).__seen)
  await test.info().attach('dom-changes.json', { body: JSON.stringify(seen, null, 2), contentType: 'application/json' })
  const log = await page.evaluate(() => window.__rtk5139!.log())
  await test.info().attach('rtk-action-log.json', { body: JSON.stringify(log, null, 2), contentType: 'application/json' })

  const shown = seen.findIndex((s) => s.name === 'Edited 1')
  expect(shown, 'the optimistic name was shown').toBeGreaterThanOrEqual(0)
  return seen.slice(shown).filter((s) => s.put === 'pending')
}

for (const variant of ['polling', 'focus'] as const) {
  test(`${variant}: the optimistic name stays while PUT /api/items/1 is pending`, async ({ page }) => {
    const whilePending = await renameAndWatch(page, variant)
    expect(
      [...new Set(whilePending.map((s) => s.name))],
      `item 1's name shown while the PUT was pending (${JSON.stringify(whilePending)})`,
    ).toEqual(['Edited 1'])
  })
}

test('control, no polling and no refetchOnFocus: the optimistic name stays', async ({ page }) => {
  const whilePending = await renameAndWatch(page, 'none')
  expect([...new Set(whilePending.map((s) => s.name))]).toEqual(['Edited 1'])
})
