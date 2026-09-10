import { test, expect } from '@playwright/test';

test('the full original arrangement renders finite stereo audio without clipping', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#loading')).toBeHidden();
  const report = await page.evaluate(async () => {
    const { RallyMusic, MUSIC_BPM } = await import('/src/music.ts');
    const { SCORE_BARS } = await import('/src/music-score.ts');
    const stepLength = 60 / MUSIC_BPM / 4;
    const duration = SCORE_BARS * 16 * stepLength + 1;
    const context = new OfflineAudioContext(2, Math.ceil(duration * 24000), 24000);
    const music: any = new RallyMusic(context as unknown as AudioContext, context.destination);
    // Offline rendering uses the actual instruments and score, without a wall-clock timer.
    music.mode = music.effectiveMode = 'racing';
    music.master.gain.value = 0.4;
    music.applyLayers(0.01);
    for (let bar = 0; bar < SCORE_BARS; bar++) {
      music.intensity = bar >= 24 ? 0.95 : 0.28;
      music.arpBus.gain.setValueAtTime(music.intensity * 0.58, bar * 16 * stepLength);
      for (let step = 0; step < 16; step++) {
        const time = 0.05 + (bar * 16 + step) * stepLength + (step % 2 ? stepLength * 0.105 : 0);
        music.scheduleStep(bar, step, time);
      }
    }
    const buffer = await context.startRendering();
    let peak = 0, energy = 0, stereoDifference = 0, finite = true;
    const left = buffer.getChannelData(0), right = buffer.getChannelData(1);
    const sections = [0, 0, 0, 0];
    for (let i = 0; i < left.length; i++) {
      finite &&= Number.isFinite(left[i]) && Number.isFinite(right[i]);
      peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
      energy += left[i] * left[i] + right[i] * right[i];
      stereoDifference += Math.abs(left[i] - right[i]);
      const section = Math.min(3, Math.floor(i / context.sampleRate / (8 * 16 * stepLength)));
      sections[section] += left[i] * left[i] + right[i] * right[i];
    }
    music.dispose();
    return { finite, peak, rms: Math.sqrt(energy / (left.length * 2)),
      stereoDifference: stereoDifference / left.length, duration: buffer.duration,
      sections, activeSources: music.snapshot.activeSources };
  });
  expect(report.finite).toBe(true);
  expect(report.duration).toBeGreaterThan(58);
  expect(report.rms).toBeGreaterThan(0.008);
  expect(report.peak).toBeLessThan(0.95);
  expect(report.stereoDifference).toBeGreaterThan(0.0005);
  expect(report.sections.every(energy => energy > 5)).toBe(true);
  expect(report.activeSources).toBe(0);
});

test('music waits for interaction, produces audio, and has independent persistent controls', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/');
  await expect(page.locator('#loading')).toBeHidden();
  expect(await page.evaluate(() => (window as any).__RALLY__.audio.snapshot.contextState)).toBe('locked');
  await page.locator('#music-button').click();
  await expect(page.locator('#music-panel')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__RALLY__.audio.snapshot.music?.timerActive)).toBe(true);
  await expect(page.locator('#radio-status')).toContainText('巡航版');
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as any).__RALLY__.audio.snapshot.music.scheduledNotes)).toBeGreaterThan(0);

  // Read the live music bus before it reaches the speakers, using the browser's real DSP.
  const signal = await page.evaluate(async () => {
    const audio = (window as any).__RALLY__.audio;
    const analyser = audio.context.createAnalyser();
    analyser.fftSize = 2048;
    audio.musicDuck.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    let energy = 0, peak = 0, count = 0;
    for (let frame = 0; frame < 24; frame++) {
      await new Promise(resolve => window.setTimeout(resolve, 35));
      analyser.getFloatTimeDomainData(samples);
      for (const sample of samples) { energy += sample * sample; peak = Math.max(peak, Math.abs(sample)); count++; }
    }
    audio.musicDuck.disconnect(analyser); analyser.disconnect();
    return { rms: Math.sqrt(energy / count), peak };
  });
  expect(signal.rms).toBeGreaterThan(0.001);
  expect(signal.peak).toBeLessThan(0.95);
  await page.screenshot({ path: 'test-results/music-menu.png' });

  await page.locator('#music-volume').fill('28');
  await page.locator('#effects-volume').fill('65');
  await expect(page.locator('#music-volume-value')).toHaveText('28%');
  await expect(page.locator('#effects-volume-value')).toHaveText('65%');
  expect(await page.evaluate(() => (window as any).__RALLY__.audio.snapshot.effectsVolume)).toBe(0.65);
  await page.locator('#music-toggle').click();
  await expect.poll(() => page.evaluate(() => (window as any).__RALLY__.audio.snapshot.music.timerActive)).toBe(false);
  await expect.poll(() => page.evaluate(() => (window as any).__RALLY__.audio.snapshot.music.activeSources)).toBe(0);
  expect(await page.evaluate(() => (window as any).__RALLY__.audio.snapshot.muted)).toBe(false);
  await page.reload();
  await expect(page.locator('#loading')).toBeHidden();
  await page.locator('#music-button').click();
  await expect(page.locator('#music-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#music-volume')).toHaveValue('28');
  await expect(page.locator('#effects-volume')).toHaveValue('65');
  await page.locator('#music-toggle').click();
  await expect.poll(() => page.evaluate(() => (window as any).__RALLY__.audio.snapshot.music.timerActive)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.locator('#music-panel')).toBeHidden();
  expect(await page.locator('body').getAttribute('data-phase')).toBe('menu');
  expect(errors).toEqual([]);
});

