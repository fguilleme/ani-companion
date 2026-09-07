import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const server = spawn('/home/francois/.hermes/hermes-agent/venv/bin/python', [
  '-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', '8796',
], { cwd: '/home/francois/ani-companion', stdio: ['ignore', 'pipe', 'pipe'] });
const distance = (a, b) => Math.sqrt(a.reduce((sum, value, index) => sum + (value - b[index]) ** 2, 0));
const fail = message => { throw new Error(message); };
let browser;
try {
  for (let attempt = 0; attempt < 50; attempt++) {
    try { if ((await fetch('http://127.0.0.1:8796/api/health')).ok) break; } catch {}
    await delay(100);
  }
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 430, height: 850 }, serviceWorkers: 'block' });
  await context.addInitScript(() => {
    localStorage.setItem('ani.profile', 'francois');
    localStorage.setItem('ani.avatar.francois', 'Melissa.glb');
  });
  const page = await context.newPage();
  const errors = [];
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:8796/', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.aniAvatar?.getAnimationState().ready, null, { timeout: 30000 });
  const initial = await page.evaluate(() => window.aniAvatar.getCameraState());
  if (!await page.evaluate(() => window.aniAvatar.playMotion('dance'))) fail('Danse GLB refusée');
  await page.waitForTimeout(3300);
  const during = await page.evaluate(() => ({ animation: window.aniAvatar.getAnimationState(), camera: window.aniAvatar.getCameraState() }));
  if (during.animation.activeMotion !== 'dance') fail(`Danse GLB trop courte: ${JSON.stringify(during.animation)}`);
  const retreat = during.camera.position[2] - initial.position[2];
  if (retreat < 0.9 || retreat > 1.1) fail(`Recul caméra incorrect: ${retreat}`);
  await page.waitForFunction(position => {
    const current = window.aniAvatar.getCameraState().position;
    return Math.sqrt(current.reduce((sum, value, index) => sum + (value - position[index]) ** 2, 0)) <= 0.03;
  }, initial.position, { timeout: 12000 });
  const final = await page.evaluate(() => window.aniAvatar.getCameraState());
  if (distance(initial.position, final.position) > 0.03) fail(`La caméra ne revient pas: ${JSON.stringify({ initial, final })}`);
  if (errors.length) fail(`Erreurs navigateur: ${errors.join(' | ')}`);
  console.log(JSON.stringify({ ok: true, avatar: 'Melissa.glb', retreat, returnedDistance: distance(initial.position, final.position) }));
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
}
