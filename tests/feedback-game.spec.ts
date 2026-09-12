import { test as base, expect, type Page } from '@playwright/test';

const test = base.extend<{ pageErrors: string[] }>({
  pageErrors: [async ({ page }, use) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await use(errors);
    expect(errors, 'feedback interactions must not produce silent browser errors').toEqual([]);
  }, { auto: true }],
});

async function startRace(page: Page) {
  await page.goto('/');
  await expect(page.locator('#loading')).toBeHidden();
  await page.locator('#start-button').click();
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'racing');
  await expect(page.locator('#countdown')).toBeHidden();
}

/** Only arrange physical state: retain the real input, renderer, colliders and HUD loop. */
async function clearRoad(page: Page, changes: {
  item?: 'rocket' | 'shield' | 'nitro' | 'mine' | null;
  charge?: number; distance?: number; lateral?: number; speed?: number;
} = {}) {
  await page.evaluate(changes => {
    const game = (window as any).__RALLY__;
    const state = game.simulation.state;
    game.input.clear();
    game.simulation.resetPlayer();
    state.racers.slice(1).forEach((racer: any, index: number) => {
      Object.assign(racer, { finished: true, distance: 650 + index * 90, lateral: -5 });
    });
    state.pickups.forEach((pickup: any) => { pickup.cooldown = 100; });
    state.projectiles = [];
    Object.assign(state.racers[0], {
      distance: 35, lateral: 0, heading: 0, speed: 35, item: null, charge: 0,
      energy: 70, driftTime: 0, shield: 0, boostTime: 0, hitTime: 0, collisionTime: 0,
      invulnerable: 0, finished: false, ...changes,
    });
  }, changes);
}

async function incomingRocket(page: Page, id = 900) {
  await page.evaluate(id => {
    const state = (window as any).__RALLY__.simulation.state;
    const player = state.racers[0];
    state.projectiles.push({ id, type: 'rocket', owner: 1, distance: player.distance - 145,
      lateral: player.lateral, lifetime: 4, powered: false, target: player.id });
  }, id);
}

async function waitForMiniBoost(page: Page) {
  // Observe the 0.5 s threshold on the render frame, without expect's increasing
  // retry delays turning a short correction into a full second of hard steering.
  await page.waitForFunction(() => (window as any).__RALLY__.simulation.state.racers[0].driftTime > 0.5
    && document.querySelector('#drift-label')?.textContent === '小喷就绪');
  await expect(page.locator('#drift-label')).toHaveText('小喷就绪');
}

/** Chrome's actual multi-touch dispatch exercises pointer capture and simultaneous buttons. */
async function holdTouch(page: Page, controls: string[]) {
  const session = await page.context().newCDPSession(page);
  const points = [];
  for (const [index, control] of controls.entries()) {
    const box = await page.locator(`[data-control="${control}"]`).boundingBox();
    expect(box, `${control} must have a tappable screen position`).not.toBeNull();
    points.push({ id: index + 1, x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 });
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points });
  return async () => {
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await session.detach();
  };
}

