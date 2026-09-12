/**
 * Capture the current game for README documentation.
 * Usage: npm run dev, then node scripts/capture-readme.mjs
 * Optional: RALLY_CAPTURE_URL=http://127.0.0.1:5173 node scripts/capture-readme.mjs
 *
 * Uses a fresh, non-persistent Chrome context; no personal browser data is read.
 * Lobby, desktop race and mobile race use ordinary controls. The drift and
 * combat images are controlled demonstrations using the same physical-state
 * fixtures as tests/feedback-game.spec.ts. Input, simulation, renderer and HUD
 * remain real: no DOM text, artwork, collision rules or camera are fabricated.
 */
import assert from 'node:assert/strict';
import { mkdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const baseURL = process.env.RALLY_CAPTURE_URL || 'http://127.0.0.1:5173';
const output = fileURLToPath(new URL('../docs/screenshots/', import.meta.url));
const captures = [];
const browserErrors = [];
const skinNames = { midnight: '午夜电光', glacier: '极地冰川', ember: '熔岩余烬', neon: '霓虹脉冲', venom: '毒液竞速' };
await mkdir(output, { recursive: true });

function observeErrors(page) {
  page.on('pageerror', error => browserErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') browserErrors.push(message.text()); });
  page.setDefaultTimeout(15_000);
}

async function openLobby(page) {
  await page.goto(baseURL, { waitUntil: 'networkidle' });
  await expect(page.locator('#loading')).toBeHidden();
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'menu');
  await expect(page.getByRole('group', { name: '赛车皮肤', exact: true })).toBeVisible();
  await page.waitForFunction(() => !!window.__RALLY__, undefined, { timeout: 10_000 });
  await settleStationaryCamera(page);
}

async function settleStationaryCamera(page) {
  // Observe normal interpolation; never reposition the camera for documentation.
  await page.waitForFunction(() => {
    const renderer = window.__RALLY__.renderer;
    return renderer.camera.position.distanceTo(renderer.targetPosition) < 0.06
      && renderer.lookAt.distanceTo(renderer.targetLook) < 0.04;
  });
}

async function chooseSkin(page, id) {
  await page.getByRole('radio', { name: skinNames[id], exact: true }).check();
  await expect(page.locator('#skin-name')).toHaveText(skinNames[id]);
  await expect.poll(() => page.evaluate(() => window.__RALLY__.renderer.cars.get(0)?.userData.skinId)).toBe(id);
  await page.mouse.move(1410, 870);
  await settleStationaryCamera(page);
  // Wait out the skin-heading entrance, plus two completed render frames.
  await page.waitForTimeout(350);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function capture(page, filename, description, check = async () => {}, screenshotOptions = {}) {
  await check();
  await expect(page.locator('#loading')).toBeHidden();
  await expect(page.locator('#pause-dialog')).toBeHidden();
  await page.screenshot({ path: `${output}${filename}`, type: 'jpeg', quality: 85, fullPage: false, ...screenshotOptions });
  const { size } = await stat(`${output}${filename}`);
  const metadata = await page.evaluate(() => {
    const state = window.__RALLY__.simulation.state;
    const player = state.racers[0];
    return { viewport: `${innerWidth}x${innerHeight}`, phase: state.phase,
      skin: window.__RALLY__.renderer.playerSkin, raceTime: +state.time.toFixed(2),
      speedKmh: Math.round(player.speed * 3.6), boostTime: +player.boostTime.toFixed(2),
      drift: document.querySelector('#drift-indicator').hidden ? null : document.querySelector('#drift-label').textContent,
      warning: document.querySelector('#threat-warning').hidden ? null : document.querySelector('#threat-label').textContent };
  });
  captures.push({ filename, bytes: size, description, ...metadata });
  console.log(JSON.stringify(captures.at(-1)));
}

async function beginRace(page, throttle = true) {
  await page.locator('#start-button').click();
  if (throttle) await page.keyboard.down('w');
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'racing', { timeout: 15_000 });
  await expect(page.locator('#countdown')).toBeHidden();
}

async function clearRoad(page, changes = {}) {
  // This is physical-state staging, not a normal race. Keep that distinction in
  // the README caption; all feedback afterwards comes from the real game loop.
  await page.evaluate(changes => {
    const game = window.__RALLY__;
    const state = game.simulation.state;
    game.input.clear();
    game.simulation.resetPlayer();
    state.racers.slice(1).forEach((racer, index) => {
      Object.assign(racer, { finished: true, distance: 650 + index * 90, lateral: -5 });
    });
    state.pickups.forEach(pickup => { pickup.cooldown = 100; });
    state.projectiles = [];
    Object.assign(state.racers[0], {
      distance: 35, lateral: -3, heading: 0, speed: 0, item: null, charge: 0,
      energy: 70, driftTime: 0, shield: 0, boostTime: 0, hitTime: 0, collisionTime: 0,
      invulnerable: 0, finished: false, ...changes,
    });
  }, changes);
  await settleStationaryCamera(page);
}

async function holdTouch(page, controls) {
  const session = await page.context().newCDPSession(page);
  const touchPoints = [];
  for (const [index, control] of controls.entries()) {
    const box = await page.locator(`[data-control="${control}"]`).boundingBox();
    assert(box, `${control} must be visible`);
    touchPoints.push({ id: index + 1, x: box.x + box.width / 2, y: box.y + box.height / 2 });
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints });
  return async () => {
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await session.detach();
  };
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await desktop.newPage();
  observeErrors(page);
  await openLobby(page);
  for (const [id, file] of [['midnight', 'menu-skins.jpg'], ['glacier', 'skin-glacier.jpg'], ['ember', 'skin-ember.jpg']]) {
    await chooseSkin(page, id);
    const screenshotOptions = id === 'midnight' ? {} : { clip: { x: 780, y: 185, width: 620, height: 415 } };
    await capture(page, file, `Normal lobby interaction: ${skinNames[id]}${id === 'midnight' ? ', six available skins.' : '; same showroom-camera crop, no composite.'}`,
      async () => {}, screenshotOptions);
  }

  await chooseSkin(page, 'neon');
  await beginRace(page);
  await page.keyboard.down('Shift');
  await page.waitForFunction(() => {
    const player = window.__RALLY__.simulation.state.racers[0];
    return player.speed > 40 && player.boostTime > 0;
  });
  await capture(page, 'race-desktop.jpg', 'Unmodified race: real throttle and Shift boost, default AI opponents.');
  await page.keyboard.up('Shift');
  await page.keyboard.up('w');

  await clearRoad(page);
  await page.evaluate(() => { window.__RALLY__.simulation.state.racers[0].speed = 35; });
  await page.keyboard.down('w');
  await page.keyboard.down('d');
  await page.keyboard.down('Space');
  await page.waitForFunction(() => window.__RALLY__.simulation.state.racers[0].driftTime > 0.5
    && document.querySelector('#drift-label').textContent === '小喷就绪', undefined, { polling: 'raf' });
  await page.keyboard.up('Space');
  await page.keyboard.up('d');
  await page.waitForFunction(() => document.querySelector('#drift-label').textContent === '出弯小喷'
    && window.__RALLY__.simulation.state.racers[0].boostTime > 0, undefined, { polling: 'raf' });
  await capture(page, 'drift-boost.jpg', 'Controlled clear-road demonstration; real W+D+Space drift and release trigger the mini-boost.', async () => {
    await expect(page.locator('#drift-indicator')).toBeVisible();
    await expect(page.locator('#drift-label')).toHaveText('出弯小喷');
  });
  await page.keyboard.up('w');

  await clearRoad(page, { item: 'shield', distance: 200, lateral: 0 });
  // Let the previous, genuine mini-boost cue expire before staging a new subject.
  await expect(page.locator('#drift-indicator')).toBeHidden();
  await page.evaluate(() => {
    const state = window.__RALLY__.simulation.state;
    const player = state.racers[0];
    player.speed = 50;
    state.projectiles.push({ id: 900, type: 'rocket', owner: 1, distance: player.distance - 145,
      lateral: player.lateral, lifetime: 4, powered: false, target: player.id });
  });
  await page.keyboard.down('w');
  await expect(page.locator('#threat-warning')).toBeVisible();
  await expect(page.locator('#threat-action')).toHaveText('按 E 开启护盾');
  await page.waitForTimeout(300);
  await capture(page, 'combat-warning.jpg', 'Controlled incoming-rocket scenario with an unused shield; real trajectory prediction and HUD.', async () => {
    await expect(page.locator('#threat-warning')).toBeVisible();
    await expect(page.locator('#threat-action')).toHaveText('按 E 开启护盾');
    await expect(page.locator('#item-name')).toHaveText('能量护盾');
  });
  await page.keyboard.up('w');
  await desktop.close();

  const mobile = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 1,
    isMobile: true, hasTouch: true });
  const touchPage = await mobile.newPage();
  observeErrors(touchPage);
  await openLobby(touchPage);
  await touchPage.getByRole('radio', { name: skinNames.venom, exact: true }).check();
  await touchPage.locator('#start-button').tap();
  await expect(touchPage.locator('[data-control="throttle"]')).toBeVisible();
  let release = await holdTouch(touchPage, ['throttle']);
  try {
    await expect(touchPage.locator('body')).toHaveAttribute('data-phase', 'racing', { timeout: 15_000 });
    await expect(touchPage.locator('#countdown')).toBeHidden();
    await release();
    release = async () => {};
    release = await holdTouch(touchPage, ['throttle', 'boost']);
    await touchPage.waitForFunction(() => window.__RALLY__.simulation.state.racers[0].speed > 35);
    await capture(touchPage, 'race-mobile.jpg', 'Unmodified mobile race: real simultaneous touchscreen throttle and boost, acid-green skin.', async () => {
      await expect(touchPage.locator('body')).toHaveAttribute('data-input-mode', 'touch');
      await expect(touchPage.locator('[data-control="throttle"]')).toBeVisible();
      await expect(touchPage.locator('[data-control="drift"]')).toBeVisible();
    });
  } finally {
    await release();
  }
  await mobile.close();
  assert.deepEqual(browserErrors, [], 'Screenshots must not hide browser errors');
  const total = captures.reduce((bytes, capture) => bytes + capture.bytes, 0);
  console.log(`Captured ${captures.length} JPEGs (${(total / 1024).toFixed(0)} KiB total) in ${output}`);
  assert.equal(captures.length, 7);
  assert(total < 1_600_000, 'Keep README screenshots compact (under 1.6 MB total)');
} finally {
  await browser.close();
}
