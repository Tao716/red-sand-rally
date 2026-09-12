import { test as base, expect, type Page } from '@playwright/test';

const SKINS = [
  { id: 'sandstorm', name: '赤沙经典' },
  { id: 'midnight', name: '午夜电光' },
  { id: 'glacier', name: '极地冰川' },
  { id: 'neon', name: '霓虹脉冲' },
  { id: 'venom', name: '毒液竞速' },
  { id: 'ember', name: '熔岩余烬' },
] as const;
type SkinId = typeof SKINS[number]['id'];
const SKIN_KEY = 'sand-rally-skin-v1';

const test = base.extend<{ browserErrors: string[] }>({
  browserErrors: [async ({ page }, use) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await use(errors);
    expect(errors, 'skin selection and the live renderer must not produce browser errors').toEqual([]);
  }, { auto: true }],
});

async function openLobby(page: Page) {
  await page.goto('/');
  await expect(page.locator('#loading')).toBeHidden();
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'menu');
  await expect(page.getByRole('group', { name: '赛车皮肤', exact: true })).toBeVisible();
  await expect(page.locator('#viewport canvas')).toBeVisible();
}

async function expectSkin(page: Page, id: SkinId) {
  const skin = SKINS.find(skin => skin.id === id)!;
  await expect(page.locator(`#skin-picker input[value="${id}"]`)).toBeChecked();
  await expect(page.locator('#skin-name')).toHaveText(skin.name);
  await expect.poll(() => page.evaluate(() => {
    const renderer = (window as any).__RALLY__.renderer;
    return { selected: renderer.playerSkin, displayed: renderer.cars.get(0)?.userData.skinId };
  })).toEqual({ selected: id, displayed: id });
}

async function chooseSkin(page: Page, id: SkinId) {
  await page.getByRole('radio', { name: SKINS.find(skin => skin.id === id)!.name, exact: true }).check();
  await expectSkin(page, id);
}

async function settlePreview(page: Page) {
  // Portrait and landscape use different showroom cameras. Observe their real
  // interpolation so responsive screenshots do not capture a clipped transition.
  await page.waitForFunction(() => {
    const renderer = (window as any).__RALLY__.renderer;
    return renderer.camera.position.distanceTo(renderer.targetPosition) < 0.06
      && renderer.lookAt.distanceTo(renderer.targetLook) < 0.04;
  });
}

async function previewVisibility(page: Page) {
  return page.evaluate(() => {
    const renderer = (window as any).__RALLY__.renderer;
    const player = renderer.cars.get(0);
    const points: { x: number; y: number }[] = [];
    player.updateMatrixWorld(true);
    player.traverse((object: any) => {
      if (!object.isMesh) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      // Use painted body geometry, never exhaust flames, shields or other VFX.
      if (!materials.some((material: any) => material.name === 'car/body')) return;
      object.geometry.computeBoundingBox();
      const bounds = object.geometry.boundingBox;
      for (const x of [bounds.min.x, bounds.max.x]) {
        for (const y of [bounds.min.y, bounds.max.y]) {
          for (const z of [bounds.min.z, bounds.max.z]) {
            const point = bounds.min.clone().set(x, y, z).applyMatrix4(object.matrixWorld).project(renderer.camera);
            points.push({ x: (point.x + 1) * innerWidth / 2, y: (1 - point.y) * innerHeight / 2 });
          }
        }
      }
    });
    if (!points.length) throw new Error('Player paint geometry is missing from the live showroom');
    const car = { left: Math.min(...points.map(point => point.x)), right: Math.max(...points.map(point => point.x)),
      top: Math.min(...points.map(point => point.y)), bottom: Math.max(...points.map(point => point.y)) };
    const clipped = { left: Math.max(0, car.left), right: Math.min(innerWidth, car.right),
      top: Math.max(0, car.top), bottom: Math.min(innerHeight, car.bottom) };
    const area = (rect: typeof car) => Math.max(0, rect.right - rect.left) * Math.max(0, rect.bottom - rect.top);
    const intersection = (a: typeof car, b: typeof car) => ({ left: Math.max(a.left, b.left), right: Math.min(a.right, b.right),
      top: Math.max(a.top, b.top), bottom: Math.min(a.bottom, b.bottom) });
    const obstructing = ['#skin-picker', '.track-card'].map(selector => {
      const rect = document.querySelector(selector)!.getBoundingClientRect();
      return { selector, ...intersection(clipped, rect) };
    });
    // Exact union for the two cards, so their intersection is never double-counted.
    const covered = obstructing.reduce((sum, rect) => sum + area(rect), 0) - area(intersection(obstructing[0], obstructing[1]));
    const total = area(car);
    return { car, clipped, obstructing, total, unobstructedRatio: total > 0 ? (area(clipped) - covered) / total : 0 };
  });
}

