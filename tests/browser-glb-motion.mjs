import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const server = spawn('/home/francois/.hermes/hermes-agent/venv/bin/python', [
  '-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', '8796',
], { cwd: '/home/francois/projects/ani-companion', stdio: ['ignore', 'pipe', 'pipe'] });
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
  const closedMouth = await page.evaluate(() => window.aniAvatar.getMouthRigState());
  if (!closedMouth.available || closedMouth.bones.length !== 6) fail(`Rig de bouche GLB incomplet: ${JSON.stringify(closedMouth)}`);

  if (Math.abs(closedMouth.lowerLip[2] + 1.2) > 0.015 || Math.abs(closedMouth.upperLip[2] - 0.8) > 0.015 || Math.abs(closedMouth.jaw[2] + 5) > 0.015) {
    fail(`La bouche ne restaure pas la pose neutre du GLB: ${JSON.stringify(closedMouth)}`);
  }
  await page.waitForTimeout(300);
  const stableMouth = await page.evaluate(() => window.aniAvatar.getMouthRigState());
  if (distance(stableMouth.lowerLip, closedMouth.lowerLip) > 0.001 || distance(stableMouth.upperLip, closedMouth.upperLip) > 0.001 || distance(stableMouth.jaw, closedMouth.jaw) > 0.001) {
    fail(`La pose de bouche dérive au repos: ${JSON.stringify({ closedMouth, stableMouth })}`);
  }
  await page.evaluate(() => window.aniAvatar.setMouthOpen(0.35));
  await page.waitForTimeout(120);
  const quietSpeechMouth = await page.evaluate(() => window.aniAvatar.getMouthRigState());
  if (Math.abs(quietSpeechMouth.lowerLip[2] - closedMouth.lowerLip[2]) < 0.45) {
    fail(`La bouche reste imperceptible à faible volume: ${JSON.stringify({ closedMouth, quietSpeechMouth })}`);
  }
  await page.evaluate(() => window.aniAvatar.setMouthOpen(0));
  await page.waitForTimeout(120);
  await page.locator('#avatar-canvas').screenshot({ path: '/tmp/melissa2-mouth-closed.png' });
  await page.evaluate(() => window.aniAvatar.setMouthOpen(1.25));
  await page.waitForTimeout(120);
  const openMouth = await page.evaluate(() => window.aniAvatar.getMouthRigState());

  if (Math.abs(openMouth.lowerLip[2] - closedMouth.lowerLip[2]) < 1.1) fail(`Ouverture insuffisante de la lèvre inférieure: ${JSON.stringify({ closedMouth, openMouth })}`);
  if (distance(openMouth.upperLip, closedMouth.upperLip) > 0.001) fail(`La lèvre supérieure ne reste pas fixe: ${JSON.stringify({ closedMouth, openMouth })}`);
  if (Math.abs(openMouth.jaw[2] - closedMouth.jaw[2]) < 0.25) fail(`Ouverture insuffisante de la mâchoire: ${JSON.stringify({ closedMouth, openMouth })}`);
  await page.locator('#avatar-canvas').screenshot({ path: '/tmp/melissa2-mouth-open.png' });
  await page.evaluate(() => window.aniAvatar.setMouthOpen(0));
  await page.waitForTimeout(120);
  const initial = await page.evaluate(() => ({ camera: window.aniAvatar.getCameraState(), lighting: window.aniAvatar.getLightingState(), animation: window.aniAvatar.getAnimationState(), framing: window.aniAvatar.getFramingState() }));
  const danceCatalog = await page.evaluate(() => window.aniAvatar.getMotionCatalog().dance);
  if (danceCatalog.includes('Boom_Dance')) fail('Boom_Dance reste exposée dans le catalogue aléatoire');
  for (const expected of ['Bass_Beats', 'Crystal_Beads', 'Dont_You_Dare', 'Squat_Stance']) {
    if (!danceCatalog.includes(expected)) fail(`Danse absente du catalogue aléatoire: ${expected}`);
  }
  const initialDistance = distance(initial.camera.position, initial.camera.target);
  if (initialDistance < 0.98 || initialDistance > 1.02) fail(`La caméra initiale n’est pas à un mètre: ${initialDistance}`);
  if (initial.framing.mode !== 'upper-body' || initial.framing.boundsNdc.minY >= -1) fail(`La pose initiale n’est pas cadrée upper body: ${JSON.stringify(initial.framing)}`);
  await page.locator('#avatar-canvas').screenshot({ path: '/tmp/melissa-upper-body.png' });
  const portraitMotionUi = await page.evaluate(() => {
    window.__aniTestPush('Bulle temporaire', 'ani');
    window.aniAvatar.playMotion('dance');
    const conversation = document.querySelector('.conversation');
    return {
      bubbleVisibility: getComputedStyle(document.querySelector('.bubble.ani')).visibility,
      historyDisplay: getComputedStyle(document.querySelector('.history')).display,
      conversationBackground: getComputedStyle(conversation).backgroundImage,
      conversationHeight: conversation.getBoundingClientRect().height,
    };
  });
  if (portraitMotionUi.bubbleVisibility !== 'hidden') fail(`Bulle portrait visible pendant l’animation: ${JSON.stringify(portraitMotionUi)}`);
  if (portraitMotionUi.historyDisplay !== 'none' || portraitMotionUi.conversationBackground !== 'none' || portraitMotionUi.conversationHeight > 90) {
    fail(`Le voile de conversation assombrit encore l’animation: ${JSON.stringify(portraitMotionUi)}`);
  }
  const motionIndicator = await page.evaluate(() => {
    const element = document.querySelector('#motion-indicator');
    const state = window.aniAvatar.getAnimationState();
    if (!element) return null;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return {
      hidden: element.hidden,
      text: element.textContent,
      clip: state.activeClip,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      color: style.color,
      backgroundColor: style.backgroundColor,
      height: rect.height,
    };
  });
  if (!motionIndicator || motionIndicator.hidden || motionIndicator.text !== motionIndicator.clip) {
    fail(`Nom de l’animation absent ou incorrect: ${JSON.stringify(motionIndicator)}`);
  }
  if (motionIndicator.fontSize !== '15px' || Number(motionIndicator.fontWeight) < 700 || motionIndicator.color !== 'rgb(255, 255, 255)' || motionIndicator.backgroundColor !== 'rgb(24, 18, 28)' || motionIndicator.height < 40) {
    fail(`Bandeau d’animation insuffisamment lisible: ${JSON.stringify(motionIndicator)}`);
  }
  await page.setViewportSize({ width: 850, height: 430 });
  const landscapeBubbleVisibility = await page.locator('.bubble.ani').evaluate(node => getComputedStyle(node).visibility);
  if (landscapeBubbleVisibility === 'hidden') fail('Bulle paysage cachée pendant l’animation');
  await page.setViewportSize({ width: 430, height: 850 });
  const danceChoices = await page.evaluate(() => {
    const originalRandom = Math.random;
    const choose = value => {
      Math.random = () => value;
      window.aniAvatar.playMotion('dance');
      return window.aniAvatar.getAnimationState().activeClip;
    };
    const first = choose(0);
    const last = choose(0.999999);
    Math.random = originalRandom;
    return [first, last];
  });
  if (!danceChoices[0] || !danceChoices[1] || danceChoices[0] === danceChoices[1]) {
    fail(`Les danses GLB ne sont pas choisies aléatoirement: ${JSON.stringify(danceChoices)}`);
  }
  const namedChoices = await page.evaluate(() => {
    window.aniAvatar.playMotion('tease');
    const tease = window.aniAvatar.getAnimationState();
    window.aniAvatar.playMotion('jump');
    const jump = window.aniAvatar.getAnimationState().activeClip;
    window.aniAvatar.playMotion('spin');
    const spin = window.aniAvatar.getAnimationState().activeClip;
    return { tease, jump, spin };
  });
  if (namedChoices.tease.activeMotion !== 'tease' || namedChoices.tease.activeClip !== null) {
    fail(`Tease déclenche encore un clip GLB: ${JSON.stringify(namedChoices.tease)}`);
  }
  if (namedChoices.jump !== 'Hop_with_Arms_Raised') fail(`Clip jump ambigu ou introuvable: ${JSON.stringify(namedChoices)}`);
  if (namedChoices.spin !== 'Depressed_Full_Turn_Left') fail(`Clip spin ambigu ou introuvable: ${JSON.stringify(namedChoices)}`);
  if (!await page.evaluate(() => window.aniAvatar.playMotion('dance'))) fail('Danse GLB refusée');
  await page.waitForTimeout(6200);
  const during = await page.evaluate(() => ({ animation: window.aniAvatar.getAnimationState(), camera: window.aniAvatar.getCameraState(), lighting: window.aniAvatar.getLightingState(), framing: window.aniAvatar.getFramingState() }));
  if (during.animation.activeMotion !== 'dance') fail(`Danse GLB trop courte: ${JSON.stringify(during.animation)}`);
  const initialKeyDistance = distance(initial.lighting.key, initial.camera.position);
  const actionKeyDistance = distance(during.lighting.key, during.camera.position);
  if (Math.abs(initialKeyDistance - actionKeyDistance) > 0.01) fail(`L’éclairage ne suit pas la caméra: ${JSON.stringify({ initial: initial.lighting, during: during.lighting })}`);
  if (distance(during.lighting.target, during.camera.target) > 0.01) fail(`L’éclairage ne suit pas la cible d’animation: ${JSON.stringify(during.lighting)}`);
  const actionDistance = distance(during.camera.position, during.camera.target);
  if (actionDistance < 1.9 || actionDistance > 2.02) fail(`La caméra d’animation n’est pas à deux mètres: ${actionDistance}`);
  const bounds = during.framing.boundsNdc;
  if (during.framing.mode !== 'full-body' || bounds.minX < -1 || bounds.maxX > 1 || bounds.minY < -1 || bounds.maxY > 1) {
    fail(`L’animation n’est pas cadrée full body: ${JSON.stringify(during.framing)}`);
  }
  await page.locator('#avatar-canvas').screenshot({ path: '/tmp/melissa-full-body.png' });
  await page.waitForFunction(position => {
    const current = window.aniAvatar.getCameraState().position;
    return Math.sqrt(current.reduce((sum, value, index) => sum + (value - position[index]) ** 2, 0)) <= 0.03;
  }, initial.camera.position, { timeout: 12000 });
  const final = await page.evaluate(() => ({ camera: window.aniAvatar.getCameraState(), animation: window.aniAvatar.getAnimationState() }));
  const returnedPosition = distance(initial.camera.position, final.camera.position);
  const returnedTarget = distance(initial.camera.target, final.camera.target);
  if (returnedPosition > 0.03 || returnedTarget > 0.03) fail(`La caméra ne revient pas: ${JSON.stringify({ initial, final })}`);
  if (final.animation.activeClip !== null) fail(`Le clip GLB laisse l’avatar dans sa pose finale: ${JSON.stringify(final.animation)}`);
  const restoredBubbleVisibility = await page.locator('.bubble.ani').evaluate(node => getComputedStyle(node).visibility);
  if (restoredBubbleVisibility !== 'visible') fail(`Bulle non restaurée après l’animation: ${restoredBubbleVisibility}`);
  const restoredMotionIndicator = await page.evaluate(() => {
    const element = document.querySelector('#motion-indicator');
    return element ? { hidden: element.hidden, text: element.textContent } : null;
  });
  if (!restoredMotionIndicator?.hidden || restoredMotionIndicator.text) {
    fail(`Nom de l’animation non effacé après sa fin: ${JSON.stringify(restoredMotionIndicator)}`);
  }
  if (distance(initial.animation.avatarPosition, final.animation.avatarPosition) > 0.001) fail('La position de l’avatar n’est pas restaurée');
  if (distance(initial.animation.avatarRotation, final.animation.avatarRotation) > 0.001) fail('La rotation de l’avatar n’est pas restaurée');
  await page.locator('#avatar-canvas').screenshot({ path: '/tmp/melissa-upper-body-returned.png' });
  if (errors.length) fail(`Erreurs navigateur: ${errors.join(' | ')}`);
  console.log(JSON.stringify({ ok: true, avatar: 'Melissa.glb', initialDistance, actionDistance, returnedPosition, returnedTarget }));
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
}
