import { test, expect } from '@playwright/test';

test('difficulty selection is real, persistent, and keeps legacy and tier records separate', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    if (!localStorage.getItem('difficulty-test-initialized')) {
      localStorage.setItem('sand-rally-best-v1', '99.25');
      localStorage.setItem('sand-rally-best-v2-hard', '83.5');
      localStorage.setItem('difficulty-test-initialized', 'true');
    }
  });
  await page.goto('/');
  await expect(page.locator('#loading')).toBeHidden();
  await expect(page.getByRole('radio', { name: '简单', exact: true })).toBeChecked();
  await expect(page.locator('#personal-best')).toHaveText('01:39.25');
  await page.getByRole('radio', { name: '困难', exact: true }).check();
  await expect(page.locator('body')).toHaveAttribute('data-difficulty', 'hard');
  await expect(page.locator('#best-label')).toHaveText('困难最佳');
  await expect(page.locator('#personal-best')).toHaveText('01:23.50');
  expect(await page.evaluate(() => (window as any).__RALLY__.simulation.state.difficulty)).toBe('hard');
  await page.reload();
  await expect(page.locator('#loading')).toBeHidden();
  await expect(page.getByRole('radio', { name: '困难', exact: true })).toBeChecked();
  await page.getByRole('radio', { name: '地狱', exact: true }).check();
  await expect(page.locator('#personal-best')).toHaveText('等待你的第一条纪录');
  await expect(page.locator('#difficulty-subtitle')).toHaveText('寸步不让');
  await page.screenshot({ path: 'test-results/difficulty-menu-hell.png' });
  await page.locator('#start-button').click();
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'countdown');
  expect(await page.evaluate(() => (window as any).__RALLY__.simulation.setDifficulty('easy'))).toBe(false);
  await expect(page.locator('#race-difficulty')).toHaveText('地狱难度');
  await expect(page.locator('input[value="easy"]')).toBeDisabled();
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'racing');
  await page.keyboard.press('Escape');
  await expect(page.locator('#pause-difficulty')).toHaveText('地狱 · 本场难度');
  expect(await page.evaluate(() => (window as any).__RALLY__.simulation.setDifficulty('hard'))).toBe(false);
  await page.locator('#restart-button').click();
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'countdown');
  expect(await page.evaluate(() => (window as any).__RALLY__.simulation.state.difficulty)).toBe('hell');
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'racing');
  await page.evaluate(async () => {
    const { TRACK_LENGTH } = await import('/src/track.ts');
    const state = (window as any).__RALLY__.simulation.state;
    state.time = 95;
    Object.assign(state.racers[0], { distance: TRACK_LENGTH * 3 - 0.5, speed: 40, heading: 0, lateral: 0, lap: 3 });
  });
  await expect(page.locator('#results-dialog')).toBeVisible();
  await expect(page.locator('#result-difficulty')).toHaveText('地狱难度');
  await expect(page.locator('#result-subtitle')).toContainText('地狱新纪录');
  const saved = await page.evaluate(() => ({
    easy: localStorage.getItem('sand-rally-best-v1'),
    hard: localStorage.getItem('sand-rally-best-v2-hard'),
    hell: Number(localStorage.getItem('sand-rally-best-v2-hell')),
  }));
  expect(saved.easy).toBe('99.25');
  expect(saved.hard).toBe('83.5');
  expect(saved.hell).toBeGreaterThan(95);
  expect(saved.hell).toBeLessThan(96);
  await page.locator('#results-lobby-button').click();
  await expect(page.getByRole('radio', { name: '地狱', exact: true })).toBeChecked();
  await page.getByRole('radio', { name: '简单', exact: true }).check();
  await expect(page.locator('#personal-best')).toHaveText('01:39.25');
  await page.getByRole('radio', { name: '地狱', exact: true }).check();
  await page.reload();
  await expect(page.locator('#loading')).toBeHidden();
  await expect(page.locator('#best-label')).toHaveText('地狱最佳');
  await expect(page.locator('#personal-best')).toContainText('01:35.');
  expect(errors).toEqual([]);
});