async function carSnapshot(page: Page) {
  return page.evaluate(() => {
    const game = (window as any).__RALLY__;
    const cars = [...game.renderer.cars.entries()].map(([id, car]: any) => {
      const meshes: any[] = [];
      let bounds: any;
      car.updateMatrixWorld(true);
      car.traverse((object: any) => {
        if (!object.isMesh) return;
        const materials = (Array.isArray(object.material) ? object.material : [object.material]).map((material: any) => ({
          uuid: material.uuid, name: material.name, color: material.color?.getHex(), emissive: material.emissive?.getHex(),
          emissiveIntensity: material.emissiveIntensity, roughness: material.roughness, metalness: material.metalness,
          map: material.map?.uuid ?? null,
        }));
        meshes.push({ object: object.uuid, geometry: object.geometry.uuid, materials });
        if (!object.visible) return;
        for (let ancestor = object.parent; ancestor && ancestor !== car; ancestor = ancestor.parent) {
          if (!ancestor.visible) return;
        }
        object.geometry.computeBoundingBox();
        const partBounds = object.geometry.boundingBox.clone().applyMatrix4(object.matrixWorld);
        if (bounds) bounds.union(partBounds); else bounds = partBounds;
      });
      return { id, object: car.uuid, meshes,
        bounds: bounds ? { min: bounds.min.toArray(), max: bounds.max.toArray() } : null,
        wheels: (car.userData.wheels ?? []).map((wheel: any) => ({ position: wheel.position.toArray(), scale: wheel.scale.toArray() })),
      };
    });
    return { cars, state: game.simulation.state, colliders: game.renderer.staticColliders };
  });
}

async function gpuMemory(page: Page) {
  // Wait for the selected materials to have been drawn, not just the radio event.
  return page.evaluate(async () => {
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const memory = (window as any).__RALLY__.renderer.renderer.info.memory;
    return { textures: memory.textures, geometries: memory.geometries };
  });
}

test('six accessible skins immediately preview the real player car and save locally', async ({ page }, testInfo) => {
  await openLobby(page);
  await expectSkin(page, 'sandstorm');
  await expect(page.locator('#skin-picker')).toHaveJSProperty('tagName', 'FIELDSET');
  await expect(page.locator('#skin-picker input[type="radio"][name="skin"]')).toHaveCount(6);
  // Returning to the default is a real change, so storage need not write on initial load.
  await chooseSkin(page, 'midnight');
  const descriptions = new Set<string>();
  for (const skin of SKINS) {
    await chooseSkin(page, skin.id);
    await expect(page.locator('#skin-description')).not.toHaveText('');
    descriptions.add((await page.locator('#skin-description').textContent())!);
    await expect(page.locator('#skin-save-status')).toContainText('本机');
    expect(await page.evaluate(key => localStorage.getItem(key), SKIN_KEY)).toBe(skin.id);
    if (['midnight', 'glacier', 'ember'].includes(skin.id)) {
      await settlePreview(page);
      await page.screenshot({ path: testInfo.outputPath(`skin-${skin.id}-desktop.png`), animations: 'disabled' });
      await page.locator('#viewport canvas').screenshot({ path: testInfo.outputPath(`skin-${skin.id}-3d.png`) });
    }
  }
  expect(descriptions.size, 'each livery has its own readable description').toBe(SKINS.length);
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'menu');
});

