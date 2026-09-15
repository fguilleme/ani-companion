import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const port = 8796;
const origin = `http://127.0.0.1:${port}`;
const fail = message => { throw new Error(message); };
const silentWav = Buffer.from('UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=', 'base64');

let browser;
let server;
try {
  server = spawn('/home/francois/.hermes/hermes-agent/venv/bin/python', [
    '-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', String(port),
  ], { cwd: '/home/francois/projects/ani-companion', stdio: ['ignore', 'pipe', 'pipe'] });
  for (let attempt = 0; attempt < 50; attempt++) {
    try { if ((await fetch(`${origin}/api/health`)).ok) break; } catch {}
    await delay(100);
  }

  browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ viewport: { width: 430, height: 850 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  const steerRequests = [];
  const cancelRequests = [];
  const ttsTexts = [];

  await page.route('**/api/tts', route => {
    ttsTexts.push(route.request().postDataJSON().text);
    return route.fulfill({ status: 200, contentType: 'audio/wav', body: silentWav });
  });
  await page.route('**/api/chat/steer', route => {
    steerRequests.push(route.request().postDataJSON());
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"queued"}' });
  });
  await page.route('**/api/cancel', route => {
    cancelRequests.push(route.request().postDataJSON());
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"cancelled":true}' });
  });
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.play = function playForToolTest() {
      this.dispatchEvent(new Event('play'));
      return Promise.resolve();
    };
    localStorage.setItem('ani.profile', 'francois');
    localStorage.setItem('ani.voice', 'on');
    const nativeFetch = window.fetch.bind(window);
    window.__chatRequests = [];
    window.fetch = async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      if (!url.endsWith('/api/chat/stream')) return nativeFetch(input, init);
      window.__chatRequests.push(JSON.parse(init.body));
      const encoder = new TextEncoder();
      const events = [
        [0, { type: 'start', session_id: 'tool-session', turn_key: 'tool-turn-secret' }],
        [20, { type: 'tool', state: 'start', name: 'web_search', context: 'chercher une information obscure' }],
        [800, { type: 'tool', state: 'complete', name: 'web_search' }],
        [900, { type: 'delta', text: 'Voici le résultat qui tient compte de ta précision.' }],
        [920, { type: 'speech', text: 'Voici le résultat qui tient compte de ta précision.', emotion: 'happy' }],
        [940, { type: 'complete', reply: 'Voici le résultat qui tient compte de ta précision.', emotion: 'happy', actions: [], session_id: 'tool-session' }],
      ];
      return new Response(new ReadableStream({ start(controller) {
        for (const [wait, event] of events) setTimeout(() => {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          if (event === events.at(-1)[1]) controller.close();
        }, wait);
      }}), { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
    };
  });

  await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
  await page.fill('#message-input', 'Cherche une information obscure');
  await page.click('button.send');
  await page.waitForFunction(() => document.querySelector('#phase-indicator')?.dataset.phase === 'tool');
  await page.fill('#message-input', 'Prends aussi en compte les sources françaises');
  await page.click('button.send');
  await page.waitForFunction(() => document.querySelector('#phase-indicator')?.dataset.phase === 'idle');

  const state = await page.evaluate(() => ({
    chatRequests: window.__chatRequests,
    response: document.querySelector('.bubble.ani')?.textContent || '',
  }));
  if (state.chatRequests.length !== 1) fail(`Une deuxième recherche a été lancée: ${JSON.stringify(state.chatRequests)}`);
  if (steerRequests.length !== 1 || steerRequests[0].message !== 'Prends aussi en compte les sources françaises') {
    fail(`Le message n'a pas été envoyé comme steering: ${JSON.stringify(steerRequests)}`);
  }
  if (steerRequests[0].turn_key !== 'tool-turn-secret') fail(`Mauvaise clé de tour: ${JSON.stringify(steerRequests)}`);
  if (cancelRequests.length) fail(`La recherche a été annulée: ${JSON.stringify(cancelRequests)}`);
  if (!ttsTexts.some(text => /cherche|recherche/i.test(text))) fail(`Aucune annonce vocale de recherche: ${JSON.stringify(ttsTexts)}`);
  if (!state.response.includes('tient compte de ta précision')) fail(`Réponse finale absente: ${JSON.stringify(state)}`);
  console.log(JSON.stringify({ ok: true, steerRequests, cancelRequests, ttsTexts, response: state.response }));
} finally {
  if (browser) await browser.close();
  if (server?.exitCode === null) {
    const gracefulExit = new Promise(resolve => server.once('exit', resolve));
    server.kill('SIGTERM');
    await Promise.race([gracefulExit, delay(2000)]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
}
