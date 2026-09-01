import { chromium } from 'playwright';

function toneWav(seconds = 1) {
  const sampleRate = 8000;
  const frames = sampleRate * seconds;
  const buffer = Buffer.alloc(44 + frames * 2);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + frames * 2, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36);
  buffer.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) buffer.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / sampleRate) * 5000), 44 + i * 2);
  return buffer;
}

const browser = await chromium.launch({ headless: true, args: ['--enable-webgl', '--use-angle=swiftshader', '--autoplay-policy=user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const mobileProfile = process.env.MOBILE_PROFILE || 'iphone';
const isIphone = mobileProfile === 'iphone';
const context = await browser.newContext({
  viewport: { width: 430, height: 932 },
  isMobile: true,
  hasTouch: true,
  userAgent: isIphone
    ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'
    : 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36',
});
await context.grantPermissions(['microphone'], { origin: 'http://127.0.0.1:8787' });
await context.addInitScript(() => localStorage.setItem('ani.microphone', 'on'));
const page = await context.newPage();
const errors = [];
const resources = [];
await page.route('**/api/stt', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: '' }) }));
page.on('console', (message) => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
page.on('pageerror', (error) => errors.push(`page: ${error.message}`));
page.on('response', (response) => {
  if (/ani\.vrm|avatar-3d\.bundle\.js/.test(response.url())) resources.push({ url: response.url(), status: response.status() });
});
await page.goto('http://127.0.0.1:8787/', { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForSelector('#ani-avatar.avatar-ready', { timeout: 120000 });
await page.waitForTimeout(1500);
const cameraBefore = await page.evaluate(() => window.aniAvatar.getCameraState());
const canvasBox = await page.locator('#avatar-canvas').boundingBox();
await page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
await page.mouse.down();
await page.mouse.move(canvasBox.x + canvasBox.width / 2 + 90, canvasBox.y + canvasBox.height / 2, { steps: 8 });
await page.mouse.up();
await page.waitForFunction(() => document.getElementById('mic-button').classList.contains('listening'));
await page.waitForTimeout(150);
const cameraDragged = await page.evaluate(() => window.aniAvatar.getCameraState());
await page.waitForTimeout(3500);
const cameraReturned = await page.evaluate(() => window.aniAvatar.getCameraState());
const cameraDelta = (a, b) => Math.hypot(...a.position.map((value, index) => value - b.position[index]));
const orbit = { moved: cameraDelta(cameraBefore, cameraDragged), returned: cameraDelta(cameraBefore, cameraReturned) };
const state = await page.evaluate(() => {
  const canvas = document.getElementById('avatar-canvas');
  const loading = document.getElementById('avatar-loading');
  return {
    ready: document.getElementById('ani-avatar').classList.contains('avatar-ready'),
    loadingHidden: loading.hidden,
    canvasWidth: canvas.width,
    canvasHeight: canvas.height,
    renderedPngBytes: Math.round(canvas.toDataURL('image/png').length * 0.75),
    api: Object.keys(window.aniAvatar || {}).sort(),
  };
});
await page.screenshot({ path: 'test-artifacts/avatar-3d-idle.png', fullPage: true });
await page.evaluate(() => { window.aniAvatar.setEmotion('happy'); window.aniAvatar.setMouthOpen(1.1); });
await page.waitForTimeout(250);
await page.screenshot({ path: 'test-artifacts/avatar-3d-speaking.png', fullPage: true });
await page.route('**/api/chat', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ reply: 'Voici une réponse volontairement longue qui doit défiler sur une seule ligne sans jamais masquer le visage d’Ani.', emotion: 'happy', session_id: 'browser-test' }) }));
let resolveTtsRequested;
const ttsRequested = new Promise(resolve => { resolveTtsRequested = resolve; });
await page.route('**/api/tts', async route => {
  resolveTtsRequested();
  await new Promise(resolve => setTimeout(resolve, 700));
  await route.fulfill({ status: 200, contentType: 'audio/wav', body: toneWav() });
});
await page.locator('#message-input').fill('Ferme le clavier');
await page.locator('button.send').click();
await ttsRequested;
const tickerHiddenBeforeAudio = await page.locator('#speech').getAttribute('hidden') !== null;
await page.waitForFunction(() => document.getElementById('voice-player').currentTime > 0.05, null, { timeout: 10000 });
const mobileInputAudio = await page.evaluate(() => ({
  keyboardDismissed: document.activeElement !== document.getElementById('message-input'),
  audioPlaying: !document.getElementById('voice-player').paused,
  audioTime: document.getElementById('voice-player').currentTime,
  microphoneContinuous: document.getElementById('mic-button').classList.contains('listening'),
  assistantHistoryBubbles: document.querySelectorAll('.bubble.ani').length,
  tickerWhiteSpace: getComputedStyle(document.querySelector('.speech-line')).whiteSpace,
  tickerHeight: document.getElementById('speech').getBoundingClientRect().height,
  tickerDuration: document.querySelector('.speech-line').getAnimations()[0]?.effect.getTiming().duration,
}));
mobileInputAudio.tickerHiddenBeforeAudio = tickerHiddenBeforeAudio;
await page.screenshot({ path: 'test-artifacts/avatar-3d-ticker.png', fullPage: true });
console.log(JSON.stringify({ mobileProfile, state, orbit, mobileInputAudio, resources, errors }, null, 2));
if (!state.ready || !state.loadingHidden || state.renderedPngBytes < 10000) process.exitCode = 2;
if (orbit.moved < 0.01 || orbit.returned > 0.02) process.exitCode = 6;
if (!mobileInputAudio.keyboardDismissed || !mobileInputAudio.audioPlaying || mobileInputAudio.audioTime <= 0.05 || !mobileInputAudio.microphoneContinuous || mobileInputAudio.assistantHistoryBubbles !== 0 || mobileInputAudio.tickerWhiteSpace !== 'nowrap' || mobileInputAudio.tickerHeight > 31 || !mobileInputAudio.tickerHiddenBeforeAudio || Math.abs(mobileInputAudio.tickerDuration - 1000) > 100) process.exitCode = 5;
if (resources.some((resource) => resource.status !== 200) || resources.length < 2) process.exitCode = 3;
if (errors.length) process.exitCode = 4;
await page.locator('#mic-button').click();
await browser.close();