test('skin radios support native arrow-key navigation without starting the race', async ({ page }) => {
  await openLobby(page);
  await page.getByRole('radio', { name: '赤沙经典', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expectSkin(page, 'midnight');
  await page.keyboard.press('ArrowRight');
  await expectSkin(page, 'glacier');
  await page.keyboard.press('ArrowLeft');
  await expectSkin(page, 'midnight');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expectSkin(page, 'ember');
  await page.keyboard.press('Space');
  await expectSkin(page, 'ember');
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'menu');
  expect(await page.evaluate(key => localStorage.getItem(key), SKIN_KEY)).toBe('ember');
});

test('a saved skin survives difficulty changes, real driving, pause, restart and both lobby routes', async ({ page }, testInfo) => {
  await openLobby(page);
  await chooseSkin(page, 'neon');
  await page.reload();
  await expect(page.locator('#loading')).toBeHidden();
  await expectSkin(page, 'neon');
  await page.getByRole('radio', { name: '困难', exact: true }).check();
  await expectSkin(page, 'neon');
  await page.locator('#start-button').click();
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'countdown');
  for (const skin of SKINS) await expect(page.locator(`#skin-picker input[value="${skin.id}"]`)).toBeDisabled();
  await page.keyboard.down('w');
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'racing');
  await expect.poll(() => page.evaluate(() => (window as any).__RALLY__.simulation.state.racers[0].speed)).toBeGreaterThan(15);
  await page.keyboard.up('w');
  await expectSkin(page, 'neon');
  await page.screenshot({ path: testInfo.outputPath('skin-neon-racing.png') });
  await page.keyboard.press('Escape');
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'paused');
  await expectSkin(page, 'neon');
  await page.locator('#restart-button').click();
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'countdown');
  await expectSkin(page, 'neon');
  await page.keyboard.press('Escape');
  await expect(page.locator('#pause-dialog')).toBeVisible();
  await page.locator('#lobby-button').click();
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'menu');
  await expectSkin(page, 'neon');
  for (const skin of SKINS) await expect(page.getByRole('radio', { name: skin.name, exact: true })).toBeEnabled();
  await expect(page.getByRole('radio', { name: '困难', exact: true })).toBeChecked();
  await chooseSkin(page, 'venom');
  await page.getByRole('radio', { name: '地狱', exact: true }).check();
  await expectSkin(page, 'venom');
  await page.locator('#start-button').click();
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'racing');
  // Arrange the finish position only; real physics and the finish/results UI still run.
  await page.evaluate(async () => {
    const { TRACK_LENGTH } = await import('/src/track.ts');
    const state = (window as any).__RALLY__.simulation.state;
    Object.assign(state.racers[0], { distance: TRACK_LENGTH * 3 - 0.5, speed: 40, heading: 0, lateral: 0, lap: 3 });
  });
  await expect(page.locator('#results-dialog')).toBeVisible();
  await expectSkin(page, 'venom');
  await page.locator('#results-lobby-button').click();
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'menu');
  await expectSkin(page, 'venom');
  await expect(page.getByRole('radio', { name: '地狱', exact: true })).toBeChecked();
  expect(await page.evaluate(key => localStorage.getItem(key), SKIN_KEY)).toBe('venom');
});

test('invalid stored skin safely falls back to the classic car and remains changeable', async ({ page }) => {
  await page.addInitScript(key => localStorage.setItem(key, 'not-a-real-skin'), SKIN_KEY);
  await openLobby(page);
  await expectSkin(page, 'sandstorm');
  await chooseSkin(page, 'glacier');
  expect(await page.evaluate(key => localStorage.getItem(key), SKIN_KEY)).toBe('glacier');
});

