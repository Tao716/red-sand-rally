import { test, expect } from '@playwright/test';

test('three full laps remain driveable with the actual scene collision geometry', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#loading')).toBeHidden();
  const report = await page.evaluate(async () => {
    const { sampleTrack } = await import('/src/track.ts');
    const { EMPTY_INPUT } = await import('/src/types.ts');
    const game = (window as any).__RALLY__;
    const sim = game.simulation;
    sim.start(); sim.update(3, EMPTY_INPUT);
    let resets = 0, collisions = 0;
    for (let frame = 0; frame < 60 * 120 && sim.state.phase === 'racing'; frame++) {
      const player = sim.state.racers[0];
      const curve = sampleTrack(player.distance + 3).curvature;
      const steer = Math.max(-1, Math.min(1,
        -curve * player.speed * 0.88 / 1.45 - player.lateral * 0.075 + player.heading * 1.3));
      sim.update(1 / 60, { ...EMPTY_INPUT, throttle: true, steer });
      resets += sim.state.events.filter((event: any) => event.type === 'reset').length;
      collisions += sim.state.events.filter((event: any) => event.type === 'collision').length;
    }
    return { phase: sim.state.phase, time: sim.state.time, rank: sim.state.racers[0].rank,
      laps: sim.state.racers[0].lap, resets, collisions, colliders: game.renderer.staticColliders.length };
  });
  expect(report.colliders).toBeGreaterThan(500);
  expect(report.phase).toBe('finished');
  expect(report.laps).toBe(3);
  expect(report.time).toBeGreaterThan(70);
  expect(report.time).toBeLessThan(110);
  expect(report.resets).toBe(0);
  expect(report.rank).toBeLessThanOrEqual(3);
  expect(report.collisions).toBeGreaterThan(0);
  await expect(page.locator('#results-dialog')).toBeVisible();
});

test('visible guardrails block both sides and real car impacts produce collision feedback', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/');
  await expect(page.locator('#loading')).toBeHidden();
  await page.locator('#start-button').click();
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'racing');
  expect(await page.evaluate(() => (window as any).__RALLY__.renderer.staticColliders.length)).toBeGreaterThan(500);

  // Observe the same physics steps that drive the visible renderer, not a second test simulation.
  await page.evaluate(async () => {
    const game = (window as any).__RALLY__;
    const { StaticCollisionIndex, racerVolume, intersectVolumes } = await import('/src/collision.ts');
    const index = new StaticCollisionIndex(game.renderer.staticColliders);
    const update = game.simulation.update.bind(game.simulation);
    game.collisionAudit = { events: [], maxLateral: 0, maxPenetration: 0, enabled: false };
    game.simulation.update = (dt: number, input: any) => {
      update(dt, input);
      const audit = game.collisionAudit;
      if (!audit.enabled) return;
      const player = game.simulation.state.racers[0];
      audit.events.push(...game.simulation.state.events.filter((event: any) => event.type === 'collision' && event.racer === 0));
      audit.maxLateral = Math.max(audit.maxLateral, Math.abs(player.lateral));
      const body = racerVolume(player);
      for (const solid of index.query(body)) audit.maxPenetration = Math.max(audit.maxPenetration, intersectVolumes(body, solid)?.depth ?? 0);
    };
  });

  for (const side of [-1, 1]) {
    await page.evaluate((side: number) => {
      const game = (window as any).__RALLY__;
      game.input.clear();
      game.simulation.start();
      const state = game.simulation.state;
      state.phase = 'racing'; state.countdown = 0;
      state.pickups.forEach((pickup: any) => { pickup.cooldown = 600; });
      state.racers.slice(1).forEach((racer: any, i: number) => { racer.distance = 900 + i * 65; racer.lateral = 0; });
      Object.assign(state.racers[0], { distance: 420, lateral: side * 6.5, heading: -side * 0.55, speed: 65, boostTime: 0 });
      game.collisionAudit = { events: [], maxLateral: 0, maxPenetration: 0, enabled: true };
    }, side);
    await page.keyboard.down('w');
    await page.keyboard.down(side === 1 ? 'd' : 'a');
    await expect.poll(() => page.evaluate(() => (window as any).__RALLY__.collisionAudit.events.some((event: any) => event.collisionKind === 'barrier'))).toBe(true);
    await page.waitForTimeout(800);
    await page.keyboard.up(side === 1 ? 'd' : 'a');
    await page.keyboard.up('w');
    const audit = await page.evaluate(() => (window as any).__RALLY__.collisionAudit);
    expect(audit.maxLateral).toBeLessThan(10);
    expect(audit.maxPenetration).toBeLessThan(0.04);
    await page.screenshot({ path: `test-results/collision-rail-${side === 1 ? 'right' : 'left'}.png` });
  }

  await page.evaluate(() => {
    const game = (window as any).__RALLY__;
    game.input.clear(); game.simulation.start();
    const state = game.simulation.state;
    state.phase = 'racing'; state.countdown = 0;
    state.pickups.forEach((pickup: any) => { pickup.cooldown = 600; });
    state.racers.slice(1).forEach((racer: any, i: number) => { racer.distance = 900 + i * 65; racer.lateral = 0; });
    Object.assign(state.racers[0], { distance: 420, lateral: 0, heading: 0, speed: 60 });
    Object.assign(state.racers[1], { distance: 427, lateral: 0, heading: 0, speed: 10 });
    game.collisionAudit = { events: [], maxLateral: 0, maxPenetration: 0, enabled: true };
    // This fixture jumps backward along the circuit; align the camera before the impact.
    game.renderer.update(state, 1);
  });
  await expect.poll(() => page.evaluate(() => (window as any).__RALLY__.collisionAudit.events.some((event: any) => event.collisionKind === 'car'))).toBe(true);
  await expect(page.locator('#toast')).toContainText('车身碰撞');
  const result = await page.evaluate(() => {
    const state = (window as any).__RALLY__.simulation.state;
    return { speed: state.racers[0].speed, protected: state.racers[0].invulnerable, attacks: state.hits };
  });
  expect(result.speed).toBeLessThan(52);
  expect(result.protected).toBe(0);
  expect(result.attacks).toBe(0);
  await page.screenshot({ path: 'test-results/collision-cars.png' });
  await page.keyboard.press('Escape');
  await expect(page.locator('#pause-dialog')).toBeVisible();
  expect(errors).toEqual([]);
});