test('difficulty radios support keyboard navigation and remain usable across screen sizes', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#loading')).toBeHidden();
  await page.getByRole('radio', { name: '简单', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('radio', { name: '困难', exact: true })).toBeChecked();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('radio', { name: '地狱', exact: true })).toBeChecked();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('radio', { name: '困难', exact: true })).toBeChecked();
  await page.keyboard.press('Space');
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'menu');
  const sizes = [[1440, 900], [1366, 768], [390, 844], [360, 740], [844, 390], [667, 375]];
  for (const [width, height] of sizes) {
    await page.setViewportSize({ width, height });
    await page.getByRole('radio', { name: '地狱', exact: true }).check();
    await page.getByRole('radio', { name: '困难', exact: true }).check();
    const picker = (await page.locator('.difficulty-selector').boundingBox())!;
    const start = (await page.locator('#start-button').boundingBox())!;
    const card = (await page.locator('.track-card').boundingBox())!;
    const personalBest = (await page.locator('.personal-best').boundingBox())!;
    const footer = (await page.locator('.menu-footer').boundingBox())!;
    expect(picker.x).toBeGreaterThanOrEqual(0);
    expect(picker.x + picker.width).toBeLessThanOrEqual(width + 1);
    expect(picker.y + picker.height).toBeLessThanOrEqual(start.y + 1);
    expect(start.y + start.height).toBeLessThanOrEqual(footer.y);
    expect(personalBest.y + personalBest.height).toBeLessThanOrEqual(footer.y - 4);
    const overlapWidth = Math.min(start.x + start.width, card.x + card.width) - Math.max(start.x, card.x);
    const overlapHeight = Math.min(start.y + start.height, card.y + card.height) - Math.max(start.y, card.y);
    expect(overlapWidth <= 0 || overlapHeight <= 0, `start is obstructed at ${width}x${height}`).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/difficulty-menu-${width}x${height}.png` });
  }
});

test('all difficulty tiers can complete a real three-lap race with scene collisions', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#loading')).toBeHidden();
  for (const difficulty of ['easy', 'hard', 'hell']) {
    // Let the UI observe the lobby between accelerated races, as a real player would.
    await page.evaluate(() => (window as any).__RALLY__.returnToMenu());
    await expect(page.locator('body')).toHaveAttribute('data-phase', 'menu');
    const result = await page.evaluate(async (difficulty: string) => {
      const { sampleTrack } = await import('/src/track.ts');
      const { EMPTY_INPUT } = await import('/src/types.ts');
      const game = (window as any).__RALLY__;
      const sim = game.simulation;
      sim.start(difficulty); sim.update(3, EMPTY_INPUT);
      let resets = 0;
      for (let frame = 0; frame < 60 * 140 && sim.state.phase === 'racing'; frame++) {
        const player = sim.state.racers[0];
        const curve = sampleTrack(player.distance + 3).curvature;
        const steer = Math.max(-1, Math.min(1, -curve * player.speed * 0.88 / 1.45 - player.lateral * 0.075 + player.heading * 1.3));
        sim.update(1 / 60, { ...EMPTY_INPUT, throttle: true, steer });
        resets += sim.state.events.filter((event: any) => event.type === 'reset').length;
      }
      return { difficulty: sim.state.difficulty, phase: sim.state.phase, time: sim.state.time,
        lap: sim.state.racers[0].lap, rank: sim.state.racers[0].rank, resets,
        finite: sim.state.racers.every((racer: any) => [racer.distance, racer.lateral, racer.speed].every(Number.isFinite)) };
    }, difficulty);
    expect(result.difficulty).toBe(difficulty);
    expect(result.phase).toBe('finished');
    expect(result.lap).toBe(3);
    expect(result.time).toBeLessThan(140);
    expect(result.finite).toBe(true);
    await expect(page.locator('#results-dialog')).toBeVisible();
    const label = { easy: '简单', hard: '困难', hell: '地狱' }[difficulty];
    await expect(page.locator('#result-difficulty')).toHaveText(`${label}难度`);
  }
});
