import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const port = 8795;
const origin = `http://127.0.0.1:${port}`;
const tempDir = mkdtempSync(join(tmpdir(), 'ani-barge-in-'));
const fakeMicPath = join(tempDir, 'mic.wav');
const fail = message => { throw new Error(message); };

const wav = ({ duration, sampleRate = 16000, sampleAt = () => 0 }) => {
  const samples = Math.floor(duration * sampleRate);
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + samples * 2, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36);
  buffer.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) {
    const value = Math.max(-1, Math.min(1, sampleAt(index / sampleRate)));
    buffer.writeInt16LE(Math.round(value * 32767), 44 + index * 2);
  }
  return buffer;
};

let browser;
let server;
try {
  // Silence until playback starts, then a sustained quiet user-like tone.
  writeFileSync(fakeMicPath, wav({
    duration: 12,
    sampleAt: time => time >= 3 && time < 5 ? 0.08 * Math.sin(2 * Math.PI * 220 * time) : 0,
  }), { flag: 'wx', mode: 0o600 });
  server = spawn('/home/francois/.hermes/hermes-agent/venv/bin/python', [
    '-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', String(port),
  ], { cwd: '/home/francois/projects/ani-companion', stdio: ['ignore', 'pipe', 'pipe'] });
  for (let attempt = 0; attempt < 50; attempt++) {
    try { if ((await fetch(`${origin}/api/health`)).ok) break; } catch {}
    await delay(100);
  }
  browser = await chromium.launch({ headless: true, args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    `--use-file-for-fake-audio-capture=${fakeMicPath}`,
  ] });
  const context = await browser.newContext({ viewport: { width: 430, height: 850 }, serviceWorkers: 'block' });
  await context.grantPermissions(['microphone'], { origin });
  const page = await context.newPage();
  const cancelRequests = [];
  const ttsCancelRequests = [];
  const sttRequests = [];
  await page.route('**/api/tts', route => route.fulfill({
    status: 200,
    contentType: 'audio/wav',
    body: wav({ duration: 8 }),
  }));
  await page.route('**/api/cancel', async route => {
    cancelRequests.push({
      ...route.request().postDataJSON(),
      observedAt: await page.evaluate(() => performance.now()),
    });
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"cancelled":true}' });
  });
  await page.route('**/api/tts/cancel', async route => {
    ttsCancelRequests.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '{"cancelled":true}',
    });
  });
  await page.route('**/api/stt', route => {
    sttRequests.push(route.request().url());
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '{"text":"Question après interruption"}',
    });
  });
  await page.addInitScript(() => {
    localStorage.setItem('ani.profile', 'francois');
    localStorage.setItem('ani.voice', 'on');
    localStorage.setItem('ani.microphone', 'off');
    const nativeFetch = window.fetch.bind(window);
    window.__chatTiming = { requestStartedAt: [], messages: [] };
    window.fetch = async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      if (!url.endsWith('/api/chat/stream')) return nativeFetch(input, init);
      const requestNumber = window.__chatTiming.requestStartedAt.push(performance.now());
      window.__chatTiming.messages.push(JSON.parse(init.body).message);
      const encoder = new TextEncoder();
      const events = requestNumber === 1 ? [
        [0, { type: 'start', session_id: 'barge-in-test', turn_key: 'barge-in-turn' }],
        [10, { type: 'delta', text: 'Une réponse volontairement longue.' }],
        [20, { type: 'speech', text: 'Une réponse volontairement longue.', emotion: 'happy' }],
        [10000, { type: 'complete', reply: 'Une réponse volontairement longue.', emotion: 'happy', actions: [], session_id: 'barge-in-test' }],
      ] : [
        [0, { type: 'start', session_id: 'barge-in-test', turn_key: 'follow-up-turn' }],
        [10, { type: 'complete', reply: 'Réponse suivante.', emotion: 'neutral', actions: [], session_id: 'barge-in-test' }],
      ];
      return new Response(new ReadableStream({ start(controller) {
        for (const [wait, event] of events) setTimeout(() => {
          try {
            if (requestNumber === 1 && event.type === 'complete') window.__chatTiming.firstStreamCompletedAt = performance.now();
            controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
            if (event === events.at(-1)[1]) controller.close();
          } catch {}
        }, wait);
      }}), { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
    };
  });

  await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
  await page.click('#mic-button');
  await page.waitForFunction(() => document.querySelector('#mic-button').classList.contains('listening'));
  await page.evaluate(() => {
    const player = document.querySelector('#voice-player');
    window.__bargeIn = { maxRms: 0, loudSamples: 0, longestLoudRun: 0, loudRun: 0 };
    window.__bargeInMeter = setInterval(() => {
      const rms = window.__aniMicRms || 0;
      window.__bargeIn.maxRms = Math.max(window.__bargeIn.maxRms, rms);
      if (rms > 0.035) {
        window.__bargeIn.loudSamples++;
        window.__bargeIn.loudRun++;
        window.__bargeIn.longestLoudRun = Math.max(window.__bargeIn.longestLoudRun, window.__bargeIn.loudRun);
      } else window.__bargeIn.loudRun = 0;
    }, 10);
    player.addEventListener('play', () => {
      if (player.dataset.turnId) window.__bargeIn.playedAt = performance.now();
    });
  });
  await page.fill('#message-input', 'Parle assez longtemps');
  await page.click('button.send');
  await page.waitForFunction(() => window.__bargeIn.playedAt > 0, null, { timeout: 6500 });
  for (let attempt = 0; attempt < 50 && !ttsCancelRequests.some(request => request.turn_key === 'barge-in-turn'); attempt++) {
    await delay(100);
  }
  const state = await page.evaluate(() => ({
    ...window.__bargeIn,
    playerPaused: document.querySelector('#voice-player').paused,
    playerCurrentTime: document.querySelector('#voice-player').currentTime,
    playerDuration: document.querySelector('#voice-player').duration,
  }));
  if (!ttsCancelRequests.some(request => request.turn_key === 'barge-in-turn')) {
    fail(`La prise de parole n'a pas annulé l'audio actif: ${JSON.stringify({ state, ttsCancelRequests })}`);
  }
  if (cancelRequests.length) {
    fail(`La prise de parole a annulé le LLM au lieu de l'audio seul: ${JSON.stringify(cancelRequests)}`);
  }
  if (!state.playerPaused) {
    fail(`L'audio joue encore après la prise de parole: ${JSON.stringify(state)}`);
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await page.evaluate(() => window.__chatTiming.requestStartedAt.length >= 2)) break;
    await delay(100);
  }
  const chatTiming = await page.evaluate(() => window.__chatTiming);
  if (chatTiming.requestStartedAt.length < 2) {
    const transcriptState = await page.evaluate(() => ({
      input: document.querySelector('#message-input').value,
      phase: document.querySelector('#phase-indicator').dataset.phase,
      micClass: document.querySelector('#mic-button').className,
    }));
    fail(`La transcription n'a pas lancé de requête suivante: ${JSON.stringify({ chatTiming, transcriptState, sttRequests })}`);
  }
  if (chatTiming.requestStartedAt[1] >= chatTiming.firstStreamCompletedAt) {
    fail(`La transcription est restée bloquée jusqu’à la fin du premier flux: ${JSON.stringify(chatTiming)}`);
  }
  if (!cancelRequests.length) {
    const transcriptState = await page.evaluate(() => ({
      input: document.querySelector('#message-input').value,
      phase: document.querySelector('#phase-indicator').dataset.phase,
      micClass: document.querySelector('#mic-button').className,
    }));
    fail(`La transcription complète n'a pas annulé le LLM avant le nouveau tour: ${JSON.stringify({ cancelRequests, chatTiming, transcriptState, sttRequests })}`);
  }
  console.log(JSON.stringify({ ok: true, playerCurrentTime: state.playerCurrentTime, maxRms: state.maxRms, ttsCancelRequests, cancelRequests, chatTiming }));
} finally {
  if (browser) await browser.close();
  if (server?.exitCode === null) {
    const gracefulExit = new Promise(resolve => server.once('exit', resolve));
    server.kill('SIGTERM');
    await Promise.race([gracefulExit, delay(2000)]);
    if (server.exitCode === null) {
      const forcedExit = new Promise(resolve => server.once('exit', resolve));
      server.kill('SIGKILL');
      await Promise.race([forcedExit, delay(2000)]);
    }
  }
  rmSync(tempDir, { recursive: true, force: true });
}
