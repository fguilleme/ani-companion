import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true, args: ['--enable-webgl', '--use-angle=swiftshader'] });
const context = await browser.newContext({ viewport: { width: 430, height: 932 } });
const page = await context.newPage();
const errors = [];
const resources = [];
page.on('console', (message) => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
page.on('pageerror', (error) => errors.push(`page: ${error.message}`));
page.on('response', (response) => {
  if (/ani\.vrm|avatar-3d\.bundle\.js/.test(response.url())) resources.push({ url: response.url(), status: response.status() });
});
await page.goto('http://127.0.0.1:8787/', { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForSelector('#ani-avatar.avatar-ready', { timeout: 120000 });
await page.waitForTimeout(1500);
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
console.log(JSON.stringify({ state, resources, errors }, null, 2));
if (!state.ready || !state.loadingHidden || state.renderedPngBytes < 10000) process.exitCode = 2;
if (resources.some((resource) => resource.status !== 200) || resources.length < 2) process.exitCode = 3;
if (errors.length) process.exitCode = 4;
await browser.close();
