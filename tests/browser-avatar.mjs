import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const server = spawn('/home/francois/.hermes/hermes-agent/venv/bin/python', [
  '-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', '8791',
], { cwd: '/home/francois/ani-companion', stdio: ['ignore', 'pipe', 'pipe'] });

const fail = (message) => { throw new Error(message); };
const distance = (a, b) => Math.sqrt(a.reduce((sum, value, index) => sum + (value - b[index]) ** 2, 0));
const silentWav = (duration = 0.12, sampleRate = 8000) => {
  const samples = Math.floor(duration * sampleRate);
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + samples * 2, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36);
  buffer.writeUInt32LE(samples * 2, 40);
  return buffer;
};

let browser;
try {
  for (let attempt = 0; attempt < 50; attempt++) {
    try { const response = await fetch('http://127.0.0.1:8791/api/health'); if (response.ok) break; }
    catch {}
    await delay(100);
  }

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 430, height: 850 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
  const page = await context.newPage();
  const consoleErrors = [];
  const ttsRequests = [];
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', error => consoleErrors.push(error.message));

  await page.route('**/api/tts', async route => {
    ttsRequests.push(route.request().postDataJSON().text);
    await route.fulfill({ status: 200, contentType: 'audio/wav', body: silentWav() });
  });
  await page.addInitScript(() => {
    localStorage.setItem('ani.profile', 'francois');
    localStorage.setItem('ani.avatar.francois', 'Ani.vrm');
    localStorage.setItem('ani.voice', 'on');
    localStorage.setItem('ani.microphone', 'off');
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      if (!url.endsWith('/api/chat/stream')) return nativeFetch(input, init);
      const request = JSON.parse(init.body || '{}');
      const encoder = new TextEncoder();
      const threeSegments = request.message.includes('trois segments');
      const events = threeSegments ? [
        [0, { type: 'start', session_id: 'browser-test', turn_key: 'server-generated-avatar-key' }],
        [10, { type: 'delta', text: 'Premier segment. ' }],
        [20, { type: 'speech', text: 'Premier segment.', emotion: 'happy' }],
        [150, { type: 'delta', text: 'Deuxième segment. ' }],
        [160, { type: 'speech', text: 'Deuxième segment.', emotion: 'happy' }],
        [300, { type: 'delta', text: 'Troisième segment.' }],
        [310, { type: 'speech', text: 'Troisième segment.', emotion: 'happy' }],
        [700, { type: 'complete', reply: 'Premier segment. Deuxième segment. Troisième segment.', speech: 'Premier segment. Deuxième segment. Troisième segment.', emotion: 'happy', actions: [], session_id: 'browser-test' }],
      ] : [
        [0, { type: 'start', session_id: 'browser-test', turn_key: 'server-generated-avatar-key' }],
        [10, { type: 'delta', text: 'Trop bien !' }],
        [20, { type: 'complete', reply: 'Trop bien !', speech: 'Trop bien !', emotion: 'happy', actions: [{ name: 'dance' }], session_id: 'browser-test' }],
      ];
      return new Response(new ReadableStream({
        start(controller) {
          for (const [delayMs, event] of events) setTimeout(() => {
            if (event.type === 'complete') window.__aniStreamCompleteAt = performance.now();
            controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
            if (event === events.at(-1)[1]) controller.close();
          }, delayMs);
        },
      }), { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
    };
  });
  await page.goto('http://127.0.0.1:8791/', { waitUntil: 'networkidle' });
  try {
    await page.waitForFunction(() => window.aniAvatar?.getAnimationState().ready, null, { timeout: 30000 });
  } catch {
    fail(`Avatar non prêt: ${JSON.stringify(consoleErrors)}`);
  }

  const titleState = await page.evaluate(() => ({ heading: document.querySelector('.topbar strong')?.textContent, title: document.title, phase: document.querySelector('.phase-label')?.textContent }));
  if (titleState.heading !== 'Ani' || titleState.title !== 'Ani') fail(`Le nom de l’avatar sélectionné n’est pas utilisé: ${JSON.stringify(titleState)}`);

  const canvas = await page.locator('#avatar-canvas').boundingBox();
  if (!canvas || canvas.width < 300 || canvas.height < 300) fail(`Canvas avatar trop petit: ${JSON.stringify(canvas)}`);

  await page.evaluate(() => window.aniAvatar.setEmotion('happy'));
  await page.waitForTimeout(100);
  const happy = await page.evaluate(() => window.aniAvatar.getAnimationState());
  if (happy.emotion !== 'happy' || happy.expressions.happy < 0.65) fail(`Expression joyeuse invisible: ${JSON.stringify(happy)}`);

  await page.evaluate(() => window.aniAvatar.setMouthOpen(1));
  const speakingA = await page.evaluate(() => window.aniAvatar.getAnimationState().headRotation);
  await page.waitForTimeout(240);
  const speakingB = await page.evaluate(() => window.aniAvatar.getAnimationState().headRotation);
  await page.evaluate(() => window.aniAvatar.setMouthOpen(0));
  if (distance(speakingA, speakingB) < 0.006) fail(`La tête ne bouge pas pendant la parole: ${speakingA} -> ${speakingB}`);

  const closeCamera = await page.evaluate(() => window.aniAvatar.getCameraState());
  if (!await page.evaluate(() => window.aniAvatar.playMotion('spin'))) fail('Le mouvement spin a été refusé');
  await page.waitForTimeout(700);
  const spin = await page.evaluate(() => ({ animation: window.aniAvatar.getAnimationState(), camera: window.aniAvatar.getCameraState() }));
  if (spin.animation.activeMotion !== 'spin' || Math.abs(spin.animation.avatarRotation[1]) < 0.5) fail(`Rotation non appliquée: ${JSON.stringify(spin)}`);
  await page.waitForTimeout(2600);
  const sustainedSpin = await page.evaluate(() => ({ animation: window.aniAvatar.getAnimationState(), camera: window.aniAvatar.getCameraState() }));
  if (sustainedSpin.animation.activeMotion !== 'spin') fail(`L’animation ne dure pas plusieurs secondes: ${JSON.stringify(sustainedSpin)}`);
  const cameraRetreat = sustainedSpin.camera.position[2] - closeCamera.position[2];
  if (cameraRetreat < 0.9 || cameraRetreat > 1.1) fail(`La caméra ne recule pas d’un mètre: ${cameraRetreat}`);
  await page.waitForFunction(closePosition => {
    const current = window.aniAvatar.getCameraState().position;
    return Math.sqrt(current.reduce((sum, value, index) => sum + (value - closePosition[index]) ** 2, 0)) <= 0.03;
  }, closeCamera.position, { timeout: 10000 });
  const afterSpin = await page.evaluate(() => window.aniAvatar.getCameraState());

  const before = afterSpin;
  await page.mouse.move(canvas.x + canvas.width * 0.72, canvas.y + canvas.height * 0.48);
  await page.mouse.down();
  await page.mouse.move(canvas.x + canvas.width * 0.30, canvas.y + canvas.height * 0.52, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  const moved = await page.evaluate(() => window.aniAvatar.getCameraState());
  if (distance(before.position, moved.position) < 0.02) fail('Le glisser n’a pas fait pivoter la caméra');
  await page.waitForFunction(closePosition => {
    const current = window.aniAvatar.getCameraState().position;
    return Math.sqrt(current.reduce((sum, value, index) => sum + (value - closePosition[index]) ** 2, 0)) <= 0.03;
  }, closeCamera.position, { timeout: 6000 });

  await page.fill('#message-input', 'Montre-moi une danse');
  await page.locator('#chat-form').evaluate(form => form.requestSubmit());
  await page.waitForFunction(() => window.aniAvatar.getAnimationState().activeMotion === 'dance');
  const dance = await page.evaluate(() => window.aniAvatar.getAnimationState());
  if (dance.activeMotion !== 'dance') fail(`Danse non déclenchée par la réponse: ${JSON.stringify(dance)}`);

  // voice-toggle remplacé par la jauge de contexte
  await page.evaluate(() => {
    window.__aniPlayedChunks = 0;
    window.__aniFirstAudioAt = 0;
    window.__aniStreamCompleteAt = 0;
    const player = document.querySelector('#voice-player');
    player.addEventListener('play', () => {
      if (!player.dataset.turnId) return;
      window.__aniPlayedChunks++;
      if (!window.__aniFirstAudioAt) window.__aniFirstAudioAt = performance.now();
    });
  });
  await page.fill('#message-input', 'Lis les trois segments');
  await page.click('button.send');
  try {
    await page.waitForFunction(() => window.__aniPlayedChunks === 3, null, { timeout: 10000 });
  } catch {
    const audioState = await page.evaluate(() => {
      const player = document.querySelector('#voice-player');
      return { playedChunks: window.__aniPlayedChunks, paused: player.paused, ended: player.ended, currentTime: player.currentTime, duration: player.duration };
    });
    fail(`Lecture multi-segments interrompue: ${JSON.stringify({ audioState, ttsRequests, consoleErrors })}`);
  }
  if (ttsRequests.join('|') !== 'Premier segment.|Deuxième segment.|Troisième segment.') {
    fail(`Pipeline audio incomplet: ${JSON.stringify(ttsRequests)}`);
  }
  const streamTiming = await page.evaluate(() => ({
    firstAudioAt: window.__aniFirstAudioAt,
    completeAt: window.__aniStreamCompleteAt,
  }));
  if (!streamTiming.firstAudioAt || !streamTiming.completeAt || streamTiming.firstAudioAt >= streamTiming.completeAt) {
    fail(`Le premier audio n’a pas commencé avant la fin du LLM: ${JSON.stringify(streamTiming)}`);
  }

  await page.evaluate(() => {
    document.querySelector('.topbar').hidden = true;

  });
  await page.locator('#avatar-canvas').screenshot({ path: '/tmp/ani-avatar-canvas.png' });
  await page.screenshot({ path: '/tmp/ani-avatar-motions.png' });
  if (consoleErrors.length) fail(`Erreurs navigateur: ${consoleErrors.join(' | ')}`);
  console.log(JSON.stringify({ ok: true, expression: happy.expressions.happy, headDelta: distance(speakingA, speakingB), spinY: spin.animation.avatarRotation[1], cameraRetreat, motion: dance.activeMotion, audioSegments: ttsRequests.length, screenshot: '/tmp/ani-avatar-motions.png' }));
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
}