test('real empty-handed drift shows mini-boost readiness and release independently of item charge', async ({ page }, testInfo) => {
  await startRace(page);
  await clearRoad(page, { lateral: -3, speed: 35 });
  await page.keyboard.down('w');
  await page.keyboard.down('d');
  await page.keyboard.down('Space');
  // Snapshot readiness on its first render frame. Serial locator assertions and
  // a screenshot while holding full right steering can drive off-road before release.
  const readyHandle = await page.waitForFunction(() => {
    const player = (window as any).__RALLY__.simulation.state.racers[0];
    const label = document.querySelector('#drift-label')!.textContent;
    if (player.driftTime <= 0.5 || label !== '小喷就绪') return null;
    const visible = (element: Element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0
        && !['hidden', 'collapse'].includes(getComputedStyle(element).visibility);
    };
    return {
      driftTime: player.driftTime, item: player.item, charge: player.charge, label,
      indicatorVisible: visible(document.querySelector('#drift-indicator')!),
      chargeHidden: !visible(document.querySelector('#drift-charge')!),
      progress: document.querySelector('#drift-indicator [role="progressbar"]')!.getAttribute('aria-valuenow'),
    };
  }, undefined, { polling: 'raf' });
  await page.keyboard.up('Space');
  await page.keyboard.up('d');
  await page.keyboard.up('w');
  const releasedHandle = await page.waitForFunction(() => {
    const state = (window as any).__RALLY__.simulation.state;
    const label = document.querySelector('#drift-label')!.textContent;
    if (label !== '出弯小喷') return null;
    return { label, status: document.querySelector('#drift-indicator')!.getAttribute('data-state'),
      boostTime: state.racers[0].boostTime, drifts: state.drifts };
  }, undefined, { polling: 'raf' });
  const [ready, released] = await Promise.all([readyHandle.jsonValue(), releasedHandle.jsonValue()]);
  await Promise.all([readyHandle.dispose(), releasedHandle.dispose()]);
  expect(ready!.driftTime).toBeGreaterThan(0.5);
  expect(ready!.item).toBeNull();
  expect(ready!.charge).toBe(0);
  expect(ready!.label).toBe('小喷就绪');
  expect(ready!.indicatorVisible).toBe(true);
  expect(ready!.chargeHidden).toBe(true);
  expect(ready!.progress).toBe('100');
  expect(released!.label).toBe('出弯小喷');
  expect(released!.status).toBe('released');
  expect(released!.boostTime).toBeGreaterThan(0);
  expect(released!.drifts).toBe(1);
  await page.screenshot({ path: testInfo.outputPath('feedback-empty-drift-released.png') });
  const { writeFile } = await import('node:fs/promises');
  const readyPath = testInfo.outputPath('feedback-empty-drift-ready.json');
  await writeFile(readyPath, JSON.stringify(ready, null, 2), 'utf8');
  await testInfo.attach('feedback-empty-drift-ready', {
    path: readyPath, contentType: 'application/json',
  });
  await expect(page.locator('#drift-indicator')).toBeHidden();
});

test('target HUD matches the actual nearest forward racer and clears on real firing', async ({ page }, testInfo) => {
  await startRace(page);
  await clearRoad(page, { item: 'rocket', speed: 30 });
  await page.evaluate(() => {
    const state = (window as any).__RALLY__.simulation.state;
    const player = state.racers[0];
    Object.assign(state.racers[1], { finished: false, distance: player.distance + 120, lateral: 0, speed: 20 });
    Object.assign(state.racers[2], { finished: false, distance: player.distance + 65, lateral: 0, speed: 20 });
    Object.assign(state.racers[3], { finished: false, distance: player.distance - 20, lateral: 0, speed: 20 });
  });
  await expect(page.locator('#target-label')).toHaveText(/^锁定 KIRA · \d+ m$/);
  await expect(page.locator('#target-lock')).toHaveClass(/is-locked/);
  const target = await page.evaluate(async () => {
    const { wrapDistance } = await import('/src/track.ts');
    const state = (window as any).__RALLY__.simulation.state;
    const player = state.racers[0];
    const nearest = state.racers.filter((racer: any) => racer.id !== player.id && !racer.finished)
      .map((racer: any) => ({ ...racer, gap: wrapDistance(racer.distance - player.distance) }))
      .filter((racer: any) => racer.gap < 220).sort((a: any, b: any) => a.gap - b.gap)[0];
    return { id: nearest.id, expected: `锁定 ${nearest.name} · ${Math.round(nearest.gap)} m`,
      actual: document.querySelector('#target-label')!.textContent };
  });
  expect(target.id).toBe(2);
  expect(target.actual).toBe(target.expected);
  await page.screenshot({ path: testInfo.outputPath('feedback-target-lock.png') });
  await page.keyboard.press('e');
  await expect.poll(() => page.evaluate(() => (window as any).__RALLY__.simulation.state.projectiles
    .find((projectile: any) => projectile.owner === 0 && projectile.type === 'rocket')?.target)).toBe(target.id);
  await expect(page.locator('#target-lock')).toBeHidden();
  await expect(page.locator('#target-reticle')).toBeHidden();
  await expect(page.locator('#threat-warning')).toBeHidden();
  await expect(page.locator('#item-name')).toHaveText('寻找补给');
  await expect(page.locator('#combat-confirmation-text')).toHaveText('命中 KIRA');
  await expect(page.locator('#combat-confirmation')).toBeVisible();
});