for (const failure of ['unavailable', 'quota'] as const) {
  test(`skin selection and driving remain usable when local storage is ${failure}`, async ({ page }) => {
    await page.addInitScript(failure => {
      if (failure === 'unavailable') {
        Storage.prototype.getItem = () => { throw new DOMException('Storage access denied', 'SecurityError'); };
      }
      Storage.prototype.setItem = () => {
        throw new DOMException('Storage write denied', failure === 'quota' ? 'QuotaExceededError' : 'SecurityError');
      };
    }, failure);
    await openLobby(page);
    await expectSkin(page, 'sandstorm');
    await chooseSkin(page, 'midnight');
    await expect(page.locator('#skin-save-status')).toContainText(/无法|未保存|受限|禁止|不可用|本次/);
    await page.locator('#start-button').click();
    await page.keyboard.down('w');
    await expect(page.locator('body')).toHaveAttribute('data-phase', 'racing');
    await expect.poll(() => page.evaluate(() => (window as any).__RALLY__.simulation.state.racers[0].speed)).toBeGreaterThan(12);
    await page.keyboard.up('w');
    await page.keyboard.press('Escape');
    await page.locator('#lobby-button').click();
    await expect(page.locator('body')).toHaveAttribute('data-phase', 'menu');
    await expectSkin(page, 'midnight');
    await expect(page.locator('#skin-save-status')).toContainText(/无法|未保存|受限|禁止|不可用|本次/);
  });
}

test('liveries only change player appearance and repeated switches keep GPU resources bounded', async ({ page }, testInfo) => {
  await openLobby(page);
  const before = await carSnapshot(page);
  expect(before.cars).toHaveLength(6);
  const classic = before.cars.find(car => car.id === 0)!;
  const classicBody = classic.meshes.flatMap(mesh => mesh.materials).find(material => material.name === 'car/body');
  expect(classicBody, 'the real player paint must exist in the scene').toBeDefined();
  for (const skin of SKINS.slice(1)) {
    await chooseSkin(page, skin.id);
    const after = await carSnapshot(page);
    const player = after.cars.find(car => car.id === 0)!;
    // A livery may recreate/dispose owned meshes or add thin decal films, but it
    // must not resize the vehicle or move the wheels/contact patches.
    expect(player.wheels).toEqual(classic.wheels);
    for (const edge of ['min', 'max'] as const) {
      player.bounds![edge].forEach((value: number, axis: number) => expect(value).toBeCloseTo(classic.bounds![edge][axis], 2));
    }
    const body = player.meshes.flatMap(mesh => mesh.materials).find(material => material.name === 'car/body');
    expect(body, `${skin.id} must retain real 3D paint`).toBeDefined();
    expect(body!.color, `${skin.id} must change the actual 3D paint color`).not.toBe(classicBody!.color);
    expect(after.cars.filter(car => car.id !== 0), 'AI cars must keep their own identity').toEqual(before.cars.filter(car => car.id !== 0));
    expect(after.state, 'cosmetic selection must not reset or tune race physics').toEqual(before.state);
    expect(after.colliders, 'skin selection must preserve the scene collision shapes').toEqual(before.colliders);
  }
  // Every measured cycle ends on ember: compare like-for-like decal resources.
  await chooseSkin(page, 'ember');
  const baseline = await gpuMemory(page);
  const samples = [baseline];
  // All six have been compiled and drawn once before measuring repeated real UI changes.
  for (let cycle = 0; cycle < 4; cycle++) {
    for (const skin of SKINS) await chooseSkin(page, skin.id);
    samples.push(await gpuMemory(page));
  }
  await testInfo.attach('skin-gpu-memory', { body: JSON.stringify(samples, null, 2), contentType: 'application/json' });
  for (const sample of samples) {
    // One lazily initialized renderer allocation is acceptable; growth per switch is not.
    expect(sample.textures).toBeLessThanOrEqual(baseline.textures + 1);
    expect(sample.geometries).toBeLessThanOrEqual(baseline.geometries + 1);
  }
  expect(samples.at(-1)!.textures).toBeLessThanOrEqual(samples[1].textures + 1);
  expect(samples.at(-1)!.geometries).toBeLessThanOrEqual(samples[1].geometries + 1);
});

