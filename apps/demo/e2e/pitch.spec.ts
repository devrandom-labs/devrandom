import { expect, test } from '@playwright/test';

test('judges can explore the whole pitch without calling a system API', async ({ page }) => {
  const errors: string[] = [];
  const unexpectedRequests: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (!request.url().startsWith('http://127.0.0.1:3213/') || request.method() !== 'GET') {
      unexpectedRequests.push(request.url());
    }
  });
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Better agents. Bounded authority.' }),
  ).toBeVisible();
  await expect(page.getByText('Interactive pitch · illustrative scenarios')).toBeVisible();
  await page.getByRole('button', { name: 'Start the story' }).click();
  await expect(
    page.getByRole('heading', { name: 'One task. Three distinct principals.' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Promotion Mandate', exact: true }).click();
  await expect(page.getByText('Delegates promotion, never permission expansion.')).toBeVisible();

  await page.getByRole('button', { name: '03 The harness' }).click();
  await page.getByRole('button', { name: 'Context & memory', exact: true }).click();
  await expect(
    page.getByText(
      'Select relevant experience without losing access to the raw evidence behind it.',
    ),
  ).toBeVisible();
  await page.getByRole('button', { name: '04 Memory' }).click();
  await page.getByRole('button', { name: 'Durable acceptance', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Only the server holds Atlas credentials');

  await page.getByRole('button', { name: '05 Evolution' }).click();
  await page.getByRole('button', { name: 'No eligible improvement' }).click();
  await expect(
    page.getByText('Keep H1. A new version is not automatically a better version.'),
  ).toBeVisible();

  await page.getByRole('button', { name: '06 Promotion' }).click();
  await page.getByLabel('Expired mandate').check();
  await expect(page.getByRole('status')).toContainText('Promotion blocked');
  await page.getByLabel('Expired mandate').uncheck();
  await page.getByLabel('Missing evidence').check();
  await expect(page.getByRole('status')).toContainText('complete protected evidence');
  await page.getByLabel('Missing evidence').uncheck();
  await page.getByRole('button', { name: 'Explain the next gate' }).click();
  await expect(page.getByText('2 / 4')).toBeVisible();

  await page.getByRole('button', { name: '07 Boundaries' }).click();
  await page.getByRole('button', { name: 'Deploy to production' }).click();
  await expect(page.getByRole('status')).toContainText('Blocked before effect');
  await expect(page.getByText('Authority unchanged')).toBeVisible();
  for (const attack of ['Replace the evaluator', 'Erase failed evidence', 'Promote itself']) {
    await page.getByRole('button', { name: attack, exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Rejected');
  }
  await page.getByRole('button', { name: '08 Continuity' }).click();
  await page.getByRole('button', { name: 'Illustrate process loss' }).click();
  await expect(page.getByText('Process stopped. The task still exists.')).toBeVisible();
  await page.getByRole('button', { name: 'Illustrate recovery' }).click();
  await expect(page.getByText('New incarnation. Same accountable Run.')).toBeVisible();
  await page.getByRole('button', { name: 'Illustrate process loss' }).click();
  await page.getByLabel('Revoke mandate before recovery').check();
  await page.getByRole('button', { name: 'Illustrate recovery' }).click();
  await expect(page.getByRole('status')).toContainText('Recovery blocked');
  await page.getByRole('button', { name: '09 Sharing' }).click();
  await page.getByRole('button', { name: 'Show sanitization' }).click();
  await expect(page.getByText('Behavior travels. Authority stays home.')).toBeVisible();
  await page.getByRole('button', { name: '10 What’s next' }).click();
  await page.getByRole('button', { name: 'Portable compute' }).click();
  await expect(
    page.getByText('The node gets a lease. Never the agent’s private key.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Restart pitch' }).click();
  await expect(
    page.getByRole('heading', { name: 'Better agents. Bounded authority.' }),
  ).toBeVisible();
  expect(errors).toEqual([]);
  expect(unexpectedRequests).toEqual([]);
});

test('keyboard navigation, notes, and reduced-motion mobile layout remain usable', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.keyboard.press('ArrowRight');
  await expect(
    page.getByRole('heading', { name: 'One task. Three distinct principals.' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Presenter notes' }).click();
  await expect(page.getByRole('dialog', { name: 'Presenter notes' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '10 What’s next' }).click();
  const dimensions = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.width);
  await page.screenshot({
    path: 'test-results/pitch-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
});

test('desktop pitch renders the production page', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const response = await page.goto('/');
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('button', { name: 'Start the story' })).toBeVisible();
  await page.screenshot({
    path: 'test-results/pitch-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: '05 Evolution' }).click();
  await page.screenshot({
    path: 'test-results/pitch-evolution.png',
    fullPage: true,
    animations: 'disabled',
  });
});

test('autoplay progresses and manual interaction pauses the story', async ({ page }) => {
  await page.clock.install();
  await page.goto('/');
  await page.getByRole('button', { name: 'Autoplay', exact: true }).click();
  await page.clock.fastForward(14_100);
  await expect(
    page.getByRole('heading', { name: 'One task. Three distinct principals.' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Promotion Mandate', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Autoplay', exact: true })).toBeVisible();
  await page.clock.fastForward(28_000);
  await expect(
    page.getByRole('heading', { name: 'One task. Three distinct principals.' }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Better agents. Bounded authority.' }),
  ).toBeVisible();
});
