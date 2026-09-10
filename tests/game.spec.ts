import { test, expect } from '@playwright/test';

test('menu, real driving, pause, pickups, finish and restart work together', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/');
  await expect(page.locator('#loading')).toBeHidden();
  await expect(page).toHaveTitle(/赤沙狂飙/);
  await expect(page.locator('#viewport canvas')).toBeVisible();
  await page.screenshot({ path: 'test-results/menu-desktop.png' });
  await page.getByRole('button', { name: '查看驾驶指南' }).click();
  await expect(page.locator('#help-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#help-dialog')).toBeHidden();
  await page.getByRole('button', { name: '开始比赛' }).click();
  await page.keyboard.down('w');
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'racing');
  await expect.poll(() => page.evaluate(() => (window as any).__RALLY__.simulation.state.racers[0].speed)).toBeGreaterThan(28);
  // Test steering on a clear stretch: a real side impact can correctly push against the input.
  // Car-to-car forces are exercised independently in collision-game.spec.ts.
  await page.evaluate(() => {
    (window as any).__RALLY__.simulation.state.racers.slice(1).forEach((racer: any, i: number) => {
      racer.distance = 650 + i * 65;
    });
  });
  await page.keyboard.press('r');
  await expect.poll(() => page.evaluate(() => (window as any).__RALLY__.simulation.state.racers[0].speed)).toBeGreaterThan(28);
  const lateralBeforeSteering = await page.evaluate(() => (window as any).__RALLY__.simulation.state.racers[0].lateral);
  await page.keyboard.down('d');
  await page.keyboard.down('Space');
  await page.waitForTimeout(400);
  const drifting = await page.evaluate(() => {
    const player = (window as any).__RALLY__.simulation.state.racers[0];
    return { drift: player.driftTime, heading: player.heading, lateral: player.lateral };
  });
  expect(drifting.drift).toBeGreaterThan(0);
  expect(drifting.heading).toBeLessThan(0);
  expect(drifting.lateral).toBeGreaterThan(lateralBeforeSteering);
  await page.keyboard.up('d');
  await page.keyboard.up('Space');
  await page.keyboard.down('Shift');
  await page.waitForTimeout(150);
  await expect.poll(() => page.evaluate(() => (window as any).__RALLY__.simulation.state.racers[0].boostTime)).toBeGreaterThan(0);
  await page.keyboard.up('Shift');
  await page.keyboard.up('w');
  await page.screenshot({ path: 'test-results/race-desktop.png' });

  // A single Escape must keep the new dialog open, not close it by native default.
  await page.keyboard.press('Escape');
  await expect(page.locator('#pause-dialog')).toBeVisible();
  const pausedTime = await page.evaluate(() => (window as any).__RALLY__.simulation.state.time);
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => (window as any).__RALLY__.simulation.state.time)).toBe(pausedTime);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'paused');
  await page.keyboard.press('Escape');
  await expect(page.locator('#pause-dialog')).toBeHidden();
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'racing');
  await page.keyboard.press('r');
  await expect.poll(() => page.evaluate(() => Math.abs((window as any).__RALLY__.simulation.state.racers[0].lateral))).toBeLessThan(1);

  // Place a real pickup on the player's line; proximity collection still goes through physics.
  await page.evaluate(() => {
    const state = (window as any).__RALLY__.simulation.state;
    const player = state.racers[0];
    const pickup = state.pickups.find((item: any) => item.type === 'shield');
    pickup.cooldown = 0;
    player.distance = pickup.distance - 2;
    player.lateral = pickup.lateral;
    player.heading = 0; player.speed = 20; player.item = null;
  });
  await expect(page.locator('#item-name')).toHaveText('能量护盾');
  await page.evaluate(() => { (window as any).__RALLY__.simulation.state.racers[0].charge = 0.995; });
  await expect(page.locator('#item-panel')).toHaveClass(/is-powered/);
  await page.keyboard.press('e');
  await expect.poll(() => page.evaluate(() => (window as any).__RALLY__.simulation.state.racers[0].shield)).toBeGreaterThan(0);
  await expect(page.locator('#item-name')).toHaveText('寻找补给');
  await page.getByRole('button', { name: '驾驶指南', exact: true }).click();
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'paused');
  await page.keyboard.press('Escape');
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'racing');

  // Fast-forward only the lap position to exercise the real finish boundary and result UI.
  await page.evaluate(async () => {
    const { TRACK_LENGTH } = await import('/src/track.ts');
    const player = (window as any).__RALLY__.simulation.state.racers[0];
    player.distance = TRACK_LENGTH * 3 - 0.5;
    player.lap = 3; player.speed = 40; player.lateral = 0; player.heading = 0;
  });
  await expect(page.locator('#results-dialog')).toBeVisible();
  await expect(page.locator('#results-dialog')).toHaveCSS('opacity', '1');
  await expect(page.locator('.result-row')).toHaveCount(6);
  await expect(page.locator('#result-time')).not.toHaveText('—');
  await page.screenshot({ path: 'test-results/results-desktop.png' });
  await page.getByRole('button', { name: '再飙一场' }).click();
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'countdown');
  expect(await page.evaluate(() => (window as any).__RALLY__.simulation.state.time)).toBe(0);
  expect(await page.evaluate(() => (window as any).__RALLY__.simulation.state.racers[0].item)).toBeNull();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '返回赛事大厅', exact: true }).click();
  await expect(page.locator('#menu')).toBeVisible();
  await expect(page.locator('#results-dialog')).toBeHidden();
  expect(errors).toEqual([]);
});

test('portrait menu, landscape touch controls and preferences are usable', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/');
  await expect(page.locator('#loading')).toBeHidden();
  await page.screenshot({ path: 'test-results/menu-mobile.png' });
  for (const selector of ['#start-button', '.track-card', '.menu-footer']) {
    const box = await page.locator(selector).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(391);
    expect(box!.y + box!.height).toBeLessThanOrEqual(845);
  }
  const previousSound = await page.locator('#sound-button').getAttribute('aria-pressed');
  await page.locator('#sound-button').click();
  await page.reload();
  await expect(page.locator('#loading')).toBeHidden();
  await expect(page.locator('#sound-button')).toHaveAttribute('aria-pressed', previousSound === 'true' ? 'false' : 'true');
  await page.setViewportSize({ width: 844, height: 390 });
  await page.locator('#start-button').click();
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'racing');
  const throttle = page.locator('[data-control="throttle"]');
  await expect(throttle).toBeVisible();
  const box = await throttle.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await expect.poll(() => page.evaluate(() => (window as any).__RALLY__.simulation.state.racers[0].speed)).toBeGreaterThan(18);
  await page.screenshot({ path: 'test-results/race-mobile-landscape.png' });
  await page.mouse.up();
  await expect(throttle).not.toHaveClass(/is-pressed/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  await context.close();
});
