/**
 * Exercise a production build using only the public UI and real input events.
 * Build and start a preview server first, then run: node scripts/smoke-site.mjs
 * RALLY_SMOKE_URL overrides http://127.0.0.1:4173/red-sand-rally/.
 * RALLY_SMOKE_OUTPUT overrides test-results/site-smoke.
 * Uses disposable Chrome contexts, never a personal browser or saved login.
 */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium, expect as playwrightExpect } from '@playwright/test';

const expect = playwrightExpect.configure({ timeout: 20_000 });
const baseURL = process.env.RALLY_SMOKE_URL || 'http://127.0.0.1:4173/red-sand-rally/';
const output = resolve(process.env.RALLY_SMOKE_OUTPUT || 'test-results/site-smoke');
const errors = [];
const screenshots = [];
const checks = {};
let browser;
let currentPage;

function observe(page, surface) {
  const responses = [];
  page.setDefaultTimeout(20_000);
  page.setDefaultNavigationTimeout(30_000);
  page.on('pageerror', error => errors.push({ surface, type: 'pageerror', message: error.message }));
  page.on('console', message => {
    if (message.type() === 'error') errors.push({ surface, type: 'console', message: message.text() });
  });
  page.on('requestfailed', request => errors.push({ surface, type: 'requestfailed',
    url: request.url(), message: request.failure()?.errorText || 'Unknown network failure' }));
  page.on('response', response => {
    responses.push({ url: response.url(), status: response.status(),
      type: response.request().resourceType(), contentType: response.headers()['content-type'] || '' });
    if (response.status() >= 400) errors.push({ surface, type: 'http',
      url: response.url(), status: response.status() });
  });
  return responses;
}

async function readyLobby(page) {
  await expect(page.locator('#loading')).toBeHidden();
  await expect(page).toHaveTitle(/赤沙狂飙/);
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'menu');
  await expect(page.locator('#viewport canvas')).toBeVisible();
  await expect(page.getByRole('group', { name: '赛车皮肤', exact: true })).toBeVisible();
  await expect(page.locator('#skin-picker input[name="skin"]')).toHaveCount(6);
  for (const swatch of await page.locator('#skin-picker .skin-option').all()) {
    await expect(swatch).toBeVisible();
    await expect(swatch).toBeInViewport();
  }
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  assert.equal(await page.evaluate(() => window.__RALLY__ === undefined), true,
    'Production site must not expose the development __RALLY__ hook');
}

async function capture(page, filename) {
  const filenamePath = join(output, filename);
  await page.screenshot({ path: filenamePath, fullPage: false });
  screenshots.push(filenamePath);
}

async function checkResources(page, responses) {
  const site = new URL(page.url());
  const prefix = new URL('.', site).pathname;
  const linked = await page.evaluate(() => ({
    scripts: [...document.querySelectorAll('script[src]')].map(element => element.src),
    styles: [...document.querySelectorAll('link[rel="stylesheet"]')].map(element => element.href),
    icons: [...document.querySelectorAll('link[rel~="icon"]')].map(element => element.href),
  }));
  assert(linked.scripts.length > 0 && linked.styles.length > 0 && linked.icons.length > 0,
    'Production HTML must reference built JavaScript, CSS and a favicon');

  // Headless Chrome does not always request the favicon automatically. Fetch
  // the real HTML-linked icon when needed; do not invent or substitute an URL.
  for (const iconURL of linked.icons) {
    if (!responses.some(response => response.url === iconURL && response.status >= 200 && response.status < 300)) {
      const iconResult = await page.evaluate(async url => {
        const response = await fetch(url);
        return { status: response.status, bytes: (await response.arrayBuffer()).byteLength };
      }, iconURL);
      assert(iconResult.status >= 200 && iconResult.status < 300 && iconResult.bytes > 0,
        `Favicon failed to load: ${iconURL}`);
    }
  }

  const relevant = responses.filter(response => ['script', 'stylesheet', 'font'].includes(response.type)
    || linked.icons.includes(response.url));
  for (const response of relevant) {
    const asset = new URL(response.url);
    assert.equal(asset.origin, site.origin, `Unexpected external asset: ${response.url}`);
    assert(asset.pathname.startsWith(prefix), `Asset escaped site prefix ${prefix}: ${response.url}`);
  }
  const successful = relevant.filter(response => response.status >= 200 && response.status < 300);
  for (const assetURL of [...linked.scripts, ...linked.styles, ...linked.icons]) {
    assert(successful.some(response => response.url === assetURL), `No successful response for ${assetURL}`);
  }
  const types = {
    javascript: successful.filter(response => response.type === 'script' && /javascript/.test(response.contentType)),
    css: successful.filter(response => response.type === 'stylesheet' && /text\/css/.test(response.contentType)),
    font: successful.filter(response => response.type === 'font' && /font|woff|octet-stream/.test(response.contentType)),
    favicon: successful.filter(response => linked.icons.includes(response.url) && /image\//.test(response.contentType)),
  };
  for (const [type, assets] of Object.entries(types)) assert(assets.length > 0, `No successfully loaded ${type} asset`);
  assert.equal(await page.evaluate(() => document.fonts.check('600 16px "Outfit Variable"')), true,
    'The bundled Outfit font must be ready');
  return { prefix, ...Object.fromEntries(Object.entries(types).map(([type, assets]) =>
    [type, new Set(assets.map(asset => asset.url)).size])) };
}

async function chooseAndReload(page, id, name) {
  const radio = page.getByRole('radio', { name, exact: true });
  await radio.check();
  await expect(radio).toBeChecked();
  await expect(page.locator('#skin-name')).toHaveText(name);
  await expect(page.locator('body')).toHaveAttribute('data-skin', id);
  await expect(page.locator('#skin-save-status')).toContainText('本机');
  await page.reload({ waitUntil: 'networkidle' });
  await readyLobby(page);
  await expect(page.getByRole('radio', { name, exact: true })).toBeChecked();
  await expect(page.locator('body')).toHaveAttribute('data-skin', id);
  await expect(page.locator('#skin-name')).toHaveText(name);
  await capture(page, `desktop-${id}.png`);
}

async function speedAbove40(page) {
  let measuredSpeed;
  await expect.poll(async () => measuredSpeed = Number(await page.locator('#speed').textContent()),
    { timeout: 20_000, message: 'Real input should accelerate the visible speedometer above 40 km/h' })
    .toBeGreaterThan(40);
  return measuredSpeed;
}

async function holdTouchThrottle(page) {
  const throttle = page.locator('[data-control="throttle"]');
  await expect(throttle).toBeVisible();
  const box = await throttle.boundingBox();
  assert(box, 'Touch throttle needs a visible hit area');
  const session = await page.context().newCDPSession(page);
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart',
    touchPoints: [{ id: 1, x: box.x + box.width / 2, y: box.y + box.height / 2 }] });
  return async () => {
    try { await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); }
    finally { await session.detach(); }
    await expect(throttle).not.toHaveClass(/is-pressed/);
  };
}