test('music follows racing, boost, pause, focus, global mute and restart without duplicate loops', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('#loading')).toBeHidden();
  await page.locator('#start-button').click();
  await expect.poll(() => page.evaluate(() => (window as any).__RALLY__.audio.snapshot.music?.mode)).toBe('countdown');
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'racing');
  await expect.poll(() => page.evaluate(() => (window as any).__RALLY__.audio.snapshot.music.mode)).toBe('racing');
  await page.keyboard.down('w');
  await expect.poll(() => page.evaluate(() => (window as any).__RALLY__.simulation.state.racers[0].speed)).toBeGreaterThan(15);
  await page.evaluate(() => {
    (window as any).__RALLY__.simulation.state.racers.slice(1).forEach((racer: any, i: number) => { racer.distance = 650 + i * 65; });
    (window as any).__RALLY__.simulation.resetPlayer();
  });
  await page.keyboard.down('Shift');
  await expect.poll(() => page.evaluate(() => (window as any).__RALLY__.audio.snapshot.music.intensity)).toBe(1);
  await page.keyboard.up('Shift');
  await page.keyboard.up('w');

  await page.keyboard.press('Escape');
  await expect(page.locator('#pause-dialog')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__RALLY__.audio.snapshot.music.mode)).toBe('paused');
  await expect.poll(() => page.evaluate(() => (window as any).__RALLY__.audio.snapshot.music.timerActive)).toBe(false);
  await expect.poll(() => page.evaluate(() => (window as any).__RALLY__.audio.snapshot.music.activeSources)).toBe(0);
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => (window as any).__RALLY__.audio.snapshot.music.timerActive)).toBe(true);

  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect.poll(() => page.evaluate(() => (window as any).__RALLY__.audio.snapshot.music.mode)).toBe('hidden');
  await expect.poll(() => page.evaluate(() => (window as any).__RALLY__.audio.snapshot.music.activeSources)).toBe(0);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => page.evaluate(() => (window as any).__RALLY__.audio.snapshot.music.mode)).toBe('paused');
  await page.keyboard.press('Escape');
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'racing');
  await page.locator('#sound-button').click();
  await expect.poll(() => page.evaluate(() => (window as any).__RALLY__.audio.snapshot.music.timerActive)).toBe(false);
  await page.locator('#sound-button').click();
  await expect.poll(() => page.evaluate(() => (window as any).__RALLY__.audio.snapshot.music.timerActive)).toBe(true);
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Escape');
    await page.locator('#restart-button').click();
    await expect.poll(() => page.evaluate(() => (window as any).__RALLY__.audio.snapshot.music.mode)).toBe('countdown');
    await page.waitForTimeout(160);
    expect(await page.evaluate(() => (window as any).__RALLY__.audio.snapshot.music.activeSources)).toBeLessThan(100);
  }
  await page.keyboard.press('Escape');
  await page.locator('#lobby-button').click();
  await expect.poll(() => page.evaluate(() => (window as any).__RALLY__.audio.snapshot.music.mode)).toBe('menu');
  await page.locator('#music-button').click();
  await expect(page.locator('#music-panel')).toBeVisible();
  await page.screenshot({ path: 'test-results/music-after-restart.png' });
  expect(errors).toEqual([]);
});