test('incoming warning survives pause, guides a real shield block and is cleared by restart', async ({ page }, testInfo) => {
  await startRace(page);
  await clearRoad(page, { item: 'shield', distance: 200, speed: 50 });
  await incomingRocket(page);
  await expect(page.locator('#threat-warning')).toBeVisible();
  await expect(page.locator('#threat-warning')).toHaveAttribute('data-direction', 'rear');
  await expect(page.locator('#threat-action')).toHaveText('按 E 开启护盾');
  await page.keyboard.press('Escape');
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'paused');
  await expect(page.locator('#threat-warning')).toBeHidden();
  await expect(page.locator('body')).not.toHaveClass(/has-threat/);
  const paused = await page.evaluate(() => {
    const state = (window as any).__RALLY__.simulation.state;
    return { time: state.time, lifetime: state.projectiles[0].lifetime };
  });
  await page.waitForTimeout(180);
  expect(await page.evaluate(() => {
    const state = (window as any).__RALLY__.simulation.state;
    return { time: state.time, lifetime: state.projectiles[0].lifetime };
  })).toEqual(paused);
  await page.keyboard.press('Escape');
  await expect(page.locator('#threat-warning')).toBeVisible();
  await page.keyboard.press('e');
  await expect(page.locator('#threat-warning')).toHaveAttribute('data-protected', 'true');
  await expect(page.locator('#threat-action')).toContainText('护盾生效');
  await expect(page.locator('#item-name')).toHaveText('寻找补给');
  await page.screenshot({ path: testInfo.outputPath('feedback-shield-protection.png') });
  await expect(page.locator('#combat-confirmation-text')).toHaveText('护盾拦截成功');
  await expect(page.locator('#combat-confirmation')).toBeVisible();
  await expect(page.locator('#threat-warning')).toBeHidden();
  const blocked = await page.evaluate(() => {
    const state = (window as any).__RALLY__.simulation.state;
    return { projectile: state.projectiles.some((projectile: any) => projectile.id === 900),
      shield: state.racers[0].shield, hitTime: state.racers[0].hitTime };
  });
  expect(blocked).toEqual({ projectile: false, shield: 0, hitTime: 0 });

  await clearRoad(page, { item: 'rocket', distance: 200, speed: 50 });
  await incomingRocket(page, 901);
  await expect(page.locator('#threat-warning')).toBeVisible();
  await expect(page.locator('#target-lock')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#target-lock')).toBeHidden();
  await page.locator('#restart-button').click();
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'countdown');
  for (const selector of ['#threat-warning', '#target-lock', '#target-reticle', '#drift-indicator', '#combat-confirmation']) {
    await expect(page.locator(selector)).toBeHidden();
  }
  expect(await page.evaluate(() => (window as any).__RALLY__.simulation.state.projectiles.length)).toBe(0);
  await expect(page.locator('body')).not.toHaveClass(/has-threat/);
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'racing');
  await expect(page.locator('#threat-warning')).toBeHidden();
  await expect(page.locator('#target-lock')).toBeHidden();
});