let failure;
try {
  assert(['http:', 'https:'].includes(new URL(baseURL).protocol), 'Smoke URL must use HTTP or HTTPS');
  await mkdir(output, { recursive: true });
  // This flag only bypasses proxy settings inside this disposable test browser.
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-proxy-server'] });
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1, serviceWorkers: 'block' });
  const page = currentPage = await desktop.newPage();
  const desktopResponses = observe(page, 'desktop');
  await page.goto(baseURL, { waitUntil: 'networkidle' });
  await readyLobby(page);
  checks.desktopAssets = await checkResources(page, desktopResponses);
  await chooseAndReload(page, 'midnight', '午夜电光');
  await chooseAndReload(page, 'glacier', '极地冰川');
  checks.skinPersistence = ['midnight', 'glacier'];

  await page.locator('#start-button').click();
  await page.keyboard.down('w');
  let desktopSpeed;
  try {
    await expect(page.locator('body')).toHaveAttribute('data-phase', 'racing');
    await expect(page.locator('#countdown')).toBeHidden();
    desktopSpeed = await speedAbove40(page);
    await capture(page, 'desktop-race.png');
  } finally { await page.keyboard.up('w'); }
  await page.keyboard.press('Escape');
  await expect(page.locator('#pause-dialog')).toBeVisible();
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'paused');
  await page.keyboard.press('Escape');
  await expect(page.locator('#pause-dialog')).toBeHidden();
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'racing');
  await page.keyboard.press('Escape');
  await page.locator('#lobby-button').click();
  await readyLobby(page);
  checks.desktop = { speedKmh: desktopSpeed, pauseResume: true, returnToLobby: true, devHookAbsent: true };
  await desktop.close();
  currentPage = undefined;

  const mobile = await browser.newContext({ viewport: { width: 844, height: 390 },
    deviceScaleFactor: 1, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const touchPage = currentPage = await mobile.newPage();
  const mobileResponses = observe(touchPage, 'mobile');
  await touchPage.goto(baseURL, { waitUntil: 'networkidle' });
  await readyLobby(touchPage);
  // A separate context must not inherit the desktop test's saved skin.
  await expect(touchPage.locator('body')).toHaveAttribute('data-skin', 'sandstorm');
  checks.mobileAssets = await checkResources(touchPage, mobileResponses);
  await touchPage.locator('#start-button').tap();
  await expect(touchPage.locator('body')).toHaveAttribute('data-phase', 'racing');
  await expect(touchPage.locator('#countdown')).toBeHidden();
  await expect(touchPage.locator('body')).toHaveAttribute('data-input-mode', 'touch');
  const release = await holdTouchThrottle(touchPage);
  let mobileSpeed;
  try {
    await expect(touchPage.locator('[data-control="throttle"]')).toHaveClass(/is-pressed/);
    mobileSpeed = await speedAbove40(touchPage);
    await capture(touchPage, 'mobile-race.png');
  } finally { await release(); }
  checks.mobile = { viewport: '844x390', speedKmh: mobileSpeed, realTouch: true, isolatedStorage: true, devHookAbsent: true };
  await mobile.close();
  currentPage = undefined;
  assert.deepEqual(errors, [], 'Production smoke test detected browser or network errors');
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  if (currentPage && !currentPage.isClosed()) {
    await capture(currentPage, 'failure.png').catch(() => {});
  }
  process.exitCode = 1;
} finally {
  await browser?.close();
  console.log(JSON.stringify({ status: failure ? 'failed' : 'passed', url: baseURL,
    checks, errors, ...(failure ? { failure } : {}), screenshots }));
}