test('all skin cards, the start button and track information fit six viewport sizes without overlap', async ({ page }, testInfo) => {
  await openLobby(page);
  for (const [width, height] of [[1440, 900], [1366, 768], [390, 844], [360, 740], [844, 390], [667, 375]]) {
    await page.setViewportSize({ width, height });
    await chooseSkin(page, 'glacier');
    await chooseSkin(page, 'ember');
    await settlePreview(page);
    const layout = await page.evaluate(() => {
      const selectors = ['#skin-picker', '#start-button', '.track-card', '.personal-best', '.menu-footer'];
      const box = (element: Element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      };
      return {
        controls: selectors.map(selector => ({ selector, ...box(document.querySelector(selector)!) })),
        cards: [...document.querySelectorAll('#skin-picker input[name="skin"]')].map(input => ({
          id: (input as HTMLInputElement).value, ...box(input.closest('label')!),
        })),
        scrollWidth: document.documentElement.scrollWidth,
      };
    });
    await testInfo.attach(`skin-layout-${width}x${height}`, { body: JSON.stringify(layout, null, 2), contentType: 'application/json' });
    for (const item of [...layout.controls, ...layout.cards]) {
      const name = 'selector' in item ? item.selector : item.id;
      expect(item.width, `${name} visible at ${width}x${height}`).toBeGreaterThan(0);
      expect(item.height, `${name} visible at ${width}x${height}`).toBeGreaterThan(0);
      expect(item.x, `${name} left edge at ${width}x${height}`).toBeGreaterThanOrEqual(-1);
      expect(item.y, `${name} top edge at ${width}x${height}`).toBeGreaterThanOrEqual(-1);
      expect(item.x + item.width, `${name} right edge at ${width}x${height}`).toBeLessThanOrEqual(width + 1);
      expect(item.y + item.height, `${name} bottom edge at ${width}x${height}`).toBeLessThanOrEqual(height + 1);
    }
    for (let i = 0; i < layout.controls.length; i++) {
      for (let j = i + 1; j < layout.controls.length; j++) {
        const a = layout.controls[i], b = layout.controls[j];
        const overlapWidth = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
        const overlapHeight = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
        expect(overlapWidth <= 1 || overlapHeight <= 1,
          `${a.selector} must not overlap ${b.selector} at ${width}x${height}`).toBe(true);
      }
    }
    expect(layout.scrollWidth).toBeLessThanOrEqual(width);
    if (height <= 570 && width > height) {
      const preview = await previewVisibility(page);
      await testInfo.attach(`skin-preview-visibility-${width}x${height}`, {
        body: JSON.stringify(preview, null, 2), contentType: 'application/json',
      });
      expect(preview.total, 'the real player body must project into the showroom').toBeGreaterThan(0);
      expect(preview.unobstructedRatio, `at least 70% of the ${width}x${height} skin preview must remain visible`).toBeGreaterThanOrEqual(0.70);
    }
    await page.screenshot({ path: testInfo.outputPath(`skin-menu-${width}x${height}.png`), animations: 'disabled' });
  }
});

test.describe('touch skin selection', () => {
  test.use({ isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });

  test('phone taps change the preview and the chosen car survives landscape start', async ({ page }, testInfo) => {
    await openLobby(page);
    await page.getByRole('radio', { name: '极地冰川', exact: true }).tap();
    await expectSkin(page, 'glacier');
    await page.getByRole('radio', { name: '霓虹脉冲', exact: true }).tap();
    await expectSkin(page, 'neon');
    await settlePreview(page);
    await page.screenshot({ path: testInfo.outputPath('skin-neon-phone-selection.png'), animations: 'disabled' });
    await page.setViewportSize({ width: 844, height: 390 });
    await page.getByRole('radio', { name: '毒液竞速', exact: true }).tap();
    await expectSkin(page, 'venom');
    await settlePreview(page);
    expect((await previewVisibility(page)).unobstructedRatio, 'landscape phone controls must not hide the selected paint').toBeGreaterThanOrEqual(0.70);
    await page.screenshot({ path: testInfo.outputPath('skin-venom-phone-landscape.png'), animations: 'disabled' });
    await page.locator('#start-button').tap();
    await expect(page.locator('body')).toHaveAttribute('data-phase', 'racing');
    await expectSkin(page, 'venom');
    await expect(page.locator('[data-control="throttle"]')).toBeVisible();
    expect(await page.evaluate(key => localStorage.getItem(key), SKIN_KEY)).toBe('venom');
  });
});