test.describe('touch feedback', () => {
  test.use({ isMobile: true, hasTouch: true, viewport: { width: 844, height: 390 }, deviceScaleFactor: 1 });

  test('99.5 percent charge upgrades both item icons and the real multi-touch drift feedback', async ({ page }, testInfo) => {
    await startRace(page);
    await clearRoad(page, { item: 'shield', charge: 0.995, lateral: -3 });
    const touchItem = page.locator('[data-control="item"]');
    await expect(page.locator('#item-panel')).toHaveClass(/is-powered/);
    await expect(touchItem).toHaveClass(/is-powered/);
    await expect(touchItem).toHaveAttribute('aria-label', '使用道具：能量护盾（已强化）');
    expect(await touchItem.locator('svg').innerHTML()).toBe(await page.locator('#item-icon svg').innerHTML());
    const release = await holdTouch(page, ['throttle', 'right', 'drift']);
    await waitForMiniBoost(page);
    await expect(page.locator('#drift-charge')).toBeVisible();
    await expect(page.locator('#drift-charge')).toHaveText('道具已强化 · 随时可释放');
    await expect(page.locator('#drift-hint')).toHaveText('松开漂移释放');
    await page.screenshot({ path: testInfo.outputPath('feedback-touch-charged-drift.png') });
    await release();
    await expect(page.locator('#drift-label')).toHaveText('出弯小喷');
    await touchItem.tap();
    await expect.poll(() => page.evaluate(() => (window as any).__RALLY__.simulation.state.racers[0].shield)).toBeGreaterThan(7);
    await expect(page.locator('#item-name')).toHaveText('寻找补给');
    await expect(touchItem).not.toHaveClass(/is-powered/);
    await expect(touchItem).toHaveAttribute('aria-label', '使用道具（尚未拾取）');
    expect(await touchItem.locator('svg').innerHTML()).toBe(await page.locator('#item-icon svg').innerHTML());
  });

  test('touch warning offers the item button and a real tap activates shield protection', async ({ page }) => {
    await startRace(page);
    await clearRoad(page, { item: 'shield', distance: 200, speed: 50 });
    await incomingRocket(page);
    await expect(page.locator('#threat-warning')).toHaveAttribute('data-direction', 'rear');
    await expect(page.locator('#threat-action')).toHaveText('点道具开启护盾');
    await page.locator('[data-control="item"]').tap();
    await expect(page.locator('#threat-warning')).toHaveAttribute('data-protected', 'true');
    await expect(page.locator('#threat-action')).toContainText('护盾生效');
    await expect(page.locator('#combat-confirmation-text')).toHaveText('护盾拦截成功');
    await expect(page.locator('#threat-warning')).toBeHidden();
    expect(await page.evaluate(() => (window as any).__RALLY__.simulation.state.racers[0].hitTime)).toBe(0);
  });

  for (const [width, height] of [[844, 390], [667, 375], [390, 844]]) {
    test(`feedback panels fit ${width}x${height} without hiding controls or each other`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height });
      await startRace(page);
      await clearRoad(page, { item: 'rocket', charge: 0.995, lateral: -3 });
      const release = await holdTouch(page, ['throttle', 'right', 'drift']);
      await waitForMiniBoost(page);
      await release();
      await expect(page.locator('#drift-label')).toHaveText('出弯小喷');
      await page.evaluate(() => {
        const state = (window as any).__RALLY__.simulation.state;
        const player = state.racers[0];
        // Align the car after the real drift so all three HUD panels stay visible
        // for the same frame; no fake DOM or simulation-loop replacement is used.
        Object.assign(player, { heading: 0, lateral: 0, speed: 35 });
        Object.assign(state.racers[2], { finished: false, distance: player.distance + 95, lateral: 0, speed: 20 });
        state.projectiles.push({ id: 902, type: 'rocket', owner: 1, distance: player.distance - 145,
          lateral: 0, lifetime: 4, powered: false, target: player.id });
      });
      await expect(page.locator('#target-lock')).toBeVisible();
      await expect(page.locator('#threat-warning')).toBeVisible();
      await expect(page.locator('#drift-indicator')).toBeVisible();
      const layout = await page.evaluate(() => {
        const selectors = ['.position-panel', '.race-clock', '#item-panel', '.speed-panel', '#drift-indicator',
          '#target-lock', '#threat-warning', ...Array.from(document.querySelectorAll<HTMLElement>('[data-control]'),
            element => `[data-control="${element.dataset.control}"]`)];
        const boxes = Object.fromEntries(selectors.map(selector => {
          const element = document.querySelector<HTMLElement>(selector)!;
          const box = element.getBoundingClientRect();
          return [selector, { x: box.x, y: box.y, width: box.width, height: box.height,
            visible: !element.hidden && getComputedStyle(element).display !== 'none' }];
        }));
        return { boxes, scrollWidth: document.documentElement.scrollWidth, viewportWidth: window.innerWidth };
      });
      await page.screenshot({ path: testInfo.outputPath(`feedback-layout-${width}x${height}.png`) });
      for (const [selector, box] of Object.entries(layout.boxes)) {
        expect(box.visible, `${selector} should be visible at ${width}x${height}`).toBe(true);
        expect(box.width, selector).toBeGreaterThan(0);
        expect(box.height, selector).toBeGreaterThan(0);
        expect(box.x, selector).toBeGreaterThanOrEqual(0);
        expect(box.y, selector).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, selector).toBeLessThanOrEqual(width + 1);
        expect(box.y + box.height, selector).toBeLessThanOrEqual(height + 1);
      }
      const disjoint = (first: string, second: string) => {
        const a = layout.boxes[first], b = layout.boxes[second];
        const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
        const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
        expect(overlapX <= 0 || overlapY <= 0, `${first} overlaps ${second} at ${width}x${height}`).toBe(true);
      };
      for (const control of ['left', 'right', 'brake', 'item', 'drift', 'boost', 'throttle']) {
        disjoint('#drift-indicator', `[data-control="${control}"]`);
      }
      disjoint('#drift-indicator', '#target-lock');
      disjoint('#drift-indicator', '#threat-warning');
      disjoint('#target-lock', '#threat-warning');
      disjoint('.race-clock', '#item-panel');
      disjoint('.race-clock', '#target-lock');
      disjoint('.speed-panel', '#target-lock');
      disjoint('#drift-indicator', '.speed-panel');
      expect(layout.scrollWidth).toBeLessThanOrEqual(layout.viewportWidth);
    });
  }
});
